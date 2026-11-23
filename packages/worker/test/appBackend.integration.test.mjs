/**
 * Full-stack apps: server.js running as a Durable Object Facet under the
 * AppRunner supervisor, loaded through the Worker Loader (Dynamic Workers).
 *
 * Exercises the real runtime end to end — dev-deploy a todo app with a
 * SQLite-backed backend, drive it through the capability-gated
 * /api/apps/:appId/api/* mount, upgrade it, and delete it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';

import { unstable_dev } from 'wrangler';

const BASE_URL = 'http://127.0.0.1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let worker;
let stateDir;

function freshIp(tag) {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function call(url, init = {}) {
  const response = await worker.fetch(`${BASE_URL}${url}`, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

async function expectStatus(url, init, status = 200) {
  const result = await call(url, init);
  assert.equal(result.status, status, `${init?.method ?? 'GET'} ${url} → ${result.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

async function signup() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
  const identity = { email: `b${suffix}@example.com`, username: `b${suffix}`.slice(0, 20), password: 'Password123' };
  const body = await expectStatus('/api/auth/signup', {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'CF-Connecting-IP': freshIp('signup') },
    body: JSON.stringify(identity),
  });
  return { ...identity, ...body };
}

const auth = (token, extra = {}) => ({ ...extra, Authorization: `Bearer ${token}` });

const TODO_SERVER = `
import { json, notFound } from './server/http.js';

export default {
  async fetch(request, env) {
    env.sql.exec('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)');
    const url = new URL(request.url);
    if (url.pathname === '/api/todos' && request.method === 'GET') {
      return json(env.sql.exec('SELECT * FROM todos ORDER BY id').toArray());
    }
    if (url.pathname === '/api/todos' && request.method === 'POST') {
      const { title } = await request.json();
      if (!title) return json({ error: 'title required' }, 400);
      return json(env.sql.exec('INSERT INTO todos (title) VALUES (?) RETURNING *', title).one(), 201);
    }
    const match = url.pathname.match(/^\\/api\\/todos\\/(\\d+)$/);
    if (match && request.method === 'PATCH') {
      const { done } = await request.json();
      env.sql.exec('UPDATE todos SET done = ? WHERE id = ?', done ? 1 : 0, Number(match[1]));
      return json(env.sql.exec('SELECT * FROM todos WHERE id = ?', Number(match[1])).one());
    }
    if (url.pathname === '/api/whoami') return { appId: env.APP_ID, version: 1 };
    if (url.pathname === '/api/outbound') {
      try {
        const res = await fetch('https://example.com/');
        return { status: res.status };
      } catch (error) {
        return { blocked: String(error.message || error) };
      }
    }
    if (url.pathname === '/api/boom') {
      console.log('about to throw');
      throw new Error('kaboom');
    }
    return notFound();
  },
};
`;

const HTTP_HELPERS = `
export function json(data, status = 200) {
  return Response.json(data, { status });
}
export function notFound() {
  return json({ error: 'not found' }, 404);
}
`;

function todoApp(serverSource = TODO_SERVER, extra = {}) {
  return {
    manifest: {
      name: 'Backend Todos',
      description: 'Full-stack todo app',
      version: '1.0.0',
      windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
      // Declared, never granted in this suite: the backend must stay offline.
      permissions: { network: { outbound: ['example.com'] } },
      ...extra,
    },
    files: {
      'index.html': '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><ul id="list"></ul><script type="module" src="./app.js"></script></body></html>',
      'styles.css': 'body { font-family: sans-serif; }',
      'app.js': `
        const list = document.getElementById('list');
        try {
          const todos = await window.eternal.api.get('/todos');
          list.textContent = todos.map((t) => t.title).join(', ');
        } catch (error) {
          list.textContent = 'Error: ' + error.message;
        }
      `,
      'server.js': serverSource,
      'server/http.js': HTTP_HELPERS,
    },
  };
}

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eternalos-backend-state-'));
  worker = await unstable_dev('src/index.ts', {
    config: process.env.WRANGLER_CONFIG ?? 'wrangler.test.toml',
    envFiles: ['test/worker.env'],
    persistTo: stateDir,
    logLevel: 'error',
    experimental: { disableExperimentalWarning: true, testMode: true },
  });
});

after(async () => {
  if (worker) await worker.stop();
  if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('full-stack app backends (Dynamic Worker facets)', () => {
  it('runs server.js with its own SQLite behind the capability gate', async () => {
    const user = await signup();
    const app = await expectStatus('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify(todoApp()),
    });
    const appId = encodeURIComponent(app.appId);

    // server.js and server/* never ship to the browser as static files.
    assert.equal((await call(`/api/apps/${appId}/server.js`)).status, 404);
    assert.equal((await call(`/api/apps/${appId}/server/http.js`)).status, 404);
    const runtime = await call(`/api/apps/${appId}/eternal-runtime.js`);
    assert.match(String(runtime.body), /const api = Object\.freeze/);
    // The runtime is emitted from a TS template literal; make sure what the
    // browser receives actually parses (escaping bugs surface only here).
    assert.doesNotThrow(() => new vm.Script(String(runtime.body)), 'eternal-runtime.js must be valid JavaScript');
    assert.doesNotThrow(() => new vm.Script(String(runtime.body).replace('const requiresCapability = true', 'const requiresCapability = false')));

    // No capability → 401 (but CORS preflight is answered).
    const noCap = await call(`/api/apps/${appId}/api/todos`);
    assert.equal(noCap.status, 401);
    assert.equal(noCap.headers.get('access-control-allow-origin'), '*');
    // Sandboxed iframes send Origin: null; their preflights must pass for
    // both the backend mount and the window.eternal bridge.
    for (const sub of ['api/todos', '_eternal/fs/list']) {
      const preflight = await worker.fetch(`${BASE_URL}/api/apps/${appId}/${sub}`, {
        method: 'OPTIONS',
        headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
      });
      assert.equal(preflight.status, 204, sub);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*', sub);
      assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /authorization/, sub);
    }

    const capability = await expectStatus(`/api/apps/${appId}/capability`, {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: '{}',
    });
    const bearer = (extra = {}) => auth(capability.token, extra);

    assert.deepEqual(await expectStatus(`/api/apps/${appId}/api/todos`, { headers: bearer() }), []);
    const created = await expectStatus(`/api/apps/${appId}/api/todos`, {
      method: 'POST',
      headers: bearer(JSON_HEADERS),
      body: JSON.stringify({ title: 'ship facets' }),
    }, 201);
    assert.equal(created.title, 'ship facets');
    assert.equal(created.done, 0);
    await expectStatus(`/api/apps/${appId}/api/todos`, {
      method: 'POST',
      headers: bearer(JSON_HEADERS),
      body: JSON.stringify({}),
    }, 400);
    const patched = await expectStatus(`/api/apps/${appId}/api/todos/${created.id}`, {
      method: 'PATCH',
      headers: bearer(JSON_HEADERS),
      body: JSON.stringify({ done: true }),
    });
    assert.equal(patched.done, 1);

    // Backend output can never execute on the API origin.
    const listed = await call(`/api/apps/${appId}/api/todos`, { headers: bearer() });
    assert.match(listed.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
    assert.equal(listed.headers.get('x-content-type-options'), 'nosniff');

    // Handler may return plain objects; env.APP_ID is wired.
    assert.deepEqual(await expectStatus(`/api/apps/${appId}/api/whoami`, { headers: bearer() }), { appId: app.appId, version: 1 });

    // Declared-but-ungranted outbound → the backend has no network at all.
    const outbound = await expectStatus(`/api/apps/${appId}/api/outbound`, { headers: bearer() });
    assert.ok(outbound.blocked, `expected outbound fetch to be blocked, got ${JSON.stringify(outbound)}`);

    // Uncaught exceptions become a legible 500, not a dead isolate.
    const boom = await call(`/api/apps/${appId}/api/boom`, { headers: bearer() });
    assert.equal(boom.status, 500);
    assert.match(JSON.stringify(boom.body), /kaboom/);
    assert.equal((await call(`/api/apps/${appId}/api/nope`, { headers: bearer() })).status, 404);

    // Upgrade the code: the facet restarts on v2, the SQLite data survives.
    await expectStatus('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify({ appId: app.appId, ...todoApp(TODO_SERVER.replace('version: 1', 'version: 2'), { version: '1.1.0' }) }),
    });
    assert.deepEqual(await expectStatus(`/api/apps/${appId}/api/whoami`, { headers: bearer() }), { appId: app.appId, version: 2 });
    const afterUpgrade = await expectStatus(`/api/apps/${appId}/api/todos`, { headers: bearer() });
    assert.deepEqual(afterUpgrade.map((todo) => [todo.title, todo.done]), [['ship facets', 1]]);

    // A capability for another app does not open this backend.
    const other = await expectStatus('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify(todoApp()),
    });
    assert.notEqual(other.appId, app.appId);
    const otherTodos = await call(`/api/apps/${encodeURIComponent(other.appId)}/api/todos`, { headers: bearer() });
    assert.equal(otherTodos.status, 401);

    // Owner can read backend logs (console output + exceptions).
    // Tail events land asynchronously after the invocation completes.
    let logs = { logs: [] };
    for (let attempt = 0; attempt < 40; attempt++) {
      logs = await expectStatus(`/api/apps/${appId}/backend/logs`, { headers: auth(user.token) });
      if (logs.logs.some((entry) => /kaboom/.test(entry.message))) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const messages = logs.logs.map((entry) => entry.message).join('\n');
    assert.match(messages, /about to throw/, messages);
    assert.match(messages, /kaboom/, messages);

    // Deleting the app drops its backend database.
    await expectStatus(`/api/apps/${appId}`, { method: 'DELETE', headers: auth(user.token) });
    assert.equal((await call(`/api/apps/${appId}/api/todos`, { headers: bearer() })).status, 404);
  });

  it('rejects broken backends before install', async () => {
    const user = await signup();
    const noDefault = todoApp('export function handler() { return new Response("x"); }');
    const rejected = await call('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify(noDefault),
    });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.match(JSON.stringify(rejected.body), /backend\/default-export-missing/);

    const apiWithoutServer = todoApp();
    delete apiWithoutServer.files['server.js'];
    delete apiWithoutServer.files['server/http.js'];
    const rejected2 = await call('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify(apiWithoutServer),
    });
    assert.equal(rejected2.status, 400, JSON.stringify(rejected2.body));
    assert.match(JSON.stringify(rejected2.body), /backend\/api-without-server/);
  });

  it('serves a static app unchanged and 404s its /api mount', async () => {
    const user = await signup();
    const app = await expectStatus('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: { name: 'Static', description: 'static', version: '1.0.0', windowConfig: { defaultWidth: 400, defaultHeight: 400, resizable: true } },
        files: { 'index.html': '<!doctype html><html><body>hi</body></html>' },
      }),
    });
    const appId = encodeURIComponent(app.appId);
    assert.equal((await call(`/api/apps/${appId}/`)).status, 200);
    const capability = await expectStatus(`/api/apps/${appId}/capability`, {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: '{}',
    });
    const res = await call(`/api/apps/${appId}/api/anything`, { headers: auth(capability.token) });
    assert.equal(res.status, 404);
    assert.match(JSON.stringify(res.body), /no server\.js backend/);
  });
});
