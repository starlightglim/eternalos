/**
 * Deterministic post-bundle validation for EternalOS apps.
 *
 * Runs after a generated/dev-supplied app workspace has been assembled into a
 * Dynamic Worker bundle (createWorkerModuleFiles → createWorker) and before
 * anything is persisted or installed. Everything here is pure and synchronous:
 * the same files, manifest, permissions, and compiled bundle always produce the
 * same issues in the same order. That determinism is what lets (a) the
 * app-builder repair loop consume the output as a checklist and (b) the
 * dev-deploy route promise a 4xx (never 500) for client-supplied bad bundles.
 *
 * What is checked, and the runtime contract each check enforces:
 *
 *   1. Bridge contract — apps may only call `window.eternal` namespaces and
 *      methods the injected runtime actually defines; anything else is a
 *      guaranteed `TypeError` at runtime (`bridge/unknown-*`).
 *   2. Declared-permission coverage — every `window.eternal` call must be
 *      backed by a matching declared permission, and every call whose scope
 *      argument is a string literal must fall inside what was declared
 *      (fs.list/fs.write paths, ipc topics). Undeclared *usage* duplicates
 *      the pre-bundle source gate (validateGeneratedApp) as defense in depth;
 *      the *coverage* checks catch the silent runtime failure mode the
 *      pre-bundle gate cannot see (empty fs.list results, 403 on fs.write,
 *      dropped IPC messages).
 *   3. Entrypoint/asset packaging — the manifest's entry HTML must exist,
 *      every asset referenced from HTML (src=/href=) or CSS (url()) must be a
 *      file in the bundle, local module imports must resolve to bundled files,
 *      and named/default imports must exist on their target modules
 *      (`asset/missing`, `module/missing`, `module/missing-export`).
 *   4. Sandbox availability — browser APIs the app iframe cannot provide
 *      (opaque-origin storage, geolocation/camera/microphone, Workers, direct
 *      external network) are reported together with the bridge alternative
 *      (`sandbox/blocked-*`, `sandbox/external-network`).
 *   5. Compiled-bundle contract — the createWorker result must contain its
 *      entry module, that module must export a default fetch handler, and
 *      every manifest-declared source file must be packaged into it
 *      (`bundle/*`).
 *
 * False-positive policy: checks only fire on code the scanner is confident
 * about. Comments, regex bodies, and string contents are blanked before
 * identifier scans, and scope/URL arguments are only checked when they are
 * plain string literals. When in doubt the validator stays silent: a false
 * negative costs one runtime error report, a false positive blocks a working
 * app.
 *
 * Deliberately NOT flagged (documented so the list stays intentional):
 *   - alert/confirm/prompt and window.open — silent no-ops in the sandbox
 *     iframe, not crashes; apps may degrade on purpose.
 *   - Guarded opaque-origin storage probes — `typeof localStorage`,
 *     `'localStorage' in window`, and access lexically inside a `try { … }`
 *     block. The try/catch pattern is the standard way to survive the
 *     SecurityError, and feature detects never touch the throwing accessor's
 *     value. Unguarded access still fails deterministically and stays an
 *     error.
 *   - Relative (same-origin) fetch/XHR — allowed by the served CSP; used for
 *     bundled asset fetches.
 *   - fs.read/readText/urlFor path coverage — those calls take item *ids*
 *     obtained from fs.list, so there is no literal scope argument to check.
 */

import type { AppPermissions } from '../types';
import { pathMatchesGlob } from './fsPolicy';

// ---------------------------------------------------------------------------
// Backend (server.js) files
// ---------------------------------------------------------------------------

/**
 * Full-stack apps may ship a server-side handler: `server.js` (entry) plus any
 * helper modules under `server/`. Those files are bundled into the app's
 * Dynamic Worker as a Durable Object Facet (own SQLite) — they are never
 * served to the browser, and the browser-sandbox checks below do not apply
 * to them.
 */
export const APP_BACKEND_ENTRY_FILE = 'server.js';

export function isBackendFile(name: string): boolean {
  return name === APP_BACKEND_ENTRY_FILE || name.startsWith('server/');
}

export function splitBackendFiles(files: Record<string, string>): {
  frontend: Record<string, string>;
  backend: Record<string, string>;
} {
  const frontend: Record<string, string> = {};
  const backend: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    (isBackendFile(name) ? backend : frontend)[name] = content;
  }
  return { frontend, backend };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One deterministic, actionable problem found in an app bundle. */
export interface AppValidationIssue {
  /** Stable machine-readable identifier, e.g. 'asset/missing'. */
  code: string;
  /** Human-readable one-liner; deterministic for the same input. */
  message: string;
  /** Source file the problem was found in, when known. */
  file?: string;
  /** Short evidence snippet from that file, when available. */
  evidence?: string;
  /** Concrete fix for the repair loop to apply. */
  hint?: string;
}

/**
 * Structural manifest contract. Kept local (and minimal) so this module never
 * imports from the agent tools; `AppWorkspace['manifest']` satisfies it.
 */
export interface AppWorkspaceContract {
  entryHtml: string;
  sourceFiles: string[];
  runtimeAsset: string;
  workerEntrypoint?: string;
}

/** The compiled Dynamic Worker bundle as produced by createWorker(). */
export interface CompiledAppBundle {
  mainModule: string;
  modules: Record<string, string | { js?: string; cjs?: string }>;
}

export interface AppBundleValidationInput {
  files: Record<string, string>;
  manifest: AppWorkspaceContract;
  /** Declared (requested) permissions — not the granted subset. */
  permissions?: AppPermissions;
  /** Compiled bundle; when present the compiled-contract checks run too. */
  compiled?: CompiledAppBundle;
}

/**
 * Typed validation failure carrying every issue found in one pass. The
 * dev-deploy route maps this to HTTP 400 (never 500) and includes the full
 * issue list in the response body; the app-builder repair loop formats the
 * issues into the regeneration prompt.
 */
export class AppValidationError extends Error {
  readonly issues: readonly AppValidationIssue[];

  constructor(issues: readonly AppValidationIssue[], messageOverride?: string) {
    const list: readonly AppValidationIssue[] = issues.length > 0
      ? issues
      : [{
        code: 'validation/unknown',
        message: messageOverride ?? 'App validation failed',
        hint: 'Validation failed without reporting any structured issue. Regenerate the app from scratch; if this repeats, the validation pipeline is dropping its issues.',
      }];
    super(messageOverride ?? buildValidationMessage(list));
    this.name = 'AppValidationError';
    this.issues = list;
  }
}

