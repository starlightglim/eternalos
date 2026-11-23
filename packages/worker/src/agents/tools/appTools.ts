/**
 * App tools for the OrchestratorAgent.
 *
 * These tools are exposed directly to the OrchestratorAgent so it can create,
 * update, list, and manage apps without routing normal app builds through a
 * secondary code-execution sandbox.
 *
 * Apps are compiled via @cloudflare/worker-bundler and run as Dynamic Workers.
 */

import { generateObject, generateText, tool } from 'ai';
import { z } from 'zod';
import { createWorker } from '@cloudflare/worker-bundler';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../../index';
import type { AppManifest, AppPermissions, DesktopItem, UserProfile } from '../../types';
import type { AppGrantedPermissions } from '../../utils/jwt';
import {
  APP_BACKEND_ENTRY_FILE,
  AppValidationError,
  assertAppBundleValid,
  isBackendFile,
  splitBackendFiles,
  formatAppValidationIssues,
  type AppValidationIssue,
} from '../../utils/appBundleValidation';
import {
  APP_SPEC_SYSTEM_PROMPT,
  appSpecSchema,
  derivePermissionsFromSpec,
  validateAppSpec,
  type AppSpec,
} from './appSpec';
import {
  ensureRevisionBaseline,
  pruneAppRevisions,
  writeAppRevision,
  type AppRevisionPointers,
} from '../../routes/appRevisions';
import { appRunnerName } from '../../durable-objects/AppRunner';
import { resolveInstalledAppBackend } from '../../routes/appServe';
import {
  intersectGranted,
  pruneGrantApprovals,
  sanitizeGranted,
} from '../../utils/appScopes';

interface AppToolsContext {
  env: Env;
  sql: SqlStorage;
  agentName: string; // uid
  toolCallId?: string;
  onBuildStage?: (toolCallId: string, stage: string, label: string) => void;
}

const REAL_BUILD_STAGES: Record<string, string> = {
  spec: 'Generating specification',
  codegen: 'Writing source files',
  bundle: 'Bundling app',
  storage: 'Saving files',
  install: 'Installing on desktop',
};

interface AppBundleInput {
  name: string;
  description?: string;
  files: Record<string, string>;
  width: number;
  height: number;
  permissions?: AppPermissions;
  rationale?: string;
}

type AppWorkspaceProfile = 'static-html' | 'fullstack';

type AppBuildStageKey =
  | 'prepare-workspace'
  | 'bundle-worker'
  | 'write-storage'
  | 'install-desktop';

interface AppWorkspaceManifest {
  version: 1;
  profile: AppWorkspaceProfile;
  entryHtml: string;
  sourceFiles: string[];
  runtimeAsset: string;
  workerEntrypoint: string;
  /** Present on 'fullstack' apps: the server-side handler module. */
  backendEntry?: string;
}

interface AppWorkspace {
  manifest: AppWorkspaceManifest;
  files: Record<string, string>;
}

interface AppBuildStageSummary {
  key: AppBuildStageKey;
  label: string;
  status: 'completed' | 'current' | 'pending';
}

