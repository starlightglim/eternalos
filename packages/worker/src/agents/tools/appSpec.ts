/**
 * Typed AppSpec for the app-builder pipeline (CORE-ROADMAP Workstream 3,
 * Phase A — the explicit spec stage ahead of file generation).
 *
 * `buildSpecFromPrompt` (appTools.ts) asks the build model for one of these
 * via the same structured-output helper the file generator uses. This module
 * is the pure half of the stage:
 *
 *   - `appSpecSchema` — the shape the model produces. Deliberately loose on
 *     semantics (defaults, plain strings for enums the model might invent
 *     values for) so a bad-but-well-shaped spec survives parsing and reaches
 *     `validateAppSpec` instead of dying in a zod error the repair loop
 *     cannot act on.
 *   - `validateAppSpec` — deterministic validation that runs BEFORE any file
 *     is generated. Every problem is collected in one pass as a structured
 *     `AppValidationIssue` (same vocabulary as appBundleValidation), so the
 *     existing repair loop can feed the exact codes back into a spec
 *     regeneration prompt.
 *   - `derivePermissionsFromSpec` — the single source of manifest
 *     permissions. The file generator no longer declares permissions at all;
 *     they are derived from the spec's data declarations, which is what makes
 *     "permission used but not declared" structurally rare: the generator is
 *     told exactly which derived permissions the manifest will carry, and
 *     the pre/post-bundle gates still verify its code stays inside them.
 *
 * What each spec section implies:
 *
 *   dataReads (kind 'fs')  -> fs.read globs and fs.mimeTypes
 *   dataWrites (kind 'fs') -> fs.write globs and (via deletePaths) fs.delete
 *                             globs — the same manifest write shape
 *                             chat-supplied apps declare; whole-desktop
 *                             write scopes require the entry to mark the app
 *                             a file manager (arbitraryFiles)
 *   networkDomains         -> network.outbound host patterns
 *   profileFields          -> profile.read fields
 *   ipcTopics              -> ipc.emit / ipc.listen topics
 *   storageKeys            -> no manifest permission (eternal.storage is
 *                             private, per-app sandboxed KV — always allowed)
 *
 * The spec model chooses WHERE each kind of state lives: dataWrites is for
 * files the user should see and open on their desktop; storageKeys is for the
 * app's own private state. Write mime types are generator guidance only —
 * the manifest's declared write shape carries path globs (there is no
 * write-mime permission field), so that is exactly what derivation emits.
 */

import { z } from 'zod';
import type { AppPermissions } from '../../types';
import type { AppValidationIssue } from '../../utils/appBundleValidation';

// ---------------------------------------------------------------------------
// Schema + type
// ---------------------------------------------------------------------------

/**
 * Data kinds the platform can derive permissions from, for both reads and
 * writes. Anything else the model produces is rejected by `validateAppSpec`
 * with a structured issue (not a zod parse error) so the repair loop can
 * name the supported kinds.
 */
export const APP_SPEC_DATA_KINDS = ['fs'] as const;

