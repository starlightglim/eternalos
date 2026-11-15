import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unstable_dev } from 'wrangler';
import { FormData as UndiciFormData } from 'undici';

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

    const blockedNetworkResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(app.appId)}/_eternal/fetch`,
      {
        method: 'POST',
        headers: authHeaders(capability.token, JSON_HEADERS),
        body: JSON.stringify({ url: 'http://127.0.0.1/' }),
      },
    );
    assert.equal(blockedNetworkResponse.status, 500);

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
    // allowlist here, so it reaches the allowlist rejection ("Not permitted"),
    // which proves it passed the SSRF gate — no real network call is made.
    const fdDomain = await proxyFetch('https://fdic.gov/data');
    assert.equal(fdDomain.response.status, 500);
    assert.match(fdDomain.body.error, /Not permitted: outbound access to fdic\.gov/);
    assert.doesNotMatch(fdDomain.body.error, /Network URL is not allowed/);

    // Actual private targets stay blocked at the SSRF gate (before the
    // allowlist): an RFC1918 IPv4 host and an IPv6 ULA literal both fail with
    // the SSRF error, confirming the fix didn't widen the private-host net.
    const loopback = await proxyFetch('http://127.0.0.1/');
    assert.equal(loopback.response.status, 500);
    assert.match(loopback.body.error, /Network URL is not allowed/);

    const ulaLiteral = await proxyFetch('http://[fd00::1]/');
    assert.equal(ulaLiteral.response.status, 500);
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

    // A patch of ONLY privileged fields changes nothing and is rejected.
    const privileged = await bridge(`/fs/patch/${encodeURIComponent(noteId)}`, {
      isPublic: true, grantedPermissions: { fs: { read: ['/**'] } },
    });
    assert.equal(privileged.response.status, 500);
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
