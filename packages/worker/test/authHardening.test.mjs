/**
 * Auth hardening unit tests (no wrangler): credential checks when the user
 * record is gone, one-time chat WebSocket tokens, Turnstile in production,
 * and the per-uid token index the account purge uses.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { authenticate, authenticateAgentChatWebSocket } = await import('../src/middleware/auth.ts');
const { signJWT, signChatWebSocketToken } = await import('../src/utils/jwt.ts');
const { verifyTurnstile } = await import('../src/utils/turnstile.ts');
const { recordAuthTokens, authTokenIndexPrefix } = await import('../src/utils/accountPurge.ts');

const SECRET = 'unit-test-secret';

function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async list({ prefix }) {
      return { keys: [...map.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// AuthCoordinator stand-in (claim-lock succeeds once per name).
function fakeCoordinator() {
  const claimed = new Set();
  return {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch() {
        const ok = !claimed.has(name);
        claimed.add(name);
        return Response.json({ claimed: ok });
      },
    }),
  };
}

async function makeAccount(env, overrides = {}) {
  const uid = crypto.randomUUID();
  const email = `${uid}@example.com`;
  await env.AUTH_KV.put(`uid:${uid}`, JSON.stringify({ email }));
  await env.AUTH_KV.put(`user:${email}`, JSON.stringify({ uid, email, username: 'tester', ...overrides }));
  const token = await signJWT({ uid, username: 'tester' }, SECRET, 900);
  await env.AUTH_KV.put(`session:${token}`, JSON.stringify({ uid, issuedAt: Date.now(), expiresAt: Date.now() + 900_000 }));
  return { uid, email, token };
}

function makeEnv() {
  return { JWT_SECRET: SECRET, AUTH_KV: fakeKV(), AUTH_COORDINATOR: fakeCoordinator() };
}

const bearer = (token) => new Request('http://x/api/desktop', { headers: { Authorization: `Bearer ${token}` } });

describe('session auth requires a live user record', () => {
  it('accepts a session while the account exists', async () => {
    const env = makeEnv();
    const { token, uid } = await makeAccount(env);
    const auth = await authenticate(bearer(token), env);
    assert.equal(auth?.uid, uid);
  });

  it('rejects (and deletes) a session once the user record is gone', async () => {
    const env = makeEnv();
    const { token, email } = await makeAccount(env);
    await env.AUTH_KV.delete(`user:${email}`);
    assert.equal(await authenticate(bearer(token), env), null);
    assert.equal(env.AUTH_KV.map.has(`session:${token}`), false);
  });

  it('rejects a session once the uid index is gone', async () => {
    const env = makeEnv();
    const { token, uid } = await makeAccount(env);
    await env.AUTH_KV.delete(`uid:${uid}`);
    assert.equal(await authenticate(bearer(token), env), null);
  });
});

describe('chat WebSocket token', () => {
  const wsRequest = (token) => new Request(`http://x/api/agent/chat?wsToken=${encodeURIComponent(token)}`, {
    headers: { Upgrade: 'websocket' },
  });

  it('is accepted once and rejected on replay', async () => {
    const env = makeEnv();
    const { uid } = await makeAccount(env);
    const wsToken = await signChatWebSocketToken(uid, SECRET);
    const first = await authenticateAgentChatWebSocket(wsRequest(wsToken), env);
    assert.equal(first?.uid, uid);
    assert.equal(first?.username, 'tester');
    assert.equal(await authenticateAgentChatWebSocket(wsRequest(wsToken), env), null);
  });

  it('is rejected for a missing, soft-deleted, or password-changed account', async () => {
    const env = makeEnv();
    const gone = await makeAccount(env);
    await env.AUTH_KV.delete(`user:${gone.email}`);
    assert.equal(await authenticateAgentChatWebSocket(wsRequest(await signChatWebSocketToken(gone.uid, SECRET)), env), null);

    const deleted = await makeAccount(env, { deletedAt: Date.now() });
    assert.equal(await authenticateAgentChatWebSocket(wsRequest(await signChatWebSocketToken(deleted.uid, SECRET)), env), null);

    const changed = await makeAccount(env, { passwordChangedAt: Date.now() + 5_000 });
    assert.equal(await authenticateAgentChatWebSocket(wsRequest(await signChatWebSocketToken(changed.uid, SECRET)), env), null);
  });
});

describe('Turnstile without a secret', () => {
  const req = new Request('http://x/api/auth/signup', { method: 'POST' });
  it('passes only in development', async () => {
    assert.equal(await verifyTurnstile(req, { ENVIRONMENT: 'development' }), true);
    assert.equal(await verifyTurnstile(req, { ENVIRONMENT: 'production' }), false);
    assert.equal(await verifyTurnstile(req, {}), false);
  });
});

describe('auth token index', () => {
  it('indexes session and refresh keys under the uid', async () => {
    const env = makeEnv();
    await recordAuthTokens(env, 'u1', 'acc', 900, 'ref', 3600);
    const prefix = authTokenIndexPrefix('u1');
    assert.deepEqual([...env.AUTH_KV.map.keys()].sort(), [`${prefix}refresh:ref`, `${prefix}session:acc`]);
  });
});
