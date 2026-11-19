/**
 * Unit tests for src/utils/appScopes.ts — the broad-scope classification and
 * grant-approval metadata rules behind Workstream 3 Phase B
 * (design/CORE-ROADMAP.md).
 *
 * Runs under plain `node --test` (Node strips the .ts types on import).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APP_SCOPE_IDS,
  broadScopeIds,
  buildGrantApprovals,
  isBroadFsPath,
  isBroadNetworkDomain,
  isBroadScope,
  listAppScopes,
  pruneGrantApprovals,
  resolveGrantApprovals,
  sanitizeBroadApprovals,
} from '../src/utils/appScopes.ts';

const ALL_PROFILE = ['username', 'displayName', 'bio', 'avatar'];

describe('broad fs paths', () => {
  for (const pattern of ['**', '/**', '**/*', '/']) {
    it(`treats ${JSON.stringify(pattern)} as broad`, () => {
      assert.equal(isBroadFsPath(pattern), true);
    });
  }
  for (const pattern of ['/Photos/**', '*.jpg', '/Notes/*.md', '/Notes/todo.txt', '/*']) {
    it(`treats ${JSON.stringify(pattern)} as narrow`, () => {
      assert.equal(isBroadFsPath(pattern), false);
    });
  }
});

describe('broad network domains', () => {
  for (const pattern of ['*', '*.example.com', '*.org', 'api.*.com']) {
    it(`treats ${JSON.stringify(pattern)} as broad`, () => {
      assert.equal(isBroadNetworkDomain(pattern), true);
    });
  }
  for (const pattern of ['api.example.com', 'example.com']) {
    it(`treats ${JSON.stringify(pattern)} as narrow`, () => {
      assert.equal(isBroadNetworkDomain(pattern), false);
    });
  }
});

describe('isBroadScope', () => {
  it('marks fs read/write/delete broad only on all-files globs', () => {
    assert.equal(isBroadScope('fs.read', ['/**']), true);
    assert.equal(isBroadScope('fs.write', ['/']), true);
    assert.equal(isBroadScope('fs.delete', ['**']), true);
    assert.equal(isBroadScope('fs.read', ['/Photos/**', '/Notes/**']), false);
    // A mixed scope containing any all-files glob is broad.
    assert.equal(isBroadScope('fs.read', ['/Photos/**', '/**']), true);
  });

  it('marks network.outbound broad only on wildcard domains', () => {
    assert.equal(isBroadScope('network.outbound', ['*']), true);
    assert.equal(isBroadScope('network.outbound', ['*.example.com', 'api.example.com']), true);
    assert.equal(isBroadScope('network.outbound', ['api.example.com']), false);
  });

  it('marks profile.read broad only when every profile field is granted', () => {
    assert.equal(isBroadScope('profile.read', ALL_PROFILE), true);
    assert.equal(isBroadScope('profile.read', ['username', 'displayName', 'bio']), false);
    assert.equal(isBroadScope('profile.read', ['username']), false);
  });

  it('never marks any other scope broad', () => {
    assert.equal(isBroadScope('fs.mimeTypes', ['image/*']), false);
    assert.equal(isBroadScope('ipc.listen', ['*']), false);
    assert.equal(isBroadScope('handlers.mimeTypes', ['*/*']), false);
    assert.equal(isBroadScope('virtualFolders.mountAt', ['/**']), false);
    assert.equal(isBroadScope('ai.modes', ['ask', 'search', 'enrich']), false);
  });
});

describe('listAppScopes / broadScopeIds on arbitrary input', () => {
  it('enumerates only known scopes with non-empty string arrays', () => {
    const scopes = listAppScopes({
      fs: { read: ['/**'], write: [], bogus: ['x'] },
      network: { outbound: ['*.example.com'] },
      profile: { read: ALL_PROFILE },
      handlers: { mimeTypes: 'text/markdown' }, // not an array: skipped
      evil: { read: ['/**'] }, // unknown domain: skipped
    });
    assert.deepEqual(scopes.map((scope) => scope.id), ['fs.read', 'network.outbound', 'profile.read']);
  });

  it('tolerates non-object input', () => {
    assert.deepEqual(listAppScopes(undefined), []);
    assert.deepEqual(listAppScopes(null), []);
    assert.deepEqual(listAppScopes('fs.read'), []);
    assert.deepEqual(broadScopeIds(42), []);
  });

  it('broadScopeIds flags exactly the broad scopes of a grant request', () => {
    assert.deepEqual(broadScopeIds({
      fs: { read: ['/**'], write: ['/Notes/**'] },
      network: { outbound: ['api.example.com'] },
      profile: { read: ['username', 'displayName'] },
      ipc: { emit: ['music.now_playing'] },
    }), ['fs.read']);
  });

  it('covers every canonical scope id', () => {
    // Every id in APP_SCOPE_IDS must be listable and none may throw. Feed
    // each one all-files/wildcard values and check that exactly the fs
    // read/write/delete paths and wildcard network domains classify broad —
    // every other scope (mimeTypes, ipc, handlers, virtualFolders, ai, and
    // a profile grant that is not all fields) never does.
    const permissions = {};
    for (const id of APP_SCOPE_IDS) {
      const [domain, scope] = id.split('.');
      permissions[domain] ||= {};
      permissions[domain][scope] = ['/**', '*'];
    }
    const listed = listAppScopes(permissions).map((scope) => scope.id);
    assert.deepEqual(listed, [...APP_SCOPE_IDS]);
    assert.deepEqual(broadScopeIds(permissions), ['fs.read', 'fs.write', 'fs.delete', 'network.outbound']);
  });
});

