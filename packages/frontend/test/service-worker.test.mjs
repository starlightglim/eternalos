import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

function workerHarness({ offline = false } = {}) {
  const listeners = new Map();
  const requests = [];
  const deleted = [];
  const context = {
    URL, Response,
    self: {
      location: { origin: 'https://eternalos.test' },
      addEventListener: (type, handler) => listeners.set(type, handler),
      clients: { claim: async () => {} },
    },
    caches: {
      keys: async () => ['eternalos-assets-v1', 'eternalos-shell-v1', 'eternalos-shell-v2', 'another-app'],
      delete: async (key) => deleted.push(key),
      open: async () => { throw new Error('API requests must never open CacheStorage'); },
    },
    fetch: async (request, options) => {
      requests.push({ request, options });
      if (offline) throw new TypeError('Offline');
      return new Response('Forbidden', { status: 403 });
    },
  };
  vm.runInNewContext(source, context);
  return {
    requests, deleted,
    dispatch(type, request) {
      let result;
      listeners.get(type)({ request, respondWith: (p) => { result = p; }, waitUntil: (p) => { result = p; } });
      return result;
    },
  };
}

test('permission-controlled API requests bypass old HTTP and service-worker caches', async () => {
  const harness = workerHarness();
  for (const origin of ['https://eternalos.test', 'https://api.eternalos.test']) {
    for (const suffix of ['', '?ft=expired-token']) {
      const request = new Request(`${origin}/api/files/user/item/file.png${suffix}`);
      const response = await harness.dispatch('fetch', request);
      assert.equal(response.status, 403);
      assert.equal(harness.requests.at(-1).options.cache, 'no-store');
      assert.equal(harness.requests.at(-1).request, request);
    }
  }
});

test('offline API requests cannot fall back to previously authorized bytes', async () => {
  const harness = workerHarness({ offline: true });
  await assert.rejects(harness.dispatch('fetch', new Request('https://eternalos.test/api/files/u/i/f')), /Offline/);
});

test('activation deletes legacy file caches and preserves unrelated caches', async () => {
  const harness = workerHarness();
  await harness.dispatch('activate');
  assert.deepEqual(harness.deleted, ['eternalos-assets-v1', 'eternalos-shell-v1']);
});

test('non-GET requests and unrelated cross-origin resources stay untouched', () => {
  const harness = workerHarness();
  assert.equal(harness.dispatch('fetch', new Request('https://eternalos.test/api/upload', { method: 'POST' })), undefined);
  assert.equal(harness.dispatch('fetch', new Request('https://other.test/photo.jpg')), undefined);
  assert.equal(harness.requests.length, 0);
});
