// Uploads & file serving (routes/upload.ts, routes/sounds.ts) under
// unstable_dev: detected-MIME storage, Range handling, single item lookup
// (no filename fallback), soft-deleted owners, versioned icon URLs, and the
// AI budget charged by automatic upload analysis.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { after, before, describe, it } from 'node:test';

import { unstable_dev } from 'wrangler';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { parseByteRange } = await import('../src/routes/upload.ts');

const BASE_URL = 'http://127.0.0.1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5F2pQAAAAASUVORK5CYII=',
  'base64'
);
// A second, different valid PNG (one extra trailing byte after IEND is
// ignored by decoders but changes the content hash).
const PNG_BYTES_2 = Buffer.concat([PNG_BYTES, Buffer.from([0])]);

let worker;
let stateDir;

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eternalos-uploads-state-'));
  worker = await unstable_dev('src/index.ts', {
    config: process.env.WRANGLER_CONFIG ?? 'wrangler.toml',
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

function ip(tag) {
  return { ...JSON_HEADERS, 'CF-Connecting-IP': `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

const auth = (token, extra = {}) => ({ ...extra, Authorization: `Bearer ${token}` });

async function json(url, init) {
  const response = await worker.fetch(`${BASE_URL}${url}`, init);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function signup() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
  const identity = { email: `up${suffix}@example.com`, username: `up${suffix}`.slice(0, 20), password: 'Password123' };
  const { response, body } = await json('/api/auth/signup', {
    method: 'POST', headers: ip('signup'), body: JSON.stringify(identity),
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return { ...identity, ...body };
}

function multipart(fields) {
  const boundary = `----up-${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (typeof value === 'string') {
      parts.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    } else {
      parts.push(Buffer.from(
        `Content-Disposition: form-data; name="${name}"; filename="${value.name}"\r\nContent-Type: ${value.type}\r\n\r\n`,
      ));
      parts.push(value.bytes, Buffer.from('\r\n'));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

async function upload(user, file, extra = {}) {
  const form = multipart({ file, ...extra });
  const { response, body } = await json('/api/upload', {
    method: 'POST', headers: auth(user.token, form.headers), body: form.body,
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.item;
}

async function items(user) {
  return (await json('/api/desktop', { headers: auth(user.token) })).body.items;
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const fileUrl = (user, item) =>
  `${BASE_URL}/api/files/${user.user.uid}/${item.id}/${encodeURIComponent(item.name)}`;

describe('parseByteRange', () => {
  it('handles normal, open, suffix, clamped, reversed and out-of-range ranges', () => {
    assert.deepEqual(parseByteRange(null, 10), { kind: 'full' });
    assert.deepEqual(parseByteRange('bytes=0-3', 10), { kind: 'partial', start: 0, end: 3 });
    assert.deepEqual(parseByteRange('bytes=4-', 10), { kind: 'partial', start: 4, end: 9 });
    assert.deepEqual(parseByteRange('bytes=-3', 10), { kind: 'partial', start: 7, end: 9 });
    assert.deepEqual(parseByteRange('bytes=-30', 10), { kind: 'partial', start: 0, end: 9 });
    assert.deepEqual(parseByteRange('bytes=2-999', 10), { kind: 'partial', start: 2, end: 9 });
    assert.deepEqual(parseByteRange('bytes=5-1', 10), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=10-', 10), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=-0', 10), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=0-', 0), { kind: 'unsatisfiable' });
    assert.deepEqual(parseByteRange('bytes=0-1,4-5', 10), { kind: 'full' });
    assert.deepEqual(parseByteRange('items=0-1', 10), { kind: 'full' });
  });
});

describe('uploads and file serving', () => {
  it('stores the detected MIME type, not the declared one', async () => {
    const user = await signup();
    const item = await upload(user, { name: 'really-a-png.jpg', type: 'image/jpeg', bytes: PNG_BYTES });
    assert.equal(item.mimeType, 'image/png');
    const served = await worker.fetch(fileUrl(user, item), { headers: auth(user.token) });
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    await served.arrayBuffer();
  });

  it('serves valid ranges, clamps the end, and answers 416 for reversed/out-of-range', async () => {
    const user = await signup();
    const item = await upload(user, { name: 'range.png', type: 'image/png', bytes: PNG_BYTES }, { isPublic: 'true' });
    const size = PNG_BYTES.length;
    for (const headers of [auth(user.token), {}]) {
      const ok = await worker.fetch(fileUrl(user, item), { headers: { ...headers, Range: 'bytes=0-7' } });
      assert.equal(ok.status, 206);
      assert.equal(ok.headers.get('content-range'), `bytes 0-7/${size}`);
      assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG_BYTES.subarray(0, 8));

      const clamped = await worker.fetch(fileUrl(user, item), { headers: { ...headers, Range: 'bytes=10-99999' } });
      assert.equal(clamped.status, 206);
      assert.equal(clamped.headers.get('content-range'), `bytes 10-${size - 1}/${size}`);
      assert.equal((await clamped.arrayBuffer()).byteLength, size - 10);

      for (const range of ['bytes=50-10', `bytes=${size}-`]) {
        const bad = await worker.fetch(fileUrl(user, item), { headers: { ...headers, Range: range } });
        assert.equal(bad.status, 416, range);
        assert.equal(bad.headers.get('content-range'), `bytes */${size}`);
        await bad.arrayBuffer();
      }
    }
  });

  it('keeps private files private and 404s deleted items instead of falling back to the filename', async () => {
    const user = await signup();
    const item = await upload(user, { name: 'secret.txt', type: 'text/plain', bytes: Buffer.from('secret') });
    const anonymous = await worker.fetch(fileUrl(user, item), { headers: { Range: 'bytes=0-1' } });
    assert.equal(anonymous.status, 403);
    await anonymous.arrayBuffer();

    const del = await json(`/api/desktop/items/${item.id}`, { method: 'DELETE', headers: auth(user.token) });
    assert.ok(del.response.ok, JSON.stringify(del.body));
    const gone = await worker.fetch(fileUrl(user, item), { headers: auth(user.token) });
    assert.equal(gone.status, 404);
    await gone.arrayBuffer();
  });

  it('stops serving public files once the owner account is soft-deleted', async () => {
    const user = await signup();
    const item = await upload(user, { name: 'public.txt', type: 'text/plain', bytes: Buffer.from('hello') }, { isPublic: 'true' });
    const before = await worker.fetch(fileUrl(user, item));
    assert.equal(before.status, 200);
    await before.arrayBuffer();

    const deletion = await json('/api/auth/delete-account', {
      method: 'POST', headers: auth(user.token, ip('delete')), body: JSON.stringify({ password: user.password }),
    });
    assert.equal(deletion.response.status, 200, JSON.stringify(deletion.body));
    const afterDelete = await worker.fetch(fileUrl(user, item));
    assert.equal(afterDelete.status, 404);
    await afterDelete.arrayBuffer();
  });

  it('gives every re-uploaded icon a new immutable URL and keeps the legacy URL working', async () => {
    const user = await signup();
    const item = await upload(user, { name: 'note.txt', type: 'text/plain', bytes: Buffer.from('x') });
    const putIcon = async (bytes) => {
      const form = multipart({ file: { name: 'icon.png', type: 'image/png', bytes }, itemId: item.id });
      const { response, body } = await json('/api/icon', {
        method: 'POST', headers: auth(user.token, form.headers), body: form.body,
      });
      assert.equal(response.status, 200, JSON.stringify(body));
      return body.customIcon;
    };
    // Same URL scheme the frontend builds (services/assets.ts getCustomIconUrl).
    const iconUrl = (customIcon) => {
      const [uid, , file] = customIcon.slice('upload:'.length).split('/');
      return `${BASE_URL}/api/icon/${uid}/${file.replace('.png', '')}/icon.png`;
    };

    const first = await putIcon(PNG_BYTES);
    const second = await putIcon(PNG_BYTES_2);
    assert.notEqual(first, second);
    assert.notEqual(iconUrl(first), iconUrl(second));

    const current = await worker.fetch(iconUrl(second));
    assert.equal(current.status, 200);
    assert.match(current.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await current.arrayBuffer()), PNG_BYTES_2);

    // Legacy unversioned URL resolves through the item to the current icon,
    // without immutable caching.
    const legacy = await worker.fetch(`${BASE_URL}/api/icon/${user.user.uid}/${item.id}/icon.png`);
    assert.equal(legacy.status, 200);
    assert.doesNotMatch(legacy.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), PNG_BYTES_2);

    // The replaced versioned URL also still answers (current icon, short cache).
    const stale = await worker.fetch(iconUrl(first));
    assert.equal(stale.status, 200);
    assert.doesNotMatch(stale.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await stale.arrayBuffer()), PNG_BYTES_2);
  });

  it('charges automatic upload analysis to the AI budget and skips it quietly when exhausted', async () => {
    const user = await signup();
    // test/worker.env caps accounts at 6 AI requests/day.
    const uploaded = [];
    for (let i = 0; i < 7; i++) {
      uploaded.push(await upload(user, { name: `img-${i}.png`, type: 'image/png', bytes: PNG_BYTES }));
    }
    const settled = await waitFor(async () => {
      const list = (await items(user)).filter((it) => uploaded.some((u) => u.id === it.id));
      return list.every((it) => it.imageAnalysis && it.imageAnalysis.status !== 'pending') ? list : null;
    });
    const skipped = settled.filter((it) => it.imageAnalysis.status === 'skipped');
    assert.equal(skipped.length, 1, JSON.stringify(settled.map((it) => it.imageAnalysis)));
    assert.match(skipped[0].imageAnalysis.error, /Daily AI limit reached/);

    // The budget is spent: the manual analyze route now refuses too.
    const manual = await json(`/api/desktop/items/${uploaded[0].id}/analyze`, {
      method: 'POST', headers: auth(user.token),
    });
    assert.equal(manual.response.status, 429);
  });
});
