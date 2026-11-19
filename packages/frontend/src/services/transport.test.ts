import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Tests for the transport/session module in isolation (importing './transport'
// directly rather than going through the './api' facade). The cross-tab
// refresh matrix (Web Locks serialization, adoption, logout races) lives in
// api.test.ts; this file covers the transport contract itself.

type Transport = typeof import('./transport');
let api: Transport | null = null;
let saved: string | null;

function jwt(uid: string, revision = 0) {
  return `header.${btoa(JSON.stringify({ uid, revision, exp: Date.now() / 1000 + 900 }))}.signature`;
}

function persist(token: string, refreshToken: string) {
  saved = JSON.stringify({ state: { token, refreshToken } });
}

/** Fresh module instance with a session installed, like a newly loaded tab. */
async function openSession(token: string | null, refreshToken: string | null): Promise<Transport> {
  vi.resetModules();
  const transport = await import('./transport');
  transport.setTokenUpdateHandler(persist);
  transport.setAuthToken(token);
  transport.setRefreshToken(refreshToken);
  return transport;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_API_URL', 'https://api.test');
  saved = null;
  vi.stubGlobal('localStorage', { getItem: () => saved });
});

afterEach(() => {
  if (api) {
    api.setAuthToken(null);
    api.setRefreshToken(null);
    api.clearFileToken();
  }
  api = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('apiRequest sends the bearer token and returns parsed JSON', async () => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  api = await openSession(token, 'refresh-1');
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    seenUrl = url;
    seenInit = init;
    return Response.json({ items: [] });
  });
  vi.stubGlobal('fetch', fetcher);

  await expect(api.apiRequest<{ items: unknown[] }>('/api/desktop')).resolves.toEqual({ items: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(seenUrl).toBe('https://api.test/api/desktop');
  expect(seenInit?.headers).toEqual({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  });
});

test('without navigator.locks, concurrent 401s still rotate the refresh token only once', async () => {
  // Force the fallback branch: no Web Locks → the module-local promise alone
  // must deduplicate the two in-flight refreshes.
  vi.stubGlobal('navigator', {});
  const old = jwt('alice');
  persist(old, 'refresh-1');
  api = await openSession(old, 'refresh-1');
  const rotated = jwt('alice', 1);
  let rotations = 0;
  let desktopCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/auth/refresh')) {
      rotations += 1;
      expect(JSON.parse(init.body as string).refreshToken).toBe('refresh-1');
      return Response.json({ token: rotated, refreshToken: 'refresh-2', expiresIn: 900 });
    }
    if (url.endsWith('/api/file-token')) {
      return Response.json({ ft: 'ft-1' });
    }
    desktopCalls += 1;
    return new Headers(init.headers).get('Authorization') === `Bearer ${rotated}`
      ? Response.json({ items: [] })
      : new Response(null, { status: 401 });
  }));

  await expect(Promise.all([api.apiRequest('/api/desktop'), api.apiRequest('/api/desktop')]))
    .resolves.toEqual([{ items: [] }, { items: [] }]);

  expect(rotations).toBe(1);
  expect(desktopCalls).toBe(4); // two initial 401s + two authorized retries
  expect(api.getRefreshToken()).toBe('refresh-2');
});

test('apiRequest normalises non-401 error bodies into "status message"', async () => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  api = await openSession(token, 'refresh-1');

  // JSON error body → its `error` field.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"Not found"}', { status: 404 })));
  await expect(api.apiRequest('/api/desktop')).rejects.toThrow('404 Not found');

  // Plain-text body → trimmed text.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(' boom ', { status: 500 })));
  await expect(api.apiRequest('/api/desktop')).rejects.toThrow('500 boom');

  // Empty body → statusText, then the generic fallback.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500, statusText: 'Internal Error' })));
  await expect(api.apiRequest('/api/desktop')).rejects.toThrow('500 Internal Error');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
  await expect(api.apiRequest('/api/desktop')).rejects.toThrow('503 Request failed');
});

test('a 401 without credentials is surfaced as a plain error, without a refresh attempt', async () => {
  api = await openSession(null, null);
  const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);

  await expect(api.apiRequest('/api/desktop')).rejects.toThrow('401 Request failed');
  expect(fetcher).toHaveBeenCalledTimes(1); // no /api/auth/refresh call
});

test('file tokens: tokenless URL first, one shared fetch, cache, clear + notify', async () => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  api = await openSession(token, 'refresh-1');
  let fileTokenCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/file-token')) {
      fileTokenCalls += 1;
      return Response.json({ ft: 'ft-1' });
    }
    return new Response(null, { status: 404 });
  }));

  // Before the token loads, getFileUrl still returns a usable (tokenless)
  // URL — public files load, private ones 401 until the token arrives.
  expect(api.getCachedFileToken()).toBeNull();
  expect(api.getFileUrl('uid/1/file.png')).toBe('https://api.test/api/files/uid/1/file.png?v=2');

  // The background fetch kicked off by getFileUrl is the same request a
  // concurrent ensureFileToken joins — only one token fetch happens.
  await expect(Promise.all([api.ensureFileToken(), api.ensureFileToken()])).resolves.toEqual(['ft-1', 'ft-1']);
  expect(fileTokenCalls).toBe(1);

  expect(api.getCachedFileToken()).toBe('ft-1');
  expect(api.getFileUrl('uid/1/file name.txt')).toBe('https://api.test/api/files/uid/1/file%20name.txt?v=2&ft=ft-1');

  // Clearing (logout path) drops the cache, bumps the version, and wakes
  // subscribers so media URLs re-render without a token.
  let notified = 0;
  const unsubscribe = api.subscribeToFileToken(() => { notified += 1; });
  const version = api.getFileTokenVersion();
  api.clearFileToken();
  expect(api.getCachedFileToken()).toBeNull();
  expect(api.getFileUrl('uid/1/file.png')).toBe('https://api.test/api/files/uid/1/file.png?v=2');
  expect(notified).toBe(1);
  expect(api.getFileTokenVersion()).toBe(version + 1);

  // Unsubscribed callbacks are not invoked again.
  unsubscribe();
  api.clearFileToken();
  expect(notified).toBe(1);
});