function buildValidationMessage(issues: readonly AppValidationIssue[]): string {
  if (issues.length === 1) return issues[0].message;
  const numbered = issues.map((issue, index) => `  ${index + 1}. ${issue.message}`).join('\n');
  return `App bundle validation failed with ${issues.length} problem(s):\n${numbered}`;
}

// ---------------------------------------------------------------------------
// Formatting for prompts / API bodies
// ---------------------------------------------------------------------------

/**
 * Render issues as a numbered, fix-oriented block. This exact block is what
 * the app-builder repair prompt embeds so the model gets every problem at
 * once instead of one error per regeneration round-trip.
 */
export function formatAppValidationIssues(issues: readonly AppValidationIssue[]): string {
  if (issues.length === 0) return 'No problems found.';
  return issues
    .map((issue, index) => {
      const location = issue.file ? ` — ${issue.file}` : '';
      const evidence = issue.evidence ? `\n     at: ${truncate(issue.evidence)}` : '';
      const hint = issue.hint ? `\n     fix: ${issue.hint}` : '';
      return `  ${index + 1}. [${issue.code}]${location}\n     ${issue.message}${evidence}${hint}`;
    })
    .join('\n');
}

function truncate(text: string, maxLength = 100): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Run every post-bundle check and collect *all* issues (nothing throws on the
 * first problem — the repair loop wants the complete list).
 */
export function collectAppBundleIssues(input: AppBundleValidationInput): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];
  const { frontend, backend } = splitBackendFiles(input.files);
  const frontendInput = { ...input, files: frontend };
  const scans = scanAppFiles(frontend);

  checkEntryHtml(frontendInput, issues);
  checkUndeclaredUsage(scans, input.permissions, issues);
  checkBridgeApi(scans, issues);
  checkPermissionCoverage(scans, input.permissions, issues);
  checkSandboxAvailability(scans, issues);
  checkAssetReferences(frontendInput, scans, issues);
  checkModuleGraph(frontend, scans, issues);
  checkBackend(backend, input.permissions, issues);
  checkApiWiring(scans, frontend, backend, issues);
  if (input.compiled) {
    checkCompiledBundle(input.manifest, input.compiled, issues, Object.keys(backend).length > 0);
  }

  return dedupeIssues(issues);
}

/**
 * Undeclared window.eternal usage. Semantics mirror the pre-bundle source
 * gate (validateGeneratedApp) so both layers speak the same vocabulary; this
 * one scans the comment/string-stripped code stream, so prose that merely
 * *mentions* an API cannot trip it. In the wired pipeline the pre-bundle gate
 * fires first — this is the module's own guarantee when used standalone.
 */
