/**
 * Code Mode run bookkeeping — pure functions, no I/O, unit-tested.
 *
 * A Code Mode run is a sandboxed JS function that calls the platform's tools.
 * To make runs legible and reversible, every inner tool call is described in
 * plain language:
 *
 *  - describeAction: what a state-changing call WOULD do — shown in the
 *    approval card after a practice ("dry") run, so the user approves
 *    "Add book to Shelf: title “Dune”", not a wall of JavaScript.
 *  - describeStep: a one-line label for each call as it happens, streamed to
 *    the chat so the user sees the run work step by step.
 *  - plan*Inverse: how to reverse a write that succeeded, from the call, its
 *    result, and the state read just before it ran. The inverses are stored
 *    per run and power the result card's Undo button.
 *  - dryRunResult: the stand-in result a write returns during the practice
 *    run (nothing is changed).
 *  - nextRoutineRun: when a saved routine runs next.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PlannedAction {
  tool: string;
  summary: string;
  detail?: string;
}

export interface RunStep {
  id: number;
  tool: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  write: boolean;
}

export type InverseOp =
  | {
    kind: 'app';
    appId: string;
    method: Exclude<HttpMethod, 'GET'>;
    path: string;
    body?: unknown;
    summary: string;
    /** Set when this op re-creates a deleted record that had this id. */
    restoresId?: string;
  }
  | { kind: 'desktop'; patches: Array<{ id: string; updates: Record<string, unknown> }>; summary: string };

export interface DesktopItemLike {
  id: string;
  name: string;
  type?: string;
  parentId?: string | null;
  isTrashed?: boolean;
}

/** Looks up display names while describing a call. All lookups are optional. */
export interface DescribeContext {
  appName?: (appId: string) => string | undefined;
  itemName?: (itemId: string) => string | undefined;
}

/* ------------------------------------------------------------------ *
 * Small text helpers
 * ------------------------------------------------------------------ */

const MAX_VALUE_CHARS = 48;

function clip(text: string, max = MAX_VALUE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return `“${clip(value)}”`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return clip(JSON.stringify(value));
}

/** "title “Dune”, author “Frank Herbert”" — at most four fields. */
export function summarizeFields(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body === undefined ? undefined : formatValue(body);
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (!entries.length) return undefined;
  const shown = entries.slice(0, 4).map(([key, value]) => {
    // Flags read as yes/no: { is_read: 1 } → "read: yes".
    const flag = /^(?:is|has)_?([a-z].*)$/i.exec(key);
    if (flag && (typeof value === 'boolean' || value === 0 || value === 1)) {
      return `${flag[1].replace(/_/g, ' ').toLowerCase()}: ${value ? 'yes' : 'no'}`;
    }
    return `${key.replace(/_/g, ' ')}: ${formatValue(value)}`;
  });
  if (entries.length > 4) shown.push(`+${entries.length - 4} more`);
  return shown.join(', ');
}

