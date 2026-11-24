/**
 * Plain-language text for Code Mode changes on the client (the single-change
 * approval card), mirroring the agent's practice-run wording.
 */

export interface PlannedAction {
  tool: string;
  summary: string;
  detail?: string;
}

function singularWord(word: string): string {
  if (/ies$/.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:ss|us)$/.test(word)) return word;
  if (/s$/.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return `“${value.length > 48 ? `${value.slice(0, 47)}…` : value}”`;
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'object') return Array.isArray(value) ? `${value.length} items` : JSON.stringify(value).slice(0, 48);
  return String(value);
}

/**
 * Plain-language description of one app-data change, for the single-change
 * approval card (mirrors the agent's practice-run wording).
 */
export function describeAppChange(method: string, path: string, body: unknown, appName?: string): PlannedAction {
  const app = appName ?? 'an app';
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  const hasId = segments.length > 1 && (/^\d+$/.test(last) || /^[0-9a-f-]{8,}$/i.test(last));
  const nounRaw = (hasId ? segments.at(-2) : last) ?? '';
  const noun = nounRaw && nounRaw !== 'api' ? singularWord(nounRaw.replace(/[-_]+/g, ' ')) : 'entry';
  const target = hasId ? `${noun} #${last}` : noun;
  const entries = body && typeof body === 'object' && !Array.isArray(body) ? Object.entries(body as Record<string, unknown>) : [];
  const shown = entries.slice(0, 4).map(([key, value]) => {
    const flag = /^(?:is|has)_?([a-z].*)$/i.exec(key);
    if (flag && (typeof value === 'boolean' || value === 0 || value === 1)) return `${flag[1].replace(/_/g, ' ').toLowerCase()}: ${value ? 'yes' : 'no'}`;
    return `${key.replace(/_/g, ' ')}: ${valueText(value)}`;
  });
  // Say when something was left out, so the summary never hides it.
  if (entries.length > shown.length) shown.push(`+${entries.length - shown.length} more field${entries.length - shown.length === 1 ? '' : 's'}`);
  if (body !== undefined && !entries.length) shown.push(`body: ${valueText(body)}`);
  if (path.includes('?')) shown.push(`with options ${path.slice(path.indexOf('?'))}`);
  const detail = shown.join(', ') || undefined;
  const upper = method.toUpperCase();
  if (upper === 'POST') return { tool: 'callAppApi', summary: `Add ${noun} to ${app}`, detail };
  if (upper === 'DELETE') return { tool: 'callAppApi', summary: `Delete ${target} from ${app}` };
  return { tool: 'callAppApi', summary: `Update ${target} in ${app}`, detail };
}

/* ------------------------------------------------------------------ *
 * Activity lines: lookups the assistant did on the way to an answer.
 * They used to be full cards ("Your apps · 1 app found", "App data · GET
 * /api/books → 200"); now consecutive lookups fold into one quiet line.
 * ------------------------------------------------------------------ */

/** Lookup tools shown as activity lines instead of cards. */
export const QUIET_TOOL_TYPES = new Set([
  'tool-listApps',
  'tool-getAppSource',
  'tool-readAppApi',
  'tool-getAppBackendLogs',
  'tool-getDesktopOverview',
  'tool-readTextFile',
  'tool-listMemories',
  'tool-listRoutines',
]);

export interface ActivityPartLike {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
}

