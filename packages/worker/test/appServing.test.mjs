// App serving, streamed body caps and the daily cron cleanup.
//
// - bundle.json used to be fetched and parsed from R2 on every app request
//   (every asset of a page load), though only a cold Dynamic Worker needs it.
// - Body caps checked only Content-Length, which a chunked body doesn't send.
// - The cron deleted R2 keys one call per key and parsed DO responses
//   without checking `ok`.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { readTextWithLimit } = await import('../src/utils/limitedBody.ts');
const { deleteR2Keys, runTrashCleanup } = await import('../src/utils/trashCleanup.ts');
const { handleServeApp, handleServeAppPreview } = await import('../src/routes/appServe.ts');

function chunkedRequest(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next);
    },
  });
  return new Request('http://test/upload', { method: 'POST', body, duplex: 'half' });
}

describe('readTextWithLimit', () => {
  it('reads a body under the limit', async () => {
    assert.equal(await readTextWithLimit(new Request('http://t/', { method: 'POST', body: '{"a":1}' }), 100), '{"a":1}');
    assert.equal(await readTextWithLimit(new Request('http://t/'), 100), '');
  });

  it('rejects a chunked body with no Content-Length once it passes the limit, without reading the rest', async () => {
    let pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(400));
      },
    });
    const request = new Request('http://t/', { method: 'POST', body, duplex: 'half' });
    assert.equal(request.headers.get('content-length'), null);
    assert.equal(await readTextWithLimit(request, 1000), null);
    assert.ok(pulls <= 4, `stopped after ${pulls} chunks`);
  });

  it('rejects a declared oversize body up front', async () => {
    const request = new Request('http://t/', { method: 'POST', body: 'x', headers: { 'content-length': '5000' } });
    assert.equal(await readTextWithLimit(request, 1000), null);
  });

  it('counts bytes, not characters, and decodes characters split across chunks', async () => {
    const euro = new TextEncoder().encode('€'); // 3 bytes
    assert.equal(await readTextWithLimit(chunkedRequest([euro.slice(0, 1), euro.slice(1), 'ok']), 5), '€ok');
    assert.equal(await readTextWithLimit(chunkedRequest(['€€']), 5), null);
  });
});

describe('daily trash cleanup', () => {
  it('deletes R2 keys in batches of up to 1000', async () => {
    const calls = [];
    const keys = Array.from({ length: 2500 }, (_, i) => `k${i}`);
    await deleteR2Keys({ delete: async (batch) => { calls.push(batch); } }, keys);
    assert.deepEqual(calls.map((batch) => batch.length), [1000, 1000, 500]);
    assert.deepEqual(calls.flat(), keys);
    calls.length = 0;
    await deleteR2Keys({ delete: async (batch) => { calls.push(batch); } }, []);
    assert.equal(calls.length, 0);
  });

  function fakeEnv(responses) {
    const deletes = [];
    return {
      deletes,
      env: {
        AUTH_KV: {
          async list({ cursor }) {
            if (!cursor) return { keys: [{ name: 'user_index:a' }, { name: 'user_index:b' }], list_complete: false, cursor: 'c2' };
            return { keys: [{ name: 'user_index:c' }], list_complete: true };
          },
        },
        USER_DESKTOP: {
          idFromName: (uid) => uid,
          get: (uid) => ({ fetch: async () => responses[uid]() }),
        },
        ETERNALOS_FILES: { delete: async (keys) => { deletes.push(keys); } },
      },
    };
  }

  it('checks each response, batches the deletes and sums one summary', async () => {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      const { env, deletes } = fakeEnv({
        a: () => Response.json({ deleted: 2, r2Keys: ['x', 'y'] }),
        b: () => new Response('Internal error', { status: 500 }),
        c: () => Response.json({ deleted: 0, r2Keys: [] }),
      });
      const summary = await runTrashCleanup(env);
      assert.deepEqual(summary, { users: 3, itemsDeleted: 2, r2Deleted: 2, failures: 1 });
      assert.deepEqual(deletes, [['x', 'y']], 'one delete call for the user\'s keys; none for an empty list');
      assert.equal(errors.length, 1);
      assert.match(errors[0], /returned 500/);
    } finally {
      console.error = originalError;
    }
  });
});

