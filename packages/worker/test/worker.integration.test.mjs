import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unstable_dev } from 'wrangler';

import { WorkerCoverageCollector } from './workerCoverage.mjs';

const BASE_URL = 'http://127.0.0.1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123';
const WORKER_NAME = 'eternalos-api';
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

async function fetchJson(url, init) {
  const response = await worker.fetch(`${BASE_URL}${url}`, init);
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

function createPngFile(name = 'pixel.png') {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

before(async () => {
  const options = {
    config: 'wrangler.toml',
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

  it('removes newly-private items from the visitor snapshot cache immediately', async () => {
    const user = await signupUser();

    const uploadForm = new FormData();
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

    const uploadForm = new FormData();
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

  it('counts wallpaper, icon, css asset, and file uploads toward quota usage', async () => {
    const user = await signupUser();
    const startingQuota = await getQuota(user.token);

    const wallpaperForm = new FormData();
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

    const iconForm = new FormData();
    iconForm.set('itemId', folder.id);
    iconForm.set('file', createPngFile('icon.png'));

    await expectOk('/api/icon', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: iconForm,
    });

    const cssForm = new FormData();
    cssForm.set('file', createPngFile('background.png'));

    await expectOk('/api/css-assets', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: cssForm,
    });

    const uploadForm = new FormData();
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
});
