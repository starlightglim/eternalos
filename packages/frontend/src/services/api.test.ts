import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Api = typeof import('./api');
const tabs: Api[] = [];
let saved: string | null;

function jwt(uid: string, revision = 0) {
  return `header.${btoa(JSON.stringify({ uid, revision, exp: Date.now() / 1000 + 900 }))}.signature`;
}

function persist(token: string, refreshToken: string) {
  saved = JSON.stringify({ state: { token, refreshToken } });
}

async function openTab(token: string, refreshToken: string) {
  vi.resetModules();
  const api = await import('./api');
  tabs.push(api);
  api.setTokenUpdateHandler(persist);
  api.setAuthToken(token);
  api.setRefreshToken(refreshToken);
  return api;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('VITE_API_URL', 'https://api.test');
  saved = null;
  vi.stubGlobal('localStorage', { getItem: () => saved });
  let queue = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, callback: () => Promise<boolean>) => {
        const result = queue.then(callback);
        queue = result.then(() => {}, () => {});
        return result;
      },
    },
  });
});

afterEach(() => {
  for (const api of tabs.splice(0)) {
    api.setAuthToken(null);
    api.setRefreshToken(null);
    api.clearFileToken();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('two tabs rotate a shared refresh token only once', async () => {
  const old = jwt('alice');
  const fresh = jwt('alice', 1);
  persist(old, 'refresh-1');
  const first = await openTab(old, 'refresh-1');
  const second = await openTab(old, 'refresh-1');
  let rotations = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/api/auth/refresh')) {
      rotations += 1;
      expect(JSON.parse(init.body as string).refreshToken).toBe('refresh-1');
      return Response.json({ token: fresh, refreshToken: 'refresh-2', expiresIn: 900 });
    }
    if (!url.endsWith('/api/desktop')) return Response.json({ token: 'file-token' });
    return new Headers(init.headers).get('Authorization') === `Bearer ${fresh}`
      ? Response.json({ items: [] })
      : new Response(null, { status: 401 });
  }));
  await expect(Promise.all([first.fetchDesktop(), second.fetchDesktop()])).resolves.toEqual([{ items: [] }, { items: [] }]);
  expect(rotations).toBe(1);
  expect(first.getRefreshToken()).toBe('refresh-2');
  expect(second.getRefreshToken()).toBe('refresh-2');
});

test.each(['offline', 429, 500, 503] as const)('a temporary refresh failure (%s) keeps credentials', async (failure) => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  const api = await openTab(token, 'refresh-1');
  const expired = vi.fn();
  api.setSessionExpiredHandler(expired);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/api/auth/refresh')) {
      if (failure === 'offline') throw new TypeError('Offline');
      return new Response(null, { status: failure });
    }
    return new Response(null, { status: 401 });
  }));
  await expect(api.fetchDesktop()).rejects.toThrow('Your session is saved');
  expect(api.getAuthToken()).toBe(token);
  expect(api.getRefreshToken()).toBe('refresh-1');
  expect(expired).not.toHaveBeenCalled();
});

test('proactive refresh retries temporary failures without logging out', async () => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  const api = await openTab(token, 'refresh-1');
  const expired = vi.fn();
  api.setSessionExpiredHandler(expired);
  const fetcher = vi.fn(async () => { throw new TypeError('Offline'); });
  vi.stubGlobal('fetch', fetcher);
  await vi.advanceTimersByTimeAsync(840_000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(api.getAuthToken()).toBe(token);
  expect(expired).not.toHaveBeenCalled();
});

test('a rejected refresh expires the session', async () => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  const api = await openTab(token, 'refresh-1');
  const expired = vi.fn();
  api.setSessionExpiredHandler(expired);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
  await expect(api.fetchDesktop()).rejects.toThrow('Session expired');
  expect(api.getAuthToken()).toBeNull();
  expect(expired).toHaveBeenCalledOnce();
});

test('a delayed refresh cannot restore a session after logout', async () => {
  const token = jwt('alice');
  persist(token, 'refresh-1');
  const api = await openTab(token, 'refresh-1');
  let resolveRefresh!: (response: Response) => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!url.endsWith('/api/auth/refresh')) return new Response(null, { status: 401 });
    started();
    return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
  }));
  const pending = api.fetchDesktop();
  const assertion = expect(pending).rejects.toThrow('session changed');
  await refreshStarted;
  saved = null;
  api.setAuthToken(null);
  api.setRefreshToken(null);
  resolveRefresh(Response.json({ token: jwt('alice', 1), refreshToken: 'refresh-2', expiresIn: 900 }));
  await assertion;
  expect(api.getAuthToken()).toBeNull();
  expect(saved).toBeNull();
});

test('a stale 401 cannot log out a newly signed-in account', async () => {
  const alice = jwt('alice');
  persist(alice, 'alice-refresh');
  const api = await openTab(alice, 'alice-refresh');
  const expired = vi.fn();
  api.setSessionExpiredHandler(expired);
  let resolveRequest!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveRequest = resolve; })));
  const pending = api.fetchDesktop();
  const assertion = expect(pending).rejects.toThrow('session changed');
  const bob = jwt('bob');
  persist(bob, 'bob-refresh');
  api.setAuthToken(bob);
  api.setRefreshToken('bob-refresh');
  resolveRequest(new Response(null, { status: 401 }));
  await assertion;
  expect(api.getAuthToken()).toBe(bob);
  expect(expired).not.toHaveBeenCalled();
});

test('refresh cannot adopt another account from storage while waiting for its lock', async () => {
  const alice = jwt('alice');
  persist(alice, 'alice-refresh');
  const api = await openTab(alice, 'alice-refresh');
  persist(jwt('bob'), 'bob-refresh');
  const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(api.fetchDesktop()).rejects.toThrow('session changed');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(api.getAuthToken()).toBe(alice);
});
