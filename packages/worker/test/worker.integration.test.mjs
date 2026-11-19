import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unstable_dev } from 'wrangler';
import { FormData as UndiciFormData } from 'undici';
import WebSocket from 'ws';

const BASE_URL = 'http://127.0.0.1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123';
const WORKER_NAME = 'eternalos-api-test';
const INSPECTOR_PORT = 9230;
const COVERAGE_ENABLED = process.env.WORKER_COVERAGE === '1';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVERAGE_DIR = path.resolve(PROJECT_ROOT, process.env.WORKER_COVERAGE_DIR ?? '.coverage');
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5F2pQAAAAASUVORK5CYII=',
  'base64'
);

let worker;
let coverageCollector;

function createTestIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
  const username = `u${suffix}`.slice(0, 20);

  return {
    email: `${username}@example.com`,
    username,
    password: PASSWORD,
  };
}

function authHeaders(token, headers = {}) {
  return {
    ...headers,
    Authorization: `Bearer ${token}`,
  };
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function serializeMultipartForm(form) {
  const boundary = `----eternalos-test-${Math.random().toString(16).slice(2)}`;
  const encoder = new TextEncoder();
  const chunks = [];

  for (const [name, value] of form.entries()) {
    chunks.push(encoder.encode(`--${boundary}\r\n`));
    if (typeof value === 'string') {
      chunks.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
      continue;
    }

    const filename = typeof value.name === 'string' ? value.name : 'upload.bin';
    const contentType = value.type || 'application/octet-stream';
    chunks.push(encoder.encode(
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    ));
    chunks.push(new Uint8Array(await value.arrayBuffer()));
    chunks.push(encoder.encode('\r\n'));
  }

  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    body,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function fetchJson(url, init) {
  let requestInit = init;
  if (init?.body instanceof UndiciFormData) {
    const multipart = await serializeMultipartForm(init.body);
    requestInit = {
      ...init,
      body: multipart.body,
      headers: { ...init.headers, ...multipart.headers },
    };
  }

  // Every product response this helper is used for is JSON — product errors
  // included (Response.json({ error }, { status })). A body that is NOT valid
  // JSON therefore means the local runtime (miniflare) hiccuped and returned
  // its own plain-text error page ("Your worker threw…"), usually on the
  // request right after a heavy operation like the scheduled purge. That is a
  // transient infra failure, not product behavior, so retry a few times before
  // giving up. We never retry a well-formed JSON response, so real 4xx/5xx
  // product errors are surfaced unchanged.
  const maxAttempts = 4;
  let lastText = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await worker.fetch(`${BASE_URL}${url}`, requestInit);
    lastText = await response.text();
    if (!lastText) return { response, body: null };
    try {
      return { response, body: JSON.parse(lastText) };
    } catch {
      if (attempt === maxAttempts) {
        // Exhausted retries — surface a clear error instead of an opaque
        // JSON SyntaxError so a genuine regression here is debuggable.
        throw new Error(
          `Non-JSON response from ${url} after ${maxAttempts} attempts ` +
          `(status ${response.status}): ${lastText.slice(0, 120)}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

async function expectOk(url, init, expectedStatus = 200) {
  const { response, body } = await fetchJson(url, init);
  assert.equal(
    response.status,
    expectedStatus,
    `Expected ${url} to return ${expectedStatus}, got ${response.status}: ${JSON.stringify(body)}`
  );
  return body;
}

async function signupUser() {
  const identity = createTestIdentity();
  // Each signup gets its own client IP (see freshAuthIp) so the per-IP auth
  // rate limit (60/min) can't be exhausted by the suite's many signups sharing
  // one bucket — which made the whole suite flaky under small timing shifts.
  const body = await expectOk('/api/auth/signup', {
    method: 'POST',
    headers: freshAuthIp('signup'),
    body: JSON.stringify(identity),
  });

  return {
    ...identity,
    ...body,
  };
}

async function getQuota(token) {
  return expectOk('/api/quota', {
    headers: authHeaders(token),
  });
}

async function patchItems(token, patches) {
  return expectOk('/api/desktop/items', {
    method: 'PATCH',
    headers: authHeaders(token, JSON_HEADERS),
    body: JSON.stringify(patches),
  });
}

async function createDesktopItem(token, item) {
  return expectOk('/api/desktop/items', {
    method: 'POST',
    headers: authHeaders(token, JSON_HEADERS),
    body: JSON.stringify(item),
  });
}

async function patchProfile(token, updates) {
  return expectOk('/api/profile', {
    method: 'PATCH',
    headers: authHeaders(token, JSON_HEADERS),
    body: JSON.stringify(updates),
  });
}

async function getCSSHistory(token) {
  return expectOk('/api/css-history', {
    headers: authHeaders(token),
  });
}

async function revertCSSHistoryVersion(token, versionId) {
  return expectOk(`/api/css-history/${versionId}/revert`, {
    method: 'POST',
    headers: authHeaders(token),
  });
}

// Unique client IP for auth requests that don't otherwise pin one, so the
// per-IP auth rate limit (60/min) can't be exhausted by the suite's many auth
// calls sharing the default bucket.
function freshAuthIp(tag = 'auth') {
  return { ...JSON_HEADERS, 'CF-Connecting-IP': `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

async function loginUser(email, password) {
  return expectOk('/api/auth/login', {
    method: 'POST',
    headers: freshAuthIp('login'),
    body: JSON.stringify({ email, password }),
  });
}

async function waitFor(assertion, { timeoutMs = 1500, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw lastError ?? new Error('Timed out waiting for condition');
}

function createPngFile(name = 'pixel.png') {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

// ---------------------------------------------------------------------------
// Checked-in app fixtures (test/fixtures/apps) — the regression contract for
// the deterministic post-bundle validation pass. `manifest.json` is the
// dev-deploy manifest; `expect.json` (when present) is the issue code the
// fixture must be rejected with.
// ---------------------------------------------------------------------------

const APP_FIXTURES_ROOT = path.join(PROJECT_ROOT, 'test', 'fixtures', 'apps');

function loadAppFixture(name) {
  const dir = path.join(APP_FIXTURES_ROOT, name);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const files = {};
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'manifest.json' || entry === 'expect.json') continue;
    files[entry] = fs.readFileSync(path.join(dir, entry), 'utf8');
  }
  return { name, manifest, files };
}

function devDeployBody(fixture) {
  return {
    manifest: {
      name: fixture.manifest.name,
      description: fixture.manifest.description,
      version: fixture.manifest.version,
      windowConfig: { ...fixture.manifest.windowConfig, resizable: fixture.manifest.windowConfig.resizable !== false },
      ...(fixture.manifest.permissions ? { permissions: fixture.manifest.permissions } : {}),
      ...(fixture.manifest.rationale ? { rationale: fixture.manifest.rationale } : {}),
    },
    files: fixture.files,
  };
}

// Perform a real WebSocket upgrade handshake with custom headers and report
// the HTTP status + body the worker answered with. The agent-chat gate
// rejects these handshakes with 401/403 before any socket is established, so
// `unexpected-response` is the expected outcome. (undici's fetch refuses to
// send a bare `Upgrade: websocket` header, which is why the `ws` client is
// needed here.)
function wsUpgrade(path, headers) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${worker.address || '127.0.0.1'}:${worker.port}${path}`, {
      headers,
    });
    socket.on('unexpected-response', (_request, response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        socket.terminate();
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') });
      });
      response.on('error', () => {
        socket.terminate();
        resolve({ status: response.statusCode, text: '' });
      });
    });
    socket.on('error', (error) => {
      reject(error);
    });
    socket.on('open', () => {
      socket.close();
      resolve({ status: 101, text: '' });
    });
  });
}

function createTestCartridge(version = '1.0.0') {
  return {
    formatVersion: 1,
    meta: {
      name: 'Integration Game',
      description: 'A publish flow test cartridge',
      author: 'test',
      version,
    },
    code: 'function _init() {}',
    spritesheet: Array.from({ length: 128 }, () => '0'.repeat(128)).join('\n'),
  };
}

// Each test run gets a fresh, ephemeral persistence directory instead of the
// default shared `.wrangler/state`. This keeps the suite hermetic (no state
// leaks between runs), stops test churn (hundreds of disposable signups) from
// bloating — and slowing down — the dev state, and avoids polluting the
// developer's real local accounts. Cleaned up in `after`.
let testStateDir;

before(async () => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eternalos-test-state-'));
  const options = {
    config: process.env.WRANGLER_CONFIG ?? 'wrangler.toml',
    envFiles: ['test/worker.env'],
    persistTo: testStateDir,
    logLevel: 'error',
    experimental: {
      disableExperimentalWarning: true,
      testMode: true,
    },
  };

  if (COVERAGE_ENABLED) {
    options.inspect = true;
    options.inspectorPort = INSPECTOR_PORT;
  }

  worker = await unstable_dev('src/index.ts', options);

  if (COVERAGE_ENABLED) {
    const { WorkerCoverageCollector } = await import('./workerCoverage.mjs');
    coverageCollector = new WorkerCoverageCollector({
      inspectorPort: INSPECTOR_PORT,
      workerName: WORKER_NAME,
      projectRoot: PROJECT_ROOT,
      reportDir: COVERAGE_DIR,
    });

    await coverageCollector.start();
  }
});

after(async () => {
  try {
    if (coverageCollector) {
      const report = await coverageCollector.stop();
      console.log(`Worker coverage written to ${report.summaryPath}`);
    }
  } finally {
    if (worker) {
      await worker.stop();
    }
    if (testStateDir) {
      try {
        fs.rmSync(testStateDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; OS temp is reclaimed anyway.
      }
    }
  }
});

describe('worker integration', () => {
  it('enforces auth rate limits atomically under concurrent requests', async () => {
    const clientIp = `rate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const requests = Array.from({ length: 70 }, () => worker.fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'CF-Connecting-IP': clientIp,
      },
      body: JSON.stringify({ email: 'rate-limit@example.com', password: 'WrongPassword123' }),
    }));

    const responses = await Promise.all(requests);
    const rateLimited = responses.filter((response) => response.status === 429).length;
    const acceptedByLimiter = responses.length - rateLimited;

    assert.ok(rateLimited > 0, 'expected concurrent requests beyond the limit to receive 429');
    assert.ok(acceptedByLimiter <= 60, 'rate limiter allowed more requests than configured');
  });

  it('serializes concurrent signups for the same email and username', async () => {
    const identity = createTestIdentity();
    const signupRequests = Array.from({ length: 2 }, () => fetchJson('/api/auth/signup', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(identity),
    }));

    const results = await Promise.all(signupRequests);
    const successfulSignups = results.filter(({ response }) => response.status === 200);
    const rejectedSignups = results.filter(({ response }) => response.status === 409);

    assert.equal(successfulSignups.length, 1);
    assert.equal(rejectedSignups.length, 1);
  });

  it('rejects usernames that collapse to empty/short under normalization', async () => {
    const signupWith = (username) => fetchJson('/api/auth/signup', {
      method: 'POST',
      headers: freshAuthIp('signup'),
      body: JSON.stringify({
        email: `norm-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        username,
        password: PASSWORD,
      }),
    });

    // sanitizeUsername lowercases and strips leading "-"/"_", so these pass the
    // raw charset check but would be stored as an empty ("___") or too-short
    // ("_ab" -> "ab") handle. Both must be rejected, not silently normalized.
    const allUnderscore = await signupWith('___');
    assert.equal(allUnderscore.response.status, 400);
    const shortAfterStrip = await signupWith('_ab');
    assert.equal(shortAfterStrip.response.status, 400);

    // A leading underscore that still leaves a valid handle is accepted and the
    // stored username is the normalized form (no leading underscore). Use a
    // unique handle so the local .wrangler KV state doesn't collide run-to-run.
    const suffix = `h${Math.random().toString(36).slice(2, 8)}`;
    const ok = await signupWith(`_${suffix}`);
    assert.equal(ok.response.status, 200);
    assert.equal(ok.body.user.username, suffix.toLowerCase());
  });

  it('publishes, browses, installs, and deletes a legacy bazaar pack', async () => {
    const user = await signupUser();
    const form = new UndiciFormData();
    form.set('manifest', JSON.stringify({
      type: 'cursor',
      name: 'Retro Cursors',
      description: 'A test cursor pack',
      tags: ['retro', 'pixel'],
      config: { 'cursor.image.default': '{asset:arrow}' },
    }));
    form.set('preview', createPngFile('preview.png'));
    form.set('asset_arrow', createPngFile('arrow.png'));

    const published = await expectOk('/api/bazaar/publish', {
      method: 'POST', headers: authHeaders(user.token), body: form,
    });
    const packId = published.pack.packId;
    assert.ok(packId);
    // The {asset:arrow} placeholder is rewritten to a first-party asset URL.
    assert.match(published.pack.config['cursor.image.default'], /^\/api\/bazaar\/assets\//);

    // It appears in type-filtered browse and in the author's my-packs.
    const browse = await expectOk('/api/bazaar/browse?type=cursor');
    assert.ok(browse.packs.some((p) => p.packId === packId), 'pack should be browsable');
    const mine = await expectOk('/api/bazaar/my-packs', { headers: authHeaders(user.token) });
    assert.ok(mine.packs.some((p) => p.packId === packId), 'pack should be in my-packs');

    // Install returns the (rewritten) config.
    const install = await expectOk(`/api/bazaar/install/${encodeURIComponent(packId)}`, {
      method: 'POST', headers: authHeaders(user.token),
    });
    assert.ok(install.config['cursor.image.default']);

    // A non-owner cannot delete it; the owner can.
    const other = await signupUser();
    const foreignDelete = await fetchJson(`/api/bazaar/pack/${encodeURIComponent(packId)}`, {
      method: 'DELETE', headers: authHeaders(other.token),
    });
    assert.equal(foreignDelete.response.status, 403);

    await expectOk(`/api/bazaar/pack/${encodeURIComponent(packId)}`, {
      method: 'DELETE', headers: authHeaders(user.token),
    });

    // Gone after deletion.
    const afterDelete = await fetchJson(`/api/bazaar/pack/${encodeURIComponent(packId)}`);
    assert.equal(afterDelete.response.status, 404);
  });

  it('publishes an .estheme theme bundle and re-validates it on read', async () => {
    const user = await signupUser();
    const author = `@${user.user.username}`;
    const manifest = {
      formatVersion: 1,
      id: 'retro-theme',
      name: 'Retro Theme',
      version: '1.0.0',
      author,
      layers: { tokens: 'tokens.json' },
    };
    const tokensFile = () => new File([JSON.stringify({ accentColor: '#00ffcc' })], 'tokens.json', { type: 'application/json' });

    const form = new UndiciFormData();
    form.set('manifest', JSON.stringify(manifest));
    form.set('preview', createPngFile('preview.png'));
    form.set('file_tokens.json', tokensFile());

    const published = await expectOk('/api/bazaar/publish-estheme', {
      method: 'POST', headers: authHeaders(user.token), body: form,
    });
    assert.ok(published.pack.packId);
    assert.equal(published.pack.manifestVersion, 1);
    assert.equal(published.manifest.id, 'retro-theme');

    // Reading the pack re-validates the stored manifest and returns it.
    const fetched = await expectOk(`/api/bazaar/pack/${encodeURIComponent(published.pack.packId)}`);
    assert.ok(fetched.manifest, 'estheme pack should return its manifest');
    assert.equal(fetched.manifest.layers.tokens, 'tokens.json');

    // The manifest author must match the authenticated user.
    const badForm = new UndiciFormData();
    badForm.set('manifest', JSON.stringify({ ...manifest, author: '@someoneelse' }));
    badForm.set('preview', createPngFile('p.png'));
    badForm.set('file_tokens.json', tokensFile());
    const badAuthor = await fetchJson('/api/bazaar/publish-estheme', {
      method: 'POST', headers: authHeaders(user.token), body: badForm,
    });
    assert.equal(badAuthor.response.status, 403);
  });

  it('publishes and republishes a playable Bazaar game', async () => {
    const user = await signupUser();
    const publish = async (cartridge, packId) => {
      const form = new UndiciFormData();
      form.set('cartridge', JSON.stringify(cartridge));
      form.set('preview', createPngFile('cover.png'));
      if (packId) form.set('packId', packId);
      return expectOk('/api/bazaar/publish-game', {
        method: 'POST',
        headers: authHeaders(user.token),
        body: form,
      });
    };

    const first = await publish(createTestCartridge());
    const installResults = await Promise.all(Array.from({ length: 32 }, () => fetchJson(
      `/api/bazaar/install/${encodeURIComponent(first.pack.packId)}`,
      {
        method: 'POST',
        headers: authHeaders(user.token),
      },
    )));
    assert.ok(installResults.every(({ response }) => response.status === 200));

    const installedPack = await expectOk(`/api/bazaar/pack/${encodeURIComponent(first.pack.packId)}`);
    assert.equal(installedPack.pack.installs, 32);

    const second = await publish({
      ...createTestCartridge('1.0.1'),
      meta: { ...createTestCartridge('1.0.1').meta, name: 'Updated Integration Game' },
    }, first.pack.packId);

    assert.ok(first.pack.packId);
    assert.equal(second.pack.packId, first.pack.packId);
    assert.equal(second.pack.name, 'Updated Integration Game');
    assert.equal(second.pack.installs, 32);

    const playResponse = await worker.fetch(
      `${BASE_URL}/api/games/play/${encodeURIComponent(first.pack.packId)}/cartridge.json`,
    );
    assert.equal(playResponse.status, 200);
    const storedCartridge = await playResponse.json();
    assert.equal(storedCartridge.meta.version, '1.0.1');
  });

  it('requires authentication before app capabilities can be minted', async () => {
    const unauthenticated = await fetchJson('/api/apps/missing-app/capability', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(unauthenticated.response.status, 401);

    const user = await signupUser();
    const missingApp = await fetchJson('/api/apps/missing-app/capability', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    assert.equal(missingApp.response.status, 404);
  });

  it('creates, serves, and loads a custom app bundle', async () => {
    const user = await signupUser();
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Custom Integration App',
          description: 'Custom app lifecycle test',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } },
        },
        files: {
          'index.html': '<!doctype html><html><body><h1>Custom app works</h1></body></html>',
          'app.js': 'document.body.dataset.ready = "true";',
          'styles.css': 'body { color: red; }',
        },
      }),
    });

    assert.ok(app.appId);
    const appResponse = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/`);
    assert.equal(appResponse.status, 200);
    assert.match(appResponse.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    const appHtml = await appResponse.text();
    assert.match(appHtml, /Custom app works/);

    const initialPermissions = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(initialPermissions.granted, {});
    const grantedPermissions = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com', 'evil.example'] } } }),
    });
    assert.deepEqual(grantedPermissions.granted, { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } });

    const capabilityBeforeRevoke = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });

    const revokedPermissions = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: {} }),
    });
    assert.deepEqual(revokedPermissions.granted, {});

    const revokedOldTokenResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/_eternal/fs/list`,
      { headers: { Authorization: `Bearer ${capabilityBeforeRevoke.token}` } },
    );
    assert.equal(revokedOldTokenResponse.status, 401);

    const revokedCapability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    const revokedBridgeResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/_eternal/fs/list`,
      { headers: { Authorization: `Bearer ${revokedCapability.token}` } },
    );
    assert.equal(revokedBridgeResponse.status, 200);
    assert.deepEqual((await readJson(revokedBridgeResponse)).items, []);

    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } } }),
    });

    const capability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    const bridgeResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/_eternal/fs/list`,
      { headers: { Authorization: `Bearer ${capability.token}` } },
    );
    assert.equal(bridgeResponse.status, 200);

    // A private-IP target is a policy denial (403), not a server fault.
    const blockedNetworkResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/_eternal/fetch`,
      {
        method: 'POST',
        headers: authHeaders(capability.token, JSON_HEADERS),
        body: JSON.stringify({ url: 'http://127.0.0.1/' }),
      },
    );
    assert.equal(blockedNetworkResponse.status, 403);

    const source = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/source`, {
      headers: authHeaders(user.token),
    });
    assert.equal(source.files['index.html'].includes('Custom app works'), true);

    const updated = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        appId: app.appId,
        manifest: {
          name: 'Custom Integration App v2',
          description: 'Updated custom app lifecycle test',
          version: '2.0.0',
          windowConfig: { defaultWidth: 640, defaultHeight: 520, resizable: true },
          permissions: { fs: { read: ['/**'] } },
        },
        files: {
          'index.html': '<!doctype html><html><body><h1>Custom app v2 works</h1></body></html>',
          'app.js': 'document.body.dataset.ready = "v2";',
          'styles.css': 'body { color: blue; }',
        },
      }),
    });
    assert.equal(updated.version, 2);

    const updatedAppResponse = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/`);
    assert.equal(updatedAppResponse.status, 200);
    assert.match(await updatedAppResponse.text(), /Custom app v2 works/);

    const versions = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/versions`, {
      headers: authHeaders(user.token),
    });
    assert.equal(versions.currentVersion, 2);
    assert.deepEqual(versions.releases.map((release) => release.version), [2, 1]);

    const rollback = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/rollback`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollback.version, 1);

    const rolledBackResponse = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/`);
    assert.equal(rolledBackResponse.status, 200);
    assert.match(await rolledBackResponse.text(), /Custom app works/);
    const rolledBackPermissions = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(rolledBackPermissions.requested.network, { outbound: ['api.example.com'] });
    assert.deepEqual(rolledBackPermissions.granted, { fs: { read: ['/**'] } });

    const updatedAfterRollback = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        appId: app.appId,
        manifest: {
          name: 'Custom Integration App v3',
          description: 'Monotonic release test',
          version: '3.0.0',
          windowConfig: { defaultWidth: 640, defaultHeight: 520, resizable: true },
          permissions: { fs: { read: ['/**'] } },
        },
        files: {
          'index.html': '<!doctype html><html><body><h1>Custom app v3 works</h1></body></html>',
          'app.js': 'document.body.dataset.ready = "v3";',
        },
      }),
    });
    assert.equal(updatedAfterRollback.version, 3);
    const versionsAfterRollbackUpdate = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/versions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(versionsAfterRollbackUpdate.releases.map((release) => release.version), [3, 2, 1]);

    const deleted = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}`, {
      method: 'DELETE',
      headers: authHeaders(user.token),
    });
    assert.equal(deleted.success, true);

    const deletedAppResponse = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/`);
    assert.equal(deletedAppResponse.status, 404);
  });

  it('rejects a capability token used against a different app or malformed', async () => {
    const user = await signupUser();
    const deployApp = (name) => expectOk('/api/apps/dev-deploy', {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: { name, version: '1.0.0', windowConfig: { defaultWidth: 600, defaultHeight: 500 }, permissions: { fs: { read: ['/**'] } } },
        files: { 'index.html': '<!doctype html><body>x</body>' },
      }),
    });
    const appA = await deployApp('Cap App A');
    const appB = await deployApp('Cap App B');

    await expectOk(`/api/apps/${encodeURIComponent(appA.appId)}/permissions`, {
      method: 'PATCH', headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'] } } }),
    });
    const capA = await expectOk(`/api/apps/${encodeURIComponent(appA.appId)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body: '{}',
    });
    const fsList = (appId, token) => worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(appId)}/fs/list`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    // A's token works on A, is rejected on B (appId-bound), and a garbage token is rejected.
    assert.equal((await fsList(appA.appId, capA.token)).status, 200);
    assert.equal((await fsList(appB.appId, capA.token)).status, 401);
    assert.equal((await fsList(appA.appId, 'not.a.valid.jwt')).status, 401);
  });

  it('rejects unsafe custom app source before registration', async () => {
    const user = await signupUser();
    const rejected = await fetchJson('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Unsafe App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: {
          'index.html': '<script src="https://evil.example/app.js"></script>',
        },
      }),
    });
    assert.equal(rejected.response.status, 400);
    assert.match(rejected.body.error, /External script URLs are not allowed/);

    // Protocol-relative URLs (`//host`) must be rejected too — they resolve to
    // an external origin just like https://. (Reuses the same user to avoid an
    // extra signup against the shared rate-limit bucket.)
    const protoRelative = await fetchJson('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Proto Relative App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: { 'index.html': '<script src="//evil.example/app.js"></script>' },
      }),
    });
    assert.equal(protoRelative.response.status, 400);
    assert.match(protoRelative.body.error, /External script URLs are not allowed/);
  });

  it('enforces app-source safety and permission-declaration rules', async () => {
    // One signup, many sequential checks — keeps us off the shared auth
    // rate-limit bucket while exercising each validateGeneratedApp branch.
    const user = await signupUser();
    const deploy = (files, permissions, name = 'Validator App') =>
      fetchJson('/api/apps/dev-deploy', {
        method: 'POST',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify({
          manifest: {
            name,
            version: '1.0.0',
            windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
            ...(permissions ? { permissions } : {}),
          },
          files,
        }),
      });

    // External stylesheet link.
    const extCss = await deploy({
      'index.html': '<!doctype html><link rel="stylesheet" href="https://evil.example/s.css"><body>x</body>',
    });
    assert.equal(extCss.response.status, 400);
    assert.match(extCss.body.error, /External stylesheet URLs are not allowed/);

    // Dynamic import() from an external URL (checked across all files, not just HTML).
    const dynImport = await deploy({
      'index.html': '<!doctype html><body><script src="app.js"></script></body>',
      'app.js': "const m = await import('https://evil.example/m.js'); void m;",
    });
    assert.equal(dynImport.response.status, 400);
    assert.match(dynImport.body.error, /Dynamic imports from external URLs are not allowed/);

    // Static `from` import from an external URL.
    const staticImport = await deploy({
      'index.html': '<!doctype html><body><script type="module" src="app.js"></script></body>',
      'app.js': "import thing from 'https://evil.example/m.js'; void thing;",
    });
    assert.equal(staticImport.response.status, 400);
    assert.match(staticImport.body.error, /Imports from external URLs are not allowed/);

    // Uses window.eternal.fs.read* but declares no fs read permission.
    const undeclaredRead = await deploy({
      'index.html': '<!doctype html><body><script src="app.js"></script></body>',
      'app.js': "const files = await window.eternal.fs.readText('/notes.txt'); void files;",
    });
    assert.equal(undeclaredRead.response.status, 400);
    assert.match(undeclaredRead.body.error, /did not declare fs read permissions/);

    // Uses window.eternal.profile but declares no profile permission.
    const undeclaredProfile = await deploy({
      'index.html': '<!doctype html><body><script src="app.js"></script></body>',
      'app.js': 'const p = window.eternal.profile.get(); void p;',
    });
    assert.equal(undeclaredProfile.response.status, 400);
    assert.match(undeclaredProfile.body.error, /did not declare profile permissions/);

    // Uses window.eternal.fetch but declares no network permission.
    const undeclaredNet = await deploy({
      'index.html': '<!doctype html><body><script src="app.js"></script></body>',
      'app.js': "window.eternal.fetch('https://api.example.com/x');",
    });
    assert.equal(undeclaredNet.response.status, 400);
    assert.match(undeclaredNet.body.error, /did not declare network permissions/);

    // Emits IPC without declaring ipc emit permission. (Regression: this
    // message prefix previously fell through the status map to 500.)
    const undeclaredIpc = await deploy({
      'index.html': '<!doctype html><body><script src="app.js"></script></body>',
      'app.js': "window.eternal.ipc.emit('channel', { hi: true });",
    });
    assert.equal(undeclaredIpc.response.status, 400);
    assert.match(undeclaredIpc.body.error, /did not declare ipc emit permissions/);

    // References a local asset that doesn't exist in the bundle.
    const missingAsset = await deploy({
      'index.html': '<!doctype html><body><script src="does-not-exist.js"></script></body>',
    });
    assert.equal(missingAsset.response.status, 400);
    assert.match(missingAsset.body.error, /Missing local asset/);

    // No HTML entrypoint at all.
    const noHtml = await deploy({ 'app.js': 'console.log("hi");' });
    assert.equal(noHtml.response.status, 400);
    assert.match(noHtml.body.error, /must include at least one HTML file/);

    // Positive control: fs read that IS declared deploys successfully.
    const allowed = await deploy(
      {
        'index.html': '<!doctype html><body><script src="app.js"></script></body>',
        'app.js': "window.eternal.fs.readText('/notes.txt').then(() => {});",
      },
      { fs: { read: ['/**'] } },
      'Declared Reader App',
    );
    assert.equal(allowed.response.status, 200);
    assert.ok(allowed.body.appId, 'declared-permission app should register');
  });

  it('rejects post-bundle contract violations with structured 400 errors, never 500', async () => {
    // Every checked-in negative fixture under test/fixtures/apps must fail
    // dev-deploy with its declared issue code. The fixture directories are
    // the regression contract for the deterministic post-bundle validation
    // pass (utils/appBundleValidation.ts).
    const user = await signupUser();
    const deployFixture = (name) =>
      fetchJson('/api/apps/dev-deploy', {
        method: 'POST',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify(devDeployBody(loadAppFixture(name))),
      });

    const negativeFixtures = fs.readdirSync(APP_FIXTURES_ROOT)
      .filter((name) => fs.existsSync(path.join(APP_FIXTURES_ROOT, name, 'expect.json')));
    assert.ok(negativeFixtures.length >= 8, 'expected at least eight negative app fixtures');

    for (const name of negativeFixtures) {
      const expect = JSON.parse(fs.readFileSync(path.join(APP_FIXTURES_ROOT, name, 'expect.json'), 'utf8'));
      const { response, body } = await deployFixture(name);
      assert.equal(
        response.status,
        400,
        `${name}: expected 400, got ${response.status}: ${JSON.stringify(body)}`,
      );
      assert.ok(Array.isArray(body.issues) && body.issues.length > 0, `${name}: expected structured issues`);
      assert.ok(
        body.issues.some((issue) => issue.code === expect.code),
        `${name}: expected issue ${expect.code}, got ${JSON.stringify(body.issues)}`,
      );
      for (const issue of body.issues) {
        assert.equal(typeof issue.code, 'string');
        assert.equal(typeof issue.message, 'string');
        assert.ok(issue.message.length > 0);
      }
    }

    // Regression: a client bundle shipping the reserved runtime filename is a
    // client error — this previously fell through the status prefix map and
    // returned 500 (server-fault alarm) instead of 400.
    const reserved = await fetchJson('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Reserved Name App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: {
          'index.html': '<!doctype html><body>x</body>',
          'eternal-runtime.js': 'window.eternal = {};',
        },
      }),
    });
    assert.equal(reserved.response.status, 400);
    assert.match(reserved.body.error, /reserved by the app runtime/);
    assert.equal(reserved.body.issues[0].code, 'source/reserved-filename');
  });

  it('accepts guarded browser-storage idioms in dev-deploy', async () => {
    // Positive control for the sandbox-storage guard rules: typeof probes,
    // 'x' in window probes, and try/catch-wrapped access are standard
    // survival idioms for the opaque-origin iframe and must deploy — only
    // unguarded access is rejected (covered by the sandbox-local-storage
    // negative fixture above).
    const user = await signupUser();
    const { response, body } = await fetchJson('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify(devDeployBody(loadAppFixture('guarded-storage'))),
    });
    assert.equal(response.status, 200, `guarded-storage fixture should deploy: ${JSON.stringify(body)}`);
    assert.ok(body.appId);
  });

  it('deploys the Photo Grid reference app and reads real photos through the fs grant', async () => {
    // The Workstream 3 acceptance story (design/12-orchestrator-v2.md):
    // "Build me a gallery app for my photos" -> app installs -> reads the
    // user's actual photos through window.eternal. The fixture must pass the
    // full pipeline (pre-bundle source gate + deterministic post-bundle
    // validation + Dynamic Worker compilation), and its fs grant must make a
    // real uploaded image visible through the app bridge.
    const user = await signupUser();

    const uploadForm = new UndiciFormData();
    uploadForm.set('file', createPngFile('sunset.png'));
    const upload = await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });
    assert.equal(upload.item.type, 'image');

    const photoGrid = loadAppFixture('photo-grid');
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify(devDeployBody(photoGrid)),
    });
    assert.ok(app.appId, 'Photo Grid should deploy');

    // The app's compiled Dynamic Worker serves the entry HTML with the
    // platform runtime injected.
    const htmlResponse = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/`);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(html, /Photo Grid/);
    assert.match(html, /eternal-runtime\.js/);

    // Grant the declared fs read (the "fs read grant" from the fixture
    // manifest), then verify the bridge the app calls at runtime exposes the
    // uploaded photo: fs.list must include it and fs.read must stream the PNG.
    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: photoGrid.manifest.permissions }),
    });
    const capability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: '{}',
    });
    const bearer = { Authorization: `Bearer ${capability.token}` };

    const list = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/fs/list`, { headers: bearer });
    const listed = list.items.filter((item) => item.id === upload.item.id);
    assert.equal(listed.length, 1, 'the granted image should be listable through the app bridge');
    assert.equal(listed[0].mimeType, 'image/png');

    const readResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/fs/read/${upload.item.id}`,
      { headers: bearer },
    );
    assert.equal(readResponse.status, 200);
    assert.equal(readResponse.headers.get('content-type'), 'image/png');
  });

  it('scopes app fs reads to the granted path glob', async () => {
    // The authoritative boundary (fsPolicy.canReadItem): an app granted only
    // /Gallery/** must see items under /Gallery and must NOT see or read
    // anything outside it. Exercised through the capability-token fs endpoints,
    // which read the live user DO directly.
    const user = await signupUser();

    const gallery = await createDesktopItem(user.token, {
      type: 'folder', name: 'Gallery', parentId: null, position: { x: 0, y: 0 }, isPublic: false,
    });
    const inScope = await createDesktopItem(user.token, {
      type: 'text', name: 'pic.txt', parentId: gallery.id, position: { x: 0, y: 1 },
      isPublic: false, textContent: 'inside gallery',
    });
    const outOfScope = await createDesktopItem(user.token, {
      type: 'text', name: 'private.txt', parentId: null, position: { x: 1, y: 0 },
      isPublic: false, textContent: 'top secret',
    });

    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Scoped Reader',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/Gallery/**'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>scoped</body></html>' },
      }),
    });

    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] } } }),
    });
    const capability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    const bearer = { Authorization: `Bearer ${capability.token}` };

    // List: the in-scope file (and its Gallery folder) appear; the root-level
    // private file does not.
    const listResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/fs/list`,
      { headers: bearer },
    );
    assert.equal(listResponse.status, 200);
    const listedNames = (await readJson(listResponse)).items.map((i) => i.name);
    assert.ok(listedNames.includes('pic.txt'), 'in-scope file should be listed');
    assert.ok(!listedNames.includes('private.txt'), 'out-of-scope file must NOT be listed');

    // Direct read of the out-of-scope item is forbidden even by id.
    const forbiddenRead = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/fs/read/${encodeURIComponent(outOfScope.id)}`,
      { headers: bearer },
    );
    assert.equal(forbiddenRead.status, 403);

    // Direct read of the in-scope item succeeds and returns its content.
    const allowedRead = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/fs/read/${encodeURIComponent(inScope.id)}`,
      { headers: bearer },
    );
    assert.equal(allowedRead.status, 200);
    assert.match(await allowedRead.text(), /inside gallery/);
  });

  it('classifies outbound hosts for SSRF without false-positives on fc/fd domains', async () => {
    const user = await signupUser();
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Net App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { network: { outbound: ['api.example.com'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>net</body></html>' },
      }),
    });
    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { network: { outbound: ['api.example.com'] } } }),
    });
    const capability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    const bearer = authHeaders(capability.token, JSON_HEADERS);
    const proxyFetch = (targetUrl) =>
      fetchJson(`/api/apps/${encodeURIComponent(app.appId)}/_eternal/fetch`, {
        method: 'POST',
        headers: bearer,
        body: JSON.stringify({ url: targetUrl }),
      });

    // Regression: a public DNS host starting with "fc"/"fd" (e.g. fdic.gov)
    // must NOT be treated as a private IPv6 ULA address. It isn't on the
    // allowlist here, so it reaches the allowlist rejection ("Not permitted",
    // 403 — a denial, not a server fault), which proves it passed the SSRF
    // gate — no real network call is made.
    const fdDomain = await proxyFetch('https://fdic.gov/data');
    assert.equal(fdDomain.response.status, 403);
    assert.match(fdDomain.body.error, /Not permitted: outbound access to fdic\.gov/);
    assert.doesNotMatch(fdDomain.body.error, /Network URL is not allowed/);

    // Actual private targets stay blocked at the SSRF gate (before the
    // allowlist): an RFC1918 IPv4 host and an IPv6 ULA literal both fail with
    // the SSRF denial (403), confirming the fix didn't widen the private-host
    // net.
    const loopback = await proxyFetch('http://127.0.0.1/');
    assert.equal(loopback.response.status, 403);
    assert.match(loopback.body.error, /Network URL is not allowed/);

    const ulaLiteral = await proxyFetch('http://[fd00::1]/');
    assert.equal(ulaLiteral.response.status, 403);
    assert.match(ulaLiteral.body.error, /Network URL is not allowed/);
  });

  it('restricts app fs.patch to benign fields (no publishing or escalation)', async () => {
    const user = await signupUser();
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Patcher',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/**'], write: ['/**'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>patch</body></html>' },
      }),
    });
    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'], write: ['/**'] } } }),
    });
    const capability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    const bearer = authHeaders(capability.token, JSON_HEADERS);
    const bridge = (p, body) => fetchJson(`/api/apps/${encodeURIComponent(app.appId)}/_eternal${p}`, {
      method: 'POST', headers: bearer, body: JSON.stringify(body),
    });

    // The app creates a private note it is allowed to write.
    const created = await bridge('/fs/write', { path: '/note.txt', content: 'hello' });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.isPublic, false);
    const noteId = created.body.id;

    // A patch mixing a benign field with privileged ones applies only the
    // benign field: the note is renamed but NOT published.
    const mixed = await bridge(`/fs/patch/${encodeURIComponent(noteId)}`, {
      name: 'renamed.txt', isPublic: true,
    });
    assert.equal(mixed.response.status, 200);
    assert.equal(mixed.body.name, 'renamed.txt', 'benign field should apply');
    assert.equal(mixed.body.isPublic, false, 'app must not be able to publish the item');

    // A patch of ONLY privileged fields changes nothing and is denied (403 —
    // a policy denial, not a server fault).
    const privileged = await bridge(`/fs/patch/${encodeURIComponent(noteId)}`, {
      isPublic: true, grantedPermissions: { fs: { read: ['/**'] } },
    });
    assert.equal(privileged.response.status, 403);
    assert.match(privileged.body.error, /No permitted fields to update/);
  });

  it('normalizes malformed custom permission declarations safely', async () => {
    const user = await signupUser();
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Permission Normalization App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          permissions: {
            fs: { read: 'not-an-array' },
            network: { outbound: ['api.example.com', 'bad host'] },
            profile: { read: ['username', 'not-a-profile-field'] },
          },
        },
        files: { 'index.html': '<!doctype html><html><body>safe</body></html>' },
      }),
    });
    const permissions = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(permissions.requested, {
      network: { outbound: ['api.example.com'] },
      profile: { read: ['username'] },
    });
  });

  // -------------------------------------------------------------------------
  // Sandbox adversarial suite (roadmap Workstream 3 item 5): a generated or
  // edited app cannot escape its declared scope. Every attempt below must be
  // denied with a 4xx — never a 500, which would make a denial look like a
  // platform fault (and trip 5xx alarms).
  // -------------------------------------------------------------------------

  it('blocks app fs scope escapes: traversal, foreign ids, symlink-like names', async () => {
    const user = await signupUser();
    const stranger = await signupUser();

    // Owner desktop: /Gallery (the granted scope), a root-level private file,
    // and /Vault/../secrets.txt — a ".."-named folder whose child paths LOOK
    // traversal-like even though they are ordinary items out of scope.
    const gallery = await createDesktopItem(user.token, {
      type: 'folder', name: 'Gallery', parentId: null, position: { x: 0, y: 0 }, isPublic: false,
    });
    const inScope = await createDesktopItem(user.token, {
      type: 'text', name: 'pic.txt', parentId: gallery.id, position: { x: 0, y: 1 },
      isPublic: false, textContent: 'inside gallery',
    });
    const privateRoot = await createDesktopItem(user.token, {
      type: 'text', name: 'private.txt', parentId: null, position: { x: 1, y: 0 },
      isPublic: false, textContent: 'top secret',
    });
    const vault = await createDesktopItem(user.token, {
      type: 'folder', name: 'Vault', parentId: null, position: { x: 2, y: 0 }, isPublic: false,
    });
    const dotDotFolder = await createDesktopItem(user.token, {
      type: 'folder', name: '..', parentId: vault.id, position: { x: 0, y: 0 }, isPublic: false,
    });
    const vaultSecret = await createDesktopItem(user.token, {
      type: 'text', name: 'secrets.txt', parentId: dotDotFolder.id, position: { x: 0, y: 1 },
      isPublic: false, textContent: 'vault secret',
    });
    // A second user's private file whose id the app will try to read.
    const strangerFile = await createDesktopItem(stranger.token, {
      type: 'text', name: 'stranger.txt', parentId: null, position: { x: 0, y: 0 },
      isPublic: false, textContent: 'stranger secret',
    });

    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Traversal Gallery',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/Gallery/**'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>gallery</body></html>' },
      }),
    });
    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] } } }),
    });
    const capability = await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: '{}',
    });
    const bearer = { Authorization: `Bearer ${capability.token}` };
    const appId = encodeURIComponent(app.appId);

    // fs.list (REST + in-app bridge): the path filter may narrow within the
    // grant but must never widen it. Plain, dot-dot, URL-encoded, and
    // absolute-path forms all stay free of out-of-scope names.
    const leakyFilters = [
      '/Gallery/../Vault',
      '/Gallery/../../',
      '../',
      '/..',
      '%2e%2e/Vault',
      `/api/files/${stranger.user.uid}/${strangerFile.id}/stranger.txt`,
      `/${stranger.user.uid}/stranger.txt`,
    ];
    for (const surface of ['/fs/list', '/_eternal/fs/list']) {
      for (const filter of leakyFilters) {
        const response = await worker.fetch(
          `${BASE_URL}/api/apps/${appId}${surface}?path=${filter}`,
          { headers: bearer },
        );
        assert.equal(response.status, 200, `${surface}?path=${filter} should not error`);
        const body = await readJson(response);
        const names = body.items.map((item) => item.name);
        assert.ok(!names.includes('secrets.txt'), `${surface}?path=${filter} leaked the Vault secret`);
        assert.ok(!names.includes('private.txt'), `${surface}?path=${filter} leaked the root private file`);
        assert.ok(!names.includes('stranger.txt'), `${surface}?path=${filter} leaked another user's file`);
      }
    }

    // fs.read by id (both surfaces): out-of-scope ids are denied even when a
    // ".."-named ancestor makes the item's path look traversal-like, and a
    // foreign user's ids never resolve in the app owner's desktop.
    const readRest = (rawId) => worker.fetch(
      `${BASE_URL}/api/apps/${appId}/fs/read/${rawId}`,
      { headers: bearer },
    );
    const readBridge = (rawId) => worker.fetch(
      `${BASE_URL}/api/apps/${appId}/_eternal/fs/read/${rawId}`,
      { headers: bearer },
    );
    for (const [surface, read] of [['rest', readRest], ['bridge', readBridge]]) {
      assert.equal(
        (await read(encodeURIComponent(vaultSecret.id))).status, 403,
        `${surface}: the ".."-path item must be denied`,
      );
      assert.equal(
        (await read(encodeURIComponent(privateRoot.id))).status, 403,
        `${surface}: an out-of-scope root file must be denied`,
      );
      assert.equal(
        (await read(encodeURIComponent(strangerFile.id))).status, 404,
        `${surface}: another user's item id must not resolve`,
      );
      const allowed = await read(encodeURIComponent(inScope.id));
      assert.equal(allowed.status, 200, `${surface}: the in-scope read must keep working`);
      assert.match(await allowed.text(), /inside gallery/);
    }

    // fs.read with traversal-shaped ids: literal dot-segments are normalized
    // away by URL parsing, URL-encoded traversal resolves to no item, and an
    // id carrying literal ".." is rejected by the id validator. None may
    // resolve to a blob or leak content.
    for (const [surface, read] of [['rest', readRest], ['bridge', readBridge]]) {
      for (const rawId of ['..', '%2e%2e', '.%2e', '..%2f..%2fprivate.txt']) {
        const response = await read(rawId);
        assert.ok(
          response.status >= 400 && response.status < 500,
          `${surface}: traversal id "${rawId}" must be a 4xx, got ${response.status}`,
        );
        const text = await response.text();
        for (const secret of ['top secret', 'vault secret', 'stranger secret']) {
          assert.ok(!text.includes(secret), `${surface}: traversal id "${rawId}" leaked "${secret}"`);
        }
      }
    }
  });

  it('denies profile.get without the profile grant and leaks no profile fields', async () => {
    const user = await signupUser();
    // Give the account real profile data so an accidental leak is observable.
    await patchProfile(user.token, { bio: 'owner bio text' });

    const deploy = (name, permissions) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name,
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          ...(permissions ? { permissions } : {}),
        },
        files: { 'index.html': '<!doctype html><html><body>profile</body></html>' },
      }),
    });
    const mint = (appId, body = '{}') => expectOk(`/api/apps/${encodeURIComponent(appId)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body,
    });
    const profileVia = (appId, token) => fetchJson(`/api/apps/${encodeURIComponent(appId)}/_eternal/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // An app that never declared profile access is denied outright — a 403,
    // not a fake-empty 200 profile.
    const bare = await deploy('Profile Bare App');
    const bareCap = await mint(bare.appId);
    const bareResult = await profileVia(bare.appId, bareCap.token);
    assert.equal(bareResult.response.status, 403);
    assert.match(bareResult.body.error, /profile access not granted/);
    assert.ok(!('username' in bareResult.body) && !('bio' in bareResult.body),
      'the denial body must not carry profile fields');

    // Declared-but-ungranted is equally denied.
    const declared = await deploy('Profile Declared App', {
      profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
    });
    const declaredCap = await mint(declared.appId);
    assert.equal((await profileVia(declared.appId, declaredCap.token)).response.status, 403);

    // Approving a subset exposes exactly that subset.
    await expectOk(`/api/apps/${encodeURIComponent(declared.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { profile: { read: ['username'] } } }),
    });
    const grantedCap = await mint(declared.appId);
    const grantedResult = await profileVia(declared.appId, grantedCap.token);
    assert.equal(grantedResult.response.status, 200);
    assert.equal(grantedResult.body.username, user.user.username);
    assert.equal(grantedResult.body.displayName, undefined, 'displayName stays hidden without its grant');
    assert.equal(grantedResult.body.bio, undefined, 'bio stays hidden without its grant');
    assert.equal(grantedResult.body.avatar, undefined, 'avatar stays hidden without its grant');

    // A capability mint that asks for more fields cannot exceed the grant.
    const wideCap = await mint(declared.appId, JSON.stringify({
      granted: { profile: { read: ['username', 'bio'] } },
    }));
    assert.deepEqual(wideCap.granted, { profile: { read: ['username'] } });
    const wideResult = await profileVia(declared.appId, wideCap.token);
    assert.equal(wideResult.response.status, 200);
    assert.equal(wideResult.body.bio, undefined, 'a self-minted wide token must not widen the profile grant');
  });

  it('denies undeclared outbound network requests with 4xx, not 500', async () => {
    const user = await signupUser();
    const deploy = (name, permissions) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name,
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          ...(permissions ? { permissions } : {}),
        },
        files: { 'index.html': '<!doctype html><html><body>net</body></html>' },
      }),
    });
    const mint = (appId, body = '{}') => expectOk(`/api/apps/${encodeURIComponent(appId)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body,
    });
    const fetchVia = (appId, token, url) => fetchJson(`/api/apps/${encodeURIComponent(appId)}/_eternal/fetch`, {
      method: 'POST',
      headers: authHeaders(token, JSON_HEADERS),
      body: JSON.stringify({ url }),
    });

    // An app that declared no network permission at all.
    const hermetic = await deploy('Net Hermetic App');
    const hermeticCap = await mint(hermetic.appId);
    const ungranted = await fetchVia(hermetic.appId, hermeticCap.token, 'https://evil.example.com/steal');
    assert.equal(ungranted.response.status, 403, 'ungranted network use must be a 4xx denial');
    assert.match(ungranted.body.error, /outbound network access not granted/);

    // Declared + granted a single host: every other target class is denied —
    // foreign hosts, private-IP/SSRF targets, non-http(s) schemes, and URLs
    // with userinfo credentials.
    const net = await deploy('Net Narrow App', { network: { outbound: ['api.example.com'] } });
    await expectOk(`/api/apps/${encodeURIComponent(net.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { network: { outbound: ['api.example.com'] } } }),
    });
    const netCap = await mint(net.appId);
    for (const [url, pattern] of [
      ['https://evil.example.com/x', /outbound access to evil\.example\.com is not allowed/],
      ['http://127.0.0.1/', /Network URL is not allowed/],
      ['http://[fd00::1]/', /Network URL is not allowed/],
      ['file:///etc/passwd', /Network URL is not allowed/],
      ['https://user:pass@api.example.com/', /Network URL is not allowed/],
    ]) {
      const result = await fetchVia(net.appId, netCap.token, url);
      assert.equal(result.response.status, 403, `fetch to ${url} must be denied, got ${result.response.status}`);
      assert.match(result.body.error, pattern);
    }

    // A capability mint that requests a wildcard cannot smuggle it past the
    // stored grant: the literal intersection keeps the granted host and
    // drops the '*'.
    const wideCap = await mint(net.appId, JSON.stringify({
      granted: { network: { outbound: ['*', 'api.example.com'] } },
    }));
    assert.deepEqual(wideCap.granted, { network: { outbound: ['api.example.com'] } });
    const starAttempt = await fetchVia(net.appId, wideCap.token, 'https://evil.example.com/x');
    assert.equal(starAttempt.response.status, 403);
  });

  it('scopes file tokens and urlFor results to their owner and app', async () => {
    const user = await signupUser();
    const stranger = await signupUser();

    const ownForm = new UndiciFormData();
    ownForm.set('file', new File(['owner file'], 'own.txt', { type: 'text/plain' }));
    const own = await expectOk('/api/upload', {
      method: 'POST', headers: authHeaders(user.token), body: ownForm,
    });

    const strangerForm = new UndiciFormData();
    strangerForm.set('file', new File(['stranger file'], 'stranger.txt', { type: 'text/plain' }));
    const strangerUpload = await expectOk('/api/upload', {
      method: 'POST', headers: authHeaders(stranger.token), body: strangerForm,
    });

    // Owner items: one inside the app's granted scope, one outside it.
    const gallery = await createDesktopItem(user.token, {
      type: 'folder', name: 'Gallery', parentId: null, position: { x: 0, y: 0 }, isPublic: false,
    });
    const inScope = await createDesktopItem(user.token, {
      type: 'text', name: 'pic.txt', parentId: gallery.id, position: { x: 0, y: 1 },
      isPublic: false, textContent: 'inside gallery',
    });
    const outOfScope = await createDesktopItem(user.token, {
      type: 'text', name: 'outside.txt', parentId: null, position: { x: 1, y: 0 },
      isPublic: false, textContent: 'outside scope',
    });

    const deploy = (name, permissions) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name,
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          ...(permissions ? { permissions } : {}),
        },
        files: { 'index.html': '<!doctype html><html><body>scoped</body></html>' },
      }),
    });
    const galleryApp = await deploy('UrlFor Gallery App', { fs: { read: ['/Gallery/**'] } });
    const vaultApp = await deploy('UrlFor Vault App', { fs: { read: ['/Vault/**'] } });
    for (const appId of [galleryApp.appId, vaultApp.appId]) {
      await expectOk(`/api/apps/${encodeURIComponent(appId)}/permissions`, {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify({ granted: { fs: { read: [appId === galleryApp.appId ? '/Gallery/**' : '/Vault/**'] } } }),
      });
    }
    const galleryCap = await expectOk(`/api/apps/${encodeURIComponent(galleryApp.appId)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body: '{}',
    });
    const galleryAppId = encodeURIComponent(galleryApp.appId);
    const vaultAppId = encodeURIComponent(vaultApp.appId);
    const bearer = { Authorization: `Bearer ${galleryCap.token}` };

    // A file token is bound to the account that minted it: the owner's token
    // reads the owner's own file...
    const { ft } = await expectOk('/api/file-token', {
      method: 'POST', headers: authHeaders(user.token),
    });
    const ownUrl = `${BASE_URL}/api/files/${user.user.uid}/${own.item.id}/${encodeURIComponent(own.item.name)}?ft=${encodeURIComponent(ft)}`;
    const ownRes = await worker.fetch(ownUrl);
    assert.equal(ownRes.status, 200, 'the owner ft must read the owner own file');
    assert.equal(await ownRes.text(), 'owner file');

    // ...but is rejected for another user's private file, even knowing the
    // exact uid/itemId/filename path.
    const strangerUrl = `${BASE_URL}/api/files/${stranger.user.uid}/${strangerUpload.item.id}/${encodeURIComponent(strangerUpload.item.name)}?ft=${encodeURIComponent(ft)}`;
    assert.equal((await worker.fetch(strangerUrl)).status, 403, 'an ft must not cross users');

    // A file token is not a session credential: it cannot approve grants,
    // mint capabilities, or renew itself.
    assert.equal((await fetchJson(`/api/apps/${galleryAppId}/permissions`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ft}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: { fs: { read: ['/**'] } } }),
    })).response.status, 401, 'an ft must not authorize permission changes');
    assert.equal((await fetchJson(`/api/apps/${galleryAppId}/capability`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ft}`, 'Content-Type': 'application/json' },
      body: '{}',
    })).response.status, 401, 'an ft must not mint capabilities');
    assert.equal((await fetchJson('/api/file-token', {
      method: 'POST', headers: { Authorization: `Bearer ${ft}` },
    })).response.status, 401, 'an ft must not renew itself');

    // The sandboxed app cannot mint a file token at all — it holds neither a
    // session nor a file token, and its capability is not one.
    assert.equal((await fetchJson('/api/file-token', { method: 'POST' })).response.status, 401);
    assert.equal((await fetchJson('/api/file-token', {
      method: 'POST', headers: { Authorization: `Bearer ${galleryCap.token}` },
    })).response.status, 401, 'an app capability must not mint file tokens');

    // urlFor results (same-origin /_eternal/fs/read URLs) are appId- and
    // scope-bound. Without any credential — exactly how an <img src> fetches
    // one — the bridge answers 401 before any scope check.
    assert.equal(
      (await worker.fetch(`${BASE_URL}/api/apps/${galleryAppId}/_eternal/fs/read/${encodeURIComponent(inScope.id)}`)).status, 401,
      'a urlFor result must not resolve without the capability',
    );
    // With the app's own capability: another user's item id never resolves.
    assert.equal(
      (await worker.fetch(`${BASE_URL}/api/apps/${galleryAppId}/_eternal/fs/read/${encodeURIComponent(strangerUpload.item.id)}`, { headers: bearer })).status, 404,
      'another user\'s item id must not resolve through the bridge',
    );
    // An out-of-scope item in the same desktop is denied.
    assert.equal(
      (await worker.fetch(`${BASE_URL}/api/apps/${galleryAppId}/_eternal/fs/read/${encodeURIComponent(outOfScope.id)}`, { headers: bearer })).status, 403,
      'an out-of-scope item must be denied through the bridge',
    );
    // A capability is appId-bound: it does not authenticate on another app's mount.
    assert.equal(
      (await worker.fetch(`${BASE_URL}/api/apps/${vaultAppId}/_eternal/fs/read/${encodeURIComponent(outOfScope.id)}`, { headers: bearer })).status, 401,
      'a capability must not authenticate on another app\'s mount',
    );
    // Positive control: the in-scope read through the app's own mount works.
    const okRead = await worker.fetch(
      `${BASE_URL}/api/apps/${galleryAppId}/_eternal/fs/read/${encodeURIComponent(inScope.id)}`,
      { headers: bearer },
    );
    assert.equal(okRead.status, 200);
    assert.match(await okRead.text(), /inside gallery/);
  });

  it('requires explicit re-approval to expand app permissions (no self-escalation)', async () => {
    const user = await signupUser();
    const rival = await signupUser();

    const gallery = await createDesktopItem(user.token, {
      type: 'folder', name: 'Gallery', parentId: null, position: { x: 0, y: 0 }, isPublic: false,
    });
    const inScope = await createDesktopItem(user.token, {
      type: 'text', name: 'pic.txt', parentId: gallery.id, position: { x: 0, y: 1 },
      isPublic: false, textContent: 'inside gallery',
    });
    const privateRoot = await createDesktopItem(user.token, {
      type: 'text', name: 'private.txt', parentId: null, position: { x: 1, y: 0 },
      isPublic: false, textContent: 'top secret',
    });

    const deploy = (appId, name, permissions, files) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        ...(appId ? { appId } : {}),
        manifest: {
          name,
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          ...(permissions ? { permissions } : {}),
        },
        files,
      }),
    });
    const html = (body) => ({ 'index.html': `<!doctype html><html><body>${body}</body></html>` });

    // v1: narrow, approved scope.
    const app = await deploy(null, 'Escalation Guard', { fs: { read: ['/Gallery/**'] } }, html('v1'));
    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] } } }),
    });
    const mint = (body = '{}') => expectOk(`/api/apps/${encodeURIComponent(app.appId)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body,
    });
    const bridge = (path, token, method, body) => worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/_eternal${path}`,
      {
        method,
        headers: authHeaders(token, JSON_HEADERS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    const appId = encodeURIComponent(app.appId);

    // v2: the app "edits its own manifest" (dev-deploy update) to declare a
    // much broader scope — keeping the old declaration alongside the new one,
    // as a realistic additive update would. The requested set grows, but the
    // grant must not.
    const updated = await deploy(app.appId, 'Escalation Guard', {
      fs: { read: ['/Gallery/**', '/**'], write: ['/**'] },
      profile: { read: ['username', 'bio'] },
      network: { outbound: ['*'] },
    }, html('v2'));
    assert.equal(updated.version, 2);
    const afterUpdate = await expectOk(`/api/apps/${appId}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(afterUpdate.requested.fs.read, ['/Gallery/**', '/**'], 'the request may grow');
    assert.deepEqual(afterUpdate.granted, { fs: { read: ['/Gallery/**'] } },
      'the grant must not grow with the request');

    // The bridge still denies everything the update tried to claim.
    const cap = await mint();
    assert.equal((await bridge(`/fs/read/${encodeURIComponent(privateRoot.id)}`, cap.token, 'GET')).status, 403);
    assert.equal((await bridge('/profile', cap.token, 'GET')).status, 403);
    assert.equal((await bridge('/fetch', cap.token, 'POST', { url: 'https://evil.example.com/x' })).status, 403);

    // A capability minted with an inflated `granted` body is intersected down
    // to nothing new, and the inflated token gains nothing.
    const wideCap = await mint(JSON.stringify({
      granted: { fs: { read: ['/**'] }, profile: { read: ['username'] }, network: { outbound: ['*'] } },
    }));
    assert.deepEqual(wideCap.granted, {}, 'an inflated mint must be intersected to the stored grant');
    assert.equal((await bridge(`/fs/read/${encodeURIComponent(privateRoot.id)}`, wideCap.token, 'GET')).status, 403);

    // Only the explicit approval route can widen the grant — and it can only
    // grant within what the current manifest requests.
    await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'], write: ['/**'] } } }),
    });
    const approved = await mint();
    const openedRead = await bridge(`/fs/read/${encodeURIComponent(privateRoot.id)}`, approved.token, 'GET');
    assert.equal(openedRead.status, 200, 'after explicit approval the widened scope must work');
    assert.match(await openedRead.text(), /top secret/);
    // The manifest never declared ipc. The approval route mirrors the real
    // client (which sends the full selection), so include the current grant
    // alongside the undeclared domain: fs survives, ipc is discarded.
    const ipcApprove = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        granted: { fs: { read: ['/**'], write: ['/**'] }, ipc: { emit: ['*'] } },
      }),
    });
    assert.deepEqual(ipcApprove.granted, { fs: { read: ['/**'], write: ['/**'] } },
      'approving an undeclared domain must not grant it');

    // With the approved write scope the app can see its own desktop item —
    // but patching itself to add permissions is filtered to benign fields.
    const list = await expectOk(`/api/apps/${appId}/fs/list`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    const selfItem = list.items.find((item) => item.type === 'app' && item.name === 'Escalation Guard');
    assert.ok(selfItem, 'the app item should be visible under a full read grant');

    const selfPatch = await fetchJson(
      `/api/apps/${appId}/_eternal/fs/patch/${encodeURIComponent(selfItem.id)}`,
      {
        method: 'POST',
        headers: authHeaders(approved.token, JSON_HEADERS),
        body: JSON.stringify({
          grantedPermissions: { profile: { read: ['username'] } },
          appManifest: {
            name: 'Escalation Guard', appId: app.appId,
            windowConfig: { defaultWidth: 600, defaultHeight: 500 },
            permissions: { profile: { read: ['username'] } },
          },
          permissionGrantedAt: Date.now(),
        }),
      },
    );
    assert.equal(selfPatch.response.status, 403, 'a self-escalation patch must be denied');
    assert.match(selfPatch.body.error, /No permitted fields to update/);

    // A mixed patch applies only the benign field; grants are untouched.
    const mixed = await fetchJson(
      `/api/apps/${appId}/_eternal/fs/patch/${encodeURIComponent(selfItem.id)}`,
      {
        method: 'POST',
        headers: authHeaders(approved.token, JSON_HEADERS),
        body: JSON.stringify({
          name: 'Escalation Guard Renamed',
          grantedPermissions: { profile: { read: ['username'] } },
        }),
      },
    );
    assert.equal(mixed.response.status, 200);
    assert.equal(mixed.body.name, 'Escalation Guard Renamed', 'the benign field applies');
    const permsAfter = await expectOk(`/api/apps/${appId}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(permsAfter.granted, { fs: { read: ['/**'], write: ['/**'] } },
      'a mixed patch must not change grants');
    assert.deepEqual(permsAfter.requested.profile, { read: ['username', 'bio'] },
      'a mixed patch must not rewrite the manifest');

    // The app's own capability is not a session credential: it cannot mint
    // capabilities or approve permissions on the REST surface.
    assert.equal((await fetchJson(`/api/apps/${appId}/capability`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${approved.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })).response.status, 401, 'a capability must not mint capabilities');
    assert.equal((await fetchJson(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${approved.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: { fs: { read: ['/**'] } } }),
    })).response.status, 401, 'a capability must not approve permissions');

    // A different account cannot edit someone else's app into more permissions.
    const foreignUpdate = await fetchJson('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(rival.token, JSON_HEADERS),
      body: JSON.stringify({
        appId: app.appId,
        manifest: {
          name: 'Hijacked App',
          version: '9.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          permissions: { fs: { read: ['/**'] } },
        },
        files: html('hijack'),
      }),
    });
    assert.equal(foreignUpdate.response.status, 403, 'a non-owner update must be denied');

    // In-scope reads keep working throughout (positive control at the end).
    const still = await bridge(`/fs/read/${encodeURIComponent(inScope.id)}`, approved.token, 'GET');
    assert.equal(still.status, 200);
    assert.match(await still.text(), /inside gallery/);
  });

  it('isolates app storage between apps and rejects forged keys with 4xx', async () => {
    const user = await signupUser();
    const deploy = (name) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name,
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: { 'index.html': '<!doctype html><html><body>storage</body></html>' },
      }),
    });
    const appA = await deploy('Storage App A');
    const appB = await deploy('Storage App B');
    const mint = (appId) => expectOk(`/api/apps/${encodeURIComponent(appId)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body: '{}',
    });
    const capA = await mint(appA.appId);
    const capB = await mint(appB.appId);
    const storage = (appId, token, method, path, body) => fetchJson(
      `/api/apps/${encodeURIComponent(appId)}/_eternal${path}`,
      {
        method,
        headers: authHeaders(token, JSON_HEADERS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );

    const written = await storage(appA.appId, capA.token, 'POST', '/storage/private-note', { value: 'A secret' });
    assert.equal(written.response.status, 200);

    // A reads its own key back; B cannot see it (per-app KV namespace).
    const readA = await storage(appA.appId, capA.token, 'GET', '/storage/private-note');
    assert.equal(readA.response.status, 200);
    assert.equal(readA.body.value, 'A secret');
    const readB = await storage(appB.appId, capB.token, 'GET', '/storage/private-note');
    assert.equal(readB.response.status, 404, "app B must not read app A's storage");

    // B's key list shows nothing from A's namespace.
    const listB = await storage(appB.appId, capB.token, 'GET', '/storage');
    assert.equal(listB.response.status, 200);
    assert.deepEqual(listB.body.keys, [], "app B's key list must not include app A's keys");

    // A key cannot forge another app's namespace: ':' is the namespace
    // separator and is rejected by the validator with a 4xx, not a 500.
    const forged = await storage(appA.appId, capA.token, 'POST', '/storage/x:y', { value: 1 });
    assert.equal(forged.response.status, 400, 'a forged storage key must be a 4xx');
    assert.match(forged.body.error, /Invalid storage key/);
  });

  it('allows only one concurrent refresh-token rotation', async () => {
    const user = await signupUser();
    const clientIp = `refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const refreshRequests = Array.from({ length: 2 }, () => fetchJson('/api/auth/refresh', {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        'CF-Connecting-IP': clientIp,
      },
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    }));

    const results = await Promise.all(refreshRequests);
    const successfulRotations = results.filter(({ response }) => response.status === 200);
    const rejectedRotations = results.filter(({ response }) => response.status === 401);

    assert.equal(successfulRotations.length, 1);
    assert.equal(rejectedRotations.length, 1);
  });

  it('rotates refresh tokens and invalidates the old session', async () => {
    const user = await signupUser();

    const refreshBody = await expectOk('/api/auth/refresh', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });

    assert.notEqual(refreshBody.token, user.token);
    assert.notEqual(refreshBody.refreshToken, user.refreshToken);

    const oldSession = await fetchJson('/api/desktop', {
      headers: authHeaders(user.token),
    });
    assert.equal(oldSession.response.status, 401);

    const newSession = await fetchJson('/api/desktop', {
      headers: authHeaders(refreshBody.token),
    });
    assert.equal(newSession.response.status, 200);

    const reusedRefresh = await fetchJson('/api/auth/refresh', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    assert.equal(reusedRefresh.response.status, 401);
  });

  it('resets passwords, invalidates old sessions, and logs out new sessions', async () => {
    const user = await signupUser();
    const newPassword = 'BetterPass123';

    const forgotPassword = await expectOk('/api/auth/forgot-password', {
      method: 'POST',
      headers: freshAuthIp('forgot'),
      body: JSON.stringify({ email: user.email }),
    });
    assert.ok(forgotPassword.resetToken);

    await expectOk('/api/auth/reset-password', {
      method: 'POST',
      headers: freshAuthIp('reset'),
      body: JSON.stringify({
        token: forgotPassword.resetToken,
        newPassword,
      }),
    });

    const oldSession = await fetchJson('/api/desktop', {
      headers: authHeaders(user.token),
    });
    assert.equal(oldSession.response.status, 401);

    const oldPasswordLogin = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: freshAuthIp('login'),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(oldPasswordLogin.response.status, 401);

    const freshLogin = await loginUser(user.email, newPassword);

    await expectOk('/api/auth/logout', {
      method: 'POST',
      headers: authHeaders(freshLogin.token, freshAuthIp('logout')),
    });

    const loggedOutSession = await fetchJson('/api/desktop', {
      headers: authHeaders(freshLogin.token),
    });
    assert.equal(loggedOutSession.response.status, 401);
  });

  it('removes newly-private items from the visitor snapshot cache immediately', async () => {
    const user = await signupUser();

    const uploadForm = new UndiciFormData();
    uploadForm.set('file', new File(['hello visitor'], 'Public Note.txt', { type: 'text/plain' }));
    uploadForm.set('isPublic', 'true');

    const upload = await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });

    const firstVisit = await expectOk(`/api/visit/${user.user.username}`, {
      method: 'GET',
    });
    assert.ok(firstVisit.items.some((item) => item.id === upload.item.id));

    await patchItems(user.token, [{
      id: upload.item.id,
      updates: { isPublic: false },
    }]);

    const secondVisit = await expectOk(`/api/visit/${user.user.username}`, {
      method: 'GET',
    });
    assert.ok(!secondVisit.items.some((item) => item.id === upload.item.id));
  });

  it('blocks direct public file access once the item is trashed', async () => {
    const user = await signupUser();

    const uploadForm = new UndiciFormData();
    uploadForm.set('file', new File(['trash me'], 'Shared Doc.txt', { type: 'text/plain' }));
    uploadForm.set('isPublic', 'true');

    const upload = await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });

    const filePath = `/api/files/${user.user.uid}/${upload.item.id}/${encodeURIComponent(upload.item.name)}`;

    const beforeTrash = await worker.fetch(`${BASE_URL}${filePath}`);
    assert.equal(beforeTrash.status, 200);

    await patchItems(user.token, [{
      id: upload.item.id,
      updates: {
        isTrashed: true,
        trashedAt: Date.now(),
        originalParentId: upload.item.parentId ?? null,
      },
    }]);

    const afterTrash = await worker.fetch(`${BASE_URL}${filePath}`);
    assert.equal(afterTrash.status, 403);
  });

  it('never caches file bytes and rechecks visibility for full, conditional, and range requests', async () => {
    const user = await signupUser();
    const form = new UndiciFormData();
    form.set('file', new File(['private content'], 'Cache Test.txt', { type: 'text/plain' }));
    form.set('isPublic', 'true');
    const upload = await expectOk('/api/upload', {
      method: 'POST', headers: authHeaders(user.token), body: form,
    });
    const filePath = `${BASE_URL}/api/files/${user.user.uid}/${upload.item.id}/${encodeURIComponent(upload.item.name)}`;
    const publicResponse = await worker.fetch(filePath);
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get('cache-control'), 'private, no-store');
    // A text/plain upload must not be MIME-sniffed into a scriptable type and
    // must download rather than render inline.
    assert.equal(publicResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.match(publicResponse.headers.get('content-disposition') ?? '', /^attachment/);
    const etag = publicResponse.headers.get('etag');
    assert.equal(await publicResponse.text(), 'private content');

    const range = await worker.fetch(filePath, { headers: { Range: 'bytes=0-6' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('cache-control'), 'private, no-store');
    assert.equal(await range.text(), 'private');

    const conditional = await worker.fetch(filePath, { headers: { 'If-None-Match': etag } });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get('cache-control'), 'private, no-store');

    await patchItems(user.token, [{ id: upload.item.id, updates: { isPublic: false } }]);
    for (const headers of [{}, { Range: 'bytes=0-6' }, { 'If-None-Match': etag }]) {
      const revoked = await worker.fetch(filePath, { headers });
      assert.equal(revoked.status, 403);
      await revoked.text();
    }
    const owner = await worker.fetch(filePath, { headers: authHeaders(user.token) });
    assert.equal(owner.status, 200);
    assert.equal(owner.headers.get('cache-control'), 'private, no-store');
    assert.equal(await owner.text(), 'private content');
  });

  it('persists profile variant selections and serves them to visitors', async () => {
    const user = await signupUser();

    // Variants used to be silently dropped by the profile allowlist, so they
    // never survived a reload on a new device and never reached visitors.
    await patchProfile(user.token, { variants: { windowChrome: 'aqua', menuStyle: 'platinum' } });

    const visit = await expectOk(`/api/visit/${user.user.username}`);
    assert.deepEqual(visit.variants, { windowChrome: 'aqua', menuStyle: 'platinum' });

    // Malformed variants are rejected (bad key / non-string value).
    const badKey = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ variants: { '1 bad!': 'x' } }),
    });
    assert.ok(badKey.response.status >= 400, `expected rejection, got ${badKey.response.status}`);

    const badValue = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ variants: { ok: 123 } }),
    });
    assert.ok(badValue.response.status >= 400, `expected rejection, got ${badValue.response.status}`);
  });

  it('changes username with password confirmation, normalization, and uniqueness', async () => {
    const user = await signupUser();
    const uniq = () => `u${Math.random().toString(36).slice(2, 9)}`;
    const change = (body) => fetchJson('/api/auth/change-username', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify(body),
    });

    // Wrong password is rejected.
    assert.equal((await change({ newUsername: uniq(), password: 'WrongPassword123' })).response.status, 401);
    // Reserved name is rejected.
    assert.equal((await change({ newUsername: 'admin', password: user.password })).response.status, 400);
    // All-underscore collapses to empty under normalization → rejected.
    assert.equal((await change({ newUsername: '___', password: user.password })).response.status, 400);

    // A name already taken by another account → 409.
    const other = await signupUser();
    assert.equal((await change({ newUsername: other.username, password: user.password })).response.status, 409);

    // A valid change succeeds and returns the normalized username.
    const target = uniq();
    const ok = await expectOk('/api/auth/change-username', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ newUsername: target, password: user.password }),
    });
    assert.equal(ok.username, target.toLowerCase());
  });

  it('changes password, invalidates old sessions, and requires the current password', async () => {
    const user = await signupUser();
    const newPassword = 'NewSecret123';

    // Wrong current password is rejected.
    const wrong = await fetchJson('/api/auth/change-password', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ currentPassword: 'WrongPassword123', newPassword }),
    });
    assert.equal(wrong.response.status, 401);

    // Correct current password succeeds and mints a fresh session.
    const changed = await expectOk('/api/auth/change-password', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ currentPassword: user.password, newPassword }),
    });
    assert.ok(changed.token && changed.refreshToken);

    // The pre-change refresh token is invalidated (passwordChangedAt > its issuedAt).
    const staleRefresh = await fetchJson('/api/auth/refresh', {
      method: 'POST',
      headers: freshAuthIp('refresh'),
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    assert.equal(staleRefresh.response.status, 401);

    // Old password no longer logs in; the new one does.
    const oldLogin = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: freshAuthIp('login'),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(oldLogin.response.status, 401);

    const newLogin = await expectOk('/api/auth/login', {
      method: 'POST',
      headers: freshAuthIp('login'),
      body: JSON.stringify({ email: user.email, password: newPassword }),
    });
    assert.ok(newLogin.token);
  });

  it('rejects dangerous link-item URLs (stored-XSS guard)', async () => {
    const user = await signupUser();

    // A javascript: URL on a link item would render as an href / open in the
    // website viewer — stored XSS against any visitor who clicks it. Rejected.
    const badCreate = await fetchJson('/api/desktop/items', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ type: 'link', name: 'Evil', url: 'javascript:alert(document.cookie)', position: { x: 0, y: 0 } }),
    });
    assert.ok(badCreate.response.status >= 400, `expected rejection, got ${badCreate.response.status}`);

    // http(s) links are fine.
    const good = await createDesktopItem(user.token, {
      type: 'link', name: 'Good', url: 'https://example.com/', position: { x: 1, y: 0 }, isPublic: false,
    });
    assert.ok(good.id);

    // Editing a safe item's URL to javascript: is rejected on PATCH too.
    const badPatch = await fetchJson('/api/desktop/items', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify([{ id: good.id, updates: { url: 'javascript:alert(1)' } }]),
    });
    assert.ok(badPatch.response.status >= 400, `expected rejection, got ${badPatch.response.status}`);
  });

  it('exports account data without leaking password-equivalent secrets', async () => {
    const user = await signupUser();
    const exportRes = await worker.fetch(`${BASE_URL}/api/auth/export-data`, {
      headers: authHeaders(user.token),
    });
    assert.equal(exportRes.status, 200);
    assert.match(exportRes.headers.get('content-disposition') ?? '', /attachment/);
    const payload = await exportRes.json();

    // Own data is present...
    assert.equal(payload.user.email, user.email);
    assert.equal(payload.user.username, user.user.username);
    // ...but password-equivalent secrets are stripped.
    assert.equal(payload.user.passwordHash, undefined);
    assert.equal(payload.user.recoveryCodesHashed, undefined);
    // And the raw export text must not contain the hash field names at all.
    assert.doesNotMatch(JSON.stringify(payload), /passwordHash|recoveryCodesHashed/);
  });

  it('cancels a pending account deletion during the grace period', async () => {
    const user = await signupUser();

    // Soft-delete (test env pins the grace period to 0, but the purge cron must
    // still run to hard-delete, so the account stays cancellable here).
    await expectOk('/api/auth/delete-account', {
      method: 'POST',
      headers: authHeaders(user.token, freshAuthIp('cancel')),
      body: JSON.stringify({ password: user.password }),
    });

    // Login is blocked with the pending-deletion signal.
    const blocked = await fetchJson('/api/auth/login', {
      method: 'POST',
      headers: freshAuthIp('login'),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.body.accountDeletionPending, true);

    // A wrong password cannot cancel.
    const wrongCancel = await fetchJson('/api/auth/cancel-deletion', {
      method: 'POST',
      headers: freshAuthIp('cancel'),
      body: JSON.stringify({ email: user.email, password: 'WrongPassword123' }),
    });
    assert.equal(wrongCancel.response.status, 401);

    // The correct password cancels, and normal login works again.
    await expectOk('/api/auth/cancel-deletion', {
      method: 'POST',
      headers: freshAuthIp('cancel'),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    const relogin = await expectOk('/api/auth/login', {
      method: 'POST',
      headers: freshAuthIp('login'),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.ok(relogin.token);
  });

  it('regenerates recovery codes, invalidating the old set', async () => {
    const user = await signupUser();
    const oldCode = user.recoveryCodes[0];

    // Password confirmation is required.
    const wrong = await fetchJson('/api/auth/regenerate-recovery-codes', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ password: 'WrongPassword123' }),
    });
    assert.equal(wrong.response.status, 401);

    // Correct password returns a fresh set that differs from the old one.
    const regen = await expectOk('/api/auth/regenerate-recovery-codes', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ password: user.password }),
    });
    assert.ok(Array.isArray(regen.recoveryCodes) && regen.recoveryCodes.length === 10);
    assert.ok(!regen.recoveryCodes.includes(oldCode), 'regenerated codes must differ from the old set');

    // An old code no longer works; a new one does.
    const oldUse = await fetchJson('/api/auth/use-recovery-code', {
      method: 'POST',
      headers: freshAuthIp('recovery'),
      body: JSON.stringify({ email: user.email, code: oldCode }),
    });
    assert.equal(oldUse.response.status, 401);

    const newUse = await expectOk('/api/auth/use-recovery-code', {
      method: 'POST',
      headers: freshAuthIp('recovery'),
      body: JSON.stringify({ email: user.email, code: regen.recoveryCodes[0] }),
    });
    assert.ok(newUse.token);
  });

  it('recovers access with a one-time recovery code', async () => {
    const user = await signupUser();
    assert.ok(Array.isArray(user.recoveryCodes) && user.recoveryCodes.length >= 2,
      'signup should return recovery codes');
    const [code, secondCode] = user.recoveryCodes;

    // Using a code mints a fresh session and burns that code.
    const used = await expectOk('/api/auth/use-recovery-code', {
      method: 'POST',
      headers: freshAuthIp('recovery'),
      body: JSON.stringify({ email: user.email, code }),
    });
    assert.ok(used.token, 'recovery should mint a session token');
    assert.ok(used.refreshToken);
    assert.equal(used.codesRemaining, user.recoveryCodes.length - 1);

    // The code is one-time — reusing it is rejected.
    const reuse = await fetchJson('/api/auth/use-recovery-code', {
      method: 'POST',
      headers: freshAuthIp('recovery'),
      body: JSON.stringify({ email: user.email, code }),
    });
    assert.equal(reuse.response.status, 401);

    // A different, unburned code still works.
    const used2 = await expectOk('/api/auth/use-recovery-code', {
      method: 'POST',
      headers: freshAuthIp('recovery'),
      body: JSON.stringify({ email: user.email, code: secondCode }),
    });
    assert.ok(used2.token);

    // An unknown email yields the same generic 401 (no enumeration).
    const unknown = await fetchJson('/api/auth/use-recovery-code', {
      method: 'POST',
      headers: freshAuthIp('recovery'),
      body: JSON.stringify({ email: `nobody-${Date.now()}@example.com`, code }),
    });
    assert.equal(unknown.response.status, 401);
  });

  it('manages agent threads per-user and caps oversized titles', async () => {
    const user = await signupUser();

    // Create with an oversized title — stored title is capped (user-supplied
    // titles were previously unbounded, unlike the 60-char auto titles).
    const created = await expectOk('/api/agent/threads', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ title: 'x'.repeat(500) }),
    }, 201);
    assert.equal(created.thread.title.length, 100);
    const threadId = created.thread.id;

    const list = await expectOk('/api/agent/threads', { headers: authHeaders(user.token) });
    assert.ok(list.threads.some((t) => t.id === threadId), 'thread should be listed for its owner');

    const renamed = await expectOk(`/api/agent/threads/${threadId}`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ title: 'y'.repeat(300) }),
    });
    assert.equal(renamed.thread.title.length, 100);

    // Threads are keyed per-user: another account can't see or delete it.
    const other = await signupUser();
    const otherList = await expectOk('/api/agent/threads', { headers: authHeaders(other.token) });
    assert.ok(!otherList.threads.some((t) => t.id === threadId), 'thread must not leak across users');
    const foreignDelete = await fetchJson(`/api/agent/threads/${threadId}`, {
      method: 'DELETE',
      headers: authHeaders(other.token),
    });
    assert.equal(foreignDelete.response.status, 404);

    // Owner deletes it.
    const del = await expectOk(`/api/agent/threads/${threadId}`, {
      method: 'DELETE',
      headers: authHeaders(user.token),
    });
    assert.equal(del.deleted, true);
  });

  it('rate limits agent routes with the general API bucket', async () => {
    // Dedicated client IP so this flood can't pollute — or be polluted by —
    // the suite's other requests, which share the default bucket.
    const headers = { 'CF-Connecting-IP': `agent-rate-${Date.now()}-${Math.random().toString(36).slice(2)}` };

    // Push /api/agent/threads past the 300/min API bucket. The limiter runs
    // before auth middleware, so the first 300 unauthenticated requests get
    // 401 and the excess comes back 429.
    const statuses = [];
    for (let batch = 0; batch < 7; batch++) {
      const requests = Array.from({ length: batch === 6 ? 10 : 50 }, () =>
        worker.fetch(`${BASE_URL}/api/agent/threads`, { headers }));
      for (const response of await Promise.all(requests)) {
        statuses.push(response.status);
      }
    }
    const accepted = statuses.filter((status) => status === 401).length;
    const rejected = statuses.filter((status) => status === 429).length;

    assert.ok(rejected > 0, 'expected requests beyond the API limit to receive 429');
    assert.ok(accepted <= 300, 'rate limiter allowed more requests than the API bucket holds');
    assert.ok(accepted > 60, 'agent routes must use the 300/min API bucket, not the 60/min auth bucket');

    // The bucket is shared per IP: with it exhausted, the other agent
    // surfaces are limited too — token minting and the chat transport.
    const wsToken = await worker.fetch(`${BASE_URL}/api/agent/chat/ws-token`, {
      method: 'POST',
      headers,
    });
    assert.equal(wsToken.status, 429);
    const chat = await worker.fetch(`${BASE_URL}/api/agent/chat?threadId=t`, { headers });
    assert.equal(chat.status, 429);

    // The 429 keeps the legacy general-block shape: JSON body, retry hints,
    // CORS + security headers.
    const chatBody = JSON.parse(await chat.text());
    assert.equal(chatBody.error, 'Too many requests. Please try again later.');
    assert.ok(chat.headers.get('Retry-After'), '429 carries a Retry-After hint');
    assert.equal(chat.headers.get('X-RateLimit-Remaining'), '0');
    assert.ok(chat.headers.get('Access-Control-Allow-Origin'), '429 is CORS-decorated');
    assert.equal(chat.headers.get('X-Content-Type-Options'), 'nosniff', '429 carries security headers');
  });

  it('keeps agent route success responses unchanged', async () => {
    const user = await signupUser();
    const headers = authHeaders(user.token, {
      'CF-Connecting-IP': `agent-ok-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });

    // Sub-limit requests still succeed and keep their legacy headers:
    // decorated with CORS + security headers, but — like every non-auth
    // route — WITHOUT success-path X-RateLimit-* headers.
    const threads = await fetchJson('/api/agent/threads', { headers });
    assert.equal(threads.response.status, 200);
    assert.ok(Array.isArray(threads.body.threads));
    assert.equal(threads.response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(threads.response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(threads.response.headers.get('X-RateLimit-Limit'), null,
      'agent routes must not gain success-path rate-limit headers');

    const wsToken = await fetchJson('/api/agent/chat/ws-token', { method: 'POST', headers });
    assert.equal(wsToken.response.status, 200);
    assert.ok(wsToken.body.token);
    assert.equal(typeof wsToken.body.expiresAt, 'number');
    assert.equal(wsToken.response.headers.get('X-RateLimit-Limit'), null);
  });

  it('rejects agent chat WebSocket upgrades from disallowed origins before credentials', async () => {
    // An upgrade with a disallowed Origin is refused before any credential
    // is examined — so without a token the response is 403, not 401. Real
    // handshake via the ws client (see wsUpgrade for why).
    const disallowed = await wsUpgrade('/api/agent/chat?threadId=t', {
      'CF-Connecting-IP': `ws-origin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      'Origin': 'https://not-allowed.example',
    });
    assert.equal(disallowed.status, 403);
    assert.deepEqual(JSON.parse(disallowed.text), { error: 'CORS origin not allowed' });

    // An upgrade without an Origin header passes the origin gate and fails
    // on credentials instead (401).
    const noOrigin = await wsUpgrade('/api/agent/chat?threadId=t', {
      'CF-Connecting-IP': `ws-noorigin-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    assert.equal(noOrigin.status, 401);
    assert.deepEqual(JSON.parse(noOrigin.text), { error: 'Unauthorized' });
  });

  it('preserves the legacy policies of a sample of existing routes', async () => {
    // Health: any method, CORS-only headers (no security headers), never
    // rate limited.
    const health = await worker.fetch(`${BASE_URL}/api/health`);
    const healthBody = JSON.parse(await health.text());
    assert.equal(health.status, 200);
    assert.equal(healthBody.status, 'ok');
    assert.equal(typeof healthBody.timestamp, 'number');
    assert.ok(health.headers.get('Access-Control-Allow-Origin'));
    assert.equal(health.headers.get('X-Frame-Options'), null,
      'health keeps its legacy CORS-only decoration (no security headers)');

    const healthPost = await worker.fetch(`${BASE_URL}/api/health`, { method: 'POST' });
    assert.equal(healthPost.status, 200);

    // Preflight: CORS-only headers, no security headers.
    const preflight = await worker.fetch(`${BASE_URL}/api/desktop`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 200);
    assert.ok(preflight.headers.get('Access-Control-Allow-Origin'));
    assert.equal(preflight.headers.get('X-Frame-Options'), null);

    // Unmatched paths: CORS-only JSON 404 after the fallback rate-limit check.
    const missing = await worker.fetch(`${BASE_URL}/api/no-such-route`);
    assert.equal(missing.status, 404);
    assert.deepEqual(JSON.parse(await missing.text()), { error: 'Not found' });
    assert.ok(missing.headers.get('Access-Control-Allow-Origin'));
    assert.equal(missing.headers.get('X-Frame-Options'), null,
      'the 404 fallback keeps its legacy CORS-only decoration');

    // Auth routes keep their success-path X-RateLimit-* headers (60/min bucket).
    const identity = createTestIdentity();
    const signup = await fetchJson('/api/auth/signup', {
      method: 'POST',
      headers: freshAuthIp('policy-sample'),
      body: JSON.stringify(identity),
    });
    assert.equal(signup.response.status, 200);
    assert.equal(signup.response.headers.get('X-RateLimit-Limit'), '60');

    // Desktop: auth-required, full withCors decoration (security headers),
    // no success-path rate-limit headers.
    const desktop = await fetchJson('/api/desktop', { headers: authHeaders(signup.body.token) });
    assert.equal(desktop.response.status, 200);
    assert.equal(desktop.response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(desktop.response.headers.get('X-RateLimit-Limit'), null);

    const unauthDesktop = await fetchJson('/api/desktop');
    assert.equal(unauthDesktop.response.status, 401);
    assert.equal(unauthDesktop.response.headers.get('X-Frame-Options'), 'DENY');

    // Fallthrough order preserved: auth runs before the inner method checks,
    // so an unauthenticated odd-method request still gets 401 — not the
    // fallthrough target's response.
    const appVersionsDelete = await fetchJson('/api/apps/some-app/versions', { method: 'DELETE' });
    assert.equal(appVersionsDelete.response.status, 401);
    const soundMultiSegment = await fetchJson('/api/sounds/a/b', { method: 'DELETE' });
    assert.equal(soundMultiSegment.response.status, 401);

    // And an authenticated odd-method draft request falls through to the
    // shared 404.
    const draftOddMethod = await fetchJson('/api/games/drafts/xyz', {
      method: 'POST',
      headers: authHeaders(signup.body.token, JSON_HEADERS),
    });
    assert.equal(draftOddMethod.response.status, 404);
    assert.deepEqual(draftOddMethod.body, { error: 'Not found' });
  });

  it('keeps the explicit no-rate-limit policy on game and app routes', async () => {
    // Game and app-management routes are deliberately unlimited (documented
    // per entry in the route table). A flood far past the general 300/min
    // bucket must still reach auth middleware on every request: all 401,
    // never 429.
    const headers = { 'CF-Connecting-IP': `games-rate-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    const statuses = [];
    for (let batch = 0; batch < 7; batch++) {
      const requests = Array.from({ length: batch === 6 ? 10 : 50 }, () =>
        worker.fetch(`${BASE_URL}/api/games/drafts`, { headers }));
      for (const response of await Promise.all(requests)) {
        statuses.push(response.status);
      }
    }
    assert.ok(
      statuses.every((status) => status === 401),
      `expected every request to reach auth middleware (401), saw ${JSON.stringify(statuses.filter((s) => s !== 401).slice(0, 5))}`
    );
  });

  it('manages game cartridge drafts per-user and mints play capabilities', async () => {
    const user = await signupUser();
    const cartId = `draft-${Math.random().toString(36).slice(2, 10)}`;

    // PUT a valid draft.
    const put = await expectOk(`/api/games/drafts/${cartId}`, {
      method: 'PUT', headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ cartridge: createTestCartridge() }),
    });
    assert.equal(put.cartId, cartId);

    // An invalid cartridge is rejected.
    const badPut = await fetchJson(`/api/games/drafts/${cartId}x`, {
      method: 'PUT', headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ cartridge: { formatVersion: 99 } }),
    });
    assert.equal(badPut.response.status, 400);

    // GET + list for the owner.
    const got = await expectOk(`/api/games/drafts/${cartId}`, { headers: authHeaders(user.token) });
    assert.ok(got.cartridge);
    const list = await expectOk('/api/games/drafts', { headers: authHeaders(user.token) });
    assert.ok(list.drafts.some((d) => d.cartId === cartId), 'draft should be listed');

    // Another user cannot read it.
    const other = await signupUser();
    const foreignGet = await fetchJson(`/api/games/drafts/${cartId}`, { headers: authHeaders(other.token) });
    assert.equal(foreignGet.response.status, 404);

    // A play capability can be minted for the draft.
    const cap = await expectOk(`/api/games/${encodeURIComponent(`draft:${cartId}`)}/capability`, {
      method: 'POST', headers: authHeaders(user.token, JSON_HEADERS), body: '{}',
    });
    assert.ok(cap.capability, 'should mint a game capability');

    // Delete removes it.
    await expectOk(`/api/games/drafts/${cartId}`, { method: 'DELETE', headers: authHeaders(user.token) });
    const afterGet = await fetchJson(`/api/games/drafts/${cartId}`, { headers: authHeaders(user.token) });
    assert.equal(afterGet.response.status, 404);
  });

  it('uploads, serves, lists, and deletes a custom sound', async () => {
    const user = await signupUser();

    const uploadForm = new UndiciFormData();
    uploadForm.set('file', new File([new Uint8Array([1, 2, 3, 4, 5, 6])], 'beep.wav', { type: 'audio/wav' }));
    const uploaded = await expectOk('/api/sounds', {
      method: 'POST', headers: authHeaders(user.token), body: uploadForm,
    });
    assert.ok(uploaded.asset?.soundId, 'upload should return a soundId');
    assert.match(uploaded.asset.url, /^\/api\/sounds\//);
    const soundId = uploaded.asset.soundId;

    // A non-audio MIME type is rejected.
    const badForm = new UndiciFormData();
    badForm.set('file', new File(['not audio'], 'x.txt', { type: 'text/plain' }));
    const badUpload = await fetchJson('/api/sounds', {
      method: 'POST', headers: authHeaders(user.token), body: badForm,
    });
    assert.equal(badUpload.response.status, 400);

    // The sound serves publicly with nosniff.
    const serveRes = await worker.fetch(`${BASE_URL}${uploaded.asset.url}`);
    assert.equal(serveRes.status, 200);
    assert.equal(serveRes.headers.get('x-content-type-options'), 'nosniff');
    await serveRes.arrayBuffer();

    // It appears in the owner's sound list, then is gone after delete.
    const listed = await expectOk('/api/sounds', { headers: authHeaders(user.token) });
    const names = (listed.sounds ?? listed.assets ?? []);
    assert.ok(names.some((s) => s.soundId === soundId), 'sound should be listed');

    await expectOk(`/api/sounds/${encodeURIComponent(soundId)}`, {
      method: 'DELETE', headers: authHeaders(user.token),
    });
    const after = await expectOk('/api/sounds', { headers: authHeaders(user.token) });
    const afterNames = (after.sounds ?? after.assets ?? []);
    assert.ok(!afterNames.some((s) => s.soundId === soundId), 'sound should be gone after delete');
  });

  it('uploads, serves, lists, and deletes a custom cursor', async () => {
    const user = await signupUser();

    const form = new UndiciFormData();
    form.set('file', createPngFile('arrow.png'));
    form.set('cursorState', 'default');
    const uploaded = await expectOk('/api/cursors', {
      method: 'POST', headers: authHeaders(user.token), body: form,
    });
    assert.ok(uploaded.asset?.cursorId, 'upload should return a cursorId');
    assert.match(uploaded.asset.url, /^\/api\/cursors\//);
    const cursorId = uploaded.asset.cursorId;

    // A non-image MIME type is rejected.
    const badForm = new UndiciFormData();
    badForm.set('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const bad = await fetchJson('/api/cursors', {
      method: 'POST', headers: authHeaders(user.token), body: badForm,
    });
    assert.equal(bad.response.status, 400);

    // Serves publicly with nosniff.
    const serve = await worker.fetch(`${BASE_URL}${uploaded.asset.url}`);
    assert.equal(serve.status, 200);
    assert.equal(serve.headers.get('x-content-type-options'), 'nosniff');
    await serve.arrayBuffer();

    // Listed, then gone after delete.
    const list = await expectOk('/api/cursors', { headers: authHeaders(user.token) });
    assert.ok(list.assets.some((a) => a.cursorId === cursorId), 'cursor should be listed');
    await expectOk(`/api/cursors/${encodeURIComponent(cursorId)}`, {
      method: 'DELETE', headers: authHeaders(user.token),
    });
    const after = await expectOk('/api/cursors', { headers: authHeaders(user.token) });
    assert.ok(!after.assets.some((a) => a.cursorId === cursorId), 'cursor should be gone after delete');
  });

  it('tracks opted-in analytics with per-IP deduplication', async () => {
    const user = await signupUser();

    await patchProfile(user.token, { analyticsEnabled: true });

    await expectOk(`/api/visit/${user.user.username}`, {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    });
    await expectOk(`/api/visit/${user.user.username}`, {
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    });
    await expectOk(`/api/visit/${user.user.username}`, {
      headers: { 'CF-Connecting-IP': '2.2.2.2' },
    });

    const analytics = await waitFor(async () => {
      const result = await expectOk('/api/analytics', {
        headers: authHeaders(user.token),
      });
      assert.equal(result.totalViews, 2);
      return result;
    });

    assert.equal(analytics.dailyViews[0].count, 2);
  });

  it('returns an SVG og:image for public desktops', async () => {
    const user = await signupUser();

    await patchProfile(user.token, {
      desktopColor: '#4A6FA5',
      shareDescription: 'A quiet corner of the web',
    });

    const response = await worker.fetch(`${BASE_URL}/api/og/${user.user.username}.png`);
    const svg = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
    assert.match(svg, /A quiet corner of the web/);
    assert.match(svg, /#4A6FA5/i);
  });

  it('marks uploaded images for async metadata enrichment', async () => {
    const user = await signupUser();
    const uploadForm = new UndiciFormData();
    uploadForm.set('file', createPngFile('analyze-me.png'));

    const upload = await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });

    assert.equal(upload.item.type, 'image');
    assert.deepEqual(upload.item.imageAnalysis, { status: 'pending' });
  });

  it('stores normalized user tags on items', async () => {
    const user = await signupUser();
    const item = await createDesktopItem(user.token, {
      type: 'image',
      name: 'Tagged.png',
      position: { x: 1, y: 1 },
      isPublic: true,
    });

    const updatedItems = await patchItems(user.token, [
      {
        id: item.id,
        updates: {
          userTags: [' Street  ', 'night', 'street', '', 'CITY WALK'],
        },
      },
    ]);

    assert.deepEqual(updatedItems[0].userTags, ['street', 'night', 'city walk']);
  });

  it('counts wallpaper, icon, css asset, and file uploads toward quota usage', async () => {
    const user = await signupUser();
    const startingQuota = await getQuota(user.token);

    const wallpaperForm = new UndiciFormData();
    wallpaperForm.set('file', createPngFile('wallpaper.png'));

    await expectOk('/api/wallpaper', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: wallpaperForm,
    });

    const folder = await createDesktopItem(user.token, {
      type: 'folder',
      name: 'Icon Target',
      position: { x: 2, y: 0 },
      isPublic: false,
    });

    const iconForm = new UndiciFormData();
    iconForm.set('itemId', folder.id);
    iconForm.set('file', createPngFile('icon.png'));

    await expectOk('/api/icon', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: iconForm,
    });

    const cssForm = new UndiciFormData();
    cssForm.set('file', createPngFile('background.png'));

    await expectOk('/api/css-assets', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: cssForm,
    });

    const uploadForm = new UndiciFormData();
    const textFile = new File(['quota file'], 'quota.txt', { type: 'text/plain' });
    uploadForm.set('file', textFile);

    await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });

    const finalQuota = await getQuota(user.token);
    const expectedIncrease = (PNG_BYTES.byteLength * 3) + textFile.size;

    assert.equal(finalQuota.used - startingQuota.used, expectedIncrease);
    assert.equal(finalQuota.itemCount - startingQuota.itemCount, 4);
  });

  it('stores custom CSS history and can restore an earlier version', async () => {
    const user = await signupUser();
    const firstCSS = '.window { border-radius: 8px; }';
    const secondCSS = '.window { border-radius: 16px; }';

    await patchProfile(user.token, { customCSS: firstCSS });
    await patchProfile(user.token, { customCSS: secondCSS });

    const history = await getCSSHistory(user.token);
    assert.equal(history.versions.length, 2);
    assert.equal(history.versions[0].css, secondCSS);
    assert.equal(history.versions[1].css, firstCSS);

    const reverted = await revertCSSHistoryVersion(user.token, history.versions[1].id);
    assert.equal(reverted.profile.customCSS, firstCSS);
    assert.equal(reverted.versions[0].source, 'revert');
    assert.equal(reverted.versions[0].css, firstCSS);
  });

  it('CSS history revert returns the whole appearance intact (round-trip the client restores from)', async () => {
    // The client restores from the revert response's FULL profile
    // (CSSEditor → profileToAppearance). If revert clobbered any non-CSS
    // appearance field, restoring an old CSS version would silently wipe the
    // user's fonts, opacity, design tokens, or variant selections.
    const user = await signupUser();
    const appearance = {
      systemFont: 'chicago',
      bodyFont: 'geneva',
      monoFont: 'monaco',
      fontSmoothing: true,
      windowOpacity: 80,
      accentColor: '#000080',
      designTokens: {
        'menuBar.background': '#222222',
        'cursor.image.default': '/api/cursors/arrow.png|0|0',
      },
      variants: { 'window.titleBar': 'gradient' },
    };
    await patchProfile(user.token, appearance);
    await patchProfile(user.token, { customCSS: '.a { color: red; }' });
    await patchProfile(user.token, { customCSS: '.b { color: blue; }' });

    const history = await getCSSHistory(user.token);
    const reverted = await revertCSSHistoryVersion(user.token, history.versions[1].id);

    // The CSS itself is the restored version...
    assert.equal(reverted.profile.customCSS, '.a { color: red; }');
    // ...and every other appearance field round-trips unchanged.
    assert.equal(reverted.profile.systemFont, 'chicago');
    assert.equal(reverted.profile.bodyFont, 'geneva');
    assert.equal(reverted.profile.monoFont, 'monaco');
    assert.equal(reverted.profile.fontSmoothing, true);
    assert.equal(reverted.profile.windowOpacity, 80);
    assert.equal(reverted.profile.accentColor, '#000080');
    assert.deepEqual(reverted.profile.designTokens, appearance.designTokens);
    assert.deepEqual(reverted.profile.variants, appearance.variants);

    // The revert is recorded in history as its own version.
    assert.equal(reverted.versions[0].source, 'revert');
    assert.equal(reverted.versions[0].css, '.a { color: red; }');
  });

  it('rejects reverting an unknown CSS history version', async () => {
    const user = await signupUser();
    await patchProfile(user.token, { customCSS: '.a { color: red; }' });

    const { response, body } = await fetchJson('/api/css-history/not-a-real-version/revert', {
      method: 'POST',
      headers: authHeaders(user.token),
    });
    assert.ok(
      response.status >= 400,
      `revert of unknown version should be rejected, got ${response.status}: ${JSON.stringify(body)}`
    );
    assert.equal(body.profile, undefined, 'a failed revert must not return a profile');

    // And the live custom CSS was untouched.
    const history = await getCSSHistory(user.token);
    assert.equal(history.versions[0].css, '.a { color: red; }');
  });

  it('persists wallpaper and wallpaperMode so the picker survives reload', async () => {
    // WallpaperPicker writes profile fields (not design tokens): the auth
    // store PATCHes /api/profile and useDesktopSync reads them back on boot.
    const user = await signupUser();
    await patchProfile(user.token, { wallpaper: 'blue', wallpaperMode: 'tile' });

    const { profile } = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.equal(profile.wallpaper, 'blue');
    assert.equal(profile.wallpaperMode, 'tile');

    // SECURITY regression guard: a custom:<uid>/... wallpaper string is later
    // parsed to derive the R2 key that the next wallpaper upload DELETES. A
    // foreign uid must be rejected, or an attacker's upload could delete a
    // victim's wallpaper object.
    const { response } = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ wallpaper: 'custom:victim-uid/w1/wallpaper.png' }),
    });
    assert.ok(
      response.status >= 400,
      `foreign custom: wallpaper must be rejected, got ${response.status}`
    );
  });

  it('allows customCSS url() to first-party bazaar assets but rejects cross-origin', async () => {
    const user = await signupUser();

    // Regression: the customCSS url() allowlist was missing /api/bazaar/assets/
    // (present in the designTokens allowlist and the client sanitizer), so CSS
    // referencing an installed bazaar theme's assets passed the client but was
    // rejected on save. It must now be accepted.
    const bazaarCSS = '.user-desktop { background: url(/api/bazaar/assets/pack123/sky.png); }';
    await patchProfile(user.token, { customCSS: bazaarCSS }); // expectOk → 200

    // A cross-origin url() is still rejected (the save fails; the value is not
    // stored). The profile route currently surfaces validation throws as 5xx
    // rather than 400, so assert on "rejected", not the exact code.
    const { response } = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        customCSS: '.x { background: url(https://evil.example/beacon.png); }',
      }),
    });
    assert.ok(response.status >= 400, `cross-origin url() should be rejected, got ${response.status}`);

    // And the hostile CSS was not persisted anywhere on the profile.
    const profile = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.ok(!JSON.stringify(profile).includes('evil.example'), 'hostile url must not be stored');
  });

  it('hard-deletes an account once past the deletion grace deadline', async () => {
    const user = await signupUser();

    // Dedicated client IP so this test's repeated auth calls use their own
    // rate-limit bucket and cannot trip the shared default-IP limiter.
    const ipHeaders = (extra = {}) => ({
      ...JSON_HEADERS,
      ...extra,
      'CF-Connecting-IP': `purge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
    const login = () => fetchJson('/api/auth/login', {
      method: 'POST',
      headers: ipHeaders(),
      body: JSON.stringify({ email: user.email, password: user.password }),
    });

    // Give the account some persisted desktop state so the purge has data to remove.
    await patchProfile(user.token, { customCSS: '.window { border-radius: 10px; }' });

    // Soft-delete. The test env pins ACCOUNT_DELETION_GRACE_DAYS=0, so the
    // hard-delete deadline is "now" and the account is immediately due.
    const deletion = await expectOk('/api/auth/delete-account', {
      method: 'POST',
      headers: authHeaders(user.token, ipHeaders()),
      body: JSON.stringify({ password: user.password }),
    });
    assert.equal(deletion.daysUntilHardDelete, 0);

    // Before the purge runs, login is blocked with the pending-deletion signal
    // (proves the account still exists, just soft-deleted).
    {
      const { response, body } = await login();
      assert.equal(response.status, 403);
      assert.equal(body.accountDeletionPending, true);
    }

    // Run the scheduled handler — it enumerates due pending deletions and purges.
    // The /cdn-cgi/handler/scheduled trigger awaits the handler, so the purge is
    // complete when this resolves (no polling needed).
    const scheduled = await worker.fetch(`${BASE_URL}/cdn-cgi/handler/scheduled`, { method: 'POST' });
    assert.ok(scheduled.ok, `scheduled trigger failed with status ${scheduled.status}`);

    // After the purge the user record is gone: login now returns generic
    // invalid-credentials, NOT the pending-deletion response.
    const afterPurge = await login();
    assert.equal(afterPurge.response.status, 401, `expected invalid-credentials after purge, got ${afterPurge.response.status}`);
    assert.notEqual(afterPurge.body?.accountDeletionPending, true);

    // The purged email/username can be reused — signup with them succeeds,
    // confirming the account indices (user:{email}, username:{username}) were freed.
    const reclaim = await fetchJson('/api/auth/signup', {
      method: 'POST',
      headers: ipHeaders(),
      body: JSON.stringify({ email: user.email, username: user.username, password: PASSWORD }),
    });
    assert.equal(reclaim.response.status, 200, `expected email/username to be reusable: ${JSON.stringify(reclaim.body)}`);

    // Idempotent: a second scheduled run with nothing due does not error.
    const scheduledAgain = await worker.fetch(`${BASE_URL}/cdn-cgi/handler/scheduled`, { method: 'POST' });
    assert.ok(scheduledAgain.ok);
  });
});