function checkUndeclaredUsage(
  scans: AppFileScan[],
  permissions: AppPermissions | undefined,
  issues: AppValidationIssue[],
): void {
  const usesFsRead = /\beternal\.fs\.(?:list|read|readText|readJson|urlFor)\s*\(/;
  const usesFsWrite = /\beternal\.fs\.(?:write|patch)\s*\(/;
  const usesFsDelete = /\beternal\.fs\.delete\s*\(/;
  const usesProfile = /\beternal\.profile\./;
  const usesNetwork = /\beternal\.fetch\s*\(/;
  const usesIpcEmit = /\beternal\.ipc\.emit\s*\(/;
  const usesIpcListen = /\beternal\.ipc\.on\s*\(/;

  for (const scan of jsScans(scans)) {
    if (
      usesFsRead.test(scan.code) &&
      !(permissions?.fs?.read?.length || permissions?.fs?.mimeTypes?.length)
    ) {
      issues.push({
        code: 'permission/undeclared-fs-read',
        file: scan.name,
        message: 'App reads through window.eternal.fs but did not declare fs read permissions',
        hint: 'Declare fs: { read: [...] } or fs: { mimeTypes: [...] } in the manifest permissions.',
      });
    }
    if (usesFsWrite.test(scan.code) && !permissions?.fs?.write?.length) {
      issues.push({
        code: 'permission/undeclared-fs-write',
        file: scan.name,
        message: 'App writes through window.eternal.fs but did not declare fs write permissions',
        hint: 'Declare fs: { write: [...] } in the manifest permissions.',
      });
    }
    if (usesFsDelete.test(scan.code) && !permissions?.fs?.delete?.length) {
      issues.push({
        code: 'permission/undeclared-fs-delete',
        file: scan.name,
        message: 'App deletes through window.eternal.fs but did not declare fs delete permissions',
        hint: 'Declare fs: { delete: [...] } in the manifest permissions.',
      });
    }
    if (usesProfile.test(scan.code) && !permissions?.profile?.read?.length) {
      issues.push({
        code: 'permission/undeclared-profile',
        file: scan.name,
        message: 'App uses window.eternal.profile but did not declare profile permissions',
        hint: "Declare profile: { read: ['username', 'displayName', …] } in the manifest permissions.",
      });
    }
    if (usesNetwork.test(scan.code) && !permissions?.network?.outbound?.length) {
      issues.push({
        code: 'permission/undeclared-network',
        file: scan.name,
        message: 'App uses window.eternal.fetch but did not declare network permissions',
        hint: "Declare network: { outbound: ['api.example.com'] } in the manifest permissions.",
      });
    }
    if (usesIpcEmit.test(scan.code) && !permissions?.ipc?.emit?.length) {
      issues.push({
        code: 'permission/undeclared-ipc-emit',
        file: scan.name,
        message: 'App emits IPC messages but did not declare ipc emit permissions',
        hint: 'Declare ipc: { emit: [topic] } in the manifest permissions.',
      });
    }
    if (usesIpcListen.test(scan.code) && !permissions?.ipc?.listen?.length) {
      issues.push({
        code: 'permission/undeclared-ipc-listen',
        file: scan.name,
        message: 'App listens for IPC messages but did not declare ipc listen permissions',
        hint: 'Declare ipc: { listen: [topic] } in the manifest permissions.',
      });
    }
  }
}

/** Collect issues and throw {@link AppValidationError} when any were found. */
export function assertAppBundleValid(input: AppBundleValidationInput): void {
  const issues = collectAppBundleIssues(input);
  if (issues.length > 0) {
    throw new AppValidationError(issues);
  }
}

function dedupeIssues(issues: AppValidationIssue[]): AppValidationIssue[] {
  const seen = new Set<string>();
  const result: AppValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}|${issue.file ?? ''}|${issue.message}|${issue.evidence ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Source scanning — quote/comment aware, position-stable
// ---------------------------------------------------------------------------

interface ScriptScan {
  /**
   * Code stream: comments, regex bodies, and string *contents* blanked
   * (delimiters kept). Same length as the input, so offsets line up.
   */
  code: string;
  /**
   * Mixed stream: comments and regex bodies blanked, string contents intact.
   * Same length as the input — used to read string literals at offsets found
   * in the code stream.
   */
  mixed: string;
}

interface AppFileScan {
  name: string;
  kind: 'js' | 'html' | 'css' | 'other';
  code: string;
  mixed: string;
  /** HTML only: comment-stripped markup, for src/href attribute scanning. */
  markup?: string;
  /** CSS only: comment-stripped stylesheet, for url() scanning. */
  css?: string;
}

const BLANK = ' ';

function blankChar(ch: string): string {
  return ch === '\n' ? '\n' : BLANK;
}

function blankRange(target: string, start: number, end: number): string {
  if (end <= start) return target;
  return target.slice(0, start) + Array.from(target.slice(start, end), blankChar).join('') + target.slice(end);
}

/**
 * Minimal quote/comment/regex-aware JavaScript scanner. Not a parser: its only
 * job is to produce two same-length views of the source so later regexes can
 * (a) match identifiers without hitting comments, prose strings, or regex
 * bodies, and (b) read the string literal at a known offset. Misclassifying
 * an ambiguous `/` can only blank a region (a false *negative* for the scans),
 * never invent matches.
 */
export function scanScript(source: string): ScriptScan {
  const length = source.length;
  let code = source;
  let mixed = source;

  type State = 'code' | 'single' | 'double' | 'template' | 'regex' | 'regexClass';
  let state: State = 'code';
  let i = 0;
  let lastSignificant = '';
  let templateBraceDepth: number[] = [];
  let stringStart = -1;
  let regexStart = -1;

  const isIdent = (ch: string) => /[\w$]/.test(ch);

  while (i < length) {
    const ch = code[i];
    const next = i + 1 < length ? code[i + 1] : '';

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        const lineEnd = source.indexOf('\n', i);
        const end = lineEnd === -1 ? length : lineEnd;
        mixed = blankRange(mixed, i, end);
        code = blankRange(code, i, end);
        i = end;
        continue;
      }
      if (ch === '/' && next === '*') {
        const close = source.indexOf('*/', i + 2);
        const end = close === -1 ? length : close + 2;
        mixed = blankRange(mixed, i, end);
        code = blankRange(code, i, end);
        i = end;
        continue;
      }
      if (ch === '/' && !/[\w$)\]}'"]/.test(lastSignificant)) {
        // A regex literal (division would require a value before the slash).
        state = 'regex';
        regexStart = i;
        i += 1;
        continue;
      }
      if (ch === "'") {
        state = 'single';
        stringStart = i;
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = 'double';
        stringStart = i;
        i += 1;
        continue;
      }
      if (ch === '`') {
        state = 'template';
        stringStart = i;
        i += 1;
        continue;
      }
      if (ch === '{' && templateBraceDepth.length > 0) {
        templateBraceDepth[templateBraceDepth.length - 1] += 1;
      } else if (ch === '}' && templateBraceDepth.length > 0) {
        const depth = --templateBraceDepth[templateBraceDepth.length - 1];
        if (depth === 0) {
          templateBraceDepth.pop();
          state = 'template';
          stringStart = i;
          i += 1;
          continue;
        }
      }
      if (!/\s/.test(ch)) lastSignificant = ch;
      i += 1;
      continue;
    }

    if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (ch === '\\') {
        code = blankRange(code, i, Math.min(i + 2, length));
        i += 2;
        continue;
      }
      if (ch === quote) {
        code = blankRange(code, stringStart + 1, i);
        i += 1;
        state = 'code';
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'template') {
      if (ch === '\\') {
        code = blankRange(code, i, Math.min(i + 2, length));
        i += 2;
        continue;
      }
      if (ch === '`') {
        code = blankRange(code, stringStart + 1, i);
        i += 1;
        state = 'code';
        continue;
      }
      if (ch === '$' && next === '{') {
        code = blankRange(code, stringStart + 1, i);
        templateBraceDepth.push(1);
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === 'regex') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '[') {
        state = 'regexClass';
        i += 1;
        continue;
      }
      if (ch === '/' || ch === '\n') {
        // Blank the regex body in both streams (keep the delimiters).
        mixed = blankRange(mixed, regexStart + 1, i);
        code = blankRange(code, regexStart + 1, i);
        state = 'code';
      }
      i += 1;
      continue;
    }

    if (state === 'regexClass') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === ']') state = 'regex';
      i += 1;
      continue;
    }
  }

  return { code, mixed };
}

const HTML_SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

function stripHtmlComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, (match) => Array.from(match, blankChar).join(''));
}

function isExecutableScript(attrs: string): boolean {
  if (/\bsrc\s*=/i.test(attrs)) return false; // external script: content is ignored
  const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
  if (typeMatch) {
    const type = typeMatch[1].toLowerCase();
    if (type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') {
      return false; // data block (type="text/plain" etc.) — never executes
    }
  }
  return true;
}

function scanAppFiles(files: Record<string, string>): AppFileScan[] {
  return Object.keys(files)
    .sort()
    .map((name) => {
      const content = files[name];
      if (name.endsWith('.html') || name === 'html') {
        const markup = stripHtmlComments(content);
        const scripts: string[] = [];
        HTML_SCRIPT_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = HTML_SCRIPT_PATTERN.exec(markup)) !== null) {
          if (isExecutableScript(match[1])) scripts.push(match[2]);
        }
        const scans = scripts.map((script) => scanScript(script));
        return {
          name,
          kind: 'html' as const,
          code: scans.map((scan) => scan.code).join('\n;\n'),
          mixed: scans.map((scan) => scan.mixed).join('\n;\n'),
          markup,
        };
      }
      if (name.endsWith('.js') || name.endsWith('.mjs')) {
        const scan = scanScript(content);
        return { name, kind: 'js' as const, code: scan.code, mixed: scan.mixed };
      }
      if (name.endsWith('.css') || name === 'css') {
        return { name, kind: 'css' as const, code: '', mixed: '', css: content.replace(/\/\*[\s\S]*?\*\//g, (m) => Array.from(m, blankChar).join('')) };
      }
      return { name, kind: 'other' as const, code: '', mixed: '' };
    });
}

