/** Pure request helpers for BazaarWindow (kept out of the .tsx for tests). */

/** Delay between the last keystroke and the search request. */
export const SEARCH_DEBOUNCE_MS = 300;

/** True for a request that was cancelled on purpose (superseded or unmounted). */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Human-readable message for a failed request. */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  // fetch() network failures surface as a bare TypeError ("Failed to fetch").
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message)) return 'Network error — check your connection and try again.';
  // ApiError carries the server's text without the status prefix.
  const detail = (err as { detail?: unknown }).detail;
  if (typeof detail === 'string' && detail) return detail;
  return err.message || fallback;
}
