/**
 * Unit tests for the app source-revision storage helpers
 * (src/routes/appRevisions.ts) — revision id shape, write/read round-trip,
 * listing order, cap-based pruning (the integration suite can't afford the
 * 50 deploys a full-cap exercise would take), and the lazy registry
 * baseline migration.
 *
 * Same plain-Node type-stripping technique as appBundleValidation.test.mjs:
 * the module under test is imported directly (tsModuleHooks resolves the
 * TS-style extensionless specifiers), against a tiny in-memory R2/KV mock.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { register } from 'node:module';

register(new URL('./tsModuleHooks.mjs', import.meta.url));

const {
  ensureRevisionBaseline,
  isValidRevisionId,
  listAppRevisionManifests,
  makeRevisionId,
  MAX_APP_REVISIONS,
  pruneAppRevisions,
  readAppRevision,
  writeAppRevision,
} = await import('../src/routes/appRevisions.ts');

// ---------------------------------------------------------------------------
// In-memory R2 / KV mocks (just the surface appRevisions.ts touches)
// ---------------------------------------------------------------------------

function mockR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, String(value)); },
    async get(key) {
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return {
        key,
        text: async () => text,
        json: async () => JSON.parse(text),
      };
    },
    async delete(key) { objects.delete(key); },
    async list({ prefix }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
    },
  };
}

function mockKV() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? JSON.parse(store.get(key)) : null;
    },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
  };
}

function mockEnv() {
  return { ETERNALOS_FILES: mockR2(), DESKTOP_KV: mockKV() };
}

const UID = 'uid-1';
const APP = 'app-1';

function revisionKey(id, file) {
  return `apps/${UID}/${APP}/revisions/${id}/${file}`;
}

async function seedRevisions(env, count, startAt = 1_000_000_000_000) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = `${startAt + index}-deadbeef`;
    ids.push(id);
    await writeAppRevision(env, UID, APP, {
      kind: 'deploy',
      author: 'human',
      valid: true,
      files: { 'index.html': `<p>save ${index}</p>` },
      summary: `Deployed v${index + 1}`,
      appVersion: index + 1,
    }, id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Revision ids
// ---------------------------------------------------------------------------

describe('revision ids', () => {
  it('generates ids that validate and stay chronologically sortable', () => {
    const earlier = makeRevisionId(1_000_000_000_000);
    const later = makeRevisionId(1_000_000_000_001);
    assert.ok(isValidRevisionId(earlier));
    assert.ok(isValidRevisionId(later));
    assert.ok(earlier < later, 'lexicographic order matches chronological order');
    assert.equal(earlier.slice(0, 14), '1000000000000-');
  });

  it('rejects traversal and malformed ids', () => {
    for (const bad of ['', '..', '../..', 'a/b', '1770000000000', '1770000000000-', 'short', 'x'.repeat(40)]) {
      assert.equal(isValidRevisionId(bad), false, `"${bad}" must be invalid`);
    }
  });
});

// ---------------------------------------------------------------------------
// Write / read / list
// ---------------------------------------------------------------------------

describe('writeAppRevision / readAppRevision / listAppRevisionManifests', () => {
  it('round-trips manifest, files, and diagnostics, and lists newest-first', async () => {
    const env = mockEnv();
    const revisionId = '1770000000000-aaaaaaaa';
    const { keys } = await writeAppRevision(env, UID, APP, {
      kind: 'restore',
      author: 'human',
      valid: false,
      issues: [{ code: 'source/external-script', message: 'External script URLs are not allowed', file: 'index.html', hint: 'Bundle it locally.' }],
      files: { 'index.html': '<script src="https://evil.example/x.js"></script>' },
      name: 'Broken App',
      description: 'desc',
      permissions: { fs: { read: ['/Gallery/**'] } },
      rationale: 'why',
      windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
      parentRevision: '1769999999999-99999999',
      summary: 'Failed save — validation rejected',
    }, revisionId);

    assert.deepEqual(keys, [
      revisionKey(revisionId, 'manifest.json'),
      revisionKey(revisionId, 'files.json'),
      revisionKey(revisionId, 'diagnostics.json'),
    ]);

    const stored = await readAppRevision(env, UID, APP, revisionId);
    assert.ok(stored);
    assert.equal(stored.manifest.kind, 'restore');
    assert.equal(stored.manifest.valid, false);
    assert.equal(stored.manifest.parentRevision, '1769999999999-99999999');
    assert.equal(stored.manifest.name, 'Broken App');
    assert.deepEqual(stored.manifest.permissions, { fs: { read: ['/Gallery/**'] } });
    assert.match(stored.files['index.html'], /evil\.example/);
    assert.equal(stored.diagnostics.valid, false);
    assert.deepEqual(stored.diagnostics.issues, [{
      code: 'source/external-script',
      message: 'External script URLs are not allowed',
      file: 'index.html',
      hint: 'Bundle it locally.',
    }]);

    // Valid revisions carry empty diagnostics.
    await writeAppRevision(env, UID, APP, {
      kind: 'deploy', author: 'human', valid: true,
      files: { 'index.html': '<p>ok</p>' }, summary: 'Deployed v1', appVersion: 1,
    }, '1770000000100-bbbbbbbb');
    const valid = await readAppRevision(env, UID, APP, '1770000000100-bbbbbbbb');
    assert.deepEqual(valid.diagnostics, { valid: true, issues: [] });

    // Unknown or malformed ids read as null; listing is newest-first.
    assert.equal(await readAppRevision(env, UID, APP, '9999999999999-zzzzzzzz'), null);
    assert.equal(await readAppRevision(env, UID, APP, '../..'), null);
    const manifests = await listAppRevisionManifests(env, UID, APP);
    assert.deepEqual(manifests.map((manifest) => manifest.id), ['1770000000100-bbbbbbbb', revisionId]);
  });

  it('ignores manifests that belong to a different app or owner', async () => {
    const env = mockEnv();
    // Hand-plant a foreign manifest under this app's revisions dir — the
    // per-app prefix already isolates writes; this pins the read-side guard.
    await env.ETERNALOS_FILES.put(
      revisionKey('1770000000002-cccccccc', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1, id: '1770000000002-cccccccc', appId: 'other-app', uid: 'other-uid',
        kind: 'deploy', author: 'human', createdAt: 1, valid: true, summary: 'foreign',
      }),
    );
    const manifests = await listAppRevisionManifests(env, UID, APP);
    assert.equal(manifests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe('pruneAppRevisions', () => {
  it('keeps the newest `cap` revisions and deletes the oldest objects', async () => {
    const env = mockEnv();
    const ids = await seedRevisions(env, 6);
    await pruneAppRevisions(env, UID, APP, new Set(), 4);

    const remaining = (await listAppRevisionManifests(env, UID, APP)).map((m) => m.id);
    assert.deepEqual(remaining, [...ids].reverse().slice(0, 4), 'newest four survive, oldest two are deleted');
    for (const id of ids.slice(0, 2)) {
      for (const file of ['manifest.json', 'files.json', 'diagnostics.json']) {
        assert.equal(env.ETERNALOS_FILES.objects.has(revisionKey(id, file)), false, `${id}/${file} deleted`);
      }
    }
  });

  it('pins the registry pointers even when they fall outside the cap', async () => {
    const env = mockEnv();
    const ids = await seedRevisions(env, 6);
    // The last VALID revision is the oldest (a long run of failed saves after it).
    await pruneAppRevisions(env, UID, APP, new Set([ids[0]]), 4);

    const remaining = new Set((await listAppRevisionManifests(env, UID, APP)).map((m) => m.id));
    assert.equal(remaining.size, 5, 'the pinned revision survives in addition to the newest four');
    assert.ok(remaining.has(ids[0]), 'the pinned (last valid) revision is never pruned');
  });

  it('is a no-op at or below the cap, and the default cap is 50', async () => {
    const env = mockEnv();
    const ids = await seedRevisions(env, 3);
    await pruneAppRevisions(env, UID, APP, new Set([ids[2]]));
    assert.equal((await listAppRevisionManifests(env, UID, APP)).length, 3);
    assert.equal(MAX_APP_REVISIONS, 50);
  });
});

// ---------------------------------------------------------------------------
// Lazy registry baseline
// ---------------------------------------------------------------------------

describe('ensureRevisionBaseline', () => {
  it('snapshots an existing app\'s current source as its first revision and updates the registry', async () => {
    const env = mockEnv();
    const legacyPrefix = `apps/${UID}/${APP}/v3`;
    await env.ETERNALOS_FILES.put(`${legacyPrefix}/source.json`, JSON.stringify({ 'index.html': '<p>legacy source</p>' }));
    await env.ETERNALOS_FILES.put(`${legacyPrefix}/metadata.json`, JSON.stringify({
      name: 'Legacy App', description: 'old', version: 3,
      permissions: { fs: { read: ['/Gallery/**'] } }, rationale: 'legacy rationale',
    }));
    await env.DESKTOP_KV.put(`app:${APP}`, JSON.stringify({
      uid: UID, version: 3, granted: {}, r2Prefix: legacyPrefix,
    }));

    const pointers = await ensureRevisionBaseline(env, UID, APP, {
      uid: UID, version: 3, r2Prefix: legacyPrefix,
    });
    assert.ok(pointers.current_revision);
    assert.equal(pointers.current_revision, pointers.last_valid_revision);

    const record = await env.DESKTOP_KV.get(`app:${APP}`);
    assert.equal(record.current_revision, pointers.current_revision);
    assert.equal(record.last_valid_revision, pointers.last_valid_revision);
    assert.equal(record.r2Prefix, legacyPrefix, 'existing registry fields are preserved');

    const manifests = await listAppRevisionManifests(env, UID, APP);
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].kind, 'backfill');
    assert.equal(manifests[0].valid, true);
    assert.equal(manifests[0].name, 'Legacy App');
    assert.equal(manifests[0].appVersion, 3);
    assert.deepEqual(manifests[0].permissions, { fs: { read: ['/Gallery/**'] } });

    const stored = await readAppRevision(env, UID, APP, pointers.current_revision);
    assert.deepEqual(stored.files, { 'index.html': '<p>legacy source</p>' });
  });

  it('is idempotent for records that already carry revision pointers', async () => {
    const env = mockEnv();
    await env.DESKTOP_KV.put(`app:${APP}`, JSON.stringify({
      uid: UID, version: 1,
      current_revision: '1770000000000-aaaaaaaa', last_valid_revision: '1770000000000-aaaaaaaa',
    }));

    const pointers = await ensureRevisionBaseline(env, UID, APP, {
      uid: UID, version: 1,
      current_revision: '1770000000000-aaaaaaaa', last_valid_revision: '1770000000000-aaaaaaaa',
    });
    assert.deepEqual(pointers, {
      current_revision: '1770000000000-aaaaaaaa',
      last_valid_revision: '1770000000000-aaaaaaaa',
    });
    assert.equal((await listAppRevisionManifests(env, UID, APP)).length, 0, 'no snapshot was written');
  });

  it('leaves apps without a readable source.json untouched', async () => {
    const env = mockEnv();
    await env.DESKTOP_KV.put(`app:${APP}`, JSON.stringify({ uid: UID, version: 1 }));

    const pointers = await ensureRevisionBaseline(env, UID, APP, { uid: UID, version: 1 });
    assert.deepEqual(pointers, {});
    assert.equal((await listAppRevisionManifests(env, UID, APP)).length, 0);
    const record = await env.DESKTOP_KV.get(`app:${APP}`);
    assert.equal(record.current_revision, undefined, 'the registry record was not modified');
  });
});