/** A tool part that is a read-only lookup (callAppApi counts only for GET). */
export function isQuietToolPart(part: ActivityPartLike): boolean {
  if (part.state === 'approval-requested' || part.state === 'output-error' || part.state === 'output-denied') return false;
  if (QUIET_TOOL_TYPES.has(part.type)) return true;
  if (part.type === 'tool-callAppApi') {
    const method = String((part.input as { method?: unknown } | undefined)?.method ?? 'GET').toUpperCase();
    return method === 'GET';
  }
  return false;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function readNoun(path: string): string {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  if (segments.length > 1 && (/^\d+$/.test(last) || /^[0-9a-f-]{8,}$/i.test(last))) {
    return `${singularWord((segments.at(-2) ?? 'entry').replace(/[-_]+/g, ' '))} #${last}`;
  }
  return last && last !== 'api' ? last.replace(/[-_]+/g, ' ') : 'data';
}

/** One short line for a lookup, e.g. "Read books from Books · 3 records". */
export function activityLabel(part: ActivityPartLike, appName: (appId: string) => string | undefined): { label: string; detail?: string } {
  const input = (part.input ?? {}) as Record<string, unknown>;
  const output = (part.output ?? {}) as Record<string, unknown>;
  const done = part.state === 'output-available';
  const app = typeof input.appId === 'string' ? (appName(input.appId) ?? 'an app') : 'an app';
  switch (part.type) {
    case 'tool-listApps':
      return { label: done ? 'Checked your apps' : 'Checking your apps', detail: done && Array.isArray(output.apps) ? `${plural(output.apps.length, 'app')} found` : undefined };
    case 'tool-getAppSource':
      return { label: `${done ? 'Read' : 'Reading'} the code of ${app}`, detail: done && output.files && typeof output.files === 'object' ? plural(Object.keys(output.files).length, 'file') : undefined };
    case 'tool-readAppApi':
    case 'tool-callAppApi': {
      const status = typeof output.status === 'number' ? output.status : undefined;
      const count = Array.isArray(output.data) ? plural(output.data.length, 'record') : undefined;
      return {
        label: `${done ? 'Read' : 'Reading'} ${readNoun(String(input.path ?? '/'))} from ${app}`,
        detail: done ? (output.ok === false ? `failed (${status ?? 'error'})` : count) : undefined,
      };
    }
    case 'tool-getAppBackendLogs':
      return { label: `${done ? 'Read' : 'Reading'} the logs of ${app}`, detail: done && Array.isArray(output.logs) ? plural(output.logs.length, 'line') : undefined };
    case 'tool-getDesktopOverview':
      return { label: done ? 'Looked over your desktop' : 'Looking over your desktop', detail: done && typeof output.totalActiveItems === 'number' ? plural(output.totalActiveItems, 'item') : undefined };
    case 'tool-readTextFile':
      return {
        label: `${done ? 'Read' : 'Reading'} “${String(input.name ?? input.id ?? 'a file')}”`,
        detail: done && output.found === false ? 'not found' : undefined,
      };
    case 'tool-listMemories':
      return { label: done ? 'Checked saved memories' : 'Checking saved memories' };
    case 'tool-listRoutines':
      return { label: done ? 'Checked routines' : 'Checking routines' };
    default:
      return { label: part.type.replace(/^tool-/, '') };
  }
}

export interface RunStepLike {
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  write: boolean;
}

/**
 * The steps of a Code Mode run that only read things, so they can fold into
 * the activity line like any other lookup — or null when the run should
 * stay a full card (it changes something, failed, or might still).
 *
 * A finished run folds when every step was a read and nothing failed. A
 * running one folds only when its practice run already found no writes.
 */
export function readOnlyRunSteps(
  state: string | undefined,
  steps: { steps: RunStepLike[]; total: number; failed: number } | undefined,
  preview: { ok: boolean; actions: unknown[] } | undefined,
): RunStepLike[] | null {
  const noWritesPlanned = preview?.ok === true && preview.actions.length === 0;
  if (state === 'output-available') {
    if (!steps || steps.failed > 0 || steps.steps.length === 0) return null;
    if (steps.steps.some((step) => step.write || step.status === 'error')) return null;
    // Older steps can be trimmed from the stream; only the preview can vouch for them.
    if (steps.total > steps.steps.length && !noWritesPlanned) return null;
    return steps.steps;
  }
  if ((state === 'input-streaming' || state === 'input-available') && noWritesPlanned) {
    if (steps?.steps.some((step) => step.write || step.status === 'error')) return null;
    return steps?.steps ?? [];
  }
  return null;
}
