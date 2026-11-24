/**
 * Real-browser check for installed apps: headless Chrome loads an app the
 * way the desktop does (sandboxed iframe, origin "null", capability handed
 * over by postMessage) and the app reports what actually happened.
 *
 * Exists because server-side tests could not see browser-only failures:
 * app files were served without CORS, so every app's
 * <script type="module"> was refused and no installed app ran its code on
 * eternalos.me — while every other test passed.
 *
 * Needs Chrome/Chromium (CHROME_PATH, or the usual install locations);
 * skipped when none is found. No extra npm dependencies: Chrome is driven
 * over the DevTools protocol with Node's built-in WebSocket.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { unstable_dev } from 'wrangler';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const JSON_HEADERS = { 'Content-Type': 'application/json' };
let worker;
let workerOrigin;
let stateDir;

async function api(url, init = {}) {
  const response = await worker.fetch(`http://127.0.0.1${url}`, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  assert.ok(response.ok, `${init.method ?? 'GET'} ${url} → ${response.status}: ${text.slice(0, 300)}`);
  return body;
}
const auth = (token, extra = {}) => ({ ...extra, Authorization: `Bearer ${token}` });

/** Minimal Chrome DevTools Protocol client: one page, evaluate + wait. */
async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eternalos-chrome-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start')), 20_000);
    chrome.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buffer);
      if (match) {
        clearTimeout(timer);
        // Stop listening: an open pipe from Chrome's helpers would keep the
        // test process alive after the test.
        chrome.stderr.removeAllListeners('data');
        chrome.stderr.destroy();
        resolve(Number(match[1]));
      }
    });
    chrome.once('exit', () => reject(new Error('Chrome exited early')));
  });
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome did not answer ${method}`));
    }, 45_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async goto(url) { await send('Page.navigate', { url }); },
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.result?.exceptionDetails) throw new Error(reply.result.exceptionDetails.exception?.description ?? 'evaluate failed');
      return reply.result?.result?.value;
    },
    async close() {
      try { socket.close(); } catch { /* already closed */ }
      // Kill Chrome and all its helper processes (its own process group).
      try { process.kill(-chrome.pid, 'SIGKILL'); } catch { chrome.kill('SIGKILL'); }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch { /* a temp folder; the OS cleans it up */ }
    },
  };
}

/** A host page that frames the app exactly like AppViewer does. */
function startHostPage(appUrl, token) {
  const html = `<!doctype html><body>
<iframe id="app" sandbox="allow-scripts" src="${appUrl}" style="width:400px;height:300px"></iframe>
<script>
  window.reports = [];
  const frame = document.getElementById('app');
  addEventListener('message', (event) => {
    if (event.source === frame.contentWindow && event.data && event.data.type === 'smoke') window.reports.push(event.data);
  });
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ type: 'eternal:capability', token: ${JSON.stringify(token)} }, '*');
  });
</script></body>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const SMOKE_SERVER = `
export default {
  async fetch(request, env) {
    env.sql.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL)');
    const url = new URL(request.url);
    // GET /api/notes
    if (url.pathname === '/api/notes' && request.method === 'GET') return Response.json(env.sql.exec('SELECT * FROM notes ORDER BY id').toArray());
    // POST /api/notes
    if (url.pathname === '/api/notes' && request.method === 'POST') {
      const body = await request.json();
      return Response.json(env.sql.exec('INSERT INTO notes (text) VALUES (?) RETURNING *', String(body.text)).one(), { status: 201 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
`;

// Everything an installed app does in the browser: run its module script,
// read its backend through eternal.api, draw on a canvas and save it to the
// desktop through eternal.fs.write. Reports back to the host page.
const SMOKE_APP_JS = `
const report = { ran: true };
try {
  report.notes = await window.eternal.api.get('/notes');
} catch (error) { report.apiError = String(error.message || error); }
try {
  const canvas = document.createElement('canvas');
  canvas.width = 8; canvas.height = 8;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e33'; ctx.fillRect(0, 0, 8, 8);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  report.saved = await window.eternal.fs.write({ path: '/Smoke Drawings/first.png', content: blob });
} catch (error) { report.saveError = String(error.message || error); }
document.body.dataset.done = '1';
parent.postMessage({ type: 'smoke', report }, '*');
`;

