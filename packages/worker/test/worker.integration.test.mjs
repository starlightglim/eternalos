import assert from 'node:assert/strict';
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
  const response = await worker.fetch(`${BASE_URL}${url}`, requestInit);
  const body = await readJson(response);
  return { response, body };
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
  const body = await expectOk('/api/auth/signup', {
    method: 'POST',
    headers: JSON_HEADERS,
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

async function loginUser(email, password) {
  return expectOk('/api/auth/login', {
    method: 'POST',
    headers: JSON_HEADERS,
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

before(async () => {
  const options = {
    config: process.env.WRANGLER_CONFIG ?? 'wrangler.toml',
    envFiles: ['test/worker.env'],
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
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: user.email }),
    });
    assert.ok(forgotPassword.resetToken);

    await expectOk('/api/auth/reset-password', {
      method: 'POST',
      headers: JSON_HEADERS,
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
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(oldPasswordLogin.response.status, 401);

    const freshLogin = await loginUser(user.email, newPassword);

    await expectOk('/api/auth/logout', {
      method: 'POST',
      headers: authHeaders(freshLogin.token),
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
