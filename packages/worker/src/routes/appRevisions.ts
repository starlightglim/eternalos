/**
 * App source revisions — the first slice of the source-first workspace
 * (design/13-source-first-app-workspaces.md, "near-term pragmatic option":
 * source.json stays the workspace serialization; revisions snapshot it).
 *
 * Every successful source save/deploy (routes/apps.ts dev-deploy, restore,
 * rollback, and the agent app tools' create/update installs) writes an
 * immutable revision under
 *
 *   apps/{uid}/{appId}/revisions/{revisionId}/
 *     files.json         — the source files as saved (same shape as source.json)
 *     manifest.json      — who/when/what (kind, author, validity, summary, …)
 *     diagnostics.json   — validation outcome; issues for rejected saves
 *
 * A save that FAILS validation writes the same triple with `valid: false` and
 * the structured issues, so the rejected attempt stays inspectable and the
 * installed bundle is untouched (install = freeze a validated revision).
 * Failed agent updates record the same way (author 'agent'); failed creates
 * record nothing — the app was never registered, so there is no history to
 * attach the attempt to (the dev-deploy create rule).
 *
 * revisionId is `${Date.now()}-${8 hex}` — fixed-width until 2286, so R2's
 * lexicographic key listing doubles as chronological ordering; no separate
 * index needs maintaining.
 *
 * The registry pointers live on the app's KV record (`app:{appId}`):
 * `current_revision` (latest revision, valid or not) and
 * `last_valid_revision` (latest revision that passed validation). Records
 * written before this slice simply lack the fields — `ensureRevisionBaseline`
 * lazily snapshots the app's current source.json as its first revision on
 * the first touch (dev-deploy update or revisions route).
 *
 * Routes in this file (owner-only, same auth as dev-deploy — the dispatcher
 * resolves the Bearer JWT before the handler runs):
 *   GET  /api/apps/:appId/revisions              list revision summaries
 *   GET  /api/apps/:appId/revisions/:revisionId  one revision (files + manifest + diagnostics)
 *
 * The restore route lives in routes/apps.ts next to dev-deploy (it reuses the
 * release-deploy pipeline and the grant-intersection helpers there):
 *   POST /api/apps/:appId/revisions/:revisionId/restore
 *
 * Nothing here rewrites history: restore appends a NEW revision; pruning only
 * ever deletes the oldest objects and always keeps the revisions the
 * registry points at.
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { AppGrantedPermissions } from '../utils/jwt';

// ---------------------------------------------------------------------------
// Constants & types
// ---------------------------------------------------------------------------

/**
 * Revisions kept per app before the oldest R2 objects are pruned. Chosen as
 * 50: a meaningful undo window (~50 saves) at modest cost — a revision is one
 * files.json roughly the size of the app source, which dev-deploy already
 * caps at 6MB per request. The registry's `current_revision` and
 * `last_valid_revision` are always pinned on top of the cap.
 */
export const MAX_APP_REVISIONS = 50;

/** revisionId = `${Date.now()}-${8 hex}` — sortable, URL-safe, R2-key-safe. */
const REVISION_ID_PATTERN = /^[0-9]{9,14}-[A-Za-z0-9]{6,12}$/;

export function isValidRevisionId(id: string): boolean {
  return REVISION_ID_PATTERN.test(id);
}

