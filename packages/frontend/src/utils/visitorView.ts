/**
 * Pure helpers for the public visitor page (VisitorPage + useVisitorSync).
 */

interface LocationLike {
  protocol: string;
  host: string;
}

/**
 * WebSocket URL for a visitor's live feed of `username`'s desktop.
 * The username is path-encoded so odd characters can't change the path.
 */
export function visitorSocketUrl(apiUrl: string, username: string, location: LocationLike): string {
  const path = `/api/ws/${encodeURIComponent(username)}`;
  if (apiUrl) return apiUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + path;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}

/**
 * Visitor username from the route param or the raw `/@name` pathname.
 * The pathname is still percent-encoded and may end in a slash; decode it so
 * every request (fetch, socket, og image) encodes the same name once.
 */
export function visitorUsernameFrom(routeParam: string | undefined, pathname: string): string | undefined {
  if (routeParam) return routeParam;
  const raw = pathname.replace(/^\/@?/, '').split('?')[0].replace(/\/+$/, '');
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Merge a live profile push into the profile on screen. Fields the push
 * doesn't carry (e.g. ones the server keeps from visitors) are kept, but the
 * look fields (`lookKeys`) always come from the push alone: a missing one
 * means the owner cleared it, and keeping the old value would leave their
 * removed custom CSS / tokens on screen.
 */
export function mergeLiveProfile<T extends object>(prev: T | null, next: T, lookKeys: readonly string[]): T {
  if (!prev) return next;
  const merged = { ...prev, ...next } as Record<string, unknown>;
  for (const key of lookKeys) {
    if (!(key in next)) delete merged[key];
  }
  return merged as unknown as T;
}

/** JSON with sorted object keys, so equal values always give equal strings. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Change-detection key for a value derived from the owner's profile (their
 * appearance or sound pack). Live profile updates arrive as new objects even
 * when nothing visual changed; comparing keys avoids re-applying the look
 * (a flash of the default theme) or reloading sounds for no reason.
 */
export function visitorLookKey(value: unknown): string {
  return stableStringify(value);
}
