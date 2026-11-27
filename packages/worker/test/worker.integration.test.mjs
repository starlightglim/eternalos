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

// --- Agent chat over WebSocket (per-account AI controls) ------------------
//
// The chat transport has no HTTP status: the client opens a WS to
// /api/agent/chat (Bearer + allowed Origin) and drives turns with
// cf_agent_use_chat_request frames, reading cf_agent_use_chat_response
// frames until done. The test worker has no [ai] binding, so every admitted
// turn fails at the provider — exactly the degraded path the per-account
// controls must handle legibly (friendly message, terminated stream, slot
// released for the next turn).

function openAgentChatSocket(user, threadId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://${worker.address || '127.0.0.1'}:${worker.port}/api/agent/chat?threadId=${threadId}`,
      {
        headers: {
          Authorization: `Bearer ${user.token}`,
          Origin: 'http://localhost:5173',
          'CF-Connecting-IP': `agentchat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        },
      }
    );
    socket.on('error', (error) => reject(error));
    socket.on('open', () => {
      socket.removeAllListeners('error');
      // Post-open socket noise (close races, keep-alive pings) must not
      // surface as unhandled errors between turns.
      socket.on('error', () => {});
      resolve(socket);
    });
  });
}

function sendChatTurn(socket, requestId, text, threadId) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let errorFrameText = null;
    let settled = false;

    const errorText = () => {
      const errorChunk = chunks.find((chunk) => chunk && chunk.type === 'error');
      return errorChunk?.errorText ?? errorFrameText ?? null;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.off('message', onMessage);
      resolve({ chunks, errorText: errorText(), done: true });
    };
    const onMessage = (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (frame.type !== 'cf_agent_use_chat_response' || frame.id !== requestId) return;
      if (frame.error) {
        // The error broadcast frame carries the message; the stream still
        // terminates with its own done frame right after.
        errorFrameText = frame.body || errorFrameText;
        return;
      }
      if (typeof frame.body === 'string' && frame.body.trim()) {
        try {
          chunks.push(JSON.parse(frame.body));
        } catch {
          // Non-JSON noise between protocol frames — ignore.
        }
      }
      if (frame.done) finish();
    };

    socket.on('message', onMessage);
    socket.send(JSON.stringify({
      id: requestId,
      type: 'cf_agent_use_chat_request',
      init: {
        method: 'POST',
        body: JSON.stringify({
          messages: [
            { id: `msg-${requestId}`, role: 'user', parts: [{ type: 'text', text }] },
          ],
          threadId,
        }),
      },
    }));

    // A turn that never terminates is precisely the failure mode these
    // tests guard against (the stuck-spinner bug) — fail loudly instead of
    // hanging the suite.
    const timeout = setTimeout(() => {
      if (settled) return;
      socket.off('message', onMessage);
      reject(new Error(`chat turn ${requestId} never completed`));
    }, 20000);
    timeout.unref?.();
  });
}

function closeAgentChatSocket(socket) {
  return new Promise((resolve) => {
    socket.removeAllListeners();
    socket.on('close', () => resolve());
    socket.on('error', () => resolve());
    socket.close();
    const force = setTimeout(() => socket.terminate(), 250);
    force.unref?.();
  });
}

const BUDGET_REFUSAL = /Daily AI limit reached/;
const CONCURRENCY_REFUSAL = /up to 2 Eternal requests at once/;
const PROVIDER_FAILURE = /AI service/;

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

  it('rejects bazaar cursor configs that smuggle cross-origin URLs with allowlisted paths', async () => {
    const user = await signupUser();
    const publishWithConfig = (configValue) => {
      const form = new UndiciFormData();
      form.set('manifest', JSON.stringify({
        type: 'cursor',
        name: 'Beacon Cursors',
        tags: [],
        config: { 'cursor.image.default': configValue },
      }));
      form.set('preview', createPngFile('preview.png'));
      return fetchJson('/api/bazaar/publish', {
        method: 'POST', headers: authHeaders(user.token), body: form,
      });
    };

    // Regression: the publish validator compared only the base-parsed pathname
    // against the allowlist, so a cross-origin URL with an allowlisted-looking
    // path was accepted into the pack config (and from there into installers'
    // designTokens). Origin equality is now authoritative → 400.
    const hostile = await publishWithConfig('https://evil.example/api/cursors/beacon.png|0|0');
    assert.equal(hostile.response.status, 400, `expected 400, got ${hostile.response.status}`);

    // Relative first-party asset paths still publish.
    const ok = await publishWithConfig('/api/cursors/arrow.png|0|0');
    assert.equal(ok.response.status, 200, `expected publish to succeed, got ${ok.response.status}`);
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

    // Fork lineage + hotspot-object cursor slots (the v1.1 manifest additions)
    // publish and read back; the schema additions are optional so this
    // old-shape manifest above still validates too.
    const forkedManifest = {
      ...manifest,
      id: 'retro-fork',
      layers: {
        tokens: 'tokens.json',
        cursors: { default: { file: 'cursors/default.png', hotspotX: 3, hotspotY: 4 } },
      },
      forkedFrom: { id: 'retro-theme', name: 'Retro Theme', author, version: '1.0.0' },
    };
    const forkedForm = new UndiciFormData();
    forkedForm.set('manifest', JSON.stringify(forkedManifest));
    forkedForm.set('preview', createPngFile('preview.png'));
    forkedForm.set('file_tokens.json', tokensFile());
    forkedForm.set('file_cursors/default.png', createPngFile('default.png'));
    const forked = await expectOk('/api/bazaar/publish-estheme', {
      method: 'POST', headers: authHeaders(user.token), body: forkedForm,
    });
    assert.equal(forked.manifest.forkedFrom.id, 'retro-theme');
    assert.deepEqual(forked.manifest.layers.cursors, {
      default: { file: 'cursors/default.png', hotspotX: 3, hotspotY: 4 },
    });

    // Malformed lineage (bad author handle) is a 400, not a 500.
    const badLineage = await fetchJson('/api/bazaar/publish-estheme', {
      method: 'POST', headers: authHeaders(user.token), body: (() => {
        const form = new UndiciFormData();
        form.set('manifest', JSON.stringify({ ...forkedManifest, forkedFrom: { id: 'x', author: 'nope' } }));
        form.set('preview', createPngFile('p.png'));
        form.set('file_tokens.json', tokensFile());
        form.set('file_cursors/default.png', createPngFile('d.png'));
        return form;
      })(),
    });
    assert.equal(badLineage.response.status, 400);
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
      body: JSON.stringify({ granted: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com', 'evil.example'] } }, broadApprovals: ['fs.read'] }),
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
      body: JSON.stringify({ granted: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } }, broadApprovals: ['fs.read'] }),
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
      body: JSON.stringify({ granted: { fs: { read: ['/**'] } }, broadApprovals: ['fs.read'] }),
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
    // The fixture declares a broad '/**' read, so the explicit tick is required.
    await expectOk(`/api/apps/${encodeURIComponent(app.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: photoGrid.manifest.permissions, broadApprovals: ['fs.read'] }),
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

  it('hides installed app items from app-scoped fs lists but not from the owner', async () => {
    // The bridge's fs.list has always skipped type:'app' items ("apps don't
    // list themselves to apps"); the capability-token REST fs list must apply
    // the same rule. An app holding a /** read grant must not be able to
    // enumerate installed app names and ids through any list path, while the
    // owner's own desktop list still shows them exactly as before.
    const user = await signupUser();

    const deployApp = (name) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name,
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/**'] } },
        },
        files: { 'index.html': `<!doctype html><html><body><h1>${name}</h1></body></html>` },
      }),
    });
    const readerApp = await deployApp('Enumerating Reader');
    const otherApp = await deployApp('Other Installed App');

    // A regular item, so the app-scoped lists are observably non-empty and
    // the app-item skip can't hide behind "everything was filtered anyway".
    const note = await createDesktopItem(user.token, {
      type: 'text', name: 'shopping.txt', parentId: null, position: { x: 0, y: 0 },
      isPublic: false, textContent: 'buy oats',
    });

    await expectOk(`/api/apps/${encodeURIComponent(readerApp.appId)}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'] } }, broadApprovals: ['fs.read'] }),
    });
    const capability = await expectOk(`/api/apps/${encodeURIComponent(readerApp.appId)}/capability`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({}),
    });
    const bearer = { Authorization: `Bearer ${capability.token}` };

    // REST fs list (capability token): no app items — not the reader's own,
    // not the other installed app's — while the regular note stays listable.
    const restList = await expectOk(`/api/apps/${encodeURIComponent(readerApp.appId)}/fs/list`, { headers: bearer });
    assert.equal(
      restList.items.filter((item) => item.type === 'app').length,
      0,
      'REST fs.list must not expose installed app items to an app',
    );
    assert.ok(
      restList.items.some((item) => item.id === note.id),
      'the regular note stays listable through the REST fs list',
    );

    // Bridge fs list (Dynamic Worker service binding): same rule. Pass an
    // explicit limit: the compiled worker's clampInt treats a missing limit
    // as 1 (Number(null) is 0, not NaN), so a bare bridge list only ever
    // returns the first item — not enough to observe the desktop.
    const bridgeResponse = await worker.fetch(
      `${BASE_URL}/api/apps/${encodeURIComponent(readerApp.appId)}/_eternal/fs/list?limit=500`,
      { headers: bearer },
    );
    assert.equal(bridgeResponse.status, 200);
    const bridgeList = await readJson(bridgeResponse);
    assert.equal(
      bridgeList.items.filter((item) => item.type === 'app').length,
      0,
      'bridge fs.list must not expose installed app items to an app',
    );
    assert.ok(
      bridgeList.items.some((item) => item.id === note.id),
      'the regular note stays listable through the bridge',
    );

    // The owner's own desktop list still includes every installed app.
    const desktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    const ownerAppItems = desktop.items.filter((item) => item.type === 'app');
    assert.equal(ownerAppItems.length, 2, 'the owner still sees both installed apps');
    assert.ok(
      ownerAppItems.some((item) => item.appManifest?.appId === otherApp.appId),
      'the other installed app is still visible to its owner',
    );
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
      body: JSON.stringify({ granted: { fs: { read: ['/**'], write: ['/**'] } }, broadApprovals: ['fs.read', 'fs.write'] }),
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

    // fs.urlFor in an installed app is capability-aware. The plain bridge URL
    // it used to return 401s when an <img src> fetches it (no Authorization
    // header), so the bridge runtime now performs the authorized fetch itself
    // and hands the app a blob: object URL. This block pins both halves.
    const urlForFetch = (id) => worker.fetch(
      `${BASE_URL}/api/apps/${galleryAppId}/_eternal/fs/read/${encodeURIComponent(id)}`,
      { headers: bearer },
    );
    // Server auth is unchanged: the raw bridge URL (what urlFor used to hand
    // out) still demands the Bearer capability — there is deliberately no
    // query-string token a bare <img src> could carry.
    assert.equal(
      (await worker.fetch(`${BASE_URL}/api/apps/${galleryAppId}/_eternal/fs/read/${encodeURIComponent(inScope.id)}`)).status, 401,
      'the raw bridge URL must still require the capability',
    );
    // The urlFor path — the runtime's authorized fetch, with the capability a
    // bare <img src> cannot send — returns the in-scope bytes (which the app
    // would then wrap into an object URL).
    const okRead = await urlForFetch(inScope.id);
    assert.equal(okRead.status, 200, 'urlFor must fetch in-scope bytes with the capability');
    assert.equal(await okRead.text(), 'inside gallery');
    // Scope bounds hold through the urlFor path: another user's item id never
    // resolves (404)...
    assert.equal(
      (await urlForFetch(strangerUpload.item.id)).status, 404,
      'another user\'s item id must not resolve through urlFor',
    );
    // ...and an out-of-scope item in the same desktop is denied (403).
    assert.equal(
      (await urlForFetch(outOfScope.id)).status, 403,
      'an out-of-scope item must be denied through urlFor',
    );
    // A capability is appId-bound: it does not authenticate on another app's mount.
    assert.equal(
      (await worker.fetch(`${BASE_URL}/api/apps/${vaultAppId}/_eternal/fs/read/${encodeURIComponent(outOfScope.id)}`, { headers: bearer })).status, 401,
      'a capability must not authenticate on another app\'s mount',
    );
    // The runtime asset the installed app actually loads must implement that
    // behavior: capability mode, blob object URLs minted from authorized
    // fetches, revoked on pagehide — with the plain-URL path kept for
    // capability-free previews.
    const runtimeResponse = await worker.fetch(`${BASE_URL}/api/apps/${galleryAppId}/eternal-runtime.js`);
    assert.equal(runtimeResponse.status, 200, 'the app must serve its bridge runtime asset');
    const runtimeSource = await runtimeResponse.text();
    assert.match(runtimeSource, /const requiresCapability = true/, 'installed apps must run the capability-gated runtime');
    assert.match(runtimeSource, /URL\.createObjectURL\(/, 'capability-mode urlFor must mint blob object URLs');
    assert.match(runtimeSource, /URL\.revokeObjectURL\(/, 'minted object URLs must be revocable');
    assert.match(runtimeSource, /pagehide/, 'object URLs must be revoked on pagehide');
    assert.match(
      runtimeSource,
      /if \(!requiresCapability\) return apiUrl\(path\)/,
      'previews must keep the plain-URL urlFor behavior',
    );
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
      body: JSON.stringify({ granted: { fs: { read: ['/**'], write: ['/**'] } }, broadApprovals: ['fs.read', 'fs.write'] }),
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
        broadApprovals: ['fs.read', 'fs.write'],
      }),
    });
    assert.deepEqual(ipcApprove.granted, { fs: { read: ['/**'], write: ['/**'] } },
      'approving an undeclared domain must not grant it');

    // fs.list no longer surfaces app items to apps (same rule as the
    // bridge) — even under a full read grant the app cannot discover its
    // own desktop item by listing. The self-escalation guard below must
    // still hold when the app knows the id out-of-band: knowing it is not
    // the same as being able to use it.
    const list = await expectOk(`/api/apps/${appId}/fs/list`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(
      list.items.filter((item) => item.type === 'app').length,
      0,
      'fs.list must not surface app items even under a full read grant',
    );

    // The owner's session still sees the app item; use its id for the
    // app-side patch attempts below.
    const ownerDesktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    const selfItem = ownerDesktop.items.find((item) => item.type === 'app' && item.name === 'Escalation Guard');
    assert.ok(selfItem, 'the app item should still be visible to its owner');

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

  it('requires an explicit per-scope tick before granting broad scopes', async () => {
    const user = await signupUser();
    const appId = encodeURIComponent(
      (await expectOk('/api/apps/dev-deploy', {
        method: 'POST',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify({
          manifest: {
            name: 'Broad Scope Guard',
            version: '1.0.0',
            windowConfig: { defaultWidth: 600, defaultHeight: 500 },
            rationale: 'Full-disk indexer.',
            permissions: {
              fs: { read: ['/**'], write: ['/Notes/**'] },
              network: { outbound: ['*', 'api.example.com'] },
              profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
            },
          },
          files: { 'index.html': '<!doctype html><html><body>guarded</body></html>' },
        }),
      })).appId
    );

    const grant = (body) => fetchJson(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify(body),
    });

    // Everything at once, unticked → 400 naming the broad scopes.
    const denied = await grant({
      granted: {
        fs: { read: ['/**'], write: ['/Notes/**'] },
        network: { outbound: ['*'] },
        profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
      },
    });
    assert.equal(denied.response.status, 400);
    assert.match(denied.body.error, /Broad permission scopes require explicit approval/);
    assert.deepEqual([...denied.body.broadScopes].sort(), ['fs.read', 'network.outbound', 'profile.read']);

    // The rejection is per-scope: ticking fs.read but not the others still
    // fails on the unticked ones.
    const partial = await grant({
      granted: {
        fs: { read: ['/**'], write: ['/Notes/**'] },
        network: { outbound: ['*'] },
        profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
      },
      broadApprovals: ['fs.read'],
    });
    assert.equal(partial.response.status, 400);
    assert.deepEqual([...partial.body.broadScopes].sort(), ['network.outbound', 'profile.read']);

    // With every broad scope ticked, the same request is granted.
    const approved = await grant({
      granted: {
        fs: { read: ['/**'], write: ['/Notes/**'] },
        network: { outbound: ['*'] },
        profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
      },
      broadApprovals: ['fs.read', 'network.outbound', 'profile.read'],
    });
    assert.equal(approved.response.status, 200);
    assert.deepEqual(approved.body.granted, {
      fs: { read: ['/**'], write: ['/Notes/**'] },
      network: { outbound: ['*'] },
      profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
    });

    // Narrow scopes keep today's flow: no tick needed, and the grant is
    // still bounded by the declaration.
    const narrow = await grant({
      granted: { fs: { write: ['/Notes/**'] }, network: { outbound: ['api.example.com'] }, profile: { read: ['username'] } },
    });
    assert.equal(narrow.response.status, 200, 'a narrow-only grant needs no approval flag');
    assert.deepEqual(narrow.body.granted, {
      fs: { write: ['/Notes/**'] },
      network: { outbound: ['api.example.com'] },
      profile: { read: ['username'] },
    });

    // A request asking beyond the declaration for a broad value is still a
    // 400 without the tick — and with the tick it still grants no more than
    // was declared ('/Vault/**' is not in the declaration).
    const undeclared = await grant({ granted: { fs: { read: ['/**', '/Vault/**'] } } });
    assert.equal(undeclared.response.status, 400);
    const bounded = await grant({
      granted: { fs: { read: ['/**', '/Vault/**'] } },
      broadApprovals: ['fs.read'],
    });
    assert.equal(bounded.response.status, 200);
    assert.deepEqual(bounded.body.granted, { fs: { read: ['/**'] } },
      'the tick approves the user\'s confirmation, never more than the declaration');

    // Client-shaped junk in the flag field must not 500.
    const junk = await grant({ granted: { fs: { read: ['/**'] } }, broadApprovals: 'fs.read' });
    assert.equal(junk.response.status, 400, 'a non-array broadApprovals is a 4xx');
    const junkIds = await grant({ granted: { fs: { read: ['/**'] } }, broadApprovals: [{ evil: true }, 42] });
    assert.equal(junkIds.response.status, 400, 'unknown/non-string tick ids are ignored, leaving the scope unticked');
  });

  it('persists per-scope grant approval metadata, keeping the rationale from approval time', async () => {
    const user = await signupUser();
    const deployed = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Approval Ledger',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          rationale: 'v1: mirrors your gallery.',
          permissions: { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>ledger</body></html>' },
      }),
    });
    const appId = encodeURIComponent(deployed.appId);

    const before = await expectOk(`/api/apps/${appId}/permissions`, { headers: authHeaders(user.token) });
    assert.deepEqual(before.approvals, {}, 'an ungranted app exposes no approvals');
    assert.deepEqual(before.broad, [], 'nothing broad is declared');

    const granted = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } } }),
    });
    assert.equal(typeof granted.approvals['fs.read'].approvedAt, 'number');
    assert.equal(granted.approvals['fs.read'].approvedBy, user.user.uid);
    assert.equal(granted.approvals['fs.read'].rationale, 'v1: mirrors your gallery.');
    assert.equal(granted.approvals['network.outbound'].approvedBy, user.user.uid,
      'narrow grants get approval metadata too, not just broad ones');

    // The GET exposes the same metadata ("approved on …") for the UI.
    const after = await expectOk(`/api/apps/${appId}/permissions`, { headers: authHeaders(user.token) });
    assert.equal(after.approvals['fs.read'].approvedAt, granted.approvals['fs.read'].approvedAt);
    assert.equal(after.approvals['fs.read'].rationale, 'v1: mirrors your gallery.');

    // A dev-deploy update that keeps the same declaration but ships a new
    // rationale keeps the approval record as it read at approval time.
    await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        appId: deployed.appId,
        manifest: {
          name: 'Approval Ledger',
          version: '2.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          rationale: 'v2: totally different reason.',
          permissions: { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>ledger v2</body></html>' },
      }),
    });
    const survived = await expectOk(`/api/apps/${appId}/permissions`, { headers: authHeaders(user.token) });
    assert.deepEqual(survived.granted, { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } },
      'an unchanged declaration must not drop the grant');
    assert.equal(survived.approvals['fs.read'].approvedAt, granted.approvals['fs.read'].approvedAt,
      'surviving grants keep their original approval timestamp');
    assert.equal(survived.approvals['fs.read'].rationale, 'v1: mirrors your gallery.',
      'the approval record keeps the rationale from approval time, not the new manifest rationale');

    // Revoking prunes the approval metadata with the grant; re-granting
    // records fresh metadata under the new rationale.
    await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: {} }),
    });
    const revoked = await expectOk(`/api/apps/${appId}/permissions`, { headers: authHeaders(user.token) });
    assert.deepEqual(revoked.granted, {});
    assert.deepEqual(revoked.approvals, {}, 'a revoked grant must not keep approval metadata');

    const regranted = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] } } }),
    });
    assert.ok(regranted.approvals['fs.read'].approvedAt >= granted.approvals['fs.read'].approvedAt,
      'a re-grant records a fresh approval timestamp');
    assert.equal(regranted.approvals['fs.read'].rationale, 'v2: totally different reason.',
      'a re-grant snapshots the rationale as it reads at the new approval time');
  });

  it('still requires the broad-scope tick for already-granted scopes, and re-approval refreshes the record', async () => {
    const user = await signupUser();
    const deployed = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Legacy Install',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          rationale: 'predates approval metadata',
          permissions: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>legacy</body></html>' },
      }),
    });
    const appId = encodeURIComponent(deployed.appId);

    // Grant through the current flow first (broad fs.read is ticked).
    const granted = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        granted: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } },
        broadApprovals: ['fs.read'],
      }),
    });
    assert.deepEqual(granted.broad, ['fs.read'], 'the broad warning list is served');

    // Pre-Phase-B items — grants stored without approval metadata — used to
    // be crafted here by clearing grantedPermissionApprovals through the
    // public item PATCH. That route now rejects writes to the grant fields
    // (see the lockdown test), and every server-side writer records
    // approvals in the same breath as grants, so the shape only exists in
    // rows written before Phase B. Its read-side resolution ("approved
    // with approvedAt unknown") stays pinned at the unit level
    // (appScopes.test.mjs → resolveGrantApprovals). What must still hold
    // at the route level:

    // Enforcement is per-request: re-requesting an already-granted broad
    // scope still requires the explicit tick, even though it is granted.
    const retick = await fetchJson(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'] } } }),
    });
    assert.equal(retick.response.status, 400, 'an already-granted broad scope still needs its tick');
    assert.deepEqual([...retick.body.broadScopes], ['fs.read']);

    // Re-approval (with the tick) records fresh metadata over the stored
    // record — the UI reads approvedBy/approvedAt from the new approval.
    const reapproved = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } }, broadApprovals: ['fs.read'] }),
    });
    assert.equal(typeof reapproved.approvals['fs.read'].approvedAt, 'number');
    assert.equal(reapproved.approvals['fs.read'].approvedBy, user.user.uid);
    assert.ok(reapproved.approvals['fs.read'].approvedAt >= granted.approvals['fs.read'].approvedAt,
      'a re-approval records a fresh approval timestamp');
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

  it('clears saved appearance fields via null PATCH; null for protected fields is rejected or ignored', async () => {
    const user = await signupUser();

    // Seed a saved appearance the way the Appearance panel does.
    await patchProfile(user.token, {
      accentColor: '#000080',
      desktopColor: '#C0C0C0',
      systemFont: 'chicago',
      fontSmoothing: true,
      windowOpacity: 80,
      customCSS: '.window { border-radius: 8px; }',
      designTokens: { 'menuBar.background': '#222' },
      variants: { 'window.titleBar': 'gradient' },
    });
    const seeded = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.equal(seeded.profile.accentColor, '#000080');
    assert.equal(seeded.profile.customCSS, '.window { border-radius: 8px; }');

    // The Appearance "Reset" + Save payload: null for every reset field.
    const cleared = await patchProfile(user.token, {
      accentColor: null,
      desktopColor: null,
      systemFont: null,
      fontSmoothing: null,
      windowOpacity: null,
      customCSS: null,
      designTokens: null,
      variants: null,
    });
    for (const field of ['accentColor', 'desktopColor', 'systemFont', 'fontSmoothing',
      'windowOpacity', 'customCSS', 'designTokens', 'variants']) {
      assert.ok(!(field in cleared.profile), `cleared field "${field}" must be absent, not stored as null`);
    }

    // GET shows them gone — a reload renders the reset state, not the old rice.
    const after = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    for (const field of ['accentColor', 'desktopColor', 'systemFont', 'fontSmoothing',
      'windowOpacity', 'customCSS', 'designTokens', 'variants']) {
      assert.ok(!(field in after.profile), `cleared field "${field}" must stay gone on GET`);
    }
    // Identity and account fields are untouched by the clear.
    assert.equal(after.profile.username, user.username);
    assert.equal(after.profile.uid, user.user.uid);
    assert.equal(after.profile.wallpaper, 'default');

    // `null` for an allowlisted identity field (username is settable via the
    // change-username flow) is an explicit clear attempt on a protected field
    // → 400, never a silent no-op.
    const nullUsername = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ username: null }),
    });
    assert.equal(nullUsername.response.status, 400,
      `null username must be rejected, got ${nullUsername.response.status}`);
    assert.match(nullUsername.body.error, /cannot be cleared/);

    // Same for other known-but-unclearable fields (wallpaper is not part of
    // the appearance reset; soundPack has its own non-null clear UI).
    for (const field of ['wallpaper', 'soundPack', 'bio']) {
      const rejected = await fetchJson('/api/profile', {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify({ [field]: null }),
      });
      assert.equal(rejected.response.status, 400,
        `null ${field} must be rejected, got ${rejected.response.status}`);
    }

    // Fields outside the allowlist entirely (uid, email, auth material) keep
    // today's unknown-field behavior: silently ignored, profile intact.
    await patchProfile(user.token, { uid: null, email: null, passwordHash: null });
    const intact = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.equal(intact.profile.uid, user.user.uid);
    assert.equal(intact.profile.username, user.username);
    assert.equal(intact.profile.email, undefined, 'unknown fields must not be stored');
    assert.ok(!JSON.stringify(intact.profile).includes('passwordHash'));

    // Non-null values validate exactly as before: out-of-range numbers and
    // dangerous color strings are still rejected and never stored.
    const badOpacity = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ windowOpacity: 999 }),
    });
    assert.ok(badOpacity.response.status >= 400,
      `out-of-range windowOpacity must be rejected, got ${badOpacity.response.status}`);

    const badColor = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ accentColor: 'javascript:alert(1)' }),
    });
    assert.ok(badColor.response.status >= 400,
      `dangerous accentColor must be rejected, got ${badColor.response.status}`);

    // A legitimate re-save after the clear still works.
    await patchProfile(user.token, { accentColor: '#008000' });
    const final = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.equal(final.profile.accentColor, '#008000');
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

  it('rejects public item writes that set app manifests or grants (server-managed fields)', async () => {
    const user = await signupUser();

    // An honest install: dev-deploy declares the scopes, the permissions
    // route grants them. Its item is the target of the forged writes below.
    const deployed = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Grantlock Target',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          rationale: 'reads the gallery',
          permissions: { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>target</body></html>' },
      }),
    });
    const appId = encodeURIComponent(deployed.appId);
    const granted = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } } }),
    });
    const desktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    const appItem = desktop.items.find((item) => item.type === 'app' && item.appManifest?.appId === deployed.appId);
    assert.ok(appItem, 'the installed app item exists');

    const forbiddenValues = {
      appManifest: { ...appItem.appManifest, permissions: { fs: { read: ['/**'], write: ['/**'] } } },
      grantedPermissions: { fs: { read: ['/**'], write: ['/**'] } },
      permissionGrantedAt: Date.now(),
      grantedPermissionApprovals: {},
    };

    // PATCH: each server-managed field alone is a 400 naming the field.
    for (const [field, value] of Object.entries(forbiddenValues)) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify([{ id: appItem.id, updates: { [field]: value } }]),
      });
      assert.equal(res.response.status, 400, `patching ${field} must be rejected`);
      assert.match(res.body.error, new RegExp(field), 'the rejection names the field');
    }

    // The rejection is atomic: a batch mixing a benign edit with a
    // forbidden one applies neither.
    const folder = await createDesktopItem(user.token, { type: 'folder', name: 'Keep', position: { x: 3, y: 3 } });
    const mixed = await fetchJson('/api/desktop/items', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify([
        { id: folder.id, updates: { name: 'Renamed' } },
        { id: appItem.id, updates: { grantedPermissions: { fs: { read: ['/**'] } } } },
      ]),
    });
    assert.equal(mixed.response.status, 400);
    const afterMixed = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    assert.equal(afterMixed.items.find((item) => item.id === folder.id).name, 'Keep',
      'a rejected batch applies none of its entries');

    // POST: creating an item that already carries a manifest or grants is
    // the same forgery (app install goes through /api/apps, never here).
    for (const [field, value] of Object.entries(forbiddenValues)) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'POST',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify({ type: 'app', name: 'Forged', position: { x: 0, y: 0 }, [field]: value }),
      });
      assert.equal(res.response.status, 400, `creating with ${field} must be rejected`);
      assert.match(res.body.error, new RegExp(field), 'the rejection names the field');
    }

    // Nothing changed: grants, approvals and the declared set are exactly
    // what the honest flow wrote.
    const after = await expectOk(`/api/apps/${appId}/permissions`, { headers: authHeaders(user.token) });
    assert.deepEqual(after.granted, granted.granted);
    assert.deepEqual(after.approvals, granted.approvals);
    assert.deepEqual(after.requested, { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } });

    // Ordinary item patches still apply through the public route.
    const renamed = await patchItems(user.token, [{
      id: appItem.id,
      updates: { name: 'Grantlock Target 2', position: { x: 4, y: 4 } },
    }]);
    assert.equal(renamed[0].name, 'Grantlock Target 2');

    // The server-side writers keep going through the DO's internal
    // endpoints: a dev-deploy update rewrites manifest + grants, and the
    // permissions route still grants.
    await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        appId: deployed.appId,
        manifest: {
          name: 'Grantlock Target',
          version: '2.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500 },
          rationale: 'v2: same scopes',
          permissions: { fs: { read: ['/Gallery/**'] }, network: { outbound: ['api.example.com'] } },
        },
        files: { 'index.html': '<!doctype html><html><body>target v2</body></html>' },
      }),
    });
    const redeployed = await expectOk(`/api/apps/${appId}/permissions`, { headers: authHeaders(user.token) });
    assert.deepEqual(redeployed.granted, granted.granted, 'the deploy update keeps the grant');
    assert.equal(redeployed.approvals['fs.read'].approvedAt, granted.approvals['fs.read'].approvedAt,
      'the deploy update keeps the approval metadata');
    const regranted = await expectOk(`/api/apps/${appId}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] } } }),
    });
    assert.deepEqual(regranted.granted, { fs: { read: ['/Gallery/**'] } },
      'the permissions route still writes grants');
  });

  it('answers malformed item-write bodies with 400s, never 500s', async () => {
    const user = await signupUser();

    // A non-JSON body is a client error on create and patch alike — the DO's
    // /items endpoints parse bodies verbatim (request.json()) and used to
    // turn these into 500s.
    for (const body of ['not json at all', '']) {
      for (const method of ['POST', 'PATCH']) {
        const res = await fetchJson('/api/desktop/items', {
          method,
          headers: authHeaders(user.token, JSON_HEADERS),
          body,
        });
        assert.equal(res.response.status, 400,
          `${method} with a non-JSON body must be a 400, got ${res.response.status}`);
        assert.match(res.body.error, /valid JSON/);
      }
    }

    // A patch body that isn't a JSON array (the DO iterates it as one) is a
    // 400 for every client-sendable shape.
    for (const body of ['{}', 'null', '42', '"entries"', 'true']) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body,
      });
      assert.equal(res.response.status, 400, `PATCH ${body} must be a 400, got ${res.response.status}`);
    }

    // Valid requests are unchanged: an honest create still works…
    const created = await createDesktopItem(user.token, {
      type: 'folder', name: 'Malformed Body Target', position: { x: 0, y: 0 },
    });
    assert.ok(created.id);
    // …an empty patch array is a 200 no-op…
    const empty = await fetchJson('/api/desktop/items', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: '[]',
    });
    assert.equal(empty.response.status, 200, `an empty patch array forwards as before, got ${empty.response.status}`);
    // …and a well-formed patch still applies.
    const renamed = await patchItems(user.token, [{ id: created.id, updates: { name: 'Renamed Anyway' } }]);
    assert.equal(renamed[0].name, 'Renamed Anyway');
  });

  it('applies item writes all-or-nothing: a bad entry rejects the batch and applies nothing', async () => {
    const user = await signupUser();

    // Two target items. The 1st entry of every rejected batch below tries to
    // rename `first` — with the old mid-loop validation that rename was
    // already applied to the DO's in-memory map when a later entry threw, so
    // GET showed a change storage never saw (and the client got a 500 for
    // bad input). The harness keeps the DO instance alive for the worker's
    // lifetime with no restart API, so a forced fresh storage read isn't
    // reachable; the GET assertions below are the observable half — they
    // fail on the old code precisely because memory and storage disagreed.
    const first = await createDesktopItem(user.token, {
      type: 'folder', name: 'First', position: { x: 0, y: 0 },
    });
    const second = await createDesktopItem(user.token, {
      type: 'link', name: 'Second', url: 'https://example.com/', position: { x: 1, y: 0 },
    });

    // An unsafe URL in the 2nd entry rejects the whole batch: a 400 naming
    // the entry, and the 1st entry is not applied.
    const badUrl = await fetchJson('/api/desktop/items', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify([
        { id: first.id, updates: { name: 'Should Not Apply' } },
        { id: second.id, updates: { url: 'javascript:alert(1)' } },
      ]),
    });
    assert.equal(badUrl.response.status, 400, `unsafe URL must be a 400, got ${badUrl.response.status}`);
    assert.match(badUrl.body.error, /Patch entry 1/, 'the rejection names the offending entry index');
    assert.match(badUrl.body.error, /URL/, 'the rejection names the reason');
    let desktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    assert.equal(desktop.items.find((item) => item.id === first.id).name, 'First',
      'the 1st entry of a rejected batch is not applied');

    // Every malformed entry shape gets the same all-or-nothing treatment
    // (a null entry used to 500 mid-batch, a shapeless entry was a 500 or a
    // silent no-op depending on whether its id resolved).
    const badEntries = [
      ['a null entry', null],
      ['a non-object entry', 42],
      ['an entry without a string id', { updates: { name: 'Nope' } }],
      ['an entry with a non-string id', { id: 42, updates: { name: 'Nope' } }],
      ['an entry without updates', { id: first.id }],
      ['an entry with null updates', { id: first.id, updates: null }],
      ['an entry with non-object updates', { id: first.id, updates: 'junk' }],
    ];
    for (const [label, entry] of badEntries) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify([
          { id: first.id, updates: { name: 'Should Not Apply' } },
          entry,
        ]),
      });
      assert.equal(res.response.status, 400, `${label} must be a 400, got ${res.response.status}`);
      assert.match(res.body.error, /Patch entry 1/, `${label}: the rejection names the offending entry`);
      desktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
      assert.equal(desktop.items.find((item) => item.id === first.id).name, 'First',
        `${label}: the batch applied nothing`);
    }

    // POST with valid JSON that isn't an object is a 400 and creates
    // nothing (it used to spread into the defaults and silently create a
    // default "Untitled" folder).
    const idsBefore = new Set(
      (await expectOk('/api/desktop', { headers: authHeaders(user.token) })).items.map((item) => item.id)
    );
    for (const body of ['42', '"x"', '[]', 'null', 'true']) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'POST',
        headers: authHeaders(user.token, JSON_HEADERS),
        body,
      });
      assert.equal(res.response.status, 400, `POST ${body} must be a 400, got ${res.response.status}`);
      assert.match(res.body.error, /JSON object/, `POST ${body} names the reason`);
    }
    desktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    assert.deepEqual(
      new Set(desktop.items.map((item) => item.id)),
      idsBefore,
      'no phantom item was created by the refused creates',
    );

    // Valid batches are unchanged: a well-formed two-entry batch applies
    // both entries and returns them in order.
    const both = await patchItems(user.token, [
      { id: first.id, updates: { name: 'First Renamed' } },
      { id: second.id, updates: { url: 'https://example.org/' } },
    ]);
    assert.equal(both.length, 2);
    assert.equal(both[0].name, 'First Renamed');
    assert.equal(both[1].url, 'https://example.org/');

    // Unknown ids keep their silent-skip semantics inside a valid batch.
    const skipped = await patchItems(user.token, [{ id: 'does-not-exist', updates: { name: 'X' } }]);
    assert.deepEqual(skipped, []);
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

  it('accepts an agent chat wsToken once and rejects a replay', async () => {
    const user = await signupUser();
    const ip = () => ({ 'CF-Connecting-IP': `ws-replay-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    const minted = await expectOk('/api/agent/chat/ws-token', { method: 'POST', headers: authHeaders(user.token, ip()) });
    const path = `/api/agent/chat?threadId=replay&wsToken=${encodeURIComponent(minted.token)}`;
    const first = await wsUpgrade(path, ip());
    assert.equal(first.status, 101, `first use should upgrade: ${first.text}`);
    const replay = await wsUpgrade(path, ip());
    assert.equal(replay.status, 401);
  });

  it('answers forgot-password identically for known and unknown emails', async () => {
    const user = await signupUser();
    const unknown = await fetchJson('/api/auth/forgot-password', {
      method: 'POST',
      headers: freshAuthIp('forgot'),
      body: JSON.stringify({ email: `nobody-${Date.now()}@example.com` }),
    });
    const known = await fetchJson('/api/auth/forgot-password', {
      method: 'POST',
      headers: freshAuthIp('forgot'),
      body: JSON.stringify({ email: user.email }),
    });
    assert.equal(unknown.response.status, 200);
    assert.equal(known.response.status, 200);
    assert.equal(known.body.message, unknown.body.message);
    // Development returns the token for local flows; it must be usable at once.
    assert.ok(known.body.resetToken);
    assert.equal(unknown.body.resetToken, undefined);
  });

  it('degrades agent chat provider failure to a legible, terminated stream', async () => {
    const user = await signupUser();
    const socket = await openAgentChatSocket(user, 'provider-failure');
    try {
      // No [ai] binding in the test worker, so the turn fails at the
      // provider — the exact degraded path this test pins down.
      const turn = await sendChatTurn(socket, 'pf-1', 'hello there', 'provider-failure');

      // The stream terminated cleanly — a provider failure must never leave
      // the client waiting forever (the stuck-spinner bug).
      assert.equal(turn.done, true, 'provider-failed turn must still terminate');

      // And the failure is legible: an AI-service explanation, not raw
      // provider internals.
      assert.match(turn.errorText ?? '', PROVIDER_FAILURE);
      assert.doesNotMatch(turn.errorText ?? '', /undefined|Cannot read|at .*\(http/i,
        'raw provider internals must not leak into the chat stream');
    } finally {
      await closeAgentChatSocket(socket);
    }
  });

  it('enforces the per-account daily AI budget across chat and image analysis', async () => {
    const user = await signupUser();
    // A real uploaded image gives the analyze surface a valid target.
    const uploadForm = new UndiciFormData();
    uploadForm.set('file', createPngFile('budget.png'));
    const upload = await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });

    const socket = await openAgentChatSocket(user, 'budget');
    try {
      // The test env caps accounts at 6 AI requests/day (test/worker.env).
      // The first 6 turns are admitted — each fails at the (absent)
      // provider but still consumes budget: attempts count.
      for (let i = 0; i < 6; i++) {
        const turn = await sendChatTurn(socket, `budget-${i}`, `turn ${i}`, 'budget');
        assert.equal(turn.done, true, `budget turn ${i} must terminate`);
        assert.doesNotMatch(turn.errorText ?? '', BUDGET_REFUSAL,
          `budget turn ${i} should be admitted`);
      }

      // The 7th turn is refused with the friendly budget message —
      // in-stream, since the WS transport has no HTTP status — and still
      // terminates like any other turn.
      const refused = await sendChatTurn(socket, 'budget-6', 'one too many', 'budget');
      assert.equal(refused.done, true, 'the refused turn must terminate');
      assert.match(refused.errorText ?? '', BUDGET_REFUSAL);
      assert.match(refused.errorText ?? '', /reset/i, 'the refusal explains when the budget resets');

      // The budget is per-account across surfaces: image analysis (a real
      // AI request against the same account) now answers a clear HTTP 429
      // with the same friendly framing and a Retry-After hint.
      const analysis = await fetchJson(`/api/desktop/items/${upload.item.id}/analyze`, {
        method: 'POST',
        headers: authHeaders(user.token),
      });
      assert.equal(analysis.response.status, 429);
      assert.match(analysis.body.error, BUDGET_REFUSAL);
      const retryAfter = Number(analysis.response.headers.get('Retry-After'));
      assert.ok(Number.isFinite(retryAfter) && retryAfter > 0,
        'the 429 carries a positive Retry-After (seconds to the UTC reset)');

      // A fresh account is unaffected — the budget is per-account, not
      // global: its first analyze call is admitted (and fails at the
      // absent provider, not at the budget).
      const other = await signupUser();
      const otherForm = new UndiciFormData();
      otherForm.set('file', createPngFile('other-budget.png'));
      const otherUpload = await expectOk('/api/upload', {
        method: 'POST',
        headers: authHeaders(other.token),
        body: otherForm,
      });
      const otherAnalysis = await fetchJson(`/api/desktop/items/${otherUpload.item.id}/analyze`, {
        method: 'POST',
        headers: authHeaders(other.token),
      });
      assert.notEqual(otherAnalysis.response.status, 429,
        'a fresh account must not inherit another account’s exhausted budget');
    } finally {
      await closeAgentChatSocket(socket);
    }
  });

  it('caps concurrent agent turns per account', async () => {
    const user = await signupUser();
    // Threads map 1:1 to OrchestratorAgent Durable Objects, so one socket
    // per thread is the real concurrency surface: turns on separate
    // threads genuinely overlap, while turns on one DO are serialized by
    // the DO's input gate. A burst across six threads therefore contends
    // on the shared per-account guard (cap 2, the default).
    const threads = ['cap-a', 'cap-b', 'cap-c', 'cap-d', 'cap-e', 'cap-f'];
    const sockets = await Promise.all(threads.map((t) => openAgentChatSocket(user, t)));
    try {
      const ids = threads.map((_, i) => `cap-${i}`);
      // Send the whole burst before awaiting anything, so the acquires
      // queue while earlier turns are still in flight.
      const pending = ids.map((id, i) => sendChatTurn(sockets[i], id, `simultaneous ${id}`, threads[i]));
      const results = await Promise.all(pending);

      const refused = results.filter((r) => CONCURRENCY_REFUSAL.test(r.errorText ?? ''));
      const admitted = results.filter((r) => PROVIDER_FAILURE.test(r.errorText ?? ''));

      // Every turn — admitted or refused — terminated with a legible
      // outcome; none of the six can hit the 6/day test budget.
      assert.equal(admitted.length + refused.length, 6,
        'every turn ended in a provider failure or a cap refusal');
      for (const result of results) {
        assert.equal(result.done, true, 'every turn, refused or not, terminates');
      }

      // The burst must produce at least one cap refusal. (Six parallel
      // turns each take several KV round-trips before releasing their
      // slot, while the whole burst is sent in one write, so total
      // serialization is not observed in practice; the strict cap math is
      // pinned by aiUsageState.test.mjs.)
      assert.ok(refused.length >= 1,
        `expected at least one concurrency refusal in the burst, got ${refused.length}`);
      assert.ok(admitted.length >= 1, 'at least one turn should run');
    } finally {
      await Promise.all(sockets.map((socket) => closeAgentChatSocket(socket)));
    }
  });

  it('releases turn slots when a turn crashes, keeping the account usable', async () => {
    const user = await signupUser();
    // Phase 1 — a parallel burst across threads: whatever is admitted
    // "crashes" at the (absent) provider, exercising the error-path
    // release; whatever is refused by the cap proves slots were held.
    const threads = ['crash-a', 'crash-b', 'crash-c', 'crash-d'];
    const sockets = await Promise.all(threads.map((t) => openAgentChatSocket(user, t)));
    try {
      const ids = threads.map((_, i) => `crash-1-${i}`);
      const burst = await Promise.all(
        ids.map((id, i) => sendChatTurn(sockets[i], id, `burst ${id}`, threads[i]))
      );
      const crashed = burst.filter((r) => PROVIDER_FAILURE.test(r.errorText ?? ''));
      assert.ok(crashed.length >= 1, 'at least one admitted turn crashed at the provider');
      for (const result of burst) {
        assert.equal(result.done, true, 'every burst turn terminated');
      }

      // Phase 2 — after the crashes settle, two more turns (on fresh
      // threads) must both be admitted. If crashed turns leaked their
      // slots, the account would be wedged at the cap instead. (A single
      // leaked slot can slip past a cap of 2 here; the strict single-slot
      // and lease-expiry reclamation rules are pinned by
      // aiUsageState.test.mjs.)
      const followUp1 = await sendChatTurn(sockets[0], 'crash-2-a', 'still usable 1', 'crash-a');
      assert.equal(followUp1.done, true);
      assert.match(followUp1.errorText ?? '', PROVIDER_FAILURE,
        'the first post-crash turn must be admitted, not refused');
      const followUp2 = await sendChatTurn(sockets[1], 'crash-2-b', 'still usable 2', 'crash-b');
      assert.equal(followUp2.done, true);
      assert.match(followUp2.errorText ?? '', PROVIDER_FAILURE,
        'the second post-crash turn must be admitted, not refused');
    } finally {
      await Promise.all(sockets.map((socket) => closeAgentChatSocket(socket)));
    }
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

  it('lets an uploaded image become a sticker on the server, and the sticker survives reload', async () => {
    const user = await signupUser();

    // The Add Sticker flow, exactly as the frontend performs it
    // (stickerUpload.ts): upload an image, then PATCH it into a sticker
    // with the default config. The DO used to strip `type` from the patch,
    // so the sticker silently reverted to a plain image on the next
    // reconcile.
    const uploadForm = new UndiciFormData();
    uploadForm.set('file', createPngFile('cat.png'));
    const upload = await expectOk('/api/upload', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: uploadForm,
    });
    assert.equal(upload.item.type, 'image');

    const stickerConfig = { width: 120, height: 120, rotation: 0, opacity: 1 };
    const applied = await patchItems(user.token, [{
      id: upload.item.id,
      updates: { type: 'sticker', stickerConfig: { ...stickerConfig } },
    }]);
    assert.equal(applied[0].type, 'sticker', 'the apply response echoes the sticker type');
    assert.deepEqual(applied[0].stickerConfig, stickerConfig);

    // The reload path: a fresh GET still shows the sticker the server
    // stored — type and config, not just optimistic local state.
    const desktop = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    const sticker = desktop.items.find((item) => item.id === upload.item.id);
    assert.ok(sticker, 'the sticker item is still listed');
    assert.equal(sticker.type, 'sticker');
    assert.deepEqual(sticker.stickerConfig, stickerConfig);

    // Ordinary patches on a sticker keep working: the context menu's
    // rotate/opacity commands and the resize handle only PATCH
    // stickerConfig (no `type` in the payload).
    const rotated = await patchItems(user.token, [{
      id: upload.item.id,
      updates: { stickerConfig: { ...stickerConfig, rotation: 15, opacity: 0.5 } },
    }]);
    assert.deepEqual(rotated[0].stickerConfig, { ...stickerConfig, rotation: 15, opacity: 0.5 });
  });

  it('rejects every other item type transition with a 400 naming it, changing nothing', async () => {
    const user = await signupUser();

    // One item per type the forbidden matrix crosses. A bare app item is
    // enough — the DO judges a transition by the stored `type` alone. The
    // first upload becomes a real sticker (the reverse transition must be
    // refused too: the frontend's "Remove Sticker" trashes the item, there
    // is no convert-back action); the second stays a plain image.
    const note = await createDesktopItem(user.token, {
      type: 'text', name: 'Note.txt', position: { x: 0, y: 0 }, textContent: 'note',
    });
    const folder = await createDesktopItem(user.token, {
      type: 'folder', name: 'Folder', position: { x: 1, y: 0 },
    });
    const app = await createDesktopItem(user.token, {
      type: 'app', name: 'Standalone App', position: { x: 2, y: 0 },
    });
    const firstForm = new UndiciFormData();
    firstForm.set('file', createPngFile('to-sticker.png'));
    const first = await expectOk('/api/upload', {
      method: 'POST', headers: authHeaders(user.token), body: firstForm,
    });
    const secondForm = new UndiciFormData();
    secondForm.set('file', createPngFile('stays-image.png'));
    const second = await expectOk('/api/upload', {
      method: 'POST', headers: authHeaders(user.token), body: secondForm,
    });
    await patchItems(user.token, [{
      id: first.item.id,
      updates: { type: 'sticker', stickerConfig: { width: 120, height: 120, rotation: 0, opacity: 1 } },
    }]);

    const desktopBefore = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    const snapshot = (item) => ({ type: item.type, name: item.name, stickerConfig: item.stickerConfig ?? null });
    const beforeById = new Map(desktopBefore.items.map((item) => [item.id, snapshot(item)]));

    // Each refused patch also tries to rename the item: with the old
    // silent strip these returned 200 and applied the rename, leaving a
    // successful-looking half-applied write. Now they must 400 naming the
    // transition — non-string type values included.
    const forbidden = [
      { id: note.id, from: 'text', requested: 'sticker' },
      { id: second.item.id, from: 'image', requested: 'app' },
      { id: app.id, from: 'app', requested: 'image' },
      { id: folder.id, from: 'folder', requested: 'sticker' },
      { id: first.item.id, from: 'sticker', requested: 'image' },
      { id: second.item.id, from: 'image', requested: 42 },
    ];
    for (const { id, from, requested } of forbidden) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify([{ id, updates: { type: requested, name: 'Should Not Stick' } }]),
      });
      assert.equal(res.response.status, 400, `${from} -> ${String(requested)} must be rejected`);
      assert.match(
        res.body.error,
        new RegExp(`from '${from}' to '${String(requested)}'`),
        'the rejection names the transition'
      );
    }

    // Nothing changed: every item is exactly what it was before the
    // refused patches — type, name, and sticker config all untouched.
    const desktopAfter = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    assert.equal(desktopAfter.items.length, desktopBefore.items.length);
    for (const item of desktopAfter.items) {
      assert.deepEqual(snapshot(item), beforeById.get(item.id), `item ${item.id} unchanged`);
    }

    // The rejection is atomic across a batch: a benign rename mixed with
    // a forbidden transition applies neither.
    const mixed = await fetchJson('/api/desktop/items', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify([
        { id: folder.id, updates: { name: 'Renamed' } },
        { id: note.id, updates: { type: 'sticker' } },
      ]),
    });
    assert.equal(mixed.response.status, 400);
    const afterMixed = await expectOk('/api/desktop', { headers: authHeaders(user.token) });
    assert.equal(afterMixed.items.find((item) => item.id === folder.id).name, 'Folder',
      'a rejected batch applies none of its entries');

    // Re-asserting an item's current type is not a transition: it stays a
    // harmless no-op, so a client echoing a full item back is not broken.
    const reasserted = await patchItems(user.token, [{ id: note.id, updates: { type: 'text' } }]);
    assert.equal(reasserted[0].type, 'text');

    // stickerConfig is shape-validated on both write paths: junk is a 400,
    // never stored state (there was no validation before this).
    const junkConfigs = [
      'wide',
      { width: 120 },
      { width: 120, height: 120, rotation: 0, opacity: 2 },
      { width: 120, height: 120, rotation: 0, opacity: 1, sparkles: true },
    ];
    for (const junk of junkConfigs) {
      const res = await fetchJson('/api/desktop/items', {
        method: 'PATCH',
        headers: authHeaders(user.token, JSON_HEADERS),
        body: JSON.stringify([{ id: second.item.id, updates: { stickerConfig: junk } }]),
      });
      assert.equal(res.response.status, 400, `junk stickerConfig ${JSON.stringify(junk)} must be rejected`);
    }
    const badCreate = await fetchJson('/api/desktop/items', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        type: 'sticker', name: 'Bad', position: { x: 3, y: 0 }, stickerConfig: 'wide',
      }),
    });
    assert.equal(badCreate.response.status, 400, 'create must refuse a malformed stickerConfig too');

    // A well-formed config still round-trips through create unchanged.
    const goodCreate = await createDesktopItem(user.token, {
      type: 'sticker', name: 'Direct', position: { x: 4, y: 0 },
      stickerConfig: { width: 80, height: 80, rotation: 45, opacity: 0.9 },
    });
    assert.deepEqual(goodCreate.stickerConfig, { width: 80, height: 80, rotation: 45, opacity: 0.9 });
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
    // stored). URL-validation failures are client errors — HttpError(400).
    const { response } = await fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        customCSS: '.x { background: url(https://evil.example/beacon.png); }',
      }),
    });
    assert.equal(response.status, 400, `cross-origin url() should be a 400, got ${response.status}`);

    // And the hostile CSS was not persisted anywhere on the profile.
    const profile = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.ok(!JSON.stringify(profile).includes('evil.example'), 'hostile url must not be stored');
  });

  it('rejects cross-origin appearance URLs with allowlisted-looking paths (stored-beacon guard)', async () => {
    const user = await signupUser();
    const patchProfileRaw = (updates) => fetchJson('/api/profile', {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify(updates),
    });

    // The old validation compared only new URL(x, base).pathname against the
    // allowlist, so a cross-origin URL with an allowlisted PATH passed and was
    // stored — a stored cursor.image.* would then be fetched in every
    // visitor's browser (tracking pixel / stored beacon). All of these must
    // now be 400 client errors, not stored.
    const cases = [
      // designTokens cursor image (bare URL + hotspot suffix)
      { designTokens: { 'cursor.image.default': 'https://evil.example/api/cursors/beacon.png|0|0' } },
      // customCSS url()
      { customCSS: '.x { background: url(https://evil.example/api/cursors/beacon.png); }' },
      // designTokens url() value
      { designTokens: { 'menu.icon': 'url(https://evil.example/api/cursors/beacon.png)' } },
      // adversarial variants of the same trick on a cursor token
      { designTokens: { 'cursor.image.default': '//evil.example/api/cursors/beacon.png|0|0' } },          // protocol-relative
      { designTokens: { 'cursor.image.default': 'https:/\\evil.example/api/cursors/beacon.png|0|0' } },   // backslash authority
      { designTokens: { 'cursor.image.default': 'https://api@evil.example/api/cursors/beacon.png|0|0' } }, // userinfo
      { designTokens: { 'cursor.image.default': '/api/cursors/%2e%2e/%2e%2e/beacon.png|0|0' } },          // encoded traversal
    ];
    for (const updates of cases) {
      const { response, body } = await patchProfileRaw(updates);
      assert.equal(
        response.status, 400,
        `expected 400 for ${JSON.stringify(updates)}, got ${response.status}: ${JSON.stringify(body)}`
      );
    }

    // data: and javascript: values are also rejected (the pre-existing
    // dangerous-pattern scan fires first, so assert "rejected", not a code).
    for (const updates of [
      { designTokens: { 'cursor.image.default': 'data:image/png;base64,AAAA|0|0' } },
      { designTokens: { 'cursor.image.default': 'javascript:alert(1)|0|0' } },
      { customCSS: '.x { background: url(data:image/png;base64,AAAA); }' },
    ]) {
      const { response } = await patchProfileRaw(updates);
      assert.ok(response.status >= 400, `expected rejection for ${JSON.stringify(updates)}`);
    }

    // Absolute URLs on the API's own origin — what CursorEditor legitimately
    // stores (getCursorUrl prefixes VITE_API_URL) — must keep working.
    const absolute = await patchProfile(user.token, {
      designTokens: { 'cursor.image.default': `${BASE_URL}/api/cursors/arrow.png|3|2` },
    });
    assert.equal(absolute.profile.designTokens['cursor.image.default'], `${BASE_URL}/api/cursors/arrow.png|3|2`);

    // Relative first-party paths still work.
    await patchProfile(user.token, {
      designTokens: { 'cursor.image.default': '/api/cursors/arrow.png|0|0' },
    });

    // Nothing hostile was persisted anywhere on the profile.
    const profile = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.ok(!JSON.stringify(profile).includes('evil.example'), 'hostile URL must not be stored');
  });

  it('returns 404 (not 500) when reverting an unknown CSS version', async () => {
    const user = await signupUser();
    await patchProfile(user.token, { customCSS: '.window { border-radius: 10px; }' });

    const { response, body } = await fetchJson('/api/css-history/no-such-version/revert', {
      method: 'POST',
      headers: authHeaders(user.token),
    });
    assert.equal(response.status, 404, `expected 404, got ${response.status}`);
    assert.match(body?.error ?? '', /not found/i);

    // The failed revert changed nothing.
    const profile = await expectOk('/api/profile', { headers: authHeaders(user.token) });
    assert.equal(profile.profile.customCSS, '.window { border-radius: 10px; }');
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

    // Old credentials stay dead after the purge: neither the session nor the
    // refresh token can mint anything for the purged account.
    const oldSession = await fetchJson('/api/quota', { headers: authHeaders(user.token) });
    assert.equal(oldSession.response.status, 401);
    const oldRefresh = await fetchJson('/api/auth/refresh', {
      method: 'POST',
      headers: ipHeaders(),
      body: JSON.stringify({ refreshToken: user.refreshToken }),
    });
    assert.equal(oldRefresh.response.status, 401);

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

  // -------------------------------------------------------------------------
  // App source revisions (design/13, first slice): every save records an
  // immutable revision; failed saves keep the installed bundle and record
  // diagnostics; restore appends a new revision and never widens grants;
  // release rollback joins the same model (kind 'rollback', pointers move).
  // -------------------------------------------------------------------------

  it('records an immutable revision per dev-deploy and restores without rewriting history', async () => {
    const user = await signupUser();
    const deploy = (appId, marker) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        ...(appId ? { appId } : {}),
        manifest: {
          name: 'Revision App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: {
          'index.html': `<!doctype html><html><body><h1>${marker}</h1></body></html>`,
          'app.js': `/* ${marker} */`,
        },
      }),
    });
    const revisionsList = () => expectOk(`/api/apps/${encodeURIComponent(appId)}/revisions`, {
      headers: authHeaders(user.token),
    });
    const revisionDetail = (revisionId) => expectOk(
      `/api/apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(revisionId)}`,
      { headers: authHeaders(user.token) },
    );

    const created = await deploy(null, 'rev-one');
    const appId = created.appId;
    assert.ok(created.revision, 'a successful create returns its revision id');

    let history = await revisionsList();
    assert.equal(history.revisions.length, 1);
    const firstRevision = history.revisions[0];
    assert.equal(firstRevision.kind, 'deploy');
    assert.equal(firstRevision.author, 'human');
    assert.equal(firstRevision.valid, true);
    assert.equal(firstRevision.appVersion, 1);
    assert.equal(history.currentRevision, firstRevision.id);
    assert.equal(history.lastValidRevision, firstRevision.id);

    const updated = await deploy(appId, 'rev-two');
    assert.equal(updated.version, 2);
    history = await revisionsList();
    assert.deepEqual(
      history.revisions.map((revision) => revision.appVersion),
      [2, 1],
      'revisions list newest-first',
    );
    assert.equal(history.currentRevision, updated.revision);
    assert.equal(history.lastValidRevision, updated.revision);

    // The old revision's files are intact and fetchable.
    const firstFiles = await revisionDetail(firstRevision.id);
    assert.match(firstFiles.files['index.html'], /rev-one/);
    assert.deepEqual(firstFiles.revision.diagnostics, { valid: true, issues: [] });

    // Restore appends: a NEW revision + a NEW release; nothing is rewritten.
    const restored = await expectOk(
      `/api/apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(firstRevision.id)}/restore`,
      { method: 'POST', headers: authHeaders(user.token) },
    );
    assert.equal(restored.version, 3, 'restore deploys the next release version');
    assert.equal(restored.restoredFrom, firstRevision.id);
    assert.notEqual(restored.revisionId, firstRevision.id);

    const served = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(appId)}/`);
    assert.equal(served.status, 200);
    assert.match(await served.text(), /rev-one/, 'the installed bundle is the restored source');

    history = await revisionsList();
    assert.equal(history.revisions.length, 3);
    const restoreRow = history.revisions[0];
    assert.equal(restoreRow.kind, 'restore');
    assert.equal(restoreRow.parentRevision, firstRevision.id);
    assert.equal(restoreRow.valid, true);
    assert.equal(restoreRow.appVersion, 3);
    assert.equal(history.currentRevision, restored.revisionId);
    assert.equal(history.lastValidRevision, restored.revisionId);

    // History stays immutable: the v2 revision still holds the v2 source.
    const secondFiles = await revisionDetail(updated.revision);
    assert.match(secondFiles.files['index.html'], /rev-two/);
    const restoredFiles = await revisionDetail(firstRevision.id);
    assert.match(restoredFiles.files['index.html'], /rev-one/);

    const source = await expectOk(`/api/apps/${encodeURIComponent(appId)}/source`, {
      headers: authHeaders(user.token),
    });
    assert.match(source.files['index.html'], /rev-one/);
  });

  it('keeps the installed bundle when a save fails and records diagnostics on the failed revision', async () => {
    const user = await signupUser();
    const deploy = (appId, files) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        ...(appId ? { appId } : {}),
        manifest: {
          name: 'Failed Save App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files,
      }),
    });

    const created = await deploy(null, {
      'index.html': '<!doctype html><html><body><h1>still-installed</h1></body></html>',
      'app.js': '/* ok */',
    });
    const appId = created.appId;
    const installedRevision = created.revision;

    // A rejected update: validation runs before any release write, so the
    // installed bundle must survive — and the attempt must be recorded.
    const rejected = await fetchJson('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        appId,
        manifest: {
          name: 'Failed Save App',
          version: '2.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: {
          'index.html': '<!doctype html><html><body><script src="https://evil.example/x.js"></script></body></html>',
          'app.js': '/* still ok */',
        },
      }),
    });
    assert.equal(rejected.response.status, 400);
    assert.ok(Array.isArray(rejected.body.issues));
    assert.equal(rejected.body.issues[0].code, 'source/external-script');
    assert.ok(rejected.body.revision, 'a failed update records its revision id');

    // The installed bundle and the served source are unchanged.
    const served = await worker.fetch(`${BASE_URL}/api/apps/${encodeURIComponent(appId)}/`);
    assert.match(await served.text(), /still-installed/);
    const source = await expectOk(`/api/apps/${encodeURIComponent(appId)}/source`, {
      headers: authHeaders(user.token),
    });
    assert.match(source.files['index.html'], /still-installed/);

    const history = await expectOk(`/api/apps/${encodeURIComponent(appId)}/revisions`, {
      headers: authHeaders(user.token),
    });
    assert.equal(history.revisions.length, 2, 'the failed attempt is part of the history');
    const failed = history.revisions[0];
    assert.equal(failed.valid, false);
    assert.equal(failed.summary, 'Failed save — validation rejected');
    assert.equal(history.currentRevision, rejected.body.revision);
    assert.equal(history.lastValidRevision, installedRevision, 'the last valid pointer did not move');

    const detail = await expectOk(
      `/api/apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(rejected.body.revision)}`,
      { headers: authHeaders(user.token) },
    );
    assert.equal(detail.revision.valid, false);
    assert.ok(detail.revision.diagnostics.issues.length >= 1);
    assert.equal(detail.revision.diagnostics.issues[0].code, 'source/external-script');
    assert.match(detail.files['index.html'], /evil\.example/, 'the attempted (rejected) source is recorded');
  });

  it('restore never widens grants beyond the current grant', async () => {
    const user = await signupUser();
    const html = (marker) => ({
      'index.html': `<!doctype html><html><body><h1>${marker}</h1></body></html>`,
    });

    // v1 declares a narrow scope and a broad one; the user grants both.
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Grant Restore App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/Gallery/**', '/**'] } },
          rationale: 'Needs broad read.',
        },
        files: html('v1'),
      }),
    });
    const appIdEncoded = encodeURIComponent(app.appId);
    await expectOk(`/api/apps/${appIdEncoded}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        granted: { fs: { read: ['/Gallery/**', '/**'] } },
        broadApprovals: ['fs.read'],
      }),
    });

    // v2 stops re-declaring the broad scope. Under dev-deploy's update rule
    // (grants intersect with the declaration, never expand), the stored
    // grant drops the scope that is no longer declared.
    await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        appId: app.appId,
        manifest: {
          name: 'Grant Restore App',
          version: '2.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ['/Gallery/**'] } },
          rationale: 'Narrowed.',
        },
        files: html('v2'),
      }),
    });
    const afterNarrow = await expectOk(`/api/apps/${appIdEncoded}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(afterNarrow.granted, { fs: { read: ['/Gallery/**'] } });

    // Restoring the broad v1 revision re-declares BOTH scopes, but the
    // grant intersects with the current grant and must not re-open the
    // broad one — restore follows the same never-expand rule as updates.
    const restored = await expectOk(
      `/api/apps/${appIdEncoded}/revisions/${encodeURIComponent(app.revision)}/restore`,
      { method: 'POST', headers: authHeaders(user.token) },
    );
    assert.equal(restored.success, true);

    const afterRestore = await expectOk(`/api/apps/${appIdEncoded}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(afterRestore.requested.fs.read, ['/Gallery/**', '/**'],
      'the declared set follows the restored revision');
    assert.deepEqual(afterRestore.granted, { fs: { read: ['/Gallery/**'] } },
      'restore must never re-grant a scope the current grant dropped');
  });

  it('rollback appends a rollback revision, moves the pointers, and never widens grants', async () => {
    const user = await signupUser();
    const deploy = (appId, marker, permissions) => expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({
        ...(appId ? { appId } : {}),
        manifest: {
          name: 'Rollback History App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions,
        },
        files: {
          'index.html': `<!doctype html><html><body><h1>${marker}</h1></body></html>`,
          'app.js': `/* ${marker} */`,
        },
      }),
    });

    // v1 declares a narrow scope; the user grants it.
    const v1 = await deploy(null, 'rollback-one', { fs: { read: ['/Gallery/**'] } });
    const appIdEncoded = encodeURIComponent(v1.appId);
    await expectOk(`/api/apps/${appIdEncoded}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**'] } } }),
    });

    // v2 declares a second scope, and the user widens the grant to both
    // through the honest permissions route (within v2's declaration).
    const v2 = await deploy(v1.appId, 'rollback-two', { fs: { read: ['/Gallery/**', '/Notes/**'] } });
    assert.equal(v2.version, 2);
    await expectOk(`/api/apps/${appIdEncoded}/permissions`, {
      method: 'PATCH',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ granted: { fs: { read: ['/Gallery/**', '/Notes/**'] } } }),
    });

    // The rollback keeps its legacy request/response shape…
    const rollback = await expectOk(`/api/apps/${appIdEncoded}/rollback`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollback.success, true);
    assert.equal(rollback.version, 1);
    assert.equal(rollback.appId, v1.appId);

    // …appends a rollback revision whose parent is the revision the app
    // rolled back FROM, and moves BOTH pointers so the registry's revision
    // history can no longer disagree with the installed release.
    const history = await expectOk(`/api/apps/${appIdEncoded}/revisions`, {
      headers: authHeaders(user.token),
    });
    assert.equal(history.revisions.length, 3, 'deploy v1, deploy v2, rollback');
    const rollbackRow = history.revisions.find((revision) => revision.kind === 'rollback');
    assert.ok(rollbackRow, 'the rollback appends its revision');
    assert.equal(rollbackRow.valid, true);
    assert.equal(rollbackRow.author, 'human');
    assert.equal(rollbackRow.appVersion, 1);
    assert.equal(rollbackRow.parentRevision, v2.revision, 'the parent points at the revision rolled back from');
    assert.equal(history.currentRevision, rollbackRow.id);
    assert.equal(history.lastValidRevision, rollbackRow.id);

    // The installed release is v1 again: registry and served bundle agree.
    const versions = await expectOk(`/api/apps/${appIdEncoded}/versions`, {
      headers: authHeaders(user.token),
    });
    assert.equal(versions.currentVersion, 1);
    const served = await worker.fetch(`${BASE_URL}/api/apps/${appIdEncoded}/`);
    assert.equal(served.status, 200);
    assert.match(await served.text(), /rollback-one/);

    // Grants never widen on rollback: the current grant (both scopes)
    // intersects with v1's declaration and drops /Notes/**.
    const afterRollback = await expectOk(`/api/apps/${appIdEncoded}/permissions`, {
      headers: authHeaders(user.token),
    });
    assert.deepEqual(afterRollback.requested.fs.read, ['/Gallery/**'],
      'the declared set follows the rolled-back release');
    assert.deepEqual(afterRollback.granted, { fs: { read: ['/Gallery/**'] } });

    // The rollback revision carries v1's saved source and validates clean.
    const detail = await expectOk(
      `/api/apps/${appIdEncoded}/revisions/${encodeURIComponent(rollbackRow.id)}`,
      { headers: authHeaders(user.token) },
    );
    assert.match(detail.files['index.html'], /rollback-one/);
    assert.deepEqual(detail.revision.diagnostics, { valid: true, issues: [] });

    // Rolling back to the already-installed release stays a no-op: the
    // legacy early return appends nothing and moves no pointer.
    const noop = await expectOk(`/api/apps/${appIdEncoded}/rollback`, {
      method: 'POST',
      headers: authHeaders(user.token, JSON_HEADERS),
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(noop.version, 1);
    const historyAfterNoop = await expectOk(`/api/apps/${appIdEncoded}/revisions`, {
      headers: authHeaders(user.token),
    });
    assert.equal(historyAfterNoop.revisions.length, 3, 'a no-op rollback appends no revision');
    assert.equal(historyAfterNoop.currentRevision, rollbackRow.id);
  });

  it('gates the revision routes to the app owner and validates revision ids', async () => {
    const owner = await signupUser();
    const rival = await signupUser();
    const app = await expectOk('/api/apps/dev-deploy', {
      method: 'POST',
      headers: authHeaders(owner.token, JSON_HEADERS),
      body: JSON.stringify({
        manifest: {
          name: 'Guarded History App',
          version: '1.0.0',
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
        },
        files: { 'index.html': '<!doctype html><html><body>guarded</body></html>' },
      }),
    });
    const appIdEncoded = encodeURIComponent(app.appId);
    const ownerHeaders = authHeaders(owner.token);
    const rivalHeaders = authHeaders(rival.token, JSON_HEADERS);

    // Unauthenticated requests never reach the handler.
    assert.equal((await fetchJson(`/api/apps/${appIdEncoded}/revisions`, {})).response.status, 401);

    // The owner sees the history; nobody else does.
    const ownerHistory = await expectOk(`/api/apps/${appIdEncoded}/revisions`, { headers: ownerHeaders });
    assert.equal(ownerHistory.revisions.length, 1);
    assert.equal((await fetchJson(`/api/apps/${appIdEncoded}/revisions`, { headers: rivalHeaders })).response.status, 403);
    assert.equal((await fetchJson(`/api/apps/${appIdEncoded}/revisions/${encodeURIComponent(app.revision)}`, { headers: rivalHeaders })).response.status, 403);
    assert.equal((await fetchJson(`/api/apps/${appIdEncoded}/revisions/${encodeURIComponent(app.revision)}/restore`, { method: 'POST', headers: rivalHeaders })).response.status, 403);

    // Unknown app → 404 (not 403: existence is not leaked to a stranger).
    assert.equal((await fetchJson('/api/apps/missing-app/revisions', { headers: ownerHeaders })).response.status, 404);

    // Unknown but well-formed revision → 404; malformed revision id → 400.
    assert.equal((await fetchJson(`/api/apps/${appIdEncoded}/revisions/1770000000000-zzzzzzzz`, { headers: ownerHeaders })).response.status, 404);
    const malformed = await fetchJson(`/api/apps/${appIdEncoded}/revisions/${encodeURIComponent('../../v1')}`, { headers: ownerHeaders });
    assert.equal(malformed.response.status, 400);

    // The owner's own restore is allowed (positive control).
    const restored = await expectOk(
      `/api/apps/${appIdEncoded}/revisions/${encodeURIComponent(app.revision)}/restore`,
      { method: 'POST', headers: ownerHeaders },
    );
    assert.equal(restored.restoredFrom, app.revision);
  });
});