describe('installed apps in a real browser', { skip: chromePath ? false : 'Chrome not found (set CHROME_PATH)' }, () => {
  before(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eternalos-browser-state-'));
    worker = await unstable_dev('src/index.ts', {
      config: process.env.WRANGLER_CONFIG ?? 'wrangler.test.toml',
      envFiles: ['test/worker.env'],
      persistTo: stateDir,
      logLevel: 'error',
      ip: '127.0.0.1',
      experimental: { disableExperimentalWarning: true, testMode: true },
    });
    workerOrigin = `http://127.0.0.1:${worker.port}`;
  });

  after(async () => {
    if (worker) await worker.stop();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('runs the app code, reads its backend and saves a drawing to the desktop', { timeout: 120_000 }, async () => {
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
    const user = await api('/api/auth/signup', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'CF-Connecting-IP': `browser-${suffix}` },
      body: JSON.stringify({ email: `w${suffix}@example.com`, username: `w${suffix}`, password: 'Password123' }),
    });
    const app = await api('/api/apps/dev-deploy', {
      method: 'POST',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Smoke Pad',
          version: '1',
          windowConfig: { defaultWidth: 400, defaultHeight: 400 },
          permissions: { fs: { write: ['/Smoke Drawings/**'] } },
        },
        files: {
          'index.html': '<!doctype html><html><body><p>smoke</p><script type="module" src="./app.js"></script></body></html>',
          'app.js': SMOKE_APP_JS,
          'server.js': SMOKE_SERVER,
        },
      }),
    });
    const appId = encodeURIComponent(app.appId);
    await api(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: auth(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { write: ['/Smoke Drawings/**'] } }, broadApprovals: [] }),
    });
    const capability = await api(`/api/apps/${appId}/capability`, { method: 'POST', headers: auth(user.token, JSON_HEADERS), body: '{}' });
    await api(`/api/apps/${appId}/api/notes`, {
      method: 'POST',
      headers: auth(capability.token, JSON_HEADERS),
      body: JSON.stringify({ text: 'hello from the backend' }),
    });

    const host = await startHostPage(`${workerOrigin}/api/apps/${appId}/`, capability.token);
    const chrome = await launchChrome();
    try {
      await chrome.goto(`http://127.0.0.1:${host.address().port}/`);
      const reports = await chrome.evaluate(`new Promise((resolve) => {
        const started = Date.now();
        const check = () => {
          if (window.reports && window.reports.length) return resolve(window.reports);
          if (Date.now() - started > 20000) return resolve([]);
          setTimeout(check, 100);
        };
        check();
      })`);
      assert.equal(reports.length, 1, "the app's module script never ran in the browser (CORS on app files? CSP? runtime error?)");
      const { report } = reports[0];
      assert.equal(report.apiError, undefined, `eternal.api failed: ${report.apiError}`);
      assert.deepEqual(report.notes.map((note) => note.text), ['hello from the backend']);
      assert.equal(report.saveError, undefined, `eternal.fs.write failed: ${report.saveError}`);
      assert.equal(report.saved.type, 'image');
      assert.equal(report.saved.mimeType, 'image/png');

      const desktop = await api('/api/desktop', { headers: auth(user.token) });
      const saved = desktop.items.find((item) => item.id === report.saved.id);
      const folder = desktop.items.find((item) => item.type === 'folder' && item.name === 'Smoke Drawings');
      assert.ok(saved && folder, 'the drawing and its folder are on the desktop');
      assert.equal(saved.parentId, folder.id);
      assert.ok(saved.r2Key, 'stored as a real file');
    } finally {
      await chrome.close();
      host.close();
    }
  });
});