describe('sanitizeBroadApprovals (client input)', () => {
  it('keeps known scope ids, drops everything else', () => {
    const approved = sanitizeBroadApprovals(['fs.read', 'network.outbound', 'not-a-scope', 42, null]);
    assert.deepEqual([...approved], ['fs.read', 'network.outbound']);
  });

  it('tolerates non-array input', () => {
    assert.equal(sanitizeBroadApprovals(undefined).size, 0);
    assert.equal(sanitizeBroadApprovals('fs.read').size, 0);
    assert.equal(sanitizeBroadApprovals({ fs: 'read' }).size, 0);
  });
});

describe('buildGrantApprovals', () => {
  it('records approvedAt, approvedBy, and the rationale at approval time', () => {
    const approvals = buildGrantApprovals(
      { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } },
      'uid-7',
      'Indexes your files for search.',
      1731993600000,
    );
    assert.deepEqual(approvals, {
      'fs.read': { approvedAt: 1731993600000, approvedBy: 'uid-7', rationale: 'Indexes your files for search.' },
      'network.outbound': { approvedAt: 1731993600000, approvedBy: 'uid-7', rationale: 'Indexes your files for search.' },
    });
  });

  it('omits the rationale when the manifest has none (or a non-string)', () => {
    assert.deepEqual(
      buildGrantApprovals({ fs: { read: ['/**'] } }, 'uid-7', undefined, 1),
      { 'fs.read': { approvedAt: 1, approvedBy: 'uid-7' } },
    );
    assert.deepEqual(
      buildGrantApprovals({ fs: { read: ['/**'] } }, 'uid-7', { evil: 'object' }, 1),
      { 'fs.read': { approvedAt: 1, approvedBy: 'uid-7' } },
    );
  });

  it('caps the rationale snapshot at 500 characters', () => {
    const approvals = buildGrantApprovals({ fs: { read: ['/**'] } }, 'uid-7', 'x'.repeat(900), 1);
    assert.equal(approvals['fs.read'].rationale.length, 500);
  });

  it('scopes every granted entry, not just broad ones', () => {
    const approvals = buildGrantApprovals({ ipc: { listen: ['clock.tick'] } }, 'u', undefined, 5);
    assert.deepEqual(approvals, { 'ipc.listen': { approvedAt: 5, approvedBy: 'u' } });
  });
});

describe('pruneGrantApprovals', () => {
  it('drops entries whose scope lost its grant, keeps the rest verbatim', () => {
    const approvals = {
      'fs.read': { approvedAt: 10, approvedBy: 'u', rationale: 'old reason' },
      'network.outbound': { approvedAt: 20, approvedBy: 'u' },
    };
    assert.deepEqual(pruneGrantApprovals(approvals, { fs: { read: ['/**'] } }), {
      'fs.read': { approvedAt: 10, approvedBy: 'u', rationale: 'old reason' },
    });
    assert.deepEqual(pruneGrantApprovals(approvals, {}), {});
    assert.deepEqual(pruneGrantApprovals(undefined, { fs: { read: ['/**'] } }), {});
  });
});

describe('resolveGrantApprovals — lazy migration of legacy installs', () => {
  it('treats granted scopes with no stored record as approved with approvedAt unknown', () => {
    // The pre-Phase-B install shape: grants persisted, no approval metadata.
    const resolved = resolveGrantApprovals(
      { fs: { read: ['/**'] }, network: { outbound: ['api.example.com'] } },
      undefined,
    );
    assert.deepEqual(resolved, {
      'fs.read': {},
      'network.outbound': {},
    });
  });

  it('returns stored records for scopes that have them, synthesized ones for the rest', () => {
    const resolved = resolveGrantApprovals(
      { fs: { read: ['/**'] }, profile: { read: ['username'] } },
      { 'fs.read': { approvedAt: 99, approvedBy: 'uid-3', rationale: 'because' } },
    );
    assert.deepEqual(resolved, {
      'fs.read': { approvedAt: 99, approvedBy: 'uid-3', rationale: 'because' },
      'profile.read': {}, // legacy: approved, date unknown
    });
  });

  it('returns {} for an empty granted set', () => {
    assert.deepEqual(resolveGrantApprovals({}, { 'fs.read': { approvedAt: 1 } }), {});
    assert.deepEqual(resolveGrantApprovals(undefined, undefined), {});
  });
});