function singular(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us)$/.test(word)) return word;
  if (/(?:ches|shes|xes)$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

function looksLikeId(segment: string): boolean {
  return /^\d+$/.test(segment) || /^[0-9a-f-]{8,}$/i.test(segment) || /^:/.test(segment);
}

function stripQuery(path: string): string {
  return (path.split('?')[0] || '/').replace(/\/+$/, '') || '/';
}

/** "/api/books/12" → { noun: "book", id: "12", collection: "/api/books" }. */
export function parseResourcePath(path: string): { noun: string; id?: string; collection: string } {
  const clean = stripQuery(path);
  const segments = clean.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  const hasId = segments.length > 1 && looksLikeId(last);
  const nounSegment = (hasId ? segments.at(-2) : last) ?? '';
  const noun = nounSegment && nounSegment !== 'api'
    ? singular(nounSegment.toLowerCase().replace(/[-_]+/g, ' '))
    : 'entry';
  const collection = hasId ? `/${segments.slice(0, -1).join('/')}` : clean;
  return { noun, id: hasId ? last : undefined, collection };
}

function appLabel(appId: unknown, ctx: DescribeContext): string {
  const id = typeof appId === 'string' ? appId : '';
  return ctx.appName?.(id) ?? (id ? `app ${id.slice(0, 8)}` : 'an app');
}

function itemLabel(itemId: string, ctx: DescribeContext): string {
  const name = ctx.itemName?.(itemId);
  return name ? `“${clip(name, 40)}”` : 'an item';
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ *
 * Actions (what a write would do)
 * ------------------------------------------------------------------ */

interface AppCallInput {
  appId?: unknown;
  method?: unknown;
  path?: unknown;
  body?: unknown;
}

function describeAppWrite(input: AppCallInput, ctx: DescribeContext): PlannedAction {
  const method = String(input.method ?? 'GET').toUpperCase();
  const path = typeof input.path === 'string' ? input.path : '/';
  const app = appLabel(input.appId, ctx);
  const { noun, id } = parseResourcePath(path);
  const target = id ? `${noun} #${id}` : noun;
  const detail = summarizeFields(input.body);
  if (method === 'POST') return { tool: 'callAppApi', summary: `Add ${noun} to ${app}`, detail };
  if (method === 'DELETE') return { tool: 'callAppApi', summary: `Delete ${target} from ${app}` };
  return { tool: 'callAppApi', summary: `Update ${target} in ${app}`, detail };
}

/** Plain-language description of a state-changing tool call. */
export function describeAction(tool: string, rawInput: unknown, ctx: DescribeContext = {}): PlannedAction {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'callAppApi':
      return describeAppWrite(input, ctx);
    case 'createTextNote': {
      const where = typeof input.folderId === 'string' ? ` in ${itemLabel(input.folderId, ctx)}` : ' on the desktop';
      const content = typeof input.content === 'string' ? clip(input.content, 80) : undefined;
      return { tool, summary: `Create note “${clip(String(input.name ?? 'Untitled'), 40)}”${where}`, detail: content };
    }
    case 'createFolder': {
      const ids = Array.isArray(input.itemIds) ? input.itemIds : [];
      const moving = ids.length ? ` and move ${countLabel(ids.length, 'item')} into it` : '';
      return { tool, summary: `Create folder “${clip(String(input.folderName ?? 'Untitled'), 40)}”${moving}` };
    }
    case 'moveItems': {
      const ids = Array.isArray(input.itemIds) ? input.itemIds.filter((v): v is string => typeof v === 'string') : [];
      const target = typeof input.targetFolderId === 'string' ? itemLabel(input.targetFolderId, ctx) : 'the desktop';
      const names = ids.slice(0, 3).map((itemId) => ctx.itemName?.(itemId)).filter(Boolean) as string[];
      return {
        tool,
        summary: `Move ${countLabel(ids.length, 'item')} to ${target}`,
        detail: names.length ? names.map((n) => `“${clip(n, 32)}”`).join(', ') + (ids.length > names.length ? ', …' : '') : undefined,
      };
    }
    default:
      return { tool, summary: `Run ${tool}`, detail: summarizeFields(input) };
  }
}

/* ------------------------------------------------------------------ *
 * Steps (live labels for every call in a real run)
 * ------------------------------------------------------------------ */

function backendDetail(result: unknown): string | undefined {
  const res = (result ?? {}) as { status?: unknown; data?: unknown; ok?: unknown };
  if (typeof res.status !== 'number') return undefined;
  const count = Array.isArray(res.data) ? ` · ${countLabel(res.data.length, 'record')}` : '';
  return `${res.status}${res.ok === false ? ' (failed)' : ''}${count}`;
}

/** "/api/books" → "books", "/api/books/3" → "book #3". */
function readTarget(path: string): string {
  const { noun, id } = parseResourcePath(path);
  if (id) return `${noun} #${id}`;
  const last = stripQuery(path).split('/').filter(Boolean).at(-1) ?? '';
  return last && last !== 'api' ? last.toLowerCase().replace(/[-_]+/g, ' ') : 'data';
}

/** The label shown while a call runs (result unknown yet). */
export function describeStepStart(tool: string, rawInput: unknown, write: boolean, ctx: DescribeContext = {}): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  if (write) return describeAction(tool, input, ctx).summary;
  switch (tool) {
    case 'listApps': return 'List your apps';
    case 'getAppSource': return `Read the source of ${appLabel(input.appId, ctx)}`;
    case 'readAppApi':
    case 'callAppApi': return `Read ${readTarget(String(input.path ?? '/'))} from ${appLabel(input.appId, ctx)}`;
    case 'getAppBackendLogs': return `Read the logs of ${appLabel(input.appId, ctx)}`;
    case 'getDesktopOverview': return 'Look over the desktop';
    case 'searchDesktop': return `Search the desktop for “${clip(String(input.query ?? ''), 32)}”`;
    case 'readTextFile': return `Read “${clip(String(input.name ?? input.id ?? 'a file'), 40)}”`;
    default: return `Run ${tool}`;
  }
}