function jsScans(scans: AppFileScan[]): AppFileScan[] {
  return scans.filter((scan) => (scan.kind === 'js' || scan.kind === 'html') && scan.code.length > 0);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Read the string literal that starts at `offset` in a mixed stream. */
function stringLiteralAt(stream: string, offset: number): string | null {
  const quote = stream[offset];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let value = '';
  for (let i = offset + 1; i < stream.length; i += 1) {
    const ch = stream[i];
    if (ch === '\\') {
      value += stream[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (ch === quote) return value;
    if (quote !== '`' && ch === '\n') return null;
    value += ch;
  }
  return null;
}

/** Literals containing template placeholders can't be checked deterministically. */
function isCheckableLiteral(value: string | null): value is string {
  return value !== null && !value.includes('${');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function joinList(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

// ---------------------------------------------------------------------------
// Check 1 — entry HTML
// ---------------------------------------------------------------------------

function checkEntryHtml(input: AppBundleValidationInput, issues: AppValidationIssue[]): void {
  if (!(input.manifest.entryHtml in input.files)) {
    issues.push({
      code: 'entry/missing-html',
      message: `The manifest entry HTML "${input.manifest.entryHtml}" is not present in the app files`,
      hint: 'Include the entry HTML file (usually index.html) in the bundle.',
    });
  }
}

// ---------------------------------------------------------------------------
// Check 2 — window.eternal bridge contract
// ---------------------------------------------------------------------------

const BRIDGE_MEMBERS: Record<string, ReadonlySet<string>> = {
  fs: new Set(['list', 'read', 'readText', 'readJson', 'urlFor', 'write', 'patch', 'delete']),
  profile: new Set(['get']),
  window: new Set(['setTitle', 'close', 'requestFocus', 'resize']),
  onIntent: new Set([]), // called directly: eternal.onIntent(cb)
  storage: new Set(['get', 'set', 'delete', 'list']),
  ipc: new Set(['emit', 'on']),
  fetch: new Set([]), // called directly: eternal.fetch(url, init)
  api: new Set(['fetch', 'get', 'post', 'put', 'patch', 'delete', 'onChange']), // app's own server.js
};

const BRIDGE_NAMESPACES = Object.keys(BRIDGE_MEMBERS);

function checkBridgeApi(scans: AppFileScan[], issues: AppValidationIssue[]): void {
  const bridgePattern = /\beternal\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g;
  for (const scan of jsScans(scans)) {
    bridgePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = bridgePattern.exec(scan.code)) !== null) {
      const namespace = match[1];
      const method = match[2];
      if (!(namespace in BRIDGE_MEMBERS)) {
        issues.push({
          code: 'bridge/unknown-namespace',
          file: scan.name,
          evidence: match[0],
          message: `window.eternal.${namespace} does not exist on the window.eternal bridge; the call would throw at runtime`,
          hint: `Available namespaces: ${BRIDGE_NAMESPACES.join(', ')}.`,
        });
        continue;
      }
      const members = BRIDGE_MEMBERS[namespace];
      if (method !== undefined && members.size > 0 && !members.has(method)) {
        issues.push({
          code: 'bridge/unknown-method',
          file: scan.name,
          evidence: match[0],
          message: `window.eternal.${namespace}.${method} does not exist; the call would throw at runtime`,
          hint: `Valid eternal.${namespace} members: ${Array.from(members).join(', ')}.`,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 3 — declared-permission coverage (literals only)
// ---------------------------------------------------------------------------

/**
 * Mirrors the parent-frame topic matcher (AppViewer.topicMatches): exact match,
 * '*', or a trailing '*' prefix.
 */
function topicMatches(topic: string, patterns: readonly string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => (
    pattern === '*' || pattern === topic || (pattern.endsWith('*') && topic.startsWith(pattern.slice(0, -1)))
  ));
}

function checkPermissionCoverage(
  scans: AppFileScan[],
  permissions: AppPermissions | undefined,
  issues: AppValidationIssue[],
): void {
  const fsReadGlobs = permissions?.fs?.read;
  const fsMimeTypes = permissions?.fs?.mimeTypes;
  const fsWriteGlobs = permissions?.fs?.write;
  const ipcEmitTopics = permissions?.ipc?.emit;
  const ipcListenTopics = permissions?.ipc?.listen;

  const listCall = /\beternal\.fs\.list\s*\(\s*\{\s*path\s*:\s*/g;
  const writeCall = /\beternal\.fs\.write\s*\(\s*\{\s*path\s*:\s*/g;
  const ipcEmitCall = /\beternal\.ipc\.emit\s*\(\s*/g;
  const ipcOnCall = /\beternal\.ipc\.on\s*\(\s*/g;

  for (const scan of jsScans(scans)) {
    for (const match of iterateCodeMatches(scan, listCall)) {
      const literal = match.literal;
      if (!isCheckableLiteral(literal)) continue;
      if (fsMimeTypes?.length) continue; // mime grants cover any path
      if (!fsReadGlobs?.length) continue; // undeclared usage is the pre-bundle gate's job
      const covered = fsReadGlobs.some((glob) => pathMatchesGlob(literal, glob));
      if (!covered) {
        issues.push({
          code: 'permission/fs-read-uncovered',
          file: scan.name,
          evidence: match.evidence,
          message: `eternal.fs.list({ path: "${literal}" }) is not covered by the declared fs.read globs (${joinList(fsReadGlobs)}); at runtime it would return no items`,
          hint: `Declare the folder you list (e.g. fs.read: ${JSON.stringify([`${literal}/**`])}) or list a covered path.`,
        });
      }
    }

    for (const match of iterateCodeMatches(scan, writeCall)) {
      const literal = match.literal;
      if (!isCheckableLiteral(literal)) continue;
      if (!fsWriteGlobs?.length) continue;
      const covered = fsWriteGlobs.some((glob) => pathMatchesGlob(literal, glob));
      if (!covered) {
        issues.push({
          code: 'permission/fs-write-uncovered',
          file: scan.name,
          evidence: match.evidence,
          message: `eternal.fs.write({ path: "${literal}" }) is not covered by the declared fs.write globs (${joinList(fsWriteGlobs)}); at runtime the write would be rejected with 403`,
          hint: `Declare the target folder (e.g. fs.write: ${JSON.stringify([`${literal}/**`])}) or write to a covered path.`,
        });
      }
    }

    for (const match of iterateCodeMatches(scan, ipcEmitCall)) {
      const literal = match.literal;
      if (!isCheckableLiteral(literal)) continue;
      if (!ipcEmitTopics?.length) continue;
      if (!topicMatches(literal, ipcEmitTopics)) {
        issues.push({
          code: 'permission/ipc-emit-uncovered',
          file: scan.name,
          evidence: match.evidence,
          message: `eternal.ipc.emit("${literal}", …) is not covered by the declared ipc.emit topics (${joinList(ipcEmitTopics)}); the parent frame would silently drop the message`,
          hint: `Declare the topic (e.g. ipc.emit: ${JSON.stringify([literal])}) or emit on a declared topic.`,
        });
      }
    }

    for (const match of iterateCodeMatches(scan, ipcOnCall)) {
      const literal = match.literal;
      if (!isCheckableLiteral(literal)) continue;
      if (!ipcListenTopics?.length) continue;
      if (!topicMatches(literal, ipcListenTopics)) {
        issues.push({
          code: 'permission/ipc-listen-uncovered',
          file: scan.name,
          evidence: match.evidence,
          message: `eternal.ipc.on("${literal}", …) is not covered by the declared ipc.listen topics (${joinList(ipcListenTopics)}); no message would ever be delivered on it`,
          hint: `Declare the topic (e.g. ipc.listen: ${JSON.stringify([literal])}) or listen on a declared topic.`,
        });
      }
    }
  }
}

/**
 * Match a call-opening pattern on the code stream, then read the string literal
 * that starts right after the match from the (position-aligned) mixed stream.
 */
function* iterateCodeMatches(
  scan: AppFileScan,
  pattern: RegExp,
): Generator<{ literal: string | null; evidence: string }> {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(scan.code)) !== null) {
    const literalOffset = match.index + match[0].length;
    const evidenceStart = Math.max(0, match.index - 24);
    const evidenceEnd = Math.min(scan.mixed.length, literalOffset + 60);
    yield {
      literal: stringLiteralAt(scan.mixed, literalOffset),
      evidence: scan.mixed.slice(evidenceStart, evidenceEnd).trim(),
    };
  }
}

// ---------------------------------------------------------------------------
// Check 4 — sandbox availability
// ---------------------------------------------------------------------------

const SANDBOX_STORAGE_HINT =
  'Use window.eternal.storage (get/set/list/delete) — the platform bridge — for state that must persist, and plain in-memory variables otherwise.';

/**
 * Spans of `try { … }` blocks in the (comment/string-stripped) code stream.
 * The brace walk only sees real code braces: string, comment, and regex
 * bodies are blanked, and template-expression braces are balanced pairs, so
 * the depth count holds even inside templates.
 */
function computeTryGuardedSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const tryPattern = /\btry\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = tryPattern.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          spans.push([open, i]);
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * Storage references that must NOT be flagged:
 *   - a `typeof X` feature-detect (incl. the parenthesized `typeof (X)` form);
 *   - an `'X' in window` probe — the probed name lives in a string literal,
 *     which is blanked in the code stream, so it never matches at all;
 *   - any reference lexically inside a `try { … }` block — a try/catch is the
 *     standard way to survive the SecurityError the opaque origin throws.
 *
 * Everything else is a deterministic runtime crash and stays an error. Note a
 * bare `if (window.localStorage)` guard does NOT pass: the property *read*
 * itself throws, so flagging it is correct.
 */
function isGuardedStorageReference(
  code: string,
  matchStart: number,
  trySpans: ReadonlyArray<readonly [number, number]>,
): boolean {
  const prefix = code.slice(Math.max(0, matchStart - 24), matchStart);
  if (/\btypeof\s*(?:\(\s*)?$/.test(prefix)) return true;
  return trySpans.some(([start, end]) => matchStart >= start && matchStart <= end);
}

function checkSandboxAvailability(scans: AppFileScan[], issues: AppValidationIssue[]): void {
  const blockedStorage: Array<[RegExp, string]> = [
    [/\b(?:window\.)?localStorage\b/g, 'localStorage'],
    [/\b(?:window\.)?sessionStorage\b/g, 'sessionStorage'],
    [/\bindexedDB\b/g, 'indexedDB'],
    [/\bdocument\s*\.\s*cookie\b/g, 'document.cookie'],
  ];
  // Calls, not bare references: `if (navigator.mediaDevices)` is a harmless
  // feature-detect, while these calls deterministically fail (media is denied
  // by the served permissions policy; opaque origins cannot start workers).
  // They fail even inside a try/catch (getUserMedia rejects asynchronously;
  // Worker construction throws), so no guard exemption applies to them.
  const blockedMedia: Array<[RegExp, string]> = [
    [/\bgeolocation\s*\.\s*(?:getCurrentPosition|watchPosition)\s*\(/, 'geolocation.getCurrentPosition()'],
    [/\bgetUserMedia\s*\(/, 'getUserMedia()'],
  ];
  const blockedWorker: Array<[RegExp, string]> = [
    [/\bnew\s+Worker\s*\(/, 'new Worker()'],
    [/\bnew\s+SharedWorker\s*\(/, 'new SharedWorker()'],
    [/\bserviceWorker\s*\.\s*register\s*\(/, 'serviceWorker.register()'],
  ];

  for (const scan of jsScans(scans)) {
    const trySpans = computeTryGuardedSpans(scan.code);
    for (const [pattern, api] of blockedStorage) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(scan.code)) !== null) {
        if (isGuardedStorageReference(scan.code, match.index, trySpans)) continue;
        issues.push({
          code: 'sandbox/blocked-storage',
          file: scan.name,
          evidence: api,
          message: `${api} is not available: the app iframe runs with an opaque origin, so storage access throws a SecurityError at runtime`,
          hint: SANDBOX_STORAGE_HINT,
        });
      }
    }
    for (const [pattern, api] of blockedMedia) {
      if (pattern.test(scan.code)) {
        issues.push({
          code: 'sandbox/blocked-media',
          file: scan.name,
          evidence: api,
          message: `${api} is disabled: the served permissions policy denies camera, microphone, and geolocation to app iframes`,
          hint: 'There is no bridge alternative; design the app to work without device sensors.',
        });
      }
    }
    for (const [pattern, api] of blockedWorker) {
      if (pattern.test(scan.code)) {
        issues.push({
          code: 'sandbox/blocked-worker',
          file: scan.name,
          evidence: api,
          message: `${api} cannot start: worker scripts cannot be loaded from the sandboxed iframe's opaque origin`,
          hint: 'Move the work onto the main thread (or onto the platform via window.eternal).',
        });
      }
    }

    for (const call of checkExternalNetworkCalls(scan)) {
      issues.push({
        code: 'sandbox/external-network',
        file: scan.name,
        evidence: call.evidence,
        message: `Direct network access to external URLs is blocked by the app sandbox CSP (connect-src 'self')`,
        hint: 'Declare network.outbound hosts and call window.eternal.fetch(url) — the allowlisted proxy. For bundled data, fetch a relative path like "./data.json".',
      });
    }
  }
}

function isExternalUrlLiteral(literal: string | null): boolean {
  return literal !== null && (/^(?:https?:)?\/\//i.test(literal) || /^wss?:\/\//i.test(literal));
}

/** Index just past the string literal that starts at `offset`, or null. */
function skipString(stream: string, offset: number): number | null {
  const quote = stream[offset];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  for (let i = offset + 1; i < stream.length; i += 1) {
    const ch = stream[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote !== '`' && ch === '\n') return null;
  }
  return null;
}

function* checkExternalNetworkCalls(scan: AppFileScan): Generator<{ evidence: string }> {
  // Global fetch only — `eternal.fetch(...)` and friends are preceded by '.'.
  const fetchCall = /(?<![.\w$])fetch\s*\(\s*/g;
  const wsCall = /\bnew\s+WebSocket\s*\(\s*/g;
  const esCall = /\bnew\s+EventSource\s*\(\s*/g;
  const beaconCall = /\bsendBeacon\s*\(\s*/g;
  const xhrOpenCall = /\.open\s*\(\s*(?=['"`])/g;

  for (const match of iterateCodeMatches(scan, fetchCall)) {
    if (isExternalUrlLiteral(match.literal)) yield { evidence: match.evidence };
  }
  // WebSockets can only connect to absolute wss:// URLs — all of which are
  // outside the sandbox's connect-src.
  for (const match of iterateCodeMatches(scan, wsCall)) {
    if (match.literal !== null) yield { evidence: match.evidence };
  }
  for (const match of iterateCodeMatches(scan, esCall)) {
    if (isExternalUrlLiteral(match.literal)) yield { evidence: match.evidence };
  }
  for (const match of iterateCodeMatches(scan, beaconCall)) {
    if (isExternalUrlLiteral(match.literal)) yield { evidence: match.evidence };
  }
  // XHR: `.open(method, url)` — both arguments are string literals. The call
  // structure is matched on the code stream, both literals read from the
  // aligned mixed stream.
  xhrOpenCall.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = xhrOpenCall.exec(scan.code)) !== null) {
    const start = match.index + match[0].length;
    const methodEnd = skipString(scan.mixed, start);
    if (methodEnd === null) continue;
    const separator = scan.mixed.slice(methodEnd, methodEnd + 16).match(/^\s*,\s*(?=['"`])/);
    if (!separator) continue;
    const url = stringLiteralAt(scan.mixed, methodEnd + separator[0].length);
    if (isExternalUrlLiteral(url)) {
      yield { evidence: scan.mixed.slice(Math.max(0, match.index - 24), Math.min(scan.mixed.length, methodEnd + separator[0].length + 60)).trim() };
    }
  }
}

// ---------------------------------------------------------------------------
// Check 5 — asset references
// ---------------------------------------------------------------------------

function isSkippableRef(ref: string): boolean {
  if (!ref) return true;
  // Any scheme-prefixed value (data:, mailto:, javascript:, blob:, about:, …)
  // is not a local path. http(s) fall here too; external refs are the
  // pre-bundle gate's business.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return true;
  if (ref.startsWith('#') || ref.startsWith('/')) return true; // fragment / origin-root — a different serving surface
  return false;
}

function normalizeRef(ref: string): string {
  return ref.split(/[?#]/, 1)[0].replace(/^\.\//, '').replace(/^\//, '');
}

function checkAssetReferences(
  input: AppBundleValidationInput,
  scans: AppFileScan[],
  issues: AppValidationIssue[],
): void {
  const knownAssets = new Set([...input.manifest.sourceFiles, input.manifest.runtimeAsset]);
  const attrPattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;

  for (const scan of scans) {
    if (scan.kind === 'html' && scan.markup) {
      attrPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = attrPattern.exec(scan.markup)) !== null) {
        const ref = match[1].trim();
        if (isSkippableRef(ref)) continue;
        if (!knownAssets.has(normalizeRef(ref))) {
          issues.push({
            code: 'asset/missing',
            file: scan.name,
            evidence: match[0],
            message: `Missing local asset "${ref}" referenced from ${scan.name}`,
            hint: 'Add the file to the bundle or remove the reference (assets must ship inside the app).',
          });
        }
      }
    }
    if (scan.kind === 'css' && scan.css) {
      cssUrlPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = cssUrlPattern.exec(scan.css)) !== null) {
        const ref = (match[1] ?? match[2] ?? match[3] ?? '').trim();
        if (isSkippableRef(ref)) continue;
        if (!knownAssets.has(normalizeRef(ref))) {
          issues.push({
            code: 'asset/missing',
            file: scan.name,
            evidence: match[0],
            message: `Missing local asset "${ref}" referenced from ${scan.name} (CSS url())`,
            hint: 'Add the file to the bundle or remove the url() reference.',
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 6 — module graph (local imports resolve + exports exist)
// ---------------------------------------------------------------------------

function resolveSpecifier(importer: string, specifier: string): string | null {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const segments = importer.split('/');
  segments.pop(); // drop the filename, keep the directory
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

const IMPORT_FROM_PATTERN =
  /\bimport\s+(?:(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}|([A-Za-z_$][\w$]*)|\*\s*as\s+[A-Za-z_$][\w$]*)\s*from\s*/g;
const SIDE_EFFECT_IMPORT_PATTERN = /\bimport\s*(?=['"`])/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(?=['"`])/g;

interface ParsedImport {
  defaultName?: string;
  named: string[];
  specifier: string;
  offset: number;
}

function collectImports(scan: AppFileScan): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const patterns: Array<{ pattern: RegExp; clause: boolean }> = [
    { pattern: IMPORT_FROM_PATTERN, clause: true },
    { pattern: SIDE_EFFECT_IMPORT_PATTERN, clause: false },
    { pattern: DYNAMIC_IMPORT_PATTERN, clause: false },
  ];

  for (const { pattern, clause } of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(scan.code)) !== null) {
      const specifierOffset = match.index + match[0].length;
      const specifier = stringLiteralAt(scan.mixed, specifierOffset);
      if (specifier === null) continue;
      if (clause) {
        const defaultWithNamed = match[1];
        const namedClause = match[2];
        const defaultOnly = match[3];
        const named = (namedClause ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
          // `import { a as b }` requires the module to export `a` (the name
          // before the alias).
          .map((entry) => entry.split(/\s+as\s+/)[0].trim())
          .filter((entry) => entry.length > 0 && entry !== ',');
        imports.push({
          defaultName: defaultWithNamed ?? defaultOnly,
          named,
          specifier,
          offset: match.index,
        });
      } else {
        imports.push({ named: [], specifier, offset: match.index });
      }
    }
  }

  return imports.sort((left, right) => left.offset - right.offset);
}

const EXPORT_DECL_PATTERN = /\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_PATTERN = /\bexport\s*\{([^}]*)\}/g;

function exportedNames(targetCode: string): { names: Set<string>; hasDefault: boolean; isWildcard: boolean } {
  if (/\bexport\s*\*/.test(targetCode)) {
    return { names: new Set(), hasDefault: true, isWildcard: true };
  }
  const names = new Set<string>();
  let match: RegExpExecArray | null;
  EXPORT_DECL_PATTERN.lastIndex = 0;
  while ((match = EXPORT_DECL_PATTERN.exec(targetCode)) !== null) {
    names.add(match[1]);
  }
  EXPORT_LIST_PATTERN.lastIndex = 0;
  while ((match = EXPORT_LIST_PATTERN.exec(targetCode)) !== null) {
    for (const entry of match[1].split(',')) {
      // `export { local as exported }` exports the *alias*.
      const parts = entry.trim().split(/\s+as\s+/);
      const exported = (parts[1] ?? parts[0] ?? '').trim();
      if (exported) names.add(exported);
    }
  }
  return { names, hasDefault: /\bexport\s+default\b/.test(targetCode), isWildcard: false };
}

function checkModuleGraph(
  files: Record<string, string>,
  scans: AppFileScan[],
  issues: AppValidationIssue[],
): void {
  const scanByName = new Map(scans.map((scan) => [scan.name, scan]));

  for (const scan of jsScans(scans)) {
    for (const appImport of collectImports(scan)) {
      const { specifier } = appImport;
      const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
      const resolved = isRelative ? resolveSpecifier(scan.name, specifier) : null;

      if (!isRelative) {
        // Bare specifier — there is no package manager or import map in the
        // app sandbox, so the browser can never resolve it.
        issues.push({
          code: 'module/missing',
          file: scan.name,
          evidence: specifier,
          message: `Module import "${specifier}" in ${scan.name} is a bare specifier — the app sandbox has no package manager, so the browser cannot resolve it`,
          hint: 'Bundle the code as a local file and import it with a relative path (e.g. "./utils.js").',
        });
        continue;
      }

      if (resolved === null || !(resolved in files)) {
        issues.push({
          code: 'module/missing',
          file: scan.name,
          evidence: specifier,
          message: `Module import "${specifier}" in ${scan.name} does not resolve to a file in the bundle${resolved === null ? '' : ` (expected "${resolved}")`}`,
          hint: 'Include the imported file (exact name and extension) in the bundle, or fix the path.',
        });
        continue;
      }

      if (appImport.named.length === 0 && !appImport.defaultName) continue;
      if (!/\.(?:js|mjs)$/.test(resolved)) continue; // JSON/other modules have no export surface to check
      const targetScan = scanByName.get(resolved);
      const targetCode = targetScan?.code ?? scanScript(files[resolved]).code;
      const exports = exportedNames(targetCode);
      if (exports.isWildcard) continue; // re-export surface unknown — stay silent

      for (const name of appImport.named) {
        if (!exports.names.has(name)) {
          issues.push({
            code: 'module/missing-export',
            file: scan.name,
            evidence: specifier,
            message: `${scan.name} imports { ${name} } from "${specifier}" but that module does not export "${name}"`,
            hint: `Export it (e.g. "export function ${name}() { … }") or import a name that exists.`,
          });
        }
      }
      if (appImport.defaultName && !exports.hasDefault) {
        issues.push({
          code: 'module/missing-export',
          file: scan.name,
          evidence: specifier,
          message: `${scan.name} imports the default export of "${specifier}" but that module has no default export`,
          hint: 'Add "export default …" to the module, or use a named import.',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check 7 — compiled-bundle contract
// ---------------------------------------------------------------------------

/**
 * Server-side handler contract. The backend runs in a Dynamic Worker facet:
 * real Workers runtime (fetch(), Request/Response, crypto), its own SQLite
 * via env.sql / env.storage, outbound fetch limited to the granted
 * network.outbound hosts. No DOM, no window.eternal.
 */
function checkBackend(
  backend: Record<string, string>,
  permissions: AppPermissions | undefined,
  issues: AppValidationIssue[],
): void {
  const names = Object.keys(backend).sort();
  if (names.length === 0) return;
  const entry = backend[APP_BACKEND_ENTRY_FILE];
  if (entry === undefined) {
    issues.push({
      code: 'backend/entry-missing',
      file: names[0],
      message: `Files under server/ require a ${APP_BACKEND_ENTRY_FILE} entry`,
      hint: `Add ${APP_BACKEND_ENTRY_FILE} with \`export default { async fetch(request, env) { … } }\`, or move the helpers out of server/.`,
    });
    return;
  }
  const entryCode = scanScript(entry).code;
  const hasDefault = /\bexport\s+default\b/.test(entryCode)
    || /\bexport\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(entryCode);
  if (!hasDefault) {
    issues.push({
      code: 'backend/default-export-missing',
      file: APP_BACKEND_ENTRY_FILE,
      message: `${APP_BACKEND_ENTRY_FILE} must export a default handler`,
      hint: 'Use `export default { async fetch(request, env) { … return Response.json(data); } }`.',
    });
  }
  for (const name of names) {
    const scan = scanScript(backend[name]);
    if (/\b(?:window|document|localStorage|sessionStorage)\s*\./.test(scan.code)) {
      issues.push({
        code: 'backend/browser-global',
        file: name,
        message: `${name} uses a browser global (window/document/localStorage) — the backend runs in a Worker, not the browser`,
        hint: 'Persist with env.sql (SQLite) or env.storage instead of localStorage, and keep DOM code in the frontend files.',
      });
    }
    // Bare specifiers have no package manager to resolve from. Relative
    // imports and the cloudflare:* runtime modules are fine.
    const importPattern = /\b(?:from\s+|import\s*\(\s*|import\s+)(["'])([^"']+)\1/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(scan.mixed)) !== null) {
      const specifier = match[2];
      if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('cloudflare:')) continue;
      issues.push({
        code: 'backend/bare-import',
        file: name,
        evidence: specifier,
        message: `${name} imports "${specifier}", which cannot be resolved — there is no package manager`,
        hint: 'Inline the logic or import a bundled local module such as "./server/db.js".',
      });
    }
    if (callsGlobalFetch(scan.code) && !permissions?.network?.outbound?.length) {
      issues.push({
        code: 'backend/undeclared-network',
        file: name,
        message: `${name} calls fetch() but the app declares no network.outbound hosts — outbound requests will be blocked`,
        hint: "Declare network: { outbound: ['api.example.com'] } for the hosts the backend calls.",
      });
    }
  }
}

/**
 * True when code makes an outbound global fetch() call. The handler's own
 * `async fetch(request, env) { … }` method definition and member calls such
 * as `handler.fetch(req)` are not outbound network use; `globalThis.fetch(`
 * and `self.fetch(` are.
 */
export function callsGlobalFetch(code: string): boolean {
  const withoutDefinitions = code.replace(/(?:\basync\s+)?\bfetch\s*\([^()]*\)\s*\{/g, ' ');
  return /(?<![.\w$])fetch\s*\(/.test(withoutDefinitions)
    || /\b(?:globalThis|self)\s*\.\s*fetch\s*\(/.test(withoutDefinitions);
}

/**
 * eternal.api.* reaches the app's server.js; without one every call 404s.
 * And ./api/* is the backend's mount, so no static asset may live there.
 */
function checkApiWiring(
  scans: AppFileScan[],
  frontend: Record<string, string>,
  backend: Record<string, string>,
  issues: AppValidationIssue[],
): void {
  if (!(APP_BACKEND_ENTRY_FILE in backend)) {
    const apiPattern = /\beternal\.api\b/;
    const offender = jsScans(scans).find((scan) => apiPattern.test(scan.code));
    if (offender) {
      issues.push({
        code: 'backend/api-without-server',
        file: offender.name,
        message: 'App calls window.eternal.api but ships no server.js backend',
        hint: `Add ${APP_BACKEND_ENTRY_FILE} implementing the routes the frontend calls, or persist with eternal.storage instead.`,
      });
    }
  }
  for (const name of Object.keys(frontend).sort()) {
    if (name.startsWith('api/')) {
      issues.push({
        code: 'asset/reserved-api-path',
        file: name,
        message: `"${name}" is under api/, which is reserved for the app backend`,
        hint: 'Move the file to another folder (for example data/).',
      });
    }
  }
}

function checkCompiledBundle(
  manifest: AppWorkspaceContract,
  compiled: CompiledAppBundle,
  issues: AppValidationIssue[],
  hasBackend = false,
): void {
  const entry = compiled.modules[compiled.mainModule];
  if (entry === undefined) {
    issues.push({
      code: 'bundle/entrypoint-missing',
      message: `The compiled app bundle is missing its entry module "${compiled.mainModule}"`,
      hint: 'Platform bundling failure, not an app-source problem. Regenerate (or re-deploy) the app so the bundler re-emits the entry module; editing source files cannot fix it.',
    });
    return;
  }
  const content = typeof entry === 'string' ? entry : (entry.js ?? '');
  // esbuild's ESM output for a default-export entrypoint comes in two shapes:
  // the literal `export default …`, or its normalized form
  // `export { name as default }`. Either satisfies the Worker Loader
  // contract; neither is optional.
  const hasDefaultExport = /\bexport\s+default\b/.test(content)
    || /\bexport\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(content);
  if (!hasDefaultExport) {
    issues.push({
      code: 'bundle/entrypoint-export-missing',
      message: `The compiled worker entrypoint "${compiled.mainModule}" does not export a default fetch handler`,
      hint: 'Platform bundling failure, not an app-source problem: the emitted entry lacks the Worker Loader contract (`export default { async fetch(request, env) { … } }`). Regenerate (or re-deploy) the app rather than editing source files.',
    });
  }
  if (hasBackend && !/\bAppBackend\b/.test(content)) {
    issues.push({
      code: 'bundle/backend-export-missing',
      message: `The compiled worker entrypoint "${compiled.mainModule}" does not export the AppBackend facet class`,
      hint: 'Platform bundling failure, not an app-source problem. Regenerate (or re-deploy) the app.',
    });
  }
  for (const name of [...manifest.sourceFiles.filter((file) => !isBackendFile(file)), manifest.runtimeAsset]) {
    const quoted = JSON.stringify(name);
    if (!content.includes(quoted) && !content.includes(`'${name}'`)) {
      issues.push({
        code: 'bundle/asset-not-packaged',
        message: `Source file "${name}" was not packaged into the compiled bundle`,
        hint: 'Platform bundling failure, not an app-source problem: the bundler skipped a declared file. Regenerate (or re-deploy) the app so every declared file is re-embedded; editing source files cannot fix it.',
      });
    }
  }
}