export const appSpecSchema = z.object({
  name: z.string().min(1).max(80),
  /** One sentence: what the app does for the user. Becomes the manifest description. */
  purpose: z.string().max(300).default(''),
  /** The screens/views the app is made of. Validated non-empty. */
  screens: z.array(z.object({
    name: z.string().min(1).max(80),
    summary: z.string().max(300).default(''),
    /** What this screen shows when its data is empty or permission is denied. */
    emptyState: z.string().max(300).default(''),
  })).max(12).default([]),
  /** Desktop data the app reads. Each entry implies fs read permissions. */
  dataReads: z.array(z.object({
    kind: z.string().min(1).max(40),
    /** Path globs such as '**', '/Photos/**', '/Notes/*.md', '*.jpg'. */
    paths: z.array(z.string().min(1).max(200)).max(20).optional(),
    /** Mime patterns such as 'image/*', 'text/*', 'application/pdf'. */
    mimeTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
  })).max(10).default([]),
  /**
   * Desktop files the app creates/writes/patches (and deletes) — for files
   * the USER should see on their desktop. Each entry implies fs write (and,
   * via deletePaths, fs delete) permissions.
   */
  dataWrites: z.array(z.object({
    kind: z.string().min(1).max(40),
    /** '/'-rooted path globs the app writes into, e.g. ['/Notes/**']. */
    paths: z.array(z.string().min(1).max(200)).max(20).optional(),
    /** '/'-rooted path globs the app deletes within — scope to what it manages. */
    deletePaths: z.array(z.string().min(1).max(200)).max(20).optional(),
    /** Formats of the written files — generator guidance, derives no permission. */
    mimeTypes: z.array(z.string().min(1).max(100)).max(20).optional(),
    /**
     * True only when the app genuinely manages files across the whole
     * desktop (file managers, batch tools). Gates the '**' write scope.
     */
    arbitraryFiles: z.boolean().default(false),
  })).max(10).default([]),
  /**
   * Server-side backend (server.js) — a real Worker running as a Durable
   * Object Facet with its own SQLite database. Plan it only when the app
   * needs structured/relational data, server-side logic, or should call
   * external APIs from the server. Derives no permission (network calls
   * still go through networkDomains). Generator guidance only.
   */
  backend: z.object({
    /** HTTP routes server.js implements, e.g. 'GET /api/todos', 'POST /api/todos'. */
    routes: z.array(z.string().min(1).max(120)).max(30).default([]),
    /** SQLite tables with their columns, e.g. 'todos(id INTEGER PRIMARY KEY, title TEXT, done INTEGER)'. */
    tables: z.array(z.string().min(1).max(300)).max(20).default([]),
  }).optional(),
  /** eternal.storage keys the app persists to (no permission implied). */
  storageKeys: z.array(z.string().min(1).max(256)).max(50).optional(),
  /** Hostnames the app fetches from via window.eternal.fetch (no scheme/path/port). */
  networkDomains: z.array(z.string().min(1).max(300)).max(20).optional(),
  profileFields: z.array(z.enum(['username', 'displayName', 'bio', 'avatar'])).max(4).optional(),
  // Models often answer `ipcTopics: []` (seen live from llama-4-scout,
  // gpt-oss-120b, and qwen3.8 in text mode), which used to fail the whole
  // spec. An empty list means none; a bare topic list means the app both
  // emits and listens — the resulting permissions are shown at install.
  ipcTopics: z.preprocess(
    (value) => (Array.isArray(value) ? (value.length ? { emit: value, listen: value } : undefined) : value),
    z.object({
      emit: z.array(z.string().min(1).max(120)).max(50).optional(),
      listen: z.array(z.string().min(1).max(120)).max(50).optional(),
    }).optional(),
  ),
  width: z.number().int().min(360).max(1600).default(720),
  height: z.number().int().min(320).max(1200).default(560),
  /** Why the app needs broad scopes, if it requested any. Shown at install. */
  rationale: z.string().max(500).optional(),
});

export type AppSpec = z.infer<typeof appSpecSchema>;

/**
 * System prompt for the spec stage. Permissions are deliberately NOT part of
 * the spec — the platform derives them, so the model plans data usage instead
 * of inventing grant shapes.
 */
export const APP_SPEC_SYSTEM_PROMPT = `You design app specifications for EternalOS before any code is written.

Your job:
- translate a natural-language app request into a compact, typed product spec
- plan the app as screens/views, each with a one-line summary and an empty state
- declare the desktop data the app reads as dataReads, and request the narrowest scopes that still let the app work (prefer mimeTypes like 'image/*' over broad path globs like '**')
- if the app does not need desktop data, omit dataReads entirely — it runs hermetic
- choose WHERE the app's state lives: dataWrites for files the USER should see and open on their desktop (e.g. "save my notes as markdown files"), storageKeys for the app's own private state (settings, drafts, caches — window.eternal.storage, no permission needed)
- declare desktop file writes as dataWrites: kind 'fs', with paths globs the app writes into (e.g. ['/Notes/**']) and, only when the app manages its own files' lifecycle, deletePaths; keep write scopes as narrow as the request allows
- reserve whole-desktop write scopes ('**') for apps that genuinely manage arbitrary user files (file managers, batch tools): such an entry must set arbitraryFiles: true, and the spec should include a rationale
- declare external services as bare hostnames in networkDomains (the frontend calls them through window.eternal.fetch; a backend calls them with plain fetch())
- plan a backend (server.js) when the app manages real records — lists, boards, logs, inventories, trackers, journals, anything with CRUD, search, sorting, or aggregation — or when it should call external APIs server-side. Declare its HTTP routes under /api/ and its SQLite tables. Simple single-value settings/drafts stay in storageKeys; tiny hermetic toys (calculators, clocks, single-screen games) need no backend
- include a short rationale whenever a broad scope ('**', '*') is genuinely required

The platform derives the app's manifest permissions from these declarations; you never write permissions yourself.

Spec fields:
- name: short app name
- purpose: ONE sentence describing what the app does (becomes its description)
- screens: every screen/view (at least one); each has name, summary, and emptyState (what it shows with no data or a denied permission)
- dataReads: desktop data reads; kind must be 'fs'; scope via paths globs ('**', '/Photos/**', '/Notes/*.md', '*.jpg') and/or mimeTypes ('image/*', 'audio/*', 'text/*', 'application/pdf')
- dataWrites: desktop file writes (creates/patches; deletePaths for deletes); kind must be 'fs'; '/'-rooted paths globs like '/Notes/**'; optional mimeTypes say what formats it writes
- backend: optional { routes: ['GET /api/items', 'POST /api/items', ...], tables: ['items(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, created_at INTEGER)'] }
- storageKeys: eternal.storage keys the app will read/write
- networkDomains: bare hostnames only — 'api.example.com', '*.example.com', '*'; never URLs
- profileFields: subset of 'username', 'displayName', 'bio', 'avatar'
- ipcTopics: topics the app emits and/or listens on (exact names or trailing-'*' prefixes)`;