/** The detail shown once a call finished. */
export function describeStepResult(tool: string, result: unknown): string | undefined {
  const res = (result ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'listApps':
      return Array.isArray(res.apps) ? `${countLabel(res.apps.length, 'app')} found` : undefined;
    case 'getAppSource':
      return res.files && typeof res.files === 'object' ? countLabel(Object.keys(res.files).length, 'file') : undefined;
    case 'readAppApi':
    case 'callAppApi':
      return backendDetail(result);
    case 'getAppBackendLogs':
      return Array.isArray(res.logs) ? countLabel(res.logs.length, 'line') : undefined;
    case 'getDesktopOverview':
      return typeof res.totalActiveItems === 'number' ? countLabel(res.totalActiveItems, 'item') : undefined;
    case 'searchDesktop':
      return typeof res.totalMatches === 'number' ? `${res.totalMatches} match${res.totalMatches === 1 ? '' : 'es'}` : undefined;
    case 'readTextFile':
      return res.found === false ? 'not found' : typeof res.content === 'string' ? `${res.content.length} characters` : undefined;
    case 'createTextNote':
      return 'created';
    case 'createFolder':
      return typeof res.movedCount === 'number' ? `created, ${countLabel(res.movedCount, 'item')} moved` : 'created';
    case 'moveItems':
      return typeof res.movedCount === 'number' ? `${countLabel(res.movedCount, 'item')} moved` : undefined;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Dry run: what a write returns during the practice run
 * ------------------------------------------------------------------ */

/**
 * A plausible stand-in result, so the code keeps going down the same path
 * it would take for real (it reads `.ok`, `.status`, `.data.id`...).
 */
export function dryRunResult(tool: string, rawInput: unknown): unknown {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'callAppApi': {
      const method = String(input.method ?? 'GET').toUpperCase();
      const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body : {};
      const { id } = parseResourcePath(String(input.path ?? '/'));
      return {
        status: method === 'POST' ? 201 : 200,
        ok: true,
        dryRun: true,
        data: method === 'DELETE' ? { ok: true } : { id: id ?? 'new', ...body },
      };
    }
    case 'createTextNote':
      return { note: { id: 'dry-run-note', name: input.name, type: 'text' }, location: 'Desktop', characters: String(input.content ?? '').length, dryRun: true };
    case 'createFolder': {
      const ids = Array.isArray(input.itemIds) ? input.itemIds : [];
      return { folder: { id: 'dry-run-folder', name: input.folderName, type: 'folder' }, movedCount: ids.length, movedItems: [], dryRun: true };
    }
    case 'moveItems':
      return { movedCount: Array.isArray(input.itemIds) ? input.itemIds.length : 0, dryRun: true };
    default:
      return { ok: true, dryRun: true };
  }
}

/* ------------------------------------------------------------------ *
 * Undo planning
 * ------------------------------------------------------------------ */

/** Where to read an app record's current state before PATCH/PUT/DELETE. */
export function appPreReadPaths(method: string, path: string): { itemPath: string; collection: string; id?: string } | null {
  const upper = method.toUpperCase();
  if (upper !== 'PATCH' && upper !== 'PUT' && upper !== 'DELETE') return null;
  const parsed = parseResourcePath(path);
  return { itemPath: stripQuery(path), collection: parsed.collection, id: parsed.id };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Pick the record with `id` out of a GET result (a record, a list, or an envelope like { books: [...] }). */
export function findRecord(data: unknown, id: string | undefined): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    if (id === undefined) return null;
    return asRecord(data.find((entry) => String(asRecord(entry)?.id ?? '') === id));
  }
  const record = asRecord(data);
  if (!record) return null;
  if ('id' in record) return id === undefined || String(record.id) === id ? record : null;
  for (const value of Object.values(record)) {
    const nested = Array.isArray(value) || asRecord(value) ? findRecord(value, id) : null;
    if (nested) return nested;
  }
  return null;
}

