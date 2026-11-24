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