export function makeRevisionId(now: number = Date.now()): string {
  return `${now}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

export type AppRevisionKind = 'deploy' | 'restore' | 'rollback' | 'backfill';
export type AppRevisionAuthor = 'human' | 'agent';

/** One validation problem, same shape as utils/appBundleValidation issues. */
export interface AppRevisionIssue {
  code: string;
  message: string;
  file?: string;
  evidence?: string;
  hint?: string;
}

export interface AppRevisionDiagnostics {
  valid: boolean;
  issues: AppRevisionIssue[];
}

export interface AppRevisionWindowConfig {
  defaultWidth: number;
  defaultHeight: number;
  resizable?: boolean;
}

/** manifest.json — the revision's identity + the deploy manifest as saved. */
export interface AppRevisionManifest {
  schemaVersion: 1;
  id: string;
  appId: string;
  uid: string;
  kind: AppRevisionKind;
  author: AppRevisionAuthor;
  createdAt: number;
  valid: boolean;
  summary: string;
  /** Registry release version this revision deployed (valid deploys only). */
  appVersion?: number;
  /** Revision this one restored its content from (kind 'restore'), or the
   *  revision the app rolled back FROM (kind 'rollback' — the registry's
   *  current_revision at rollback time; the rolled-back-to side is a
   *  release, recorded as appVersion). */
  parentRevision?: string;
  name?: string;
  description?: string;
  permissions?: AppGrantedPermissions;
  rationale?: string;
  windowConfig?: AppRevisionWindowConfig;
}

/** A revision as stored across its three R2 objects. */
export interface AppRevisionStorage {
  manifest: AppRevisionManifest;
  files: Record<string, string>;
  diagnostics: AppRevisionDiagnostics;
}

export interface WriteAppRevisionInput {
  kind: AppRevisionKind;
  author: AppRevisionAuthor;
  /** Whether this revision passed validation (a failed save writes false). */
  valid: boolean;
  /** Structured validation issues; required when valid is false. */
  issues?: readonly AppRevisionIssue[];
  /** The source files as they were saved (or attempted, for failed saves). */
  files: Record<string, string>;
  summary: string;
  name?: string;
  description?: string;
  permissions?: AppGrantedPermissions;
  rationale?: string;
  windowConfig?: AppRevisionWindowConfig;
  appVersion?: number;
  parentRevision?: string;
}

export interface WrittenAppRevision {
  revisionId: string;
  /** Every R2 key written, so callers can clean up on infra failure. */
  keys: string[];
}

/** Registry record fields this module owns (see routes/apps.ts). */
export interface AppRevisionPointers {
  current_revision?: string;
  last_valid_revision?: string;
}

// ---------------------------------------------------------------------------
// R2 helpers
// ---------------------------------------------------------------------------

function revisionsPrefix(uid: string, appId: string): string {
  return `apps/${uid}/${appId}/revisions/`;
}

async function listRevisionKeys(env: Env, uid: string, appId: string): Promise<string[]> {
  const prefix = revisionsPrefix(uid, appId);
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ETERNALOS_FILES.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Revision ids under the app, oldest first (lexicographic == chronological). */
async function listRevisionIds(env: Env, uid: string, appId: string): Promise<string[]> {
  const marker = '/manifest.json';
  const ids = (await listRevisionKeys(env, uid, appId))
    .filter((key) => key.endsWith(marker))
    .map((key) => key.slice(0, -marker.length).split('/').pop() ?? '');
  return ids.filter((id) => isValidRevisionId(id));
}

// ---------------------------------------------------------------------------
// Write / read / prune
// ---------------------------------------------------------------------------

/**
 * Persist one immutable revision. Never overwrites an existing id (ids are
 * timestamp + random). Returns the keys written so the caller can roll them
 * back on infra failure — validation-failure revisions are deliberately kept.
 */
export async function writeAppRevision(
  env: Env,
  uid: string,
  appId: string,
  input: WriteAppRevisionInput,
  revisionId: string = makeRevisionId(),
): Promise<WrittenAppRevision> {
  const manifest: AppRevisionManifest = {
    schemaVersion: 1,
    id: revisionId,
    appId,
    uid,
    kind: input.kind,
    author: input.author,
    createdAt: Date.now(),
    valid: input.valid,
    summary: input.summary,
    ...(input.appVersion !== undefined ? { appVersion: input.appVersion } : {}),
    ...(input.parentRevision !== undefined ? { parentRevision: input.parentRevision } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    ...(input.windowConfig !== undefined ? { windowConfig: input.windowConfig } : {}),
  };
  const diagnostics: AppRevisionDiagnostics = {
    valid: input.valid,
    issues: input.valid ? [] : (input.issues ?? []).map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.file !== undefined ? { file: issue.file } : {}),
      ...(issue.evidence !== undefined ? { evidence: issue.evidence } : {}),
      ...(issue.hint !== undefined ? { hint: issue.hint } : {}),
    })),
  };

  const base = `${revisionsPrefix(uid, appId)}${revisionId}`;
  const keys = [`${base}/manifest.json`, `${base}/files.json`, `${base}/diagnostics.json`];
  await env.ETERNALOS_FILES.put(`${base}/manifest.json`, JSON.stringify(manifest));
  await env.ETERNALOS_FILES.put(`${base}/files.json`, JSON.stringify(input.files));
  await env.ETERNALOS_FILES.put(`${base}/diagnostics.json`, JSON.stringify(diagnostics));
  return { revisionId, keys };
}

/** Read one revision (manifest + files + diagnostics), or null when absent. */
export async function readAppRevision(
  env: Env,
  uid: string,
  appId: string,
  revisionId: string,
): Promise<AppRevisionStorage | null> {
  if (!isValidRevisionId(revisionId)) return null;
  const base = `${revisionsPrefix(uid, appId)}${revisionId}`;
  const [manifestObj, filesObj, diagnosticsObj] = await Promise.all([
    env.ETERNALOS_FILES.get(`${base}/manifest.json`),
    env.ETERNALOS_FILES.get(`${base}/files.json`),
    env.ETERNALOS_FILES.get(`${base}/diagnostics.json`),
  ]);
  if (!manifestObj || !filesObj) return null;

  try {
    const manifest = await manifestObj.json<AppRevisionManifest>();
    const files = await filesObj.json<Record<string, string>>();
    // Defense in depth: a manifest copied under another app/owner never reads.
    if (manifest.uid !== uid || manifest.appId !== appId || manifest.id !== revisionId) return null;
    const diagnostics = diagnosticsObj
      ? await diagnosticsObj.json<AppRevisionDiagnostics>().catch(() => ({ valid: manifest.valid, issues: [] }))
      : { valid: manifest.valid, issues: [] };
    return { manifest, files, diagnostics };
  } catch {
    return null;
  }
}

/** All revision manifests for an app, newest first. */
export async function listAppRevisionManifests(
  env: Env,
  uid: string,
  appId: string,
): Promise<AppRevisionManifest[]> {
  const ids = await listRevisionIds(env, uid, appId);
  const manifests: AppRevisionManifest[] = [];
  for (const id of ids) {
    const object = await env.ETERNALOS_FILES.get(`${revisionsPrefix(uid, appId)}${id}/manifest.json`);
    if (!object) continue;
    try {
      const manifest = await object.json<AppRevisionManifest>();
      if (manifest.uid !== uid || manifest.appId !== appId) continue;
      manifests.push(manifest);
    } catch {
      continue;
    }
  }
  return manifests.reverse(); // ids list oldest-first → newest first
}

/**
 * Keep the newest `cap` revisions (plus every pinned id) and delete the oldest
 * revision objects. Pinned ids — the registry's current/last-valid pointers —
 * survive even when they fall outside the cap (e.g. a long run of failed
 * saves must not evict the last known-good source).
 */
export async function pruneAppRevisions(
  env: Env,
  uid: string,
  appId: string,
  pinned: ReadonlySet<string>,
  cap: number = MAX_APP_REVISIONS,
): Promise<void> {
  const ids = await listRevisionIds(env, uid, appId); // oldest first
  if (ids.length <= cap) return;

  // The newest `cap` revisions always survive; pinned ids (the registry's
  // current/last-valid pointers) survive even when they fall outside the
  // cap — a long run of failed saves must not evict the last known-good
  // source. Total kept is therefore at most cap + pinned.
  const keep = new Set(ids.slice(-cap));
  for (const id of pinned) keep.add(id);
  const stale = ids.filter((id) => !keep.has(id));
  await Promise.allSettled(stale.map((id) =>
    env.ETERNALOS_FILES.delete(`${revisionsPrefix(uid, appId)}${id}/manifest.json`)));
  await Promise.allSettled(stale.map((id) =>
    env.ETERNALOS_FILES.delete(`${revisionsPrefix(uid, appId)}${id}/files.json`)));
  await Promise.allSettled(stale.map((id) =>
    env.ETERNALOS_FILES.delete(`${revisionsPrefix(uid, appId)}${id}/diagnostics.json`)));
}

// ---------------------------------------------------------------------------
// Lazy registry migration
// ---------------------------------------------------------------------------

/**
 * Give an app created before revisions existed its first revision, from the
 * source.json its registry record points at. Idempotent: records that already
 * carry `current_revision` are returned untouched, and an app with no
 * readable source.json is left as-is (there is nothing to snapshot).
 *
 * Concurrent first touches can each snapshot once (harmless: both revisions
 * hold the same source and the registry keeps the winner).
 */
export async function ensureRevisionBaseline(
  env: Env,
  uid: string,
  appId: string,
  appMeta: AppRevisionPointers & { r2Prefix?: string },
): Promise<AppRevisionPointers> {
  if (appMeta.current_revision) {
    return {
      current_revision: appMeta.current_revision,
      last_valid_revision: appMeta.last_valid_revision,
    };
  }

  const r2Prefix = appMeta.r2Prefix || `apps/${uid}/${appId}`;
  const sourceObj = await env.ETERNALOS_FILES.get(`${r2Prefix}/source.json`);
  if (!sourceObj) return {};
  let files: Record<string, string>;
  try {
    files = await sourceObj.json<Record<string, string>>();
  } catch {
    return {};
  }

  // Best-effort release metadata so the baseline carries name/permissions.
  let release: {
    name?: string; description?: string; permissions?: unknown;
    rationale?: string; version?: number; createdAt?: number; width?: number; height?: number;
  } = {};
  const metadataObj = await env.ETERNALOS_FILES.get(`${r2Prefix}/metadata.json`);
  if (metadataObj) {
    release = await metadataObj.json<typeof release>().catch(() => ({}));
  }

  const written = await writeAppRevision(env, uid, appId, {
    kind: 'backfill',
    author: 'human',
    valid: true,
    files,
    summary: "Imported from the app's current source",
    ...(typeof release.name === 'string' ? { name: release.name } : {}),
    ...(typeof release.description === 'string' ? { description: release.description } : {}),
    ...(release.permissions !== undefined ? { permissions: release.permissions as AppGrantedPermissions } : {}),
    ...(typeof release.rationale === 'string' ? { rationale: release.rationale } : {}),
    ...(typeof release.version === 'number' ? { appVersion: release.version } : {}),
    ...(release.width !== undefined && release.height !== undefined
      ? { windowConfig: { defaultWidth: release.width, defaultHeight: release.height, resizable: true } }
      : {}),
  });

  // Merge onto a fresh read: another request may have touched the record
  // since the caller loaded it (e.g. a grant update). Ownership re-checked
  // so a concurrent registry change can never be overwritten by a stale read.
  const latest = await env.DESKTOP_KV.get<AppRevisionPointers & { uid?: string }>(`app:${appId}`, 'json');
  if (latest && latest.uid === uid) {
    await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({
      ...latest,
      current_revision: written.revisionId,
      last_valid_revision: written.revisionId,
    }));
  }
  return { current_revision: written.revisionId, last_valid_revision: written.revisionId };
}

// ---------------------------------------------------------------------------
// Route handlers — owner-only (same auth mode as dev-deploy)
// ---------------------------------------------------------------------------

async function resolveAppForOwner(
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<{ ok: true; meta: Record<string, unknown> } | { ok: false; response: Response }> {
  const meta = await env.DESKTOP_KV.get<Record<string, unknown>>(`app:${appId}`, 'json');
  if (!meta) {
    return { ok: false, response: Response.json({ error: 'App not found' }, { status: 404 }) };
  }
  if (meta.uid !== auth.uid) {
    return { ok: false, response: Response.json({ error: 'Not authorized' }, { status: 403 }) };
  }
  return { ok: true, meta };
}

/**
 * GET /api/apps/:appId/revisions
 *
 * Summaries (id, createdAt, author, valid, kind, summary), newest first, plus
 * the registry's current/last-valid pointers. Lazily baselines apps whose
 * registry record predates revisions (see ensureRevisionBaseline).
 */
export async function handleAppRevisionsList(
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  const resolved = await resolveAppForOwner(env, auth, appId);
  if (!resolved.ok) return resolved.response;

  // Lazy migration: apps deployed before revisions existed get their current
  // source snapshotted as revision #0 on this first touch.
  const pointers = await ensureRevisionBaseline(env, auth.uid, appId, resolved.meta as AppRevisionPointers);

  const manifests = await listAppRevisionManifests(env, auth.uid, appId);
  return Response.json({
    appId,
    currentRevision: pointers.current_revision ?? null,
    lastValidRevision: pointers.last_valid_revision ?? null,
    revisions: manifests.map((manifest) => ({
      id: manifest.id,
      createdAt: manifest.createdAt,
      author: manifest.author,
      valid: manifest.valid,
      kind: manifest.kind,
      summary: manifest.summary,
      ...(manifest.appVersion !== undefined ? { appVersion: manifest.appVersion } : {}),
      ...(manifest.parentRevision !== undefined ? { parentRevision: manifest.parentRevision } : {}),
      ...(manifest.name !== undefined ? { name: manifest.name } : {}),
    })),
  });
}

/**
 * GET /api/apps/:appId/revisions/:revisionId
 *
 * One revision: manifest, diagnostics, and the saved files (the inputs for a
 * client-side per-file diff against any other revision or the working copy).
 */
export async function handleAppRevisionGet(
  env: Env,
  auth: AuthContext,
  appId: string,
  revisionId: string,
): Promise<Response> {
  if (!isValidRevisionId(revisionId)) {
    return Response.json({ error: 'Invalid revision ID' }, { status: 400 });
  }
  const resolved = await resolveAppForOwner(env, auth, appId);
  if (!resolved.ok) return resolved.response;

  const revision = await readAppRevision(env, auth.uid, appId, revisionId);
  if (!revision) {
    return Response.json({ error: 'Revision not found' }, { status: 404 });
  }

  const { manifest, files, diagnostics } = revision;
  return Response.json({
    appId,
    revision: {
      id: manifest.id,
      createdAt: manifest.createdAt,
      author: manifest.author,
      valid: manifest.valid,
      kind: manifest.kind,
      summary: manifest.summary,
      ...(manifest.appVersion !== undefined ? { appVersion: manifest.appVersion } : {}),
      ...(manifest.parentRevision !== undefined ? { parentRevision: manifest.parentRevision } : {}),
      ...(manifest.name !== undefined ? { name: manifest.name } : {}),
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      ...(manifest.permissions !== undefined ? { permissions: manifest.permissions } : {}),
      ...(manifest.rationale !== undefined ? { rationale: manifest.rationale } : {}),
      ...(manifest.windowConfig !== undefined ? { windowConfig: manifest.windowConfig } : {}),
      diagnostics,
    },
    files,
  });
}