/** The id of a record a POST created, from common response shapes. */
export function createdRecordId(data: unknown): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  for (const key of ['id', 'insertedId', 'lastInsertRowid', 'rowid']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  for (const value of Object.values(record)) {
    const nested = asRecord(value);
    if (nested && (typeof nested.id === 'string' || typeof nested.id === 'number')) return String(nested.id);
  }
  return undefined;
}

const SERVER_FIELDS = new Set(['id', 'created_at', 'createdAt', 'updated_at', 'updatedAt']);

export type InversePlan = { op: InverseOp } | { skipped: string } | null;

/**
 * How to reverse one app-data write. `before` is the record as read just
 * before the write (PATCH/PUT/DELETE). Returns null when nothing changed
 * (a failed write needs no undo).
 */
export function planAppInverse(
  input: AppCallInput,
  result: unknown,
  before: Record<string, unknown> | null,
  ctx: DescribeContext = {},
): InversePlan {
  const res = (result ?? {}) as { ok?: unknown; data?: unknown };
  if (res.ok === false) return null;
  const appId = String(input.appId ?? '');
  const method = String(input.method ?? 'GET').toUpperCase();
  const path = String(input.path ?? '/');
  const { noun, collection } = parseResourcePath(path);
  const app = appLabel(appId, ctx);

  if (method === 'POST') {
    const id = createdRecordId(res.data);
    if (!id) return { skipped: `the new ${noun} in ${app} (the app did not say which id it got)` };
    return { op: { kind: 'app', appId, method: 'DELETE', path: `${stripQuery(path)}/${id}`, summary: `Remove the ${noun} added to ${app}` } };
  }
  if (method === 'PATCH' || method === 'PUT') {
    if (!before) return { skipped: `the change to a ${noun} in ${app} (its previous state could not be read)` };
    const changed = asRecord(input.body);
    const body = method === 'PATCH' && changed
      ? Object.fromEntries(Object.keys(changed).map((key) => [key, key in before ? before[key] : null]))
      : Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'id'));
    return { op: { kind: 'app', appId, method, path: stripQuery(path), body, summary: `Restore the ${noun} in ${app}` } };
  }
  if (method === 'DELETE') {
    if (!before) return { skipped: `the deleted ${noun} in ${app} (its contents could not be read first)` };
    const body = Object.fromEntries(Object.entries(before).filter(([key]) => !SERVER_FIELDS.has(key)));
    const { id } = parseResourcePath(path);
    return {
      op: {
        kind: 'app',
        appId,
        method: 'POST',
        path: collection,
        body,
        summary: `Re-add the deleted ${noun} to ${app} (as a new entry)`,
        ...(id !== undefined ? { restoresId: id } : {}),
      },
    };
  }
  return null;
}

/**
 * How to reverse one desktop write. `before` is the desktop as it was just
 * before the write (needed to put moved items back).
 */
export function planDesktopInverse(
  tool: string,
  rawInput: unknown,
  result: unknown,
  before: DesktopItemLike[] | null,
): InversePlan {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const res = (result ?? {}) as Record<string, any>;
  const parentOf = (id: string) => before?.find((item) => item.id === id)?.parentId ?? null;

  if (tool === 'createTextNote') {
    const id = res.note?.id;
    if (typeof id !== 'string') return { skipped: 'the new note (no id returned)' };
    return { op: { kind: 'desktop', patches: [{ id, updates: { isTrashed: true } }], summary: `Move the note “${clip(String(res.note?.name ?? ''), 40)}” to the Trash` } };
  }
  if (tool === 'createFolder') {
    const folderId = res.folder?.id;
    if (typeof folderId !== 'string') return { skipped: 'the new folder (no id returned)' };
    if (!before) return { skipped: 'the new folder (the desktop could not be read first)' };
    const moved: string[] = Array.isArray(res.movedItems) ? res.movedItems.map((item: { id?: unknown }) => item.id).filter((id: unknown): id is string => typeof id === 'string') : [];
    return {
      op: {
        kind: 'desktop',
        patches: [
          ...moved.map((id) => ({ id, updates: { parentId: parentOf(id) } })),
          { id: folderId, updates: { isTrashed: true } },
        ],
        summary: `Put ${countLabel(moved.length, 'item')} back and move the folder “${clip(String(res.folder?.name ?? ''), 40)}” to the Trash`,
      },
    };
  }
  if (tool === 'moveItems') {
    if (!before) return { skipped: 'the moved items (the desktop could not be read first)' };
    const ids = Array.isArray(input.itemIds) ? input.itemIds.filter((v): v is string => typeof v === 'string') : [];
    return {
      op: { kind: 'desktop', patches: ids.map((id) => ({ id, updates: { parentId: parentOf(id) } })), summary: `Move ${countLabel(ids.length, 'item')} back` },
    };
  }
  return { skipped: `a ${tool} change (not reversible)` };
}