describe('app serving reads bundle.json only for a cold isolate', () => {
  const BUNDLE = { mainModule: 'index.js', modules: { 'index.js': 'export default {}' } };

  function harness({ bundle = BUNDLE } = {}) {
    const r2Gets = [];
    const isolates = new Map();
    const kv = {
      'app:app1': { uid: 'u1', version: 3, r2Prefix: 'apps/u1/app1/v3' },
      'app-preview:pre1': { uid: 'u1', version: 1, r2Prefix: 'previews/u1/pre1' },
    };
    const env = {
      ENVIRONMENT: 'development',
      DESKTOP_KV: { get: async (key) => kv[key] ?? null },
      ETERNALOS_FILES: {
        async get(key) {
          r2Gets.push(key);
          return bundle ? { json: async () => structuredClone(bundle) } : null;
        },
      },
      // Mirrors the Worker Loader: the callback runs only for an uncached id.
      LOADER: {
        get(id, load) {
          if (!isolates.has(id)) isolates.set(id, load());
          const ready = isolates.get(id);
          return {
            getEntrypoint: () => ({
              async fetch(request) {
                const code = await ready;
                if (code.mainModule === 'missing.js') {
                  // Evaluate the stub the way the loader would run it.
                  const source = code.modules['missing.js'];
                  const mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);
                  return mod.default.fetch(request);
                }
                return new Response(`${code.mainModule}:${new URL(request.url).pathname}`, {
                  headers: { 'content-type': 'text/html' },
                });
              },
            }),
          };
        },
      },
    };
    const ctx = { exports: { EternalService: ({ props }) => ({ props }) } };
    const call = (handler, url, mount) => handler({
      request: new Request(`http://localhost${url}`),
      env,
      ctx,
      params: [url.slice(mount.length)],
      corsHeaders: {},
    });
    return { r2Gets, call };
  }

  it('serves the page and its assets with one R2 read per isolate', async () => {
    const { r2Gets, call } = harness();
    const page = await call(handleServeApp, '/api/apps/app1/', '/api/apps/');
    assert.equal(page.status, 200);
    assert.equal(await page.text(), 'index.js:/api/apps/app1/');
    for (const asset of ['app.js', 'styles.css', 'app.js']) {
      assert.equal((await call(handleServeApp, `/api/apps/app1/${asset}`, '/api/apps/')).status, 200);
    }
    assert.deepEqual(r2Gets, ['apps/u1/app1/v3/bundle.json']);

    // eternal-runtime.js is the current runtime and never touches R2.
    const runtime = await call(handleServeApp, '/api/apps/app1/eternal-runtime.js', '/api/apps/');
    assert.equal(runtime.status, 200);
    assert.match(runtime.headers.get('content-type'), /javascript/);
    assert.equal(r2Gets.length, 1);

    assert.equal((await call(handleServeAppPreview, '/api/app-previews/pre1/', '/api/app-previews/')).status, 200);
    assert.equal((await call(handleServeAppPreview, '/api/app-previews/pre1/a.js', '/api/app-previews/')).status, 200);
    assert.deepEqual(r2Gets, ['apps/u1/app1/v3/bundle.json', 'previews/u1/pre1/bundle.json']);
  });

  it('answers 404 when the bundle is missing', async () => {
    const { call } = harness({ bundle: null });
    const app = await call(handleServeApp, '/api/apps/app1/', '/api/apps/');
    assert.equal(app.status, 404);
    assert.equal(await app.text(), 'App bundle not found');
    const preview = await call(handleServeAppPreview, '/api/app-previews/pre1/', '/api/app-previews/');
    assert.equal(preview.status, 404);
    assert.equal(await preview.text(), 'App preview bundle not found');
  });
});

describe('route body caps hold for chunked bodies', async () => {
  const { handleAppDevDeploy } = await import('../src/routes/apps.ts');
  const { handleAppSkins } = await import('../src/routes/appSkins.ts');

  function endless() {
    return new Request('http://t/', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20)); } }),
    });
  }

  it('dev-deploy answers 413 past 6MB with no Content-Length', async () => {
    const response = await handleAppDevDeploy(endless(), {}, { uid: 'u1' });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/);
  });

  it('skin install answers 413 past 9MB with no Content-Length', async () => {
    const env = { DESKTOP_KV: { get: async () => ({ uid: 'u1' }) } };
    const response = await handleAppSkins(endless(), env, { uid: 'u1' }, 'app1', undefined);
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/);
  });
});