// ---------------------------------------------------------------------------
// Deterministic spec validation
// ---------------------------------------------------------------------------

/** One DNS label: alphanumeric, interior hyphens allowed. */
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** type/subtype with an optional wildcard subtype — 'image/*', 'application/pdf'. */
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&.+^-]*\/(?:\*|[A-Za-z0-9!#$&.+^-]+)$/;

const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f]/;

/**
 * Hostname pattern accepted for network.outbound. Tighter than the manifest's
 * zod regex (no empty/duplicated/hyphen-edge labels, no trailing dot) so
 * anything derived here is guaranteed to pass the manifest schema downstream:
 *   ok:   'api.example.com', '*.example.com', '*', 'localhost'
 *   bad:  'https://api.example.com/x', 'api.example.com:8443', 'exa mple.com', 'example..com', 'example.*'
 */
export function isValidNetworkDomain(domain: string): boolean {
  if (domain === '*') return true;
  const host = domain.startsWith('*.') ? domain.slice(2) : domain;
  if (host.length === 0) return false;
  return host.split('.').every((label) => HOST_LABEL_PATTERN.test(label));
}

/**
 * Path glob the fs policy (utils/fsPolicy.ts pathMatchesGlob) can actually
 * match against "/"-rooted item paths, used for both reads and writes.
 * Relative folder globs ('Photos/**') would silently match nothing, so they
 * are rejected up front:
 *   ok:   '**', the root glob, '/Photos/**', '/Notes/*.md', '*.jpg'
 *   bad:  'Photos/**', a bare '*', '/Photos/../Secret/**', '/Photos//x'
 */
export function isValidFsGlob(glob: string): boolean {
  if (glob === '**' || glob === '/**' || glob === '**/*') return true;
  if (glob.includes('\\') || CONTROL_CHARS_PATTERN.test(glob)) return false;
  if (glob.startsWith('*.')) return !glob.includes('/'); // extension glob: '*.jpg'
  if (!glob.startsWith('/')) return false; // must be absolute
  const segments = glob.split('/').slice(1);
  return segments.length > 0
    && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Globs whose write scope is the entire desktop — see spec/broad-fs-write. */
const WHOLE_DESKTOP_GLOBS = new Set(['**', '/**', '**/*']);

/**
 * eternal.storage key, mirroring EternalService.validateStorageKey exactly:
 * non-empty, at most 256 chars, no ':' (it is the KV namespace separator) and
 * no control characters.
 */
export function isValidStorageKey(key: string): boolean {
  return key.length > 0 && key.length <= 256 && !key.includes(':') && !CONTROL_CHARS_PATTERN.test(key);
}

/**
 * Validate a parsed spec deterministically. Pure and total: collects every
 * issue in one pass (nothing throws) so a single regeneration can fix the
 * whole spec. Run this BEFORE generating files; feed the result into the
 * repair loop as AppValidationError issues.
 */
export function validateAppSpec(spec: AppSpec): AppValidationIssue[] {
  const issues: AppValidationIssue[] = [];

  if (!spec.purpose.trim()) {
    issues.push({
      code: 'spec/missing-purpose',
      message: 'App spec is missing a one-line purpose',
      hint: 'Describe what the app does for the user in one sentence; it becomes the app description.',
    });
  }

  if (spec.screens.length === 0) {
    issues.push({
      code: 'spec/empty-screens',
      message: 'App spec declares no screens/views',
      hint: 'List every screen or view the app offers (at least one), each with a one-line summary.',
    });
  }

  const readsDesktopData = spec.dataReads.length > 0;
  for (const screen of spec.screens) {
    if (readsDesktopData && !screen.emptyState.trim()) {
      issues.push({
        code: 'spec/screen-missing-empty-state',
        file: screen.name,
        message: `Screen "${screen.name}" declares no empty state`,
        hint: 'A data-reading app must say what each screen shows when the data is empty or permission is denied (one sentence).',
      });
    }
  }

  const knownKinds = new Set<string>(APP_SPEC_DATA_KINDS);
  for (const [index, read] of spec.dataReads.entries()) {
    if (!knownKinds.has(read.kind)) {
      issues.push({
        code: 'spec/unknown-permission-kind',
        message: `Data read #${index + 1} declares unknown permission kind "${read.kind}"`,
        hint: `Supported data kinds: ${APP_SPEC_DATA_KINDS.join(', ')}.`,
      });
      continue;
    }
    if ((read.paths?.length ?? 0) === 0 && (read.mimeTypes?.length ?? 0) === 0) {
      issues.push({
        code: 'spec/data-read-without-scope',
        message: `Data read #${index + 1} declares neither paths nor mimeTypes`,
        hint: 'Scope the read with path globs (e.g. ["/Photos/**"]) and/or mime types (e.g. ["image/*"]), or remove it.',
      });
      continue;
    }
    for (const glob of read.paths ?? []) {
      if (!isValidFsGlob(glob)) {
        issues.push({
          code: 'spec/invalid-fs-glob',
          message: `fs read path "${glob}" is not a supported path glob`,
          hint: 'Use "**", an absolute folder glob like "/Photos/**", a file glob like "/Notes/*.md", or an extension glob like "*.jpg".',
        });
      }
    }
    for (const mime of read.mimeTypes ?? []) {
      if (!MIME_TYPE_PATTERN.test(mime)) {
        issues.push({
          code: 'spec/invalid-mime-type',
          message: `fs read mime type "${mime}" is not a valid type/subtype pattern`,
          hint: 'Use a wildcard pattern like "image/*", "audio/*", "text/*", or an exact type like "application/pdf".',
        });
      }
    }
  }

  for (const [index, write] of spec.dataWrites.entries()) {
    if (!knownKinds.has(write.kind)) {
      issues.push({
        code: 'spec/unknown-permission-kind',
        message: `Data write #${index + 1} declares unknown permission kind "${write.kind}"`,
        hint: `Supported data kinds: ${APP_SPEC_DATA_KINDS.join(', ')}.`,
      });
      continue;
    }
    if ((write.paths?.length ?? 0) === 0 && (write.deletePaths?.length ?? 0) === 0) {
      issues.push({
        code: 'spec/data-write-without-scope',
        message: `Data write #${index + 1} declares neither paths nor deletePaths`,
        hint: 'Scope the write with path globs (e.g. ["/Notes/**"]) and, if it deletes, deletePaths — or remove it.',
      });
      continue;
    }
    for (const glob of [...(write.paths ?? []), ...(write.deletePaths ?? [])]) {
      if (!isValidFsGlob(glob)) {
        issues.push({
          code: 'spec/invalid-fs-glob',
          message: `fs write path "${glob}" is not a supported path glob`,
          hint: 'Use an absolute folder glob like "/Notes/**" or a file glob like "/Notes/*.md".',
        });
        continue;
      }
      // A write/delete scope that covers the whole desktop is a file-manager
      // grant. It is only derivable when the spec says so explicitly, so a
      // note-taking app can't quietly land fs.write: ['**'] in the manifest.
      if (!write.arbitraryFiles && WHOLE_DESKTOP_GLOBS.has(glob)) {
        issues.push({
          code: 'spec/broad-fs-write',
          message: `fs write scope "${glob}" covers the whole desktop but the write is not marked arbitraryFiles`,
          hint: 'Scope the write to a folder glob like "/Notes/**", or set arbitraryFiles: true only if the app genuinely manages files across the desktop, and explain why in the rationale.',
        });
      }
    }
    for (const mime of write.mimeTypes ?? []) {
      if (!MIME_TYPE_PATTERN.test(mime)) {
        issues.push({
          code: 'spec/invalid-mime-type',
          message: `fs write mime type "${mime}" is not a valid type/subtype pattern`,
          hint: 'Use a wildcard pattern like "text/*" or an exact type like "text/markdown".',
        });
      }
    }
  }

  for (const domain of spec.networkDomains ?? []) {
    if (!isValidNetworkDomain(domain)) {
      issues.push({
        code: 'spec/invalid-network-domain',
        message: `Network domain "${domain}" is not a hostname pattern`,
        hint: 'Declare bare hostnames only — "api.example.com", "*.example.com", or "*". No scheme, path, port, or spaces.',
      });
    }
  }

  for (const key of spec.storageKeys ?? []) {
    if (!isValidStorageKey(key)) {
      issues.push({
        code: 'spec/invalid-storage-key',
        message: `Storage key "${truncate(key, 60)}" is not a valid eternal.storage key`,
        hint: 'Keys are non-empty, at most 256 characters, with no ":" and no control characters.',
      });
    }
  }

  return dedupeIssues(issues);
}

// ---------------------------------------------------------------------------
// Spec -> manifest permissions
// ---------------------------------------------------------------------------

function dedupe<T>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

/**
 * Derive the manifest AppPermissions from the spec's data declarations.
 * Deterministic and pure: same spec, same permissions (de-duplicated, stable
 * key order fs -> profile -> network -> ipc). `storageKeys` deliberately
 * contribute nothing — eternal.storage is private per-app KV and needs no
 * grant — and write `mimeTypes` contribute nothing either: the manifest's
 * declared write shape is path globs (there is no write-mime permission
 * field), matching what chat-supplied apps declare. Unknown data kinds are
 * skipped here; validateAppSpec rejects them first, so derivation only ever
 * runs on a valid spec.
 */
export function derivePermissionsFromSpec(spec: AppSpec): AppPermissions {
  const permissions: AppPermissions = {};

  const fsRead: string[] = [];
  const fsMime: string[] = [];
  for (const read of spec.dataReads) {
    if (read.kind !== 'fs') continue;
    fsRead.push(...(read.paths ?? []));
    fsMime.push(...(read.mimeTypes ?? []));
  }
  const fsWrite: string[] = [];
  const fsDelete: string[] = [];
  for (const write of spec.dataWrites) {
    if (write.kind !== 'fs') continue;
    fsWrite.push(...(write.paths ?? []));
    fsDelete.push(...(write.deletePaths ?? []));
  }
  const readGlobs = dedupe(fsRead);
  const mimeTypes = dedupe(fsMime);
  const writeGlobs = dedupe(fsWrite);
  const deleteGlobs = dedupe(fsDelete);
  if (readGlobs.length > 0 || mimeTypes.length > 0 || writeGlobs.length > 0 || deleteGlobs.length > 0) {
    permissions.fs = {};
    if (readGlobs.length > 0) permissions.fs.read = readGlobs;
    if (mimeTypes.length > 0) permissions.fs.mimeTypes = mimeTypes;
    if (writeGlobs.length > 0) permissions.fs.write = writeGlobs;
    if (deleteGlobs.length > 0) permissions.fs.delete = deleteGlobs;
  }

  const profileFields = dedupe(spec.profileFields ?? []);
  if (profileFields.length > 0) {
    permissions.profile = { read: profileFields };
  }

  const domains = dedupe(spec.networkDomains ?? []);
  if (domains.length > 0) {
    permissions.network = { outbound: domains };
  }

  const ipcEmit = dedupe(spec.ipcTopics?.emit ?? []);
  const ipcListen = dedupe(spec.ipcTopics?.listen ?? []);
  if (ipcEmit.length > 0 || ipcListen.length > 0) {
    permissions.ipc = {};
    if (ipcEmit.length > 0) permissions.ipc.emit = ipcEmit;
    if (ipcListen.length > 0) permissions.ipc.listen = ipcListen;
  }

  return permissions;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function dedupeIssues(issues: AppValidationIssue[]): AppValidationIssue[] {
  const seen = new Set<string>();
  const result: AppValidationIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}|${issue.file ?? ''}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}