export interface UndoOutcome {
  done: string[];
  failed: Array<{ summary: string; error: string }>;
  changedApps: string[];
}

/**
 * Apply a run's undo plan: newest write first. A re-added record gets a new
 * id, so later ops aimed at its old id are rewritten to the new one (e.g. a
 * run that added a book and then deleted it).
 */
export async function applyUndoPlan(
  ops: readonly InverseOp[],
  execute: (op: InverseOp) => Promise<{ ok?: boolean; status?: number; data?: unknown } | void>,
): Promise<UndoOutcome> {
  const outcome: UndoOutcome = { done: [], failed: [], changedApps: [] };
  const remap = new Map<string, string>(); // `${appId} ${collection}/${oldId}` → new id
  for (const original of [...ops].reverse()) {
    let op = original;
    if (op.kind === 'app') {
      const { collection, id } = parseResourcePath(op.path);
      const mapped = id !== undefined ? remap.get(`${op.appId} ${collection}/${id}`) : undefined;
      if (mapped) op = { ...op, path: `${collection}/${mapped}` };
    }
    try {
      const result = await execute(op);
      if (result && result.ok === false) throw new Error(`the app answered ${result.status ?? 'an error'}`);
      outcome.done.push(op.summary);
      if (op.kind === 'app') {
        if (!outcome.changedApps.includes(op.appId)) outcome.changedApps.push(op.appId);
        if (op.restoresId !== undefined) {
          const newId = createdRecordId(result?.data);
          if (newId) remap.set(`${op.appId} ${op.path}/${op.restoresId}`, newId);
        }
      }
    } catch (error) {
      outcome.failed.push({ summary: op.summary, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}

/* ------------------------------------------------------------------ *
 * Routine schedules
 * ------------------------------------------------------------------ */

export type RoutineSchedule =
  | { every: 'day'; at: string; timeZone?: string }
  | { every: 'hours'; hours: number };

export const MIN_ROUTINE_HOURS = 1;
export const MAX_ROUTINE_HOURS = 24 * 7;

/** Minutes east of UTC for `timeZone` at instant `at` (DST-aware). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

export function isValidTimeZone(timeZone: string | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The next time a routine should run, strictly after `now`. */
export function nextRoutineRun(schedule: RoutineSchedule, now: Date): Date {
  if (schedule.every === 'hours') {
    const hours = Math.min(MAX_ROUTINE_HOURS, Math.max(MIN_ROUTINE_HOURS, Math.round(schedule.hours)));
    return new Date(now.getTime() + hours * 3_600_000);
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(schedule.at.trim());
  const hour = match ? Math.min(23, Number(match[1])) : 8;
  const minute = match ? Math.min(59, Number(match[2])) : 0;
  const timeZone = isValidTimeZone(schedule.timeZone) ? schedule.timeZone : 'UTC';
  // Walk forward day by day from "today" in the target zone until the local
  // wall-clock time lands after now. Offsets are re-read per candidate so a
  // DST change between today and tomorrow is handled.
  const offsetNow = zoneOffsetMinutes(now, timeZone);
  const local = new Date(now.getTime() + offsetNow * 60_000);
  for (let dayOffset = 0; dayOffset < 3; dayOffset++) {
    const wallUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour, minute);
    const guess = new Date(wallUtc - offsetNow * 60_000);
    const candidate = new Date(wallUtc - zoneOffsetMinutes(guess, timeZone) * 60_000);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return new Date(now.getTime() + 86_400_000);
}

export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.every === 'hours') {
    const hours = Math.round(schedule.hours);
    return hours === 1 ? 'every hour' : hours % 24 === 0 ? `every ${hours / 24} days` : `every ${hours} hours`;
  }
  return `every day at ${schedule.at}${schedule.timeZone ? ` (${schedule.timeZone})` : ''}`;
}
