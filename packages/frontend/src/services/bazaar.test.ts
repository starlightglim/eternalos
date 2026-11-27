import { afterEach, beforeEach, expect, test, vi } from 'vitest';

type Call = { url: string; init: RequestInit };
let calls: Call[];

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }));
}

async function load() {
  vi.resetModules();
  return import('./api');
}

beforeEach(() => {
  calls = [];
  vi.stubEnv('VITE_API_URL', 'https://api.test');
  vi.stubGlobal('localStorage', { getItem: () => null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('bazaarBrowse sends page params and normalizes the current page-based response', async () => {
  const api = await load();
  respond(200, { packs: [{ packId: 'p1' }], total: 45, page: 2, pageSize: 20 });
  const result = await api.bazaarBrowse({ type: 'cursor', q: 'pixel art', page: 2 });
  const url = new URL(calls[0].url);
  expect(url.pathname).toBe('/api/bazaar/browse');
  expect(url.searchParams.get('type')).toBe('cursor');
  expect(url.searchParams.get('q')).toBe('pixel art');
  expect(url.searchParams.get('page')).toBe('2');
  expect(result).toEqual({ packs: [{ packId: 'p1' }], total: 45, page: 2, pageSize: 20 });
});

test('bazaarBrowse passes limit/cursor and keeps nextCursor from cursor-paginated backends', async () => {
  const api = await load();
  respond(200, { packs: [], total: 3, page: 1, pageSize: 10, nextCursor: 'abc' });
  const result = await api.bazaarBrowse({ limit: 10, cursor: 'xyz' });
  const url = new URL(calls[0].url);
  expect(url.searchParams.get('limit')).toBe('10');
  expect(url.searchParams.get('cursor')).toBe('xyz');
  expect(result.nextCursor).toBe('abc');
  expect(result.pageSize).toBe(10);
});

test('bazaarBrowse throws on a failed response instead of returning the error body as packs', async () => {
  const api = await load();
  respond(500, { error: 'Failed to browse' });
  await expect(api.bazaarBrowse()).rejects.toMatchObject({ status: 500, detail: 'Failed to browse' });
});

test('bazaarBrowse forwards the abort signal', async () => {
  const api = await load();
  respond(200, { packs: [] });
  const controller = new AbortController();
  await api.bazaarBrowse({ signal: controller.signal });
  expect(calls[0].init.signal).toBe(controller.signal);
});

test('bazaarDelete reports a failed delete as success:false with the server error', async () => {
  const api = await load();
  api.setAuthToken('header.e30.sig');
  respond(403, { error: 'Not your pack' });
  const result = await api.bazaarDelete('a/b');
  expect(result).toEqual({ success: false, error: 'Not your pack' });
  expect(calls[0].url).toBe('https://api.test/api/bazaar/pack/a%2Fb');
  expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer header.e30.sig');
});

test('bazaarInstall turns a network failure into success:false', async () => {
  const api = await load();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
  expect(await api.bazaarInstall('p1')).toEqual({ success: false, error: 'Failed to fetch' });
});

test('bazaarPublish sends multipart without forcing a JSON content type', async () => {
  const api = await load();
  respond(200, { success: true, pack: { packId: 'p9' } });
  const preview = new File(['x'], 'p.png', { type: 'image/png' });
  const result = await api.bazaarPublish(
    { type: 'cursor', name: 'N', description: '', tags: [], config: {} }, preview, {},
  );
  expect(result.success).toBe(true);
  expect(calls[0].init.body).toBeInstanceOf(FormData);
  expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
});

test('bazaarMyPacks throws on failure so the UI can show an error', async () => {
  const api = await load();
  respond(401, { error: 'Unauthorized' });
  await expect(api.bazaarMyPacks()).rejects.toThrow('401');
});

test('postGuestbookEntry maps rate limits and errors to success:false', async () => {
  const api = await load();
  respond(429, { error: 'You can only sign once per hour. Please try again later.' });
  expect(await api.postGuestbookEntry('u', 'i', { name: 'a', message: 'b' }))
    .toEqual({ success: false, error: 'You can only sign once per hour. Please try again later.' });
  respond(400, { error: 'Message too long' });
  expect(await api.postGuestbookEntry('u', 'i', { name: 'a', message: 'b' }))
    .toEqual({ success: false, error: 'Message too long' });
});

test('postGuestbookEntry posts JSON and returns the entries', async () => {
  const api = await load();
  const entries = [{ name: 'a', message: 'b', timestamp: 1 }];
  respond(200, { success: true, entries });
  const result = await api.postGuestbookEntry('u 1', 'i', { name: 'a', message: 'b' });
  expect(result.entries).toEqual(entries);
  expect(calls[0].url).toBe('https://api.test/api/guestbook/u%201/i');
  expect(calls[0].init.method).toBe('POST');
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'a', message: 'b' });
});

test('fetchVisitorDesktop encodes the username and keeps the "User not found" message', async () => {
  const api = await load();
  respond(404, { error: 'Not found' });
  await expect(api.fetchVisitorDesktop('a/b?c')).rejects.toThrow(/^User not found$/);
  expect(calls[0].url).toBe('https://api.test/api/visit/a%2Fb%3Fc');
  respond(503, { error: 'Busy' });
  await expect(api.fetchVisitorDesktop('bob')).rejects.toThrow(/^Busy$/);
});

test('a guestbook 429 without error text still gets the once-per-hour hint', async () => {
  const api = await load();
  respond(429, {});
  expect((await api.postGuestbookEntry('u', 'i', { name: 'a', message: 'b' })).error)
    .toBe('You can only sign once per hour. Please try again later.');
});

test('a sign-out during a public read retries instead of failing', async () => {
  const api = await load();
  api.setAuthToken('header.e30.sig');
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (n++ === 0) api.setAuthToken(null); // session changes mid-request
    return new Response(JSON.stringify({ username: 'bob', displayName: 'Bob', items: [] }), { status: 200 });
  }));
  const result = await api.fetchVisitorDesktop('bob');
  expect(result.profile.username).toBe('bob');
  expect(n).toBe(2);
});