interface AppBuildSummary {
  currentStage: AppBuildStageKey | 'ready';
  stages: AppBuildStageSummary[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

interface StoredAppMetadata {
  id: string;
  uid: string;
  name: string;
  description?: string;
  width: number;
  height: number;
  permissions?: AppPermissions;
  rationale?: string;
  granted: AppGrantedPermissions;
  version: number;
  r2Prefix: string;
  createdAt: number;
  expiresAt?: number;
  /**
   * Only on preview records (`app-preview:{previewId}` in KV): the installed
   * app a change-preview targets. A preview with a target reinstalls that
   * app on install (new version, same desktop item and storage); one
   * without installs as a brand-new app.
   */
  targetAppId?: string;
}

type AppArtifactBuildResult = {
  metadata: StoredAppMetadata;
  build: AppBuildSummary;
  /**
   * The normalized workspace source files (what source.json holds). The
   * install paths use these as the revision's files so a revision always
   * snapshots exactly what was deployed.
   */
  files: Record<string, string>;
};

const APP_WORKER_ENTRY_FILE = '__eternal_worker__.js';
const APP_BACKEND_WRAPPER_FILE = '__eternal_backend__.js';
const APP_RUNTIME_ASSET_FILE = 'eternal-runtime.js';
const APP_WORKSPACE_MANIFEST_FILE = 'workspace.json';
const APP_BUNDLE_FILE = 'bundle.json';
const APP_SOURCE_FILE = 'source.json';
const APP_METADATA_FILE = 'metadata.json';
const APP_PREVIEW_TTL_SECONDS = 60 * 60 * 6;
const MAX_APP_RELEASES = 20;
const MAX_APP_FILES = 100;
const MAX_APP_FILE_NAME_BYTES = 180;
const MAX_APP_FILE_BYTES = 512 * 1024;
const MAX_APP_SOURCE_BYTES = 4 * 1024 * 1024;
const RESERVED_APP_SOURCE_FILES = new Set([
  APP_WORKER_ENTRY_FILE,
  APP_RUNTIME_ASSET_FILE,
  APP_BACKEND_WRAPPER_FILE,
]);

const APP_BUILD_STAGE_LABELS: Record<AppBuildStageKey, string> = {
  'prepare-workspace': 'Preparing workspace',
  'bundle-worker': 'Bundling worker runtime',
  'write-storage': 'Writing app files',
  'install-desktop': 'Installing on desktop',
};

/**
 * What the generator is asked to produce. `permissions` is a declaration of
 * requested capabilities; the user grants a subset when the app first opens.
 */
const permissionsSchema = z.object({
  fs: z.object({
    read: z.array(z.string().min(1).max(200)).max(20).optional(),
    write: z.array(z.string().min(1).max(200)).max(20).optional(),
    delete: z.array(z.string().min(1).max(200)).max(20).optional(),
    mimeTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
  }).optional(),
  profile: z.object({
    read: z.array(z.enum(['username', 'displayName', 'bio', 'avatar'])).max(4).optional(),
  }).optional(),
  network: z.object({
    outbound: z.array(z.string().regex(/^(?:\*|(?:\*\.)?[A-Za-z0-9.-]+)$/).max(300)).max(20).optional(),
  }).optional(),
  ipc: z.object({
    listen: z.array(z.string().min(1).max(120)).max(50).optional(),
    emit: z.array(z.string().min(1).max(120)).max(50).optional(),
  }).optional(),
  handlers: z.object({
    mimeTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
    extensions: z.array(z.string().min(1).max(30)).max(20).optional(),
  }).optional(),
}).optional();

const generatedAppFilesSchema = z.object({
  files: z.record(z.string(), z.string()).refine(
    (files) => Object.keys(files).length > 0,
    'At least one source file is required',
  ),
});

const APP_BUILD_TIMEOUT_MS = {
  desktopSummary: 5_000,
  specGeneration: 90_000,
  fileGeneration: 120_000,
  bundling: 30_000,
  storageWrite: 15_000,
  desktopInstall: 15_000,
} as const;

/**
 * Owner-trusted call into an installed app's backend facet (agent / Code
 * Mode). Ownership is checked against the app registry; the capability gate
 * the iframe goes through is not needed because the caller IS the owner.
 */
export async function callAppBackend(
  env: Env,
  uid: string,
  input: { appId: string; method?: string; path: string; body?: unknown },
): Promise<{ status: number; ok: boolean; data: unknown }> {
  const resolved = await resolveInstalledAppBackend(env, input.appId);
  if (!resolved || resolved.ownerUid !== uid) {
    throw new Error(`App ${input.appId} not found`);
  }
  const rawPath = input.path.startsWith('/') ? input.path : `/${input.path}`;
  const path = rawPath === '/api' || rawPath.startsWith('/api/') || rawPath.startsWith('/api?') ? rawPath : `/api${rawPath}`;
  const method = (input.method ?? 'GET').toUpperCase();
  const hasBody = input.body !== undefined && !['GET', 'HEAD', 'DELETE'].includes(method);
  const request = new Request(`https://app.internal${path}`, {
    method,
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(input.body) : undefined,
  });
  const response = await env.APP_RUNNER.getByName(appRunnerName('app', input.appId)).handle(request, resolved.config);
  const text = await response.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* plain text body */ }
  if (typeof data === 'string' && data.length > 20_000) data = `${data.slice(0, 20_000)}…`;
  return { status: response.status, ok: response.ok, data };
}

/** Drop a full-stack app's facet database + logs. No-op for static apps. */
export async function purgeAppBackend(env: Env, appId: string): Promise<void> {
  await env.APP_RUNNER.getByName(appRunnerName('app', appId)).purge();
}

async function listR2Prefix(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ETERNALOS_FILES.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.ETERNALOS_FILES.list({ prefix, cursor });
    await Promise.allSettled(page.objects.map((object) => env.ETERNALOS_FILES.delete(object.key)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function getNextAppVersion(env: Env, uid: string, appId: string, currentVersion: number): Promise<number> {
  const metadataKeys = (await listR2Prefix(env, `apps/${uid}/${appId}/`))
    .filter((key) => key.endsWith(`/${APP_METADATA_FILE}`) || key === `apps/${uid}/${appId}/${APP_METADATA_FILE}`);
  let highestVersion = currentVersion;
  for (const key of metadataKeys) {
    const object = await env.ETERNALOS_FILES.get(key);
    if (!object) continue;
    const metadata = await object.json<{ version?: number }>().catch(() => null);
    if (metadata?.version && Number.isInteger(metadata.version)) {
      highestVersion = Math.max(highestVersion, metadata.version);
    }
  }
  return highestVersion + 1;
}

async function pruneAppReleases(env: Env, uid: string, appId: string, currentPrefix: string): Promise<void> {
  const metadataKeys = (await listR2Prefix(env, `apps/${uid}/${appId}/`))
    .filter((key) => key.endsWith(`/${APP_METADATA_FILE}`) || key === `apps/${uid}/${appId}/${APP_METADATA_FILE}`);
  const releases: Array<{ version: number; r2Prefix: string }> = [];
  for (const key of metadataKeys) {
    const object = await env.ETERNALOS_FILES.get(key);
    if (!object) continue;
    const metadata = await object.json<{ version?: number; r2Prefix?: string }>().catch(() => null);
    const r2Prefix = metadata?.r2Prefix || key.slice(0, -`/${APP_METADATA_FILE}`.length);
    if (metadata?.version && Number.isInteger(metadata.version)) releases.push({ version: metadata.version, r2Prefix });
  }
  releases.sort((left, right) => right.version - left.version);
  const keep = new Set([
    currentPrefix,
    ...releases.slice(0, Math.max(0, MAX_APP_RELEASES - 1)).map((release) => release.r2Prefix),
  ]);
  const stale = Array.from(new Set(releases.map((release) => release.r2Prefix))).filter((prefix) => !keep.has(prefix));
  await Promise.all(stale.map((prefix) => deleteR2Prefix(env, prefix)));
}

async function cleanupExpiredPreviewObjects(env: Env, uid: string): Promise<void> {
  const metadataKeys = (await listR2Prefix(env, `app-previews/${uid}/`))
    .filter((key) => key.endsWith(`/${APP_METADATA_FILE}`));
  await Promise.all(metadataKeys.map(async (key) => {
    const object = await env.ETERNALOS_FILES.get(key);
    if (!object) return;
    const metadata = await object.json<{ expiresAt?: number }>().catch(() => null);
    if (metadata?.expiresAt && metadata.expiresAt < Date.now()) {
      await deleteR2Prefix(env, key.slice(0, -`/${APP_METADATA_FILE}`.length));
    }
  }));
}

function getAppReleasePrefix(prefix: string, version: number): string {
  return `${prefix.replace(/\/v\d+$/, '')}/v${version}`;
}

function parseGeneratedJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('AI returned invalid JSON');
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function generateStructuredObject<T>(
  env: Env,
  schema: z.ZodType<T>,
  system: string,
  prompt: string,
  step: string,
  timeoutMs: number,
): Promise<T> {
  const model = getAppBuilderModel(env);
  try {
    const { object } = await withStepTimeout(
      step,
      timeoutMs,
      generateObject({ model, schema, system, prompt }),
    );
    return schema.parse(object);
  } catch (structuredError) {
    const { text } = await withStepTimeout(
      `${step} fallback`,
      timeoutMs,
      generateText({
        model,
        system: `${system}\nReturn only one valid JSON object. Do not use markdown fences or explanatory text.`,
        prompt,
        maxOutputTokens: 24_000,
      }),
    );

    try {
      return schema.parse(parseGeneratedJson(text));
    } catch (fallbackError) {
      const firstError = structuredError instanceof Error ? structuredError.message : String(structuredError);
      const secondError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${step} failed: ${firstError}; fallback failed: ${secondError}`);
    }
  }
}

async function withStepTimeout<T>(
  step: string,
  timeoutMs: number,
  work: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${step} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function isCapacityExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('3040') || /capacity temporarily exceeded/i.test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCapacityRetry(attempt: number): Promise<void> {
  const baseDelayMs = [1_500, 4_000, 8_000][attempt] ?? 12_000;
  const jitterMs = Math.floor(Math.random() * 750);
  await sleep(baseDelayMs + jitterMs);
}

async function getNextDesktopGridPosition(stub: DurableObjectStub): Promise<{ x: number; y: number }> {
  const snapshotRes = await stub.fetch(new Request('http://internal/items'));
  if (!snapshotRes.ok) {
    return { x: 0, y: 0 };
  }

  const snapshot = await snapshotRes.json<{ items: DesktopItem[] }>();
  const rootItems = snapshot.items.filter((item) => item.parentId === null && !item.isTrashed);
  const nextY = rootItems.length > 0
    ? Math.max(...rootItems.map((item) => Number(item.position?.y) || 0)) + 1
    : 0;

  return { x: 0, y: nextY };
}

interface RegisteredDesktopApp {
  item: DesktopItem;
  metadata: AgentAppRegistryMeta;
}

/**
 * Registry record shape (`app:{appId}` in KV) as the agent update flow reads
 * and restores it — the shared fields plus the revision pointers this module
 * now writes (see routes/appRevisions.ts).
 */
type AgentAppRegistryMeta = AppRevisionPointers & {
  uid: string;
  version: number;
  granted?: AppGrantedPermissions;
  r2Prefix?: string;
};

async function getRegisteredDesktopApp(
  env: Env,
  uid: string,
  appId: string,
): Promise<RegisteredDesktopApp> {
  const metadata = await env.DESKTOP_KV.get<RegisteredDesktopApp['metadata']>(`app:${appId}`, 'json');
  if (!metadata || metadata.uid !== uid) {
    throw new Error(`App ${appId} not found`);
  }

  const stub = env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid));
  const response = await stub.fetch(new Request('http://internal/items'));
  if (!response.ok) {
    throw new Error(`Failed to load app ${appId}`);
  }
  const items = (await response.json<{ items: DesktopItem[] }>()).items;
  const item = items.find((candidate) => candidate.type === 'app' && candidate.appManifest?.appId === appId && !candidate.isTrashed);
  if (!item) {
    throw new Error(`App ${appId} is not installed on the desktop`);
  }

  return { item, metadata };
}

function getAppBuilderModel(env: Env) {
  const workersAI = createWorkersAI({ binding: env.AI });
  const modelId = env.APP_BUILDER_MODEL?.startsWith('@cf/')
    ? env.APP_BUILDER_MODEL
    : '@cf/zai-org/glm-4.7-flash';
  return workersAI(modelId as Parameters<typeof workersAI>[0]);
}


function createBuildTracker() {
  const orderedStages = Object.keys(APP_BUILD_STAGE_LABELS) as AppBuildStageKey[];
  const startedAt = Date.now();
  const completedStages = new Set<AppBuildStageKey>();
  let currentStage: AppBuildStageKey | 'ready' = orderedStages[0];

  const snapshot = (stage: AppBuildStageKey | 'ready' = currentStage, completedAt = Date.now()): AppBuildSummary => ({
    currentStage: stage,
    stages: orderedStages.map((key) => ({
      key,
      label: APP_BUILD_STAGE_LABELS[key],
      status: completedStages.has(key)
        ? 'completed'
        : stage !== 'ready' && key === stage
          ? 'current'
          : 'pending',
    })),
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
  });

  return {
    currentStageLabel(): string {
      return currentStage === 'ready' ? 'Ready' : APP_BUILD_STAGE_LABELS[currentStage];
    },
    markCompleted(stage: AppBuildStageKey) {
      completedStages.add(stage);
      const nextStage = orderedStages[orderedStages.indexOf(stage) + 1];
      currentStage = nextStage ?? 'ready';
    },
    success(): AppBuildSummary {
      currentStage = 'ready';
      return snapshot('ready');
    },
  };
}

function wrapBuildError(error: unknown, tracker: ReturnType<typeof createBuildTracker>): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('Build failed during ')) {
    return error instanceof Error ? error : new Error(message);
  }
  const wrapped = new Error(`Build failed during ${tracker.currentStageLabel()}: ${message}`);
  // Preserve the structured issues so the repair loop can feed the full
  // checklist back into the regeneration prompt.
  if (error instanceof AppValidationError) {
    return new AppValidationError(error.issues, wrapped.message);
  }
  return wrapped;
}

function selectHtmlEntry(files: Record<string, string>): string {
  return files['index.html']
    ? 'index.html'
    : files['app.html']
      ? 'app.html'
      : files['html']
        ? 'html'
        : Object.keys(files).find((name) => name.endsWith('.html')) || 'index.html';
}

function selectDefaultCssEntry(files: Record<string, string>): string | undefined {
  return files['styles.css']
    ? 'styles.css'
    : files['style.css']
      ? 'style.css'
      : files['app.css']
        ? 'app.css'
        : files['css']
          ? 'css'
          : Object.keys(files).find((name) => name.endsWith('.css'));
}

function selectDefaultJsEntry(files: Record<string, string>): string | undefined {
  return files['app.js']
    ? 'app.js'
    : files['script.js']
      ? 'script.js'
      : files['main.js']
        ? 'main.js'
        : files['index.js']
          ? 'index.js'
          : files['js']
            ? 'js'
            : Object.keys(files).find((name) => name.endsWith('.js') || name.endsWith('.mjs'));
}

export function createAppWorkspace(files: Record<string, string>): AppWorkspace {
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > MAX_APP_FILES) {
    throw new AppValidationError([{
      code: 'source/file-count',
      message: `App source must contain between 1 and ${MAX_APP_FILES} files`,
      hint: `Send between 1 and ${MAX_APP_FILES} source files.`,
    }]);
  }

  const normalizedFiles: Record<string, string> = {};
  let totalBytes = 0;
  for (const [rawName, rawContent] of entries) {
    const name = rawName.replace(/^\/+/, '').trim();
    const content = String(rawContent);
    const segments = name.split('/');
    if (!name || name.length > MAX_APP_FILE_NAME_BYTES || segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
      throw new AppValidationError([{
        code: 'source/invalid-filename',
        message: `Invalid app source filename "${rawName}"`,
        hint: 'Use plain relative names such as "index.html", "styles.css", or "assets/logo.png".',
      }]);
    }
    if (name in normalizedFiles) {
      throw new AppValidationError([{
        code: 'source/duplicate-filename',
        message: `Duplicate app source filename "${name}"`,
        hint: 'Send each file exactly once.',
      }]);
    }

    const fileBytes = new TextEncoder().encode(content).byteLength;
    if (fileBytes > MAX_APP_FILE_BYTES) {
      throw new AppValidationError([{
        code: 'source/file-too-large',
        message: `App source file "${name}" exceeds the ${MAX_APP_FILE_BYTES / 1024}KB limit`,
        hint: 'Split large data out of the bundle or shrink the file.',
      }]);
    }
    totalBytes += fileBytes;
    if (totalBytes > MAX_APP_SOURCE_BYTES) {
      throw new AppValidationError([{
        code: 'source/source-too-large',
        message: `App source exceeds the ${MAX_APP_SOURCE_BYTES / 1024 / 1024}MB limit`,
        hint: 'Send fewer or smaller files.',
      }]);
    }
    normalizedFiles[name] = content;
  }

  for (const reserved of RESERVED_APP_SOURCE_FILES) {
    if (reserved in normalizedFiles) {
      throw new AppValidationError([{
        code: 'source/reserved-filename',
        message: `Source file name "${reserved}" is reserved by the app runtime`,
        hint: 'Remove the file — the platform injects its own runtime assets with those names.',
      }]);
    }
  }

  const { frontend: frontendFiles } = splitBackendFiles(normalizedFiles);
  const hasBackend = APP_BACKEND_ENTRY_FILE in normalizedFiles;
  const entryHtml = selectHtmlEntry(frontendFiles);
  if (!(entryHtml in normalizedFiles)) {
    throw new AppValidationError([{
      code: 'entry/no-html',
      message: 'App bundle must include at least one HTML entry file',
      hint: 'Include an index.html (or another *.html entry).',
    }]);
  }

  return {
    files: normalizedFiles,
    manifest: {
      version: 1,
      profile: hasBackend ? 'fullstack' : 'static-html',
      entryHtml,
      sourceFiles: Object.keys(normalizedFiles).sort(),
      runtimeAsset: APP_RUNTIME_ASSET_FILE,
      workerEntrypoint: APP_WORKER_ENTRY_FILE,
      ...(hasBackend ? { backendEntry: APP_BACKEND_ENTRY_FILE } : {}),
    },
  };
}

function normalizeGeneratedFiles(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files)
      .map(([name, content]) => [name.replace(/^\/+/, '').trim(), String(content)] as const)
      .filter(([name, content]) => name.length > 0 && content.length > 0),
  );
}

/**
 * Assemble the app the manifest will record from the validated spec and the
 * generated files. The manifest permissions are DERIVED from the spec here —
 * the file generator does not declare any — so the permissions the bundle
 * gates enforce are by construction the ones the spec planned.
 */
function normalizeAppFromSpec(spec: AppSpec, files: Record<string, string>): AppBundleInput {
  const normalizedFiles = normalizeGeneratedFiles(files);
  createAppWorkspace(normalizedFiles);

  return {
    name: spec.name.trim() || 'Untitled App',
    description: spec.purpose.trim(),
    width: Math.min(1600, Math.max(360, spec.width)),
    height: Math.min(1200, Math.max(320, spec.height)),
    files: normalizedFiles,
    permissions: derivePermissionsFromSpec(spec),
    rationale: spec.rationale?.trim() || undefined,
  };
}

/**
 * Attribute a full-source pattern match to the file that contains it (files
 * walked in sorted order for determinism). Purely informational — the gate's
 * accept/reject decision stays on the joined source, so a pattern that only
 * matches across a file boundary still rejects, just without a file attached
 * (and the repair loop then regenerates in full instead of patching).
 */
function findMatchingFile(files: Record<string, string>, pattern: RegExp): string | undefined {
  for (const name of Object.keys(files).sort()) {
    if (pattern.test(files[name])) return name;
  }
  return undefined;
}

/**
 * Pre-bundle source gate. Throws {@link AppValidationError} with one issue per
 * rejection so every client-supplied bad bundle maps to HTTP 400
 * deterministically (`instanceof` check in routes/apps.ts) and the repair
 * loop can format the issue. The thrown `message` is unchanged from the
 * historical strings — existing tests and the dev-deploy status mapping match
 * on them. Pattern-matched issues carry the file that triggered them so the
 * targeted repair pass can patch just that file.
 */
export function validateGeneratedApp(app: AppBundleInput): void {
  // Browser-sandbox gates apply to what ships to the iframe. server.js and
  // server/* run in the Worker facet and are checked by checkBackend().
  const files = splitBackendFiles(app.files).frontend;
  const htmlFiles = Object.entries(files).filter(([name]) => name.endsWith('.html') || name === 'html');
  if (htmlFiles.length === 0) {
    throw new AppValidationError([{
      code: 'entry/no-html',
      message: 'App bundle must include at least one HTML file',
      hint: 'Include an index.html (or another *.html entry).',
    }]);
  }

  const fullSource = Object.values(files).join('\n');
  // `(?:https?:)?\/\/` catches protocol-relative URLs (`//evil.com/x`) too, not
  // just explicit http(s) — otherwise `<script src="//evil.com/app.js">` slips
  // past this check (the served CSP's `script-src 'self'` still blocks it at
  // runtime, so this is defense-in-depth, but the check should match its intent).
  const forbiddenPatterns: Array<{ code: string; pattern: RegExp; message: string; hint?: string }> = [
    {
      code: 'source/external-script',
      pattern: /<script[^>]+src=["'](?:https?:)?\/\//i,
      message: 'External script URLs are not allowed',
      hint: 'Bundle the script as a local file and reference it with a relative path.',
    },
    {
      code: 'source/external-stylesheet',
      pattern: /<link[^>]+href=["'](?:https?:)?\/\//i,
      message: 'External stylesheet URLs are not allowed',
      hint: 'Bundle the stylesheet as a local file and reference it with a relative path.',
    },
    {
      code: 'source/external-dynamic-import',
      pattern: /\bimport\s*\(\s*["'`](?:https?:)?\/\//i,
      message: 'Dynamic imports from external URLs are not allowed',
      hint: 'Bundle the module as a local file and import it with a relative path.',
    },
    {
      code: 'source/external-import',
      pattern: /\bfrom\s+["'](?:https?:)?\/\//i,
      message: 'Imports from external URLs are not allowed',
      hint: 'Bundle the module as a local file and import it with a relative path.',
    },
  ];

  for (const { pattern, code, message, hint } of forbiddenPatterns) {
    if (pattern.test(fullSource)) {
      throw new AppValidationError([{ code, message, hint, file: findMatchingFile(files, pattern) }]);
    }
  }

  const fsReadPattern = /\b(?:window\.)?eternal\.fs\.(?:list|read|readText|readJson|urlFor)\s*\(/;
  const fsWritePattern = /\b(?:window\.)?eternal\.fs\.(?:write|patch)\s*\(/;
  const fsDeletePattern = /\b(?:window\.)?eternal\.fs\.delete\s*\(/;
  const profilePattern = /\b(?:window\.)?eternal\.profile\./;
  const networkPattern = /\b(?:window\.)?eternal\.fetch\s*\(/;
  const ipcEmitPattern = /\b(?:window\.)?eternal\.ipc\.emit\s*\(/;
  const ipcListenPattern = /\b(?:window\.)?eternal\.ipc\.on\s*\(/;
  const usesFsRead = fsReadPattern.test(fullSource);
  const usesFsWrite = fsWritePattern.test(fullSource);
  const usesFsDelete = fsDeletePattern.test(fullSource);
  const usesProfile = profilePattern.test(fullSource);
  const usesNetwork = networkPattern.test(fullSource);
  const usesIpcEmit = ipcEmitPattern.test(fullSource);
  const usesIpcListen = ipcListenPattern.test(fullSource);

  if (usesFsRead && !(app.permissions?.fs?.read?.length || app.permissions?.fs?.mimeTypes?.length)) {
    throw new AppValidationError([{
      code: 'permission/undeclared-fs-read',
      message: 'App reads through window.eternal.fs but did not declare fs read permissions',
      hint: 'Declare fs: { read: [...] } or fs: { mimeTypes: [...] } in the manifest permissions.',
      file: findMatchingFile(files, fsReadPattern),
    }]);
  }
  if (usesFsWrite && !app.permissions?.fs?.write?.length) {
    throw new AppValidationError([{
      code: 'permission/undeclared-fs-write',
      message: 'App writes through window.eternal.fs but did not declare fs write permissions',
      hint: 'Declare fs: { write: [...] } in the manifest permissions.',
      file: findMatchingFile(files, fsWritePattern),
    }]);
  }
  if (usesFsDelete && !app.permissions?.fs?.delete?.length) {
    throw new AppValidationError([{
      code: 'permission/undeclared-fs-delete',
      message: 'App deletes through window.eternal.fs but did not declare fs delete permissions',
      hint: 'Declare fs: { delete: [...] } in the manifest permissions.',
      file: findMatchingFile(files, fsDeletePattern),
    }]);
  }
  if (usesProfile && !app.permissions?.profile?.read?.length) {
    throw new AppValidationError([{
      code: 'permission/undeclared-profile',
      message: 'App uses window.eternal.profile but did not declare profile permissions',
      hint: "Declare profile: { read: ['username', 'displayName', …] } in the manifest permissions.",
      file: findMatchingFile(files, profilePattern),
    }]);
  }
  if (usesNetwork && !app.permissions?.network?.outbound?.length) {
    throw new AppValidationError([{
      code: 'permission/undeclared-network',
      message: 'App uses window.eternal.fetch but did not declare network permissions',
      hint: "Declare network: { outbound: ['api.example.com'] } in the manifest permissions.",
      file: findMatchingFile(files, networkPattern),
    }]);
  }
  if (usesIpcEmit && !app.permissions?.ipc?.emit?.length) {
    throw new AppValidationError([{
      code: 'permission/undeclared-ipc-emit',
      message: 'App emits IPC messages but did not declare ipc emit permissions',
      hint: 'Declare ipc: { emit: [topic] } in the manifest permissions.',
      file: findMatchingFile(files, ipcEmitPattern),
    }]);
  }
  if (usesIpcListen && !app.permissions?.ipc?.listen?.length) {
    throw new AppValidationError([{
      code: 'permission/undeclared-ipc-listen',
      message: 'App listens for IPC messages but did not declare ipc listen permissions',
      hint: 'Declare ipc: { listen: [topic] } in the manifest permissions.',
      file: findMatchingFile(files, ipcListenPattern),
    }]);
  }

  const knownAssets = new Set([...Object.keys(files), APP_RUNTIME_ASSET_FILE]);
  const assetRefPattern = /\b(?:src|href)=["']([^"']+)["']/gi;
  for (const [fileName, html] of htmlFiles) {
    let match: RegExpExecArray | null;
    while ((match = assetRefPattern.exec(html)) !== null) {
      const ref = match[1].trim();
      if (
        ref.length === 0 ||
        ref.startsWith('http://') ||
        ref.startsWith('https://') ||
        ref.startsWith('data:') ||
        ref.startsWith('mailto:') ||
        ref.startsWith('javascript:') ||
        ref.startsWith('#') ||
        ref.startsWith('/')
      ) {
        continue;
      }

      const normalizedRef = ref.replace(/^\.\//, '').replace(/^\//, '');
      if (!knownAssets.has(normalizedRef)) {
        throw new AppValidationError([{
          code: 'asset/missing',
          file: fileName,
          message: `Missing local asset "${ref}" referenced from ${fileName}`,
          hint: 'Add the file to the bundle or remove the reference.',
        }]);
      }
    }
  }
}

/**
 * Short, LLM-facing summary of the user's desktop. Intentionally compact —
 * enough signal for the builder to pick sensible defaults and produce
 * believable placeholders, not enough to leak PII into every prompt.
 */
interface DesktopSummary {
  totalActiveItems: number;
  counts: Record<string, number>;
  hasPhotos: boolean;
  hasAudio: boolean;
  hasVideo: boolean;
  hasNotes: boolean;
  analyzedImages: number;
  topFolders: Array<{ path: string; count: number; sampleCaptions?: string[] }>;
  sampleTags: string[];
}

function summarizeDesktopForLLM(
  items: DesktopItem[],
  profile: UserProfile | null,
): DesktopSummary {
  const active = items.filter((i) => !i.isTrashed);
  const counts: Record<string, number> = {};
  const tagCounts = new Map<string, number>();
  const folderBuckets = new Map<string, DesktopItem[]>();
  let analyzedImages = 0;

  for (const item of active) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
    if (item.type === 'image' && item.imageAnalysis?.status === 'complete') {
      analyzedImages += 1;
    }
    for (const tag of item.userTags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    for (const tag of item.imageAnalysis?.tags ?? []) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    const parentName = item.parentId
      ? (active.find((p) => p.id === item.parentId)?.name ?? 'Desktop')
      : 'Desktop';
    const path = parentName === 'Desktop' ? '/' : `/${parentName}`;
    if (!folderBuckets.has(path)) folderBuckets.set(path, []);
    folderBuckets.get(path)!.push(item);
  }

  const topFolders = Array.from(folderBuckets.entries())
    .map(([path, entries]) => {
      const sampleCaptions = entries
        .map((e) => e.imageAnalysis?.caption)
        .filter((c): c is string => Boolean(c))
        .slice(0, 3);
      return {
        path,
        count: entries.length,
        sampleCaptions: sampleCaptions.length > 0 ? sampleCaptions : undefined,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const sampleTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag]) => tag);

  return {
    totalActiveItems: active.length,
    counts,
    hasPhotos: (counts.image ?? 0) > 0,
    hasAudio: (counts.audio ?? 0) > 0,
    hasVideo: (counts.video ?? 0) > 0,
    hasNotes: (counts.text ?? 0) > 0,
    analyzedImages,
    topFolders,
    sampleTags,
  };
}

async function loadDesktopSummary(ctx: AppToolsContext): Promise<DesktopSummary | null> {
  try {
    const stub = ctx.env.USER_DESKTOP.get(ctx.env.USER_DESKTOP.idFromName(ctx.agentName));
    const res = await withStepTimeout(
      'Loading desktop summary',
      APP_BUILD_TIMEOUT_MS.desktopSummary,
      stub.fetch(new Request('http://internal/items')),
    );
    if (!res.ok) return null;
    const data = await res.json<{ items: DesktopItem[]; profile: UserProfile | null }>();
    return summarizeDesktopForLLM(data.items, data.profile);
  } catch {
    return null;
  }
}

/**
 * Explicit spec stage ahead of file generation (CORE-ROADMAP Workstream 3,
 * Phase A): ask the build model for a typed AppSpec from the user's prompt
 * BEFORE any file is written, then reject it deterministically when it
 * declares anything the platform cannot derive permissions from. Validation
 * failures throw AppValidationError so the repair loop can feed the exact
 * issue codes back into a spec regeneration prompt.
 */
async function buildSpecFromPrompt(
  env: Env,
  prompt: string,
  desktopSummary: DesktopSummary | null,
  repairContext?: string,
): Promise<AppSpec> {
  const contextBlock = desktopSummary
    ? `User desktop summary:
${JSON.stringify(desktopSummary, null, 2)}`
    : 'Desktop summary not available.';

  const repairBlock = repairContext
    ? `

A previous specification attempt was rejected by deterministic validation. Every problem below is exact — fix each one:
${repairContext}`
    : '';

  const spec = await generateStructuredObject(
    env,
    appSpecSchema,
    APP_SPEC_SYSTEM_PROMPT,
    `Create an app specification for this request:

${prompt}

${contextBlock}${repairBlock}`,
    'Generating app specification',
    APP_BUILD_TIMEOUT_MS.specGeneration,
  );

  const issues = validateAppSpec(spec);
  if (issues.length > 0) {
    throw new AppValidationError(issues);
  }
  return spec;
}

/**
 * Spec stage wired to the existing repair loop: a deterministic spec
 * rejection regenerates with the structured issue codes in the prompt (no
 * delay — these are model-fixable), a capacity error waits and retries, and
 * anything else propagates immediately. The spec must be valid before file
 * generation starts, so the permissions derived from it are exactly the ones
 * the generated files are held to.
 */
async function generateSpecWithRetries(
  ctx: AppToolsContext,
  prompt: string,
  desktopSummary: DesktopSummary | null,
): Promise<AppSpec> {
  let lastError = 'Unknown generation error';
  let repairContext: string | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      emitStage(ctx, 'spec');
      return await buildSpecFromPrompt(ctx.env, prompt, desktopSummary, repairContext);
    } catch (error) {
      if (error instanceof AppValidationError) {
        lastError = repairContext = formatAppValidationIssues(error.issues);
        continue;
      }
      lastError = error instanceof Error ? error.message : String(error);
      if (!isCapacityExceededError(error) || attempt === 2) {
        throw error;
      }
      await waitForCapacityRetry(attempt);
    }
  }

  throw new Error(`Failed to generate a valid app specification: ${lastError}`);
}

/**
 * Bridge API surface shared by the generation and targeted-repair prompts.
 * Kept verbatim-identical between the two so a repaired file is held to the
 * same contract the generator was told about.
 */
const APP_BRIDGE_API_PROMPT = `Available in window.eternal (platform-injected — do not re-implement):
  eternal.fs.list({ path?, mimeType?, limit? })   -> Item[]
  eternal.fs.read(id)       -> Blob
  eternal.fs.readText(id)   -> string
  eternal.fs.readJson(id)   -> object
  eternal.fs.urlFor(id)     -> Promise<string>, always await it, then assign the
                              URL to <img src>/<audio src>/<video src> (a blob:
                              object URL in installed apps, a plain URL in
                              previews)
  eternal.fs.write(options), fs.patch(id, updates), fs.delete(id)
  eternal.profile.get()     -> { username?, displayName?, bio?, avatar? }
  eternal.fetch(url, init?) -> allowlisted proxy response
  eternal.ipc.emit(topic, payload), ipc.on(topic, callback)
  eternal.window.setTitle(s), eternal.window.close(), eternal.window.requestFocus()
  eternal.api.get(path), api.post(path, body), api.put(path, body),
  api.patch(path, body), api.delete(path)  -> parsed JSON from the app's own
                              server.js (throws Error with the server's
                              { error } message on non-2xx). api.fetch(path,
                              init) returns the raw Response. Paths are
                              relative to the backend: api.get('/todos') hits
                              GET /api/todos. Only exists when server.js ships.
  eternal.api.onChange(callback) -> unsubscribe fn; called when the assistant
                              changes this app's backend data while it is
                              open — re-fetch there (without a handler the
                              app is reloaded).

Item shape: { id, name, type, path, mimeType?, fileSize?, updatedAt, isPublic, caption?, tags?, dominantColors?, url? }`;

/**
 * The runtime sandbox contract every generated file is held to. The
 * deterministic post-bundle validator rejects violations of exactly these
 * rules, so the generation and targeted-repair prompts must state them the
 * same way.
 */
const APP_RUNTIME_CONTRACT_PROMPT = `Runtime sandbox contract (violations are rejected by deterministic validation before install):
- The app runs in a sandboxed iframe with an opaque origin. localStorage, sessionStorage, document.cookie, and indexedDB all throw SecurityError. Use window.eternal.storage.get/set/list/delete for persistent state, and plain variables for the rest.
- geolocation, camera/microphone (getUserMedia), and Web Workers/service workers are unavailable — there is no bridge alternative; design around them.
- Direct fetch/XHR/WebSocket/EventSource to absolute external URLs is blocked by the CSP. For external data, call window.eternal.fetch(url) with a host in the derived network.outbound list (the allowlisted proxy). For bundled data, fetch a relative path like './data.json'.
- Only the window.eternal APIs listed above exist. Calling any other namespace or method (e.g. eternal.fs.save, eternal.ai.chat) throws at runtime.
- eternal.fs.urlFor(id) is asynchronous in installed apps. Always capture it with await first (const src = await eternal.fs.urlFor(id); img.src = src). Calling it without awaiting — or interpolating its result into a string or template literal — produces "[object Promise]", not a URL.
- CSS url() and HTML src/href references must point at files included in the bundle.
- import statements must reference bundled local files ('./utils.js') and names those files actually export; bare specifiers like 'lodash' cannot resolve — there is no package manager.
- Static files must not live under api/ — that path is the backend's mount.

Backend contract (server.js — optional; include it when the specification has a backend):
- server.js is a real Cloudflare Worker module running as a Durable Object Facet. It never ships to the browser.
- Shape: export default { async fetch(request, env) { ... return Response.json(data, { status }); } }
- Route on new URL(request.url).pathname, which always starts with /api/ (e.g. '/api/todos', '/api/todos/42'), and on request.method. Return 404 JSON for unknown routes and 400 JSON ({ error }) for bad input. Parse bodies with await request.json() inside try/catch.
- env.sql is the app's own SQLite database (Durable Object SQL API), synchronous:
    env.sql.exec('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)');
    const rows = env.sql.exec('SELECT * FROM todos ORDER BY id DESC').toArray();
    const row = env.sql.exec('INSERT INTO todos (title, created_at) VALUES (?, ?) RETURNING *', title, Date.now()).one();
    env.sql.exec('UPDATE todos SET done = ? WHERE id = ?', done ? 1 : 0, id);
  Always bind values with ? placeholders — never interpolate input into SQL. Run CREATE TABLE IF NOT EXISTS at the top of fetch (cheap, idempotent). Booleans are stored as 0/1.
- env.storage is the async Durable Object storage API on the same database (await env.storage.get(key) / put(key, value) / delete(key)) for small JSON blobs.
- env.desktop.list({ path?, mimeType?, limit? }), env.desktop.readText(id), env.desktop.write({ path, content, mimeType? }) reach the user's desktop under the same derived fs permissions as the frontend.
- Plain fetch(url) works only for hosts in derived network.outbound; everything else is blocked. No window, document, localStorage, or npm packages in the backend. Helper modules go under server/ and are imported relatively ('./server/db.js').
- The frontend talks to it only through eternal.api.* (never raw fetch('/api/...')). Render a loading state while requests are in flight and an error message if a request throws.
- Register eternal.api.onChange(() => reload()) once at startup (reload = your function that re-fetches and re-renders), so records the assistant adds or edits while the app is open appear immediately.`;

async function generateAppFromPrompt(
  env: Env,
  prompt: string,
  spec: AppSpec,
  desktopSummary: DesktopSummary | null,
  previousError?: string,
): Promise<AppBundleInput> {
  const repairContext = previousError
    ? `Previous attempt failed deterministic app validation. Every problem below is exact — fix each one:
${previousError}

Return the corrected, complete app bundle. Keep everything that was already valid; change only what the problems call out.`
    : 'This is the first generation attempt.';

  const contextBlock = desktopSummary
    ? `User's desktop summary (use this to pick sensible defaults and make the app feel personal — but only call the bridge APIs the derived permissions cover):
${JSON.stringify(desktopSummary, null, 2)}`
    : 'Desktop summary not available; design the app as a general-purpose starter.';

  const object = await generateStructuredObject(
    env,
    generatedAppFilesSchema,
    `You generate complete desktop web apps as structured source files for EternalOS.

Apps run in a sandboxed iframe. Direct browser network access is blocked by CSP;
the platform injects a window.eternal bridge that gives apps access to the
user's desktop or an allowlisted network proxy if (and only if) the app's
manifest grants it. Always prefer window.eternal APIs over asking the user
to paste data.

${APP_BRIDGE_API_PROMPT}

Permissions — DERIVED from the app specification by the platform, not declared by you:
  The manifest permissions supplied with the prompt are final. Do not add,
  remove, or re-declare permissions, and do not return a permissions field —
  it is ignored. Use ONLY the bridge APIs the derived permissions cover:
  - eternal.fs.list/read/readText/readJson/urlFor require derived fs
    permissions; list with a path inside a derived fs.read glob or with a
    derived fs.mimeTypes type, otherwise the call silently returns nothing
  - eternal.fs.write/patch require derived fs.write: write only to paths
    inside a derived fs.write glob, otherwise the write is rejected with 403
  - eternal.fs.delete requires derived fs.delete
  - eternal.profile.get requires derived profile.read fields
  - eternal.fetch requires the URL's host to be in derived network.outbound
  - eternal.ipc.emit/on require the topic in derived ipc.emit/listen
  - eternal.storage.get/set/list/delete need no permission (private per-app)
  Without derived fs write/delete scopes, do not write or delete desktop
  files — persist state with eternal.storage instead. If the derived
  permissions are empty, the app runs hermetic: use only plain variables and
  eternal.storage.

Rules for files:
- Return a COMPLETE app bundle: at minimum index.html, styles.css, app.js
- When the specification has a backend, ALSO return server.js implementing every listed route and creating every listed table; the frontend must load and save its records through eternal.api.* so data persists server-side
- Do NOT include eternal-runtime.js — the platform auto-injects it
- Do NOT load external CDNs, fonts, or images
- Reference local assets with relative paths: ./styles.css, ./app.js
- Use standard browser APIs and window.eternal only — no npm packages
- Output production-ready HTML/CSS/JS. No markdown fences, no placeholder "// TODO" stubs
- Handle the empty case gracefully: eternal.fs.list() returns [] until the user grants permission, and every data-driven screen must implement the empty state its specification declares
- Wrap fetches in try/catch so a permission denial or empty desktop doesn't crash the UI
- Match the supplied app specification exactly for name, purpose, screens, and window size

${APP_RUNTIME_CONTRACT_PROMPT}`,
    `Build a desktop web app for this request:

${prompt}

App specification:
${JSON.stringify(spec, null, 2)}

Manifest permissions (derived from the specification by the platform — final; use only bridge APIs these cover):
${JSON.stringify(derivePermissionsFromSpec(spec), null, 2)}

${contextBlock}

${repairContext}`,
    'Generating app files',
    APP_BUILD_TIMEOUT_MS.fileGeneration,
  );

  // Pre-bundle validation runs in the retry loop (generateAppWithRepairLoop),
  // right after the generated files are captured, so a source-gate failure
  // can be repaired by patching the files it names.
  return normalizeAppFromSpec(spec, object.files);
}

function emitStage(ctx: AppToolsContext, stage: keyof typeof REAL_BUILD_STAGES): void {
  if (ctx.toolCallId) {
    ctx.onBuildStage?.(ctx.toolCallId, stage, REAL_BUILD_STAGES[stage]);
  }
}

/**
 * Repair-prompt context for a failed build: the full formatted issue
 * checklist when the failure is deterministic validation (so one pass can
 * fix every problem at once), the raw message otherwise.
 */
function buildRepairContext(error: unknown): string {
  if (error instanceof AppValidationError) {
    return formatAppValidationIssues(error.issues);
  }
  return errorText(error);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Files a targeted repair pass would have to patch: every validation issue
 * must name a file that exists in the failed attempt's bundle. Returns null
 * (and the loop regenerates in full) when any issue is file-less — those are
 * either bundle-shape problems (no HTML, file limits, compiled-bundle
 * contracts) or protocol failures a source patch cannot reach.
 */
function targetedRepairFiles(
  issues: readonly AppValidationIssue[] | undefined,
  files: Record<string, string> | undefined,
): string[] | null {
  if (!issues || issues.length === 0 || !files) return null;
  const failing = new Set<string>();
  for (const issue of issues) {
    if (!issue.file || !(issue.file in files)) return null;
    failing.add(issue.file);
  }
  return Array.from(failing).sort();
}

/**
 * Targeted repair (CORE-ROADMAP Workstream 3, Phase C). A validation failure
 * names concrete files, so the repair attempt is targeted: the model receives
 * ONLY the failing files (full contents) plus the structured issues, and
 * returns patched versions of exactly those files. The patches are merged
 * into the previous bundle and revalidated through the same gates — no blind
 * full regeneration, no re-derivation of what already validated clean.
 */
const APP_REPAIR_SYSTEM_PROMPT = `You repair EternalOS desktop apps by patching the exact source files named in the request.

Hard rules:
- Return ONLY complete patched versions of the files listed in the request — same names, full file contents, nothing else. The rest of the bundle is already valid and is kept exactly as-is.
- Never add, rename, or drop files. If a fix seems to need a new file, restructure a listed file instead (remove the reference, inline the code, or fix the path).
- Change only what the validation issues require; keep everything that already works.
- The manifest permissions are DERIVED from the app specification and final — you cannot declare, add, or widen them. For permission issues, fix the code: call only the bridge APIs the derived permissions cover, or use eternal.storage (private per-app state, no permission needed).
- No markdown fences, no placeholder stubs, no explanations — just the files.

${APP_BRIDGE_API_PROMPT}

${APP_RUNTIME_CONTRACT_PROMPT}`;

async function generateTargetedAppRepair(
  env: Env,
  spec: AppSpec,
  previousFiles: Record<string, string>,
  failingFiles: string[],
  issues: readonly AppValidationIssue[],
): Promise<AppBundleInput> {
  const fileBlocks = failingFiles
    .map((name) => `--- ${name} (current content) ---\n${previousFiles[name]}`)
    .join('\n\n');

  const object = await generateStructuredObject(
    env,
    generatedAppFilesSchema,
    APP_REPAIR_SYSTEM_PROMPT,
    `Repair the app "${spec.name}" — it failed deterministic validation.

App specification:
${JSON.stringify(spec, null, 2)}

Manifest permissions (derived from the specification by the platform — final; the patch must stay inside them):
${JSON.stringify(derivePermissionsFromSpec(spec), null, 2)}

Files to patch (current contents):
${fileBlocks}

Deterministic validation issues (every one is exact — fix each):
${formatAppValidationIssues(issues)}

Return { "files": { "<name>": "<full patched content>" } } with exactly the files listed under "Files to patch".`,
    'Repairing app files',
    APP_BUILD_TIMEOUT_MS.fileGeneration,
  );

  // A targeted patch may only rewrite the failing files. Anything else the
  // model returns (a renamed file, a brand-new file) cannot be merged
  // blindly — reject the patch and let the loop fall back to a full
  // regeneration.
  const patched = normalizeGeneratedFiles(object.files);
  const requested = new Set(failingFiles);
  const unrequested = Object.keys(patched).filter((name) => !requested.has(name));
  if (unrequested.length > 0 || Object.keys(patched).length === 0) {
    throw new AppValidationError([{
      code: 'repair/invalid-patch',
      file: unrequested[0],
      message: unrequested.length > 0
        ? `Targeted repair returned "${unrequested[0]}", which is not one of the failing files`
        : 'Targeted repair returned no files',
      hint: 'Return complete patched versions of only the failing files listed in the prompt; the rest of the bundle stays unchanged.',
    }]);
  }

  return normalizeAppFromSpec(spec, { ...previousFiles, ...patched });
}

/**
 * Generation + repair loop shared by the build and preview tools. The
 * existing attempt budget is unchanged (3): the first attempt generates in
 * full; the second attempt is a TARGETED repair pass when every issue of the
 * first failure names a file (only the failing files plus the structured
 * issues are fed back, and just those files are patched into the bundle);
 * the final attempt falls back to today's full regeneration for anything a
 * targeted patch cannot converge on.
 */
async function generateAppWithRepairLoop<T>(
  ctx: AppToolsContext,
  prompt: string,
  spec: AppSpec,
  desktopSummary: DesktopSummary | null,
  finalize: (app: AppBundleInput) => Promise<T>,
  failureNoun: string,
): Promise<{ app: AppBundleInput; result: T }> {
  let lastError = 'Unknown generation error';
  let lastIssues: readonly AppValidationIssue[] | undefined;
  let lastFiles: Record<string, string> | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let attemptFiles: Record<string, string> | undefined;
    try {
      emitStage(ctx, 'codegen');
      const repairFiles = attempt === 1 ? targetedRepairFiles(lastIssues, lastFiles) : null;
      const app = repairFiles
        ? await generateTargetedAppRepair(ctx.env, spec, lastFiles!, repairFiles, lastIssues!)
        : await generateAppFromPrompt(
          ctx.env,
          prompt,
          spec,
          desktopSummary,
          attempt > 0 ? lastError : undefined,
        );
      attemptFiles = app.files;
      // Pre-bundle source gate — runs with the generated files captured, so
      // its failures can be repaired by patching the files they name.
      validateGeneratedApp(app);
      return { app, result: await finalize(app) };
    } catch (error) {
      const isBundleValidation = error instanceof AppValidationError
        && error.issues.some((issue) => !issue.code.startsWith('repair/'));
      if (isBundleValidation) {
        lastError = buildRepairContext(error);
        lastIssues = error.issues;
        lastFiles = attemptFiles;
      } else if (error instanceof AppValidationError && lastIssues !== undefined) {
        // Targeted-patch protocol failure (repair/*): the underlying bundle
        // issues stay the authoritative repair context — a bad patch says
        // nothing about the app itself.
      } else {
        lastError = buildRepairContext(error);
        lastIssues = undefined;
        lastFiles = undefined;
      }
      if (isCapacityExceededError(error) && attempt < 2) {
        await waitForCapacityRetry(attempt);
      }
    }
  }

  if (isCapacityExceededError(lastError)) {
    throw new Error('Cloudflare Workers AI is temporarily out of capacity for Kimi. Please retry in a minute.');
  }

  throw new Error(`Failed to generate a working ${failureNoun} after multiple attempts: ${lastError}`);
}

async function buildAppFromPromptWithRetries(
  ctx: AppToolsContext,
  prompt: string,
): Promise<{ appId: string; itemId: string; name: string; status: 'created'; revision: string; permissions?: AppPermissions }> {
  const desktopSummary = await loadDesktopSummary(ctx);
  const spec = await generateSpecWithRetries(ctx, prompt, desktopSummary);
  const { app, result } = await generateAppWithRepairLoop(
    ctx,
    prompt,
    spec,
    desktopSummary,
    (generated) => createAndRegisterApp(ctx, generated),
    'app',
  );
  return { ...result, permissions: app.permissions };
}

async function writeAppArtifact(
  ctx: AppToolsContext,
  input: AppBundleInput,
  artifactId: string,
  r2Prefix: string,
  mountBasePath: '/api/apps' | '/api/app-previews',
  tracker: ReturnType<typeof createBuildTracker>,
  options?: { expiresAt?: number },
): Promise<AppArtifactBuildResult> {
  const { env, agentName: uid } = ctx;
  const workspace = createAppWorkspace(input.files);
  tracker.markCompleted('prepare-workspace');

  emitStage(ctx, 'bundle');
  const workerFiles = createWorkerModuleFiles(workspace, mountBasePath);
  const { mainModule, modules } = await withStepTimeout(
    'Bundling app worker',
    APP_BUILD_TIMEOUT_MS.bundling,
    createWorker({
      files: {
        ...workerFiles,
        [APP_WORKER_ENTRY_FILE]: workerFiles[APP_WORKER_ENTRY_FILE].replaceAll('__APP_ID__', artifactId),
      },
      entryPoint: APP_WORKER_ENTRY_FILE,
    }),
  );
  tracker.markCompleted('bundle-worker');

  // Deterministic post-bundle validation: the compiled artifact is checked
  // against the runtime contract (bridge surface, declared-permission
  // coverage, asset packaging, sandbox availability, compiled entrypoint)
  // before anything is persisted or installed. Collects every issue at once
  // so a failed build can be repaired in a single regeneration.
  assertAppBundleValid({
    files: workspace.files,
    manifest: workspace.manifest,
    permissions: input.permissions,
    compiled: { mainModule, modules },
  });

  const now = Date.now();
  const metadata: StoredAppMetadata = {
    id: artifactId,
    uid,
    name: input.name,
    description: input.description,
    width: input.width,
    height: input.height,
    permissions: input.permissions,
    rationale: input.rationale,
    granted: {},
    version: 1,
    r2Prefix,
    createdAt: now,
    expiresAt: options?.expiresAt,
  };

  emitStage(ctx, 'storage');
  const bundle = JSON.stringify({ mainModule, modules });
  await withStepTimeout(
    'Writing app bundle',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_BUNDLE_FILE}`, bundle),
  );
  await withStepTimeout(
    'Writing app source',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_SOURCE_FILE}`, JSON.stringify(workspace.files)),
  );
  await withStepTimeout(
    'Writing workspace manifest',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_WORKSPACE_MANIFEST_FILE}`, JSON.stringify(workspace.manifest)),
  );
  await withStepTimeout(
    'Writing app metadata',
    APP_BUILD_TIMEOUT_MS.storageWrite,
    env.ETERNALOS_FILES.put(`${r2Prefix}/${APP_METADATA_FILE}`, JSON.stringify(metadata)),
  );
  tracker.markCompleted('write-storage');

  return { metadata, build: tracker.success(), files: workspace.files };
}

async function createAndRegisterApp(
  ctx: AppToolsContext,
  input: AppBundleInput
): Promise<{ appId: string; itemId: string; name: string; status: 'created'; build: AppBuildSummary; revision: string }> {
  const { env, sql, agentName: uid } = ctx;
  const appId = crypto.randomUUID();
  const r2Prefix = `apps/${uid}/${appId}`;
  const tracker = createBuildTracker();
  let desktopItemId: string | null = null;

  try {
    validateGeneratedApp(input);
    const artifact = await writeAppArtifact(ctx, input, appId, r2Prefix, '/api/apps', tracker);

    // Same revision contract as dev-deploy (routes/appRevisions.ts): every
    // save that installs a bundle appends an immutable revision, and the
    // registry points at it. Author 'agent' marks the tool pipeline as the
    // writer. A failed create cleans everything up below and records
    // nothing — the app was never registered (the dev-deploy create rule).
    const revision = await writeAppRevision(env, uid, appId, {
      kind: 'deploy',
      author: 'agent',
      valid: true,
      files: artifact.files,
      name: input.name,
      description: input.description,
      permissions: input.permissions,
      rationale: input.rationale,
      windowConfig: { defaultWidth: input.width, defaultHeight: input.height, resizable: true },
      appVersion: 1,
      summary: 'Agent build (v1)',
    });

    const now = Date.now();
    sql.exec(
      `INSERT INTO apps (id, name, description, version, r2_prefix, width, height, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      appId, input.name, input.description ?? '', r2Prefix, input.width, input.height, now, now,
    );

    await withStepTimeout(
      'Saving app registry metadata',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.DESKTOP_KV.put(
        `app:${appId}`,
        JSON.stringify({
          uid,
          version: 1,
          granted: {},
          r2Prefix,
          current_revision: revision.revisionId,
          last_valid_revision: revision.revisionId,
        }),
      ),
    );

    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);
    const position = await withStepTimeout(
      'Finding desktop placement',
      APP_BUILD_TIMEOUT_MS.desktopInstall,
      getNextDesktopGridPosition(stub),
    );

    emitStage(ctx, 'install');
    const manifest: AppManifest = {
      name: input.name,
      description: input.description,
      version: '1',
      windowConfig: { defaultWidth: input.width, defaultHeight: input.height, resizable: true },
      appId,
      permissions: input.permissions,
      rationale: input.rationale,
    };

    const createRes = await withStepTimeout(
      'Installing app on desktop',
      APP_BUILD_TIMEOUT_MS.desktopInstall,
      stub.fetch(new Request('http://internal/items', {
        method: 'POST',
        body: JSON.stringify({
          type: 'app',
          name: input.name,
          parentId: null,
          position,
          isPublic: false,
          appManifest: manifest,
          grantedPermissions: {},
        }),
      })),
    );

    if (!createRes.ok) {
      const detail = await createRes.text().catch(() => '');
      throw new Error(`Failed to create desktop item (${createRes.status})${detail ? `: ${detail}` : ''}`);
    }

    const item = await createRes.json<DesktopItem>();
    desktopItemId = item.id;
    sql.exec('UPDATE apps SET desktop_item_id = ? WHERE id = ?', item.id, appId);
    tracker.markCompleted('install-desktop');

    // Cap the revision history with the registry pointers pinned (same as
    // dev-deploy). A no-op on first install (one revision, cap 50).
    await pruneAppRevisions(env, uid, appId, new Set([revision.revisionId])).catch((error) => {
      console.error('App revision cleanup failed:', error);
    });

    return {
      appId,
      itemId: item.id,
      name: input.name,
      status: 'created',
      revision: revision.revisionId,
      build: {
        ...artifact.build,
        currentStage: 'ready',
        stages: artifact.build.stages.map((stage) => (
          stage.key === 'install-desktop' ? { ...stage, status: 'completed' } : stage
        )),
        completedAt: Date.now(),
        durationMs: Date.now() - artifact.build.startedAt,
      },
    };
  } catch (error) {
    await deleteR2Prefix(env, r2Prefix).catch(() => {});
    await env.DESKTOP_KV.delete(`app:${appId}`).catch(() => {});
    sql.exec('DELETE FROM apps WHERE id = ?', appId);
    if (desktopItemId) {
      const doId = env.USER_DESKTOP.idFromName(uid);
      const stub = env.USER_DESKTOP.get(doId);
      await stub.fetch(new Request('http://internal/items', {
        method: 'PATCH',
        body: JSON.stringify([{
          id: desktopItemId,
          updates: { isTrashed: true, trashedAt: Date.now() },
        }]),
      })).catch(() => {});
    }
    throw wrapBuildError(error, tracker);
  }
}

async function createAppPreview(
  ctx: AppToolsContext,
  input: AppBundleInput,
  options?: { targetAppId?: string },
): Promise<{
  previewId: string;
  name: string;
  status: 'preview-ready';
  previewUrl: string;
  expiresAt: number;
  permissions?: AppPermissions;
  build: AppBuildSummary;
}> {
  const { env, agentName: uid } = ctx;
  const previewId = crypto.randomUUID();
  const r2Prefix = `app-previews/${uid}/${previewId}`;
  const tracker = createBuildTracker();
  const expiresAt = Date.now() + APP_PREVIEW_TTL_SECONDS * 1000;

  try {
    await cleanupExpiredPreviewObjects(env, uid).catch(() => {});
    const artifact = await writeAppArtifact(
      ctx,
      input,
      previewId,
      r2Prefix,
      '/api/app-previews',
      tracker,
      { expiresAt },
    );

    await withStepTimeout(
      'Saving preview registry metadata',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.DESKTOP_KV.put(
        `app-preview:${previewId}`,
        JSON.stringify({
          ...artifact.metadata,
          // Previews deliberately run hermetic. Desktop grants only activate
          // after the user installs the app onto their desktop.
          granted: {},
          // When the brief was a change to an installed app, remember the
          // target: installing this preview reinstalls THAT app (new
          // version, same desktop item and storage) instead of creating a
          // second one next to it.
          ...(options?.targetAppId ? { targetAppId: options.targetAppId } : {}),
        }),
        { expirationTtl: APP_PREVIEW_TTL_SECONDS },
      ),
    );

    return {
      previewId,
      name: input.name,
      status: 'preview-ready',
      previewUrl: `/api/app-previews/${previewId}/`,
      expiresAt,
      permissions: input.permissions,
      build: artifact.build,
    };
  } catch (error) {
    await deleteR2Prefix(env, r2Prefix).catch(() => {});
    await env.DESKTOP_KV.delete(`app-preview:${previewId}`).catch(() => {});
    throw wrapBuildError(error, tracker);
  }
}

async function buildAppPreviewFromPromptWithRetries(
  ctx: AppToolsContext,
  prompt: string,
  targetAppId?: string,
): Promise<Awaited<ReturnType<typeof createAppPreview>>> {
  if (targetAppId) {
    // The preview targets an installed app: it must exist, belong to this
    // user, and still be on the desktop — a reinstall has nowhere to land
    // otherwise. Checked before any generation work.
    await getRegisteredDesktopApp(ctx.env, ctx.agentName, targetAppId);
  }
  const desktopSummary = await loadDesktopSummary(ctx);
  const spec = await generateSpecWithRetries(ctx, prompt, desktopSummary);
  const { result } = await generateAppWithRepairLoop(
    ctx,
    prompt,
    spec,
    desktopSummary,
    (generated) => createAppPreview(ctx, generated, { targetAppId }),
    'app preview',
  );
  return result;
}

/**
 * Update an installed app's release in place — the one pipeline behind both
 * agent update paths (the updateApp tool, and installing a preview that was
 * staged for an existing app). The app keeps its identity: same appId (so its
 * private eternal.storage keys survive), same desktop item (no duplicate
 * icon), same registry history — the new release lands at
 * apps/{uid}/{appId}/v{N+1} and a valid agent revision is appended.
 *
 * Fields left unset fall back to the installed app's current values; the
 * caller decides what changes (updateApp passes only what its input names
 * and keeps the current declared permissions; a preview reinstall passes the
 * preview's own declaration).
 *
 * Grants follow the dev-deploy contract: intersected with the release's
 * declared set, so they only ever narrow — a reinstall that declares new
 * scopes grants nothing by itself; widening needs the user's explicit
 * approval through the permissions route. Surviving scopes keep their
 * approval metadata (and its dates) exactly as the user approved them.
 */
async function applyRegisteredAppUpdate(
  ctx: AppToolsContext,
  input: {
    appId: string;
    files: Record<string, string>;
    name?: string;
    description?: string;
    width?: number;
    height?: number;
    /** The release's declared permissions. Unset = the app's current set. */
    permissions?: AppPermissions;
    rationale?: string;
    revisionSummary: (version: number) => string;
  },
): Promise<{
  appId: string;
  itemId: string;
  name: string;
  version: number;
  status: 'updated';
  revision: string;
  build: AppBuildSummary;
}> {
  const { env, agentName: uid } = ctx;
  const registered = await getRegisteredDesktopApp(env, uid, input.appId);
  // Lazy migration: apps created before revisions existed get their current
  // source snapshotted as revision #0 on this first touch (same as the
  // dev-deploy update flow), so this update lands on top of a real history
  // instead of starting one.
  await ensureRevisionBaseline(env, uid, input.appId, registered.metadata);
  const manifest = registered.item.appManifest;
  const app = {
    version: registered.metadata.version,
    r2_prefix: registered.metadata.r2Prefix || `apps/${uid}/${input.appId}`,
    desktop_item_id: registered.item.id,
  };
  const nextName = input.name ?? (manifest?.name || registered.item.name);
  const nextDescription = input.description ?? (manifest?.description || '');
  const nextWidth = input.width ?? (manifest?.windowConfig.defaultWidth || 600);
  const nextHeight = input.height ?? (manifest?.windowConfig.defaultHeight || 500);
  const nextPermissions = input.permissions ?? manifest?.permissions;
  const nextRationale = input.rationale ?? manifest?.rationale;

  const tracker = createBuildTracker();
  const newVersion = await getNextAppVersion(env, uid, input.appId, app.version);
  const nextR2Prefix = getAppReleasePrefix(app.r2_prefix, newVersion);
  let previousMeta: AgentAppRegistryMeta | null = null;
  let appMetadataWriteStarted = false;
  // Revision objects are tracked separately from release keys: on a
  // genuine infra failure both are cleaned up, but on a *validation*
  // failure the (invalid) revision is the diagnostics record and is
  // deliberately kept — it is written in the catch below, after these
  // keys are decided, so this list only ever holds the success path's.
  let writtenRevisionKeys: string[] = [];

  try {
    // Re-read after the baseline so an infra-failure rollback
    // restores the baselined record (same as dev-deploy).
    previousMeta = await env.DESKTOP_KV.get<AgentAppRegistryMeta>(`app:${input.appId}`, 'json');

    const updatedInput: AppBundleInput = {
      name: nextName,
      description: nextDescription,
      files: input.files,
      width: nextWidth,
      height: nextHeight,
      permissions: nextPermissions,
      rationale: nextRationale,
    };
    validateGeneratedApp(updatedInput);
    const workspace = createAppWorkspace(input.files);
    tracker.markCompleted('prepare-workspace');

    emitStage(ctx, 'bundle');
    const workerFiles = createWorkerModuleFiles(workspace);
    const { mainModule, modules } = await withStepTimeout(
      'Bundling app worker',
      APP_BUILD_TIMEOUT_MS.bundling,
      createWorker({
        files: {
          ...workerFiles,
          [APP_WORKER_ENTRY_FILE]: workerFiles[APP_WORKER_ENTRY_FILE].replaceAll('__APP_ID__', input.appId),
        },
        entryPoint: APP_WORKER_ENTRY_FILE,
      }),
    );
    tracker.markCompleted('bundle-worker');

    // Same deterministic post-bundle gate as every other install path.
    assertAppBundleValid({
      files: workspace.files,
      manifest: workspace.manifest,
      permissions: nextPermissions,
      compiled: { mainModule, modules },
    });

    emitStage(ctx, 'storage');
    const bundle = JSON.stringify({ mainModule, modules });
    await withStepTimeout(
      'Writing app bundle',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.ETERNALOS_FILES.put(`${nextR2Prefix}/bundle.json`, bundle),
    );
    await withStepTimeout(
      'Writing app source',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.ETERNALOS_FILES.put(`${nextR2Prefix}/source.json`, JSON.stringify(workspace.files)),
    );
    await withStepTimeout(
      'Writing workspace manifest',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.ETERNALOS_FILES.put(`${nextR2Prefix}/${APP_WORKSPACE_MANIFEST_FILE}`, JSON.stringify(workspace.manifest)),
    );
    await withStepTimeout(
      'Writing release metadata',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.ETERNALOS_FILES.put(`${nextR2Prefix}/${APP_METADATA_FILE}`, JSON.stringify({
        id: input.appId,
        uid,
        name: nextName,
        description: nextDescription,
        version: newVersion,
        r2Prefix: nextR2Prefix,
        createdAt: Date.now(),
        permissions: nextPermissions,
        rationale: nextRationale,
      })),
    );
    tracker.markCompleted('write-storage');

    // Same revision contract as dev-deploy: the validated update appends a
    // revision (author 'agent') and the registry below points at it.
    // Install = freeze a validated revision.
    const revision = await writeAppRevision(env, uid, input.appId, {
      kind: 'deploy',
      author: 'agent',
      valid: true,
      files: workspace.files,
      name: nextName,
      description: nextDescription,
      permissions: nextPermissions,
      rationale: nextRationale,
      windowConfig: { defaultWidth: nextWidth, defaultHeight: nextHeight, resizable: true },
      appVersion: newVersion,
      summary: input.revisionSummary(newVersion),
    });
    writtenRevisionKeys.push(...revision.keys);

    // Grants only ever narrow on a release change (dev-deploy contract):
    // the release's declared set intersected with the stored grant. When
    // the declaration is unchanged this is a no-op; a reinstall declaring
    // new scopes keeps every existing grant and grants nothing new.
    const granted = intersectGranted(
      sanitizeGranted(nextPermissions),
      previousMeta?.granted ?? {},
    );
    appMetadataWriteStarted = true;
    await withStepTimeout(
      'Saving app registry metadata',
      APP_BUILD_TIMEOUT_MS.storageWrite,
      env.DESKTOP_KV.put(
        `app:${input.appId}`,
        JSON.stringify({
          uid,
          version: newVersion,
          granted,
          r2Prefix: nextR2Prefix,
          current_revision: revision.revisionId,
          last_valid_revision: revision.revisionId,
        }),
      ),
    );

    emitStage(ctx, 'install');
    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);
    const appManifest: AppManifest = {
      name: nextName,
      description: nextDescription,
      version: String(newVersion),
      windowConfig: {
        defaultWidth: nextWidth,
        defaultHeight: nextHeight,
        resizable: true,
      },
      appId: input.appId,
      permissions: nextPermissions,
      rationale: nextRationale,
    };
    // The item's grants mirror the registry (same intersection), and every
    // surviving scope keeps its approval metadata as it read when the user
    // approved it — an update must never re-date an approval.
    const updateRes = await withStepTimeout(
      'Installing updated app on desktop',
      APP_BUILD_TIMEOUT_MS.desktopInstall,
      stub.fetch(new Request('http://internal/items', {
        method: 'PATCH',
        body: JSON.stringify([{
          id: app.desktop_item_id,
          updates: {
            name: nextName,
            appManifest,
            grantedPermissions: granted,
            grantedPermissionApprovals: pruneGrantApprovals(
              registered.item.grantedPermissionApprovals,
              granted,
            ),
          },
        }]),
      })),
    );
    if (!updateRes.ok) {
      const detail = await updateRes.text().catch(() => '');
      throw new Error(`Failed to update desktop item (${updateRes.status})${detail ? `: ${detail}` : ''}`);
    }

    tracker.markCompleted('install-desktop');
    await pruneAppReleases(env, uid, input.appId, nextR2Prefix).catch((error) => {
      console.error('App release cleanup failed:', error);
    });
    // Cap the revision history with the registry pointers pinned
    // (same as dev-deploy).
    await pruneAppRevisions(env, uid, input.appId, new Set([revision.revisionId])).catch((error) => {
      console.error('App revision cleanup failed:', error);
    });
    return {
      appId: input.appId,
      itemId: app.desktop_item_id,
      name: nextName,
      version: newVersion,
      status: 'updated',
      revision: revision.revisionId,
      build: tracker.success(),
    };
  } catch (error) {
    await deleteR2Prefix(env, getAppReleasePrefix(app.r2_prefix, app.version + 1)).catch(() => {});
    if (writtenRevisionKeys.length > 0) {
      // Infra failure mid-flight: the revision never became a save.
      // A validation failure takes the branch below instead and keeps
      // its revision (writtenRevisionKeys is only populated on the
      // success path, after validation, so this never deletes a
      // diagnostics record).
      await Promise.allSettled(writtenRevisionKeys.map((key) => env.ETERNALOS_FILES.delete(key)));
    }
    if (appMetadataWriteStarted) {
      if (previousMeta) {
        await env.DESKTOP_KV.put(`app:${input.appId}`, JSON.stringify(previousMeta)).catch(() => {});
      } else {
        await env.DESKTOP_KV.delete(`app:${input.appId}`).catch(() => {});
      }
    }
    if (error instanceof AppValidationError) {
      // A rejected update on an EXISTING app is itself history: all
      // validation ran before any release write, so the installed
      // bundle is untouched — but the attempted source and the
      // diagnostics are recorded as an invalid revision, and only
      // current_revision moves (last_valid_revision does not). Same
      // contract as dev-deploy's failed update.
      try {
        const failed = await writeAppRevision(env, uid, input.appId, {
          kind: 'deploy',
          author: 'agent',
          valid: false,
          issues: error.issues,
          files: input.files,
          name: nextName,
          description: nextDescription,
          permissions: nextPermissions,
          rationale: nextRationale,
          windowConfig: { defaultWidth: nextWidth, defaultHeight: nextHeight, resizable: true },
          summary: 'Failed agent update — validation rejected',
        });
        const currentMeta = await env.DESKTOP_KV.get<AppRevisionPointers & { uid?: string }>(`app:${input.appId}`, 'json');
        if (currentMeta && currentMeta.uid === uid) {
          await env.DESKTOP_KV.put(`app:${input.appId}`, JSON.stringify({
            ...currentMeta,
            current_revision: failed.revisionId,
          }));
        }
      } catch (revisionError) {
        console.error('Failed to record invalid app revision:', revisionError);
      }
    }
    throw wrapBuildError(error, tracker);
  }
}

async function installAppPreview(
  ctx: AppToolsContext,
  previewId: string,
): Promise<{
  appId: string;
  itemId: string;
  name: string;
  status: 'created' | 'updated';
  version: number;
  revision: string;
  previewId: string;
  build?: AppBuildSummary;
}> {
  const { env, sql, agentName: uid } = ctx;
  const previewMeta = await env.DESKTOP_KV.get<StoredAppMetadata>(`app-preview:${previewId}`, 'json');
  if (!previewMeta || previewMeta.uid !== uid) {
    throw new Error(`Preview ${previewId} not found`);
  }
  if (previewMeta.expiresAt && previewMeta.expiresAt < Date.now()) {
    throw new Error('App preview expired; generate a new preview');
  }

  const sourceObj = await env.ETERNALOS_FILES.get(`${previewMeta.r2Prefix}/${APP_SOURCE_FILE}`);
  if (!sourceObj) {
    throw new Error('Preview source files not found');
  }
  const sourceFiles = await sourceObj.json<Record<string, string>>();

  // A preview staged FOR an installed app (previewAppFromPrompt with the
  // app's id) reinstalls that app: the previewed bundle becomes its next
  // release on the SAME desktop item, the appId is unchanged so its
  // eternal.storage keys survive, and grants only ever narrow — the change
  // may declare new scopes, but only the permissions route, with the
  // user's approval, can grant them. An untargeted preview installs as a
  // brand-new app, as before.
  const result = previewMeta.targetAppId
    ? await applyRegisteredAppUpdate(ctx, {
      appId: previewMeta.targetAppId,
      files: sourceFiles,
      name: previewMeta.name,
      description: previewMeta.description,
      width: previewMeta.width,
      height: previewMeta.height,
      permissions: previewMeta.permissions,
      rationale: previewMeta.rationale,
      revisionSummary: (version) => `Agent preview install (v${version})`,
    })
    : {
      ...await createAndRegisterApp(ctx, {
        name: previewMeta.name,
        description: previewMeta.description,
        files: sourceFiles,
        width: previewMeta.width,
        height: previewMeta.height,
        permissions: previewMeta.permissions,
        rationale: previewMeta.rationale,
      }),
      version: 1,
    };
  await deleteR2Prefix(env, previewMeta.r2Prefix).catch(() => {});
  await env.DESKTOP_KV.delete(`app-preview:${previewId}`).catch(() => {});
  sql.exec('UPDATE apps SET updated_at = ? WHERE id = ?', Date.now(), result.appId);
  return { ...result, previewId };
}

/**
 * Initialize the app registry table in the agent's SQLite database.
 */
export function initAppRegistry(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    version INTEGER DEFAULT 1,
    r2_prefix TEXT NOT NULL,
    desktop_item_id TEXT,
    width INTEGER DEFAULT 600,
    height INTEGER DEFAULT 500,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

/**
 * Platform-provided runtime bundled with every app. Exposes `window.eternal`
 * as a thin fetch wrapper over same-origin `/_eternal/*` routes handled inside
 * the Dynamic Worker (which then RPCs to the parent's EternalService binding).
 *
 * Installed apps are capability-gated: the parent frame postMessages a
 * short-lived capability token in, every request() attaches it as a Bearer
 * header, and grants are still bound into the Dynamic Worker at load time
 * via ctx.props. Preview mounts skip the handshake (requiresCapability is
 * compiled to false).
 *
 * fs.urlFor(id) must produce a URL usable from <img src>/<audio src>, which
 * cannot send headers: in capability mode it fetches the bytes through
 * request() itself and returns a cached blob: object URL (all revoked on
 * pagehide); capability-free previews keep the plain bridge URL, returned
 * synchronously. Apps must always await urlFor — its result is a Promise in
 * installed apps.
 */
const ETERNAL_RUNTIME_JS = `(() => {
  const requiresCapability = __REQUIRE_CAPABILITY__;
  let capability = null;
  let capabilityResolver;
  const capabilityReady = new Promise((resolve) => {
    capabilityResolver = resolve;
    setTimeout(() => {
      if (capabilityResolver) {
        capabilityResolver(null);
        capabilityResolver = null;
      }
    }, 5000);
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.type !== 'eternal:capability' || typeof data.token !== 'string') return;
    if (data.token.length < 16 || data.token.length > 4096) return;
    capability = data.token;
    if (capabilityResolver) {
      capabilityResolver(capability);
      capabilityResolver = null;
    }
  });

  // The iframe's document URL ends with "/api/apps/:appId/". Resolve bridge
  // calls relative to it so we hit the Dynamic Worker's mount path rather
  // than the origin root (which would bypass our routing).
  function apiUrl(path) {
    return new URL('_eternal' + path, document.baseURI).toString();
  }

  async function request(path, init) {
    let requestInit = init || {};
    if (requiresCapability) {
      const token = capability || await capabilityReady;
      if (!token) throw new Error('EternalOS capability unavailable');
      const headers = new Headers(requestInit.headers || {});
      headers.set('Authorization', 'Bearer ' + token);
      requestInit = { ...requestInit, headers };
    }
    const res = await fetch(apiUrl(path), requestInit);
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      throw new Error('eternal ' + path + ' failed (' + res.status + ')' + (detail ? ': ' + detail : ''));
    }
    return res;
  }

  function encodeId(id) {
    return encodeURIComponent(String(id || ''));
  }

  // Blob object URLs minted by fs.urlFor in capability mode, keyed by the
  // bridge path of the item. An entry is the in-flight fetch Promise until
  // it settles, then the plain blob: URL string. Repeated calls for the same
  // id reuse the entry instead of refetching. Everything is revoked on
  // pagehide so the blobs don't outlive the app document.
  const objectUrls = new Map();
  window.addEventListener('pagehide', () => {
    for (const entry of objectUrls.values()) {
      if (typeof entry === 'string') {
        URL.revokeObjectURL(entry);
      } else {
        entry.then((url) => URL.revokeObjectURL(url)).catch(() => {});
      }
    }
    objectUrls.clear();
  });

  const fs = {
    async list(opts) {
      const params = new URLSearchParams();
      if (opts && opts.path) params.set('path', String(opts.path));
      if (opts && opts.mimeType) params.set('mimeType', String(opts.mimeType));
      if (opts && opts.limit) params.set('limit', String(opts.limit | 0));
      const res = await request('/fs/list' + (params.toString() ? '?' + params : ''));
      return res.json();
    },
    async read(id) {
      const res = await request('/fs/read/' + encodeId(id));
      return res.blob();
    },
    async readText(id) {
      const res = await request('/fs/read/' + encodeId(id));
      return res.text();
    },
    async readJson(id) {
      const res = await request('/fs/read/' + encodeId(id));
      return res.json();
    },
    // urlFor(id) hands the app a URL it can assign straight to <img src>,
    // <audio src>, or <video src> — none of which can send an Authorization
    // header. Two very different shapes depending on the mount:
    // - Capability-free previews keep the plain same-origin bridge URL; the
    //   preview bridge answers without a Bearer header, so it resolves as-is.
    //   (Returned synchronously, like it always was.)
    // - Installed apps require the Bearer capability, so the plain URL would
    //   401 in a bare <img src> fetch. Instead fetch the bytes through
    //   request() — which attaches the capability — and return a blob:
    //   object URL, cached per id. This path is asynchronous: apps must
    //   await the result; using it without awaiting (or interpolating it
    //   into a string) yields "[object Promise]", not a URL.
    urlFor(id) {
      const path = '/fs/read/' + encodeId(id);
      if (!requiresCapability) return apiUrl(path);
      const cached = objectUrls.get(path);
      if (cached !== undefined) return Promise.resolve(cached);
      const pending = request(path)
        .then((res) => res.blob())
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (objectUrls.get(path) === pending) objectUrls.set(path, url);
          return url;
        });
      // A failed fetch must not poison the id: drop the entry so the next
      // call retries instead of re-throwing the same error forever.
      pending.catch(() => {
        if (objectUrls.get(path) === pending) objectUrls.delete(path);
      });
      objectUrls.set(path, pending);
      return pending;
    },
    async write(opts) {
      const res = await request('/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      });
      return res.json();
    },
    async patch(itemId, updates) {
      const res = await request('/fs/patch/' + encodeId(itemId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      return res.json();
    },
    async delete(itemId) {
      await request('/fs/delete/' + encodeId(itemId), {
        method: 'DELETE',
      });
    },
  };

  const profile = {
    async get() {
      const res = await request('/profile');
      return res.json();
    },
  };

  const postToParent = (msg) => {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(msg, '*');
      }
    } catch (_) {}
  };

  const appWindow = {
    setTitle(title) { postToParent({ type: 'eternal:window:setTitle', title: String(title == null ? '' : title) }); },
    close() { postToParent({ type: 'eternal:window:close' }); },
    requestFocus() { postToParent({ type: 'eternal:window:requestFocus' }); },
    resize(width, height) { postToParent({ type: 'eternal:window:resize', width: Number(width || 600), height: Number(height || 500) }); },
  };

  function onIntent(cb) {
    const handler = (e) => {
      if (!e || !e.data || e.data.type !== 'eternal:intent') return;
      try { cb(e.data.intent); } catch (_) {}
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }

  const storage = {
    async get(key) {
      try {
        const res = await request('/storage/' + encodeId(key));
        const data = await res.json();
        return data.value;
      } catch (err) {
        if (String(err).includes('404')) return null;
        throw err;
      }
    },
    async set(key, value) {
      await request('/storage/' + encodeId(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    },
    async delete(key) {
      await request('/storage/' + encodeId(key), {
        method: 'DELETE',
      });
    },
    async list() {
      const res = await request('/storage');
      const data = await res.json();
      return data.keys;
    },
  };

  const ipc = {
    emit(topic, payload) {
      postToParent({ type: 'eternal:ipc:emit', topic, payload });
    },
    on(topic, cb) {
      const handler = (e) => {
        if (!e || !e.data || e.data.type !== 'eternal:ipc:message' || e.data.topic !== topic) return;
        try { cb(e.data.payload, e.data.sender); } catch (_) {}
      };
      window.addEventListener('message', handler);
      return () => window.removeEventListener('message', handler);
    },
  };

  async function fetchProxy(url, init) {
    const res = await request('/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        init: {
          method: init?.method,
          headers: init?.headers,
          body: init?.body,
        },
      }),
    });
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error);
    }
    return {
      status: data.status,
      statusText: data.statusText,
      ok: data.status >= 200 && data.status < 300,
      headers: new Headers(data.headers),
      text: () => Promise.resolve(data.body),
      json: () => Promise.resolve(JSON.parse(data.body)),
      blob: () => Promise.resolve(new Blob([data.body])),
    };
  }

  // Full-stack apps: call the app's own server.js (a Durable Object facet
  // with its own SQLite) at ./api/*. Same capability gate as the bridge.
  async function apiFetch(path, init) {
    let requestInit = init || {};
    const headers = new Headers(requestInit.headers || {});
    if (requiresCapability) {
      const token = capability || await capabilityReady;
      if (!token) throw new Error('EternalOS capability unavailable');
      headers.set('Authorization', 'Bearer ' + token);
    }
    requestInit = { ...requestInit, headers };
    const clean = String(path || '').replace(/^\\/+/, '').replace(/^api\\//, '');
    return fetch(new URL('api/' + clean, document.baseURI).toString(), requestInit);
  }

  async function apiJson(method, path, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await apiFetch(path, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    if (!res.ok) {
      const message = data && typeof data === 'object' && data.error ? data.error : (text || res.statusText);
      throw new Error('api ' + method + ' ' + path + ' failed (' + res.status + '): ' + message);
    }
    return data;
  }

  // The assistant (or another client) changed this app's backend data while
  // it is open. Apps that register handlers refresh in place; apps that
  // don't are reloaded so they never show stale records.
  const changeHandlers = new Set();
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (!event.data || event.data.type !== 'eternal:data:changed') return;
    if (changeHandlers.size === 0) {
      location.reload();
      return;
    }
    for (const handler of changeHandlers) {
      try { handler(event.data); } catch (_) {}
    }
  });

  const api = Object.freeze({
    onChange(handler) {
      if (typeof handler !== 'function') return () => {};
      changeHandlers.add(handler);
      return () => changeHandlers.delete(handler);
    },
    fetch: apiFetch,
    get: (path) => apiJson('GET', path),
    post: (path, body) => apiJson('POST', path, body),
    put: (path, body) => apiJson('PUT', path, body),
    patch: (path, body) => apiJson('PATCH', path, body),
    delete: (path) => apiJson('DELETE', path),
  });

  const meta = document.querySelector('meta[name="eternal-app-id"]');
  const appId = meta ? meta.getAttribute('content') || '' : '';

  Object.defineProperty(window, 'eternal', {
    value: Object.freeze({ appId, hostVersion: '1', fs, profile, window: appWindow, onIntent, storage, ipc, fetch: fetchProxy, api }),
    writable: false,
    configurable: false,
  });
})();
`;

/**
 * Facet wrapper for full-stack apps. Bundled next to the app's server.js and
 * re-exported from the worker entry as `AppBackend`; AppRunner instantiates
 * it as a Durable Object Facet, so `this.ctx.storage` is the app's OWN SQLite
 * database. The app's handler gets a small, explicit env:
 *
 *   env.sql      SqlStorage  — env.sql.exec(query, ...bindings).toArray()
 *   env.storage  DurableObjectStorage — await env.storage.get/put/delete/list
 *   env.kv       synchronous key/value on the same database
 *   env.desktop  grant-checked desktop access (list/readText/write)
 *   env.APP_ID   the app id
 *
 * Plain fetch() works for granted network.outbound hosts only.
 */
const APP_BACKEND_WRAPPER_JS = `import { DurableObject } from 'cloudflare:workers';
import * as userModule from './server.js';

const handler = userModule.default;

function resolveHandler() {
  if (typeof handler === 'function') return handler;
  if (handler && typeof handler.fetch === 'function') return (request, env, ctx) => handler.fetch(request, env, ctx);
  return null;
}

function toResponse(value) {
  if (value instanceof Response) return value;
  if (value === undefined || value === null) return new Response(null, { status: 204 });
  if (typeof value === 'string') return new Response(value, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return Response.json(value);
}

export class AppBackend extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const eternal = env && env.ETERNAL;
    const desktop = Object.freeze({
      list: (options) => eternal.list(options || {}),
      readText: async (id) => (await eternal.read(id)).text(),
      readJson: async (id) => (await eternal.read(id)).json(),
      write: (options) => eternal.write(options),
    });
    this.appEnv = Object.freeze({
      sql: ctx.storage.sql,
      storage: ctx.storage,
      kv: ctx.storage.kv,
      desktop,
      APP_ID: env && env.APP_ID,
    });
  }

  async fetch(request) {
    const run = resolveHandler();
    if (!run) {
      return Response.json({ error: 'server.js must export default { async fetch(request, env) { ... } }' }, { status: 500 });
    }
    try {
      return toResponse(await run(request, this.appEnv, { waitUntil: (p) => this.ctx.waitUntil(p) }));
    } catch (err) {
      console.error('Unhandled error in server.js:', err && err.stack ? err.stack : String(err));
      return Response.json({ error: String(err && err.message ? err.message : err) }, { status: 500 });
    }
  }
}
`;

/**
 * Wrap user-provided app files into a Worker that serves the assembled HTML
 * page AND handles the `/_eternal/*` bridge calls via the ETERNAL binding.
 */
export function createWorkerModuleFiles(
  workspace: AppWorkspace,
  mountBasePath: '/api/apps' | '/api/app-previews' = '/api/apps',
): Record<string, string> {
  const { frontend: normalizedFiles, backend: backendFiles } = splitBackendFiles(workspace.files);
  const hasBackend = APP_BACKEND_ENTRY_FILE in backendFiles;
  const htmlPath = workspace.manifest.entryHtml;
  const cssPath = selectDefaultCssEntry(normalizedFiles);
  const jsPath = selectDefaultJsEntry(normalizedFiles);
  const html = normalizedFiles[htmlPath] || '';
  const isCompleteHtml = html.toLowerCase().includes('<!doctype') || html.toLowerCase().includes('<html');

  const ETERNAL_META_ID = '__APP_ID__';
  const eternalMetaTag = `<meta name="eternal-app-id" content="${ETERNAL_META_ID}">`;
  const eternalRuntimeTag = `<script src="./${APP_RUNTIME_ASSET_FILE}"></script>`;

  const injectAssetsIntoHtml = (sourceHtml: string): string => {
    let result = sourceHtml;
    // Runtime + meta always come first so user scripts can rely on window.eternal.
    if (!result.includes(APP_RUNTIME_ASSET_FILE)) {
      if (/<\/head>/i.test(result)) {
        result = result.replace(/<\/head>/i, `${eternalMetaTag}\n${eternalRuntimeTag}\n</head>`);
      } else if (/<body[^>]*>/i.test(result)) {
        result = result.replace(/<body([^>]*)>/i, `<body$1>\n${eternalMetaTag}\n${eternalRuntimeTag}`);
      } else {
        result = `${eternalMetaTag}\n${eternalRuntimeTag}\n${result}`;
      }
    }
    if (cssPath && !result.includes(cssPath)) {
      const cssTag = `<link rel="stylesheet" href="./${cssPath}">`;
      if (/<\/head>/i.test(result)) {
        result = result.replace(/<\/head>/i, `${cssTag}\n</head>`);
      } else {
        result = `${cssTag}\n${result}`;
      }
    }
    if (jsPath && !result.includes(jsPath)) {
      const jsTag = `<script type="module" src="./${jsPath}"></script>`;
      if (/<\/body>/i.test(result)) {
        result = result.replace(/<\/body>/i, `${jsTag}\n</body>`);
      } else {
        result = `${result}\n${jsTag}`;
      }
    }
    return result;
  };

  const fullHtml = isCompleteHtml
    ? injectAssetsIntoHtml(html)
    : `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${eternalMetaTag}
${eternalRuntimeTag}
${cssPath ? `<link rel="stylesheet" href="./${cssPath}">` : ''}
</head>
<body>
${html}
${jsPath ? `<script type="module" src="./${jsPath}"></script>` : ''}
</body>
</html>`;

  const assets: Record<string, string> = {
    ...normalizedFiles,
    [htmlPath]: fullHtml,
    [APP_RUNTIME_ASSET_FILE]: ETERNAL_RUNTIME_JS.replace('__REQUIRE_CAPABILITY__', String(mountBasePath === '/api/apps')),
  };
  const mountPath = `${mountBasePath}/__APP_ID__`;

  const backendModules: Record<string, string> = hasBackend
    ? { ...backendFiles, [APP_BACKEND_WRAPPER_FILE]: APP_BACKEND_WRAPPER_JS }
    : {};
  const backendExport = hasBackend
    ? `export { AppBackend } from './${APP_BACKEND_WRAPPER_FILE}';\n`
    : '';

  return {
    ...backendModules,
    [APP_WORKER_ENTRY_FILE]: `${backendExport}
const ASSETS = ${JSON.stringify(assets)};
const ENTRY = ${JSON.stringify(htmlPath)};
const MOUNT_PATH = ${JSON.stringify(mountPath)};
const ETERNAL_PREFIX = '/_eternal';

function getContentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (path.endsWith('.txt')) return 'text/plain; charset=utf-8';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.woff')) return 'font/woff';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.ttf')) return 'font/ttf';
  if (path.endsWith('.otf')) return 'font/otf';
  return 'application/octet-stream';
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Sandboxed iframes with only 'allow-scripts' get an opaque (null) origin.
// Bridge calls from there are cross-origin fetches to this Dynamic Worker,
// so every response needs CORS headers the browser will accept from null.
// Credentials are never included (iframe has no cookies/auth for this host),
// so '*' is safe and simpler than echoing 'null' back.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '300',
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// EternalService rejects bridge calls it must not serve with typed,
// message-prefixed errors: 'Not permitted…' / 'No permitted fields…' (policy
// denial), 'Invalid…' (malformed input), 'Item not found', and size/quota
// limits. Map those to the matching 4xx so a denied call is distinguishable
// from a server fault — previously every throw surfaced as 500, which made
// app-side permission denials look like platform bugs. Unknown messages stay
// 500 so genuine faults remain observable.
function bridgeErrorStatus(message) {
  if (/^Not permitted/.test(message) || /^No permitted fields/.test(message)) return 403;
  if (/^Network URL is not allowed/.test(message)) return 403;
  if (/^Item not found/.test(message)) return 404;
  if (/^Invalid/.test(message)) return 400;
  if (/^Parent folder not found/.test(message)) return 400;
  if (/^Network method is not allowed/.test(message)) return 400;
  if (/^Storage value must be JSON serializable/.test(message)) return 400;
  if (/too large/i.test(message)) return 413;
  if (/^Storage key limit exceeded/.test(message)) return 429;
  return 500;
}

function bridgeErrorResponse(err) {
  const message = String(err && err.message ? err.message : err);
  return withCors(Response.json({ error: message }, { status: bridgeErrorStatus(message) }));
}

async function handleEternal(request, env, bridgePath) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (!env || !env.ETERNAL) {
    return withCors(new Response(JSON.stringify({ error: 'Bridge not available' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));
  }
  const authorization = request.headers.get('Authorization');
  const capability = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
  if (!(await env.ETERNAL.authorizeApp(capability))) {
    return withCors(Response.json({ error: 'Invalid or missing capability token' }, { status: 401 }));
  }
  const url = new URL(request.url);

  if (bridgePath === '/fs/list' && request.method === 'GET') {
    try {
      const items = await env.ETERNAL.list({
        path: url.searchParams.get('path') || undefined,
        mimeType: url.searchParams.get('mimeType') || undefined,
        limit: clampInt(url.searchParams.get('limit'), 1, 500, 100),
      });
      return withCors(Response.json({ items }));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath === '/fs/write' && request.method === 'POST') {
    try {
      const body = await request.json();
      const item = await env.ETERNAL.write(body);
      return withCors(Response.json(item));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath.startsWith('/fs/patch/') && request.method === 'POST') {
    const id = bridgePath.slice('/fs/patch/'.length);
    if (!id) return withCors(Response.json({ error: 'Missing id' }, { status: 400 }));
    try {
      const updates = await request.json();
      const item = await env.ETERNAL.patch(id, updates);
      return withCors(Response.json(item));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath.startsWith('/fs/delete/') && request.method === 'DELETE') {
    const id = bridgePath.slice('/fs/delete/'.length);
    if (!id) return withCors(Response.json({ error: 'Missing id' }, { status: 400 }));
    try {
      await env.ETERNAL.delete(id);
      return withCors(Response.json({ success: true }));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath.startsWith('/fs/read/') && request.method === 'GET') {
    const id = bridgePath.slice('/fs/read/'.length);
    if (!id) return withCors(Response.json({ error: 'Missing id' }, { status: 400 }));
    try {
      return withCors(await env.ETERNAL.read(id));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath === '/profile' && request.method === 'GET') {
    try {
      // Deny profile reads without the grant outright (403) instead of
      // answering 200 with an empty object: a 200 tells the app the user's
      // profile is empty, a 403 tells it the grant is missing. profile()
      // keeps its graceful empty-object behavior for bundles compiled before
      // this check existed.
      if (!(await env.ETERNAL.profilePermitted())) {
        return withCors(Response.json({ error: 'Not permitted: profile access not granted' }, { status: 403 }));
      }
      const profile = await env.ETERNAL.profile();
      return withCors(Response.json(profile));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath === '/storage' && request.method === 'GET') {
    try {
      const keys = await env.ETERNAL.storageList();
      return withCors(Response.json({ keys }));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath.startsWith('/storage/') && request.method === 'GET') {
    const key = bridgePath.slice('/storage/'.length);
    try {
      const value = await env.ETERNAL.storageGet(key);
      if (value === null) {
        return withCors(Response.json({ error: 'Not found' }, { status: 404 }));
      }
      return withCors(Response.json({ value }));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath.startsWith('/storage/') && request.method === 'POST') {
    const key = bridgePath.slice('/storage/'.length);
    try {
      const { value } = await request.json();
      await env.ETERNAL.storageSet(key, value);
      return withCors(Response.json({ success: true }));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath.startsWith('/storage/') && request.method === 'DELETE') {
    const key = bridgePath.slice('/storage/'.length);
    try {
      await env.ETERNAL.storageDelete(key);
      return withCors(Response.json({ success: true }));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  if (bridgePath === '/fetch' && request.method === 'POST') {
    try {
      const { url, init } = await request.json();
      const res = await env.ETERNAL.fetchProxy(url, init);
      return withCors(Response.json(res));
    } catch (err) {
      return bridgeErrorResponse(err);
    }
  }

  return withCors(new Response('Not found', { status: 404 }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let assetPath = url.pathname;

    if (assetPath === MOUNT_PATH || assetPath === MOUNT_PATH + '/') {
      assetPath = '/' + ENTRY;
    } else if (assetPath.startsWith(MOUNT_PATH + '/')) {
      assetPath = assetPath.slice(MOUNT_PATH.length);
    }

    if (assetPath === ETERNAL_PREFIX || assetPath.startsWith(ETERNAL_PREFIX + '/')) {
      const bridgePath = assetPath.slice(ETERNAL_PREFIX.length) || '/';
      return handleEternal(request, env, bridgePath);
    }

    const normalizedPath = assetPath.replace(/^\\/+/, '') || ENTRY;
    const asset = ASSETS[normalizedPath];
    if (asset == null) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(asset, {
      headers: {
        'content-type': getContentType(normalizedPath),
        'cache-control': 'no-cache',
        ...SECURITY_HEADERS,
      },
    });
  },
};
`,
  };
}

/**
 * Create the app tools that are exposed to the OrchestratorAgent.
 */
export function createAppTools(ctx: AppToolsContext) {
  const { env, sql, agentName: uid } = ctx;

  return {
    previewAppFromPrompt: tool({
      description: 'Generate an app preview from a natural-language product brief without installing it on the desktop. Use this when the user wants to inspect or approve an app before install. When the brief is a change to an app that is already installed, pass its appId — installing that preview reinstalls the same app as a new version (same icon, grants, and storage) instead of creating a second one.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000).describe('Natural-language app request or product brief'),
        appId: z.string().min(1).max(128).optional().describe('Installed app ID when the brief is a change to that app'),
      }),
      needsApproval: true,
      execute: async (input, { toolCallId }) => buildAppPreviewFromPromptWithRetries({ ...ctx, toolCallId }, input.prompt, input.appId),
    }),

    installAppPreview: tool({
      description: 'Install a previously generated app preview onto the user desktop. A preview staged for an installed app reinstalls that app as its next version — same desktop item, grants, and storage.',
      inputSchema: z.object({
        previewId: z.string().min(1).max(128).describe('Preview ID returned by previewAppFromPrompt'),
      }),
      needsApproval: true,
      execute: async (input, { toolCallId }) => installAppPreview({ ...ctx, toolCallId }, input.previewId),
    }),

    buildAppFromPrompt: tool({
      description: 'Generate and create a new app from a natural-language product brief. Use this for most new app requests instead of embedding full source files in the tool call.',
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000).describe('Natural-language app request or product brief'),
      }),
      needsApproval: true,
      execute: async (input, { toolCallId }) => buildAppFromPromptWithRetries({ ...ctx, toolCallId }, input.prompt),
    }),

    createApp: tool({
      description: 'Create a new desktop app from bundled static files. You can provide HTML, CSS, JS, JSON, SVG, images, fonts, and other relative-path assets. The app runs in a sandboxed iframe.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('App name'),
        description: z.string().max(500).optional().describe('Short description'),
        files: z.record(z.string(), z.string()).describe('App source files: { "index.html": "...", "styles.css": "...", "app.js": "..." }'),
        width: z.number().int().min(360).max(1600).optional().default(600).describe('Default window width'),
        height: z.number().int().min(320).max(1200).optional().default(500).describe('Default window height'),
        permissions: permissionsSchema,
        rationale: z.string().max(500).optional().describe('Why the app needs its requested permissions'),
      }),
      needsApproval: true,
      execute: async (input, { toolCallId }) => createAndRegisterApp({ ...ctx, toolCallId }, {
        name: input.name,
        description: input.description,
        files: input.files,
        width: input.width,
        height: input.height,
        permissions: input.permissions,
        rationale: input.rationale,
      }),
    }),

    updateApp: tool({
      description: 'Update an existing app\'s code. Provide the full updated files.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to update'),
        files: z.record(z.string(), z.string()).describe('Updated source files'),
        name: z.string().optional().describe('Updated name'),
        description: z.string().max(500).optional().describe('Updated description'),
        width: z.number().int().min(360).max(1600).optional().describe('Updated default window width'),
        height: z.number().int().min(320).max(1200).optional().describe('Updated default window height'),
      }),
      needsApproval: true,
      execute: async (input, { toolCallId }) => applyRegisteredAppUpdate({ ...ctx, toolCallId }, {
        appId: input.appId,
        files: input.files,
        name: input.name,
        description: input.description,
        width: input.width,
        height: input.height,
        // updateApp edits the app's code as-is: with no permissions passed,
        // the release keeps the app's current declared set, so grants
        // cannot change.
        revisionSummary: (version) => `Agent update (v${version})`,
      }),
    }),

    listApps: tool({
      description: 'List all apps created by the user.',
      inputSchema: z.object({}),
      execute: async () => {
        const response = await env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid)).fetch(new Request('http://internal/items'));
        if (!response.ok) throw new Error('Failed to load desktop apps');
        const items = (await response.json<{ items: DesktopItem[] }>()).items;
        const apps = await Promise.all(items
          .filter((item) => item.type === 'app' && item.appManifest?.appId && !item.isTrashed)
          .map(async (item) => {
            const appId = item.appManifest!.appId;
            const metadata = await env.DESKTOP_KV.get<{ version?: number }>(`app:${appId}`, 'json');
            return {
              id: appId,
              name: item.appManifest?.name || item.name,
              description: item.appManifest?.description || '',
              version: metadata?.version ?? (Number(item.appManifest?.version) || 1),
              created_at: item.createdAt,
            };
          }));
        apps.sort((left, right) => right.created_at - left.created_at);
        return { apps };
      },
    }),

    getAppSource: tool({
      description: 'Get the source files of an existing app so you can see or modify its code.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to read source from'),
      }),
      execute: async (input) => {
        const registered = await getRegisteredDesktopApp(env, uid, input.appId);
        const r2Prefix = registered.metadata.r2Prefix || `apps/${uid}/${input.appId}`;

        const obj = await env.ETERNALOS_FILES.get(`${r2Prefix}/source.json`);
        if (!obj) throw new Error('Source files not found');

        const files = await obj.json<Record<string, string>>();
        const workspaceObj = await env.ETERNALOS_FILES.get(`${r2Prefix}/${APP_WORKSPACE_MANIFEST_FILE}`);
        const workspaceManifest = workspaceObj
          ? await workspaceObj.json<AppWorkspaceManifest>().catch(() => null)
          : null;
        return {
          appId: input.appId,
          name: registered.item.appManifest?.name || registered.item.name,
          files,
          workspaceManifest,
        };
      },
    }),

    callAppApi: tool({
      description: "Call an installed full-stack app's own backend (its server.js, backed by the app's private SQLite database) as the owner. Use it to read or change the app's data for the user — e.g. list the items in their todo app, add an entry to their journal app. Routes are the app's /api/* routes (read getAppSource to see server.js if unsure).",
      inputSchema: z.object({
        appId: z.string().min(1).max(128).describe('Installed app ID (from listApps)'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
        path: z.string().min(1).max(500).describe("Backend path, e.g. '/api/todos' or '/api/todos/3?full=1'"),
        body: z.unknown().optional().describe('JSON body for POST/PUT/PATCH'),
      }),
      // Reads are free; anything that changes the app's data is confirmed.
      needsApproval: async (input) => (input.method ?? 'GET') !== 'GET',
      execute: async (input) => callAppBackend(env, uid, input),
    }),

    readAppApi: tool({
      description: "Read data from an installed full-stack app's backend (GET only) — e.g. list the items in the user's todo or journal app.",
      inputSchema: z.object({
        appId: z.string().min(1).max(128).describe('Installed app ID (from listApps)'),
        path: z.string().min(1).max(500).describe("Backend path, e.g. '/api/todos'"),
      }),
      execute: async (input) => callAppBackend(env, uid, { ...input, method: 'GET' }),
    }),

    getAppBackendLogs: tool({
      description: "Recent console output and uncaught exceptions from an installed app's server.js backend. Use it to debug a full-stack app that returns errors.",
      inputSchema: z.object({
        appId: z.string().min(1).max(128),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: async (input) => {
        const resolved = await resolveInstalledAppBackend(env, input.appId);
        if (!resolved || resolved.ownerUid !== uid) throw new Error(`App ${input.appId} not found`);
        const logs = await env.APP_RUNNER.getByName(appRunnerName('app', input.appId)).getLogs(input.limit);
        return { appId: input.appId, logs };
      },
    }),

    deleteApp: tool({
      description: 'Delete an app from the desktop and clean up its stored data.',
      inputSchema: z.object({
        appId: z.string().describe('The app ID to delete'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const registered = await getRegisteredDesktopApp(env, uid, input.appId);

        // Trash the desktop icon FIRST. If this fails, nothing has been
        // deleted yet and the user keeps a fully working app — the safer
        // half-done state. (Deleting the data first used to leave an inert
        // icon pointing at deleted R2/KV/SQL data when this step failed.)
        const stub = env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid));
        const trashResponse = await stub.fetch(new Request('http://internal/items', {
          method: 'PATCH',
          body: JSON.stringify([{
            id: registered.item.id,
            updates: { isTrashed: true, trashedAt: Date.now() },
          }]),
        }));
        if (!trashResponse.ok) {
          throw new Error('Failed to remove app from desktop');
        }

        // The icon is gone, so the app can no longer be launched. Clean up
        // the backing data best-effort — every store is attempted even if a
        // previous one failed — and report whichever failed. Leftover data
        // is recoverable; a dead icon pointing at deleted data is not.
        const failedCleanup: string[] = [];
        try {
          await deleteR2Prefix(env, `apps/${uid}/${input.appId}/`);
        } catch (error) {
          failedCleanup.push(`app files (${errorText(error)})`);
        }
        try {
          await env.DESKTOP_KV.delete(`app:${input.appId}`);
        } catch (error) {
          failedCleanup.push(`app registry entry (${errorText(error)})`);
        }
        try {
          await purgeAppBackend(env, input.appId);
        } catch (error) {
          failedCleanup.push(`app backend database (${errorText(error)})`);
        }
        try {
          sql.exec('DELETE FROM apps WHERE id = ?', input.appId);
        } catch (error) {
          failedCleanup.push(`app record (${errorText(error)})`);
        }
        if (failedCleanup.length > 0) {
          throw new Error(
            `App removed from the desktop, but cleaning up its data failed: ${failedCleanup.join('; ')}`,
          );
        }

        return { appId: input.appId, status: 'deleted' };
      },
    }),
  };
}
