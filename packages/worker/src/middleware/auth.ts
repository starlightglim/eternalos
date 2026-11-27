/**
 * Auth Middleware
 *
 * Extracts and verifies JWT from Authorization header.
 * Attaches uid to request context for downstream handlers.
 *
 * Implementation in Phase 4
 */

import type { Env } from '../index';
import type { JWTPayload, SessionRecord, UserRecord } from '../types';
import { verifyJWT, signFileToken, verifyFileToken, verifyChatWebSocketToken } from '../utils/jwt';

export interface AuthContext {
  uid: string;
  username: string;
  /**
   * Discriminates the credential that produced this context:
   * - 'session': Bearer JWT with a matching KV session record (full privilege).
   * - 'file':    `?ft=` short-lived file token. Only valid for file-serving
   *              routes. `requireAuth()` must reject these by default, since
   *              file-token URLs leak via Referer, server logs, browser
   *              history, image-proxy unfurlers, etc.
   */
  kind: 'session' | 'file';
}

/**
 * Verify Authorization header and return auth context for a full-session
 * credential. `?ft=` file tokens are intentionally NOT accepted here — they
 * are limited to file-serving routes via `authenticateFileRequest()` to
 * prevent a leaked media URL from authorizing account-scope mutations.
 *
 * Returns null if auth fails.
 */
export async function authenticate(
  request: Request,
  env: Env
): Promise<AuthContext | null> {
  const token = extractBearerToken(request);
  if (!token) {
    return null;
  }

  return authenticateSessionToken(token, env);
}

function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }
  return null;
}

async function authenticateSessionToken(token: string, env: Env): Promise<AuthContext | null> {
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (!payload) {
      return null;
    }

    // Verify session exists in KV
    const sessionJson = await env.AUTH_KV.get(`session:${token}`);
    if (!sessionJson) {
      return null;
    }

    const session = JSON.parse(sessionJson) as SessionRecord;

    // Check if session is expired
    if (Date.now() > session.expiresAt) {
      // Clean up expired session
      await env.AUTH_KV.delete(`session:${token}`);
      return null;
    }

    // SECURITY: the account must still exist and be active. A missing uid
    // index or user record (e.g. after a hard-delete purge) means 401 — a
    // leftover session must never outlive its account.
    const user = await loadActiveUser(env, payload.uid, session.issuedAt);
    if (!user) {
      await env.AUTH_KV.delete(`session:${token}`);
      return null;
    }

    return {
      uid: payload.uid,
      username: payload.username,
      kind: 'session',
    };
  } catch {
    return null;
  }
}

export async function authenticateAgentChatWebSocket(
  request: Request,
  env: Env
): Promise<AuthContext | null> {
  const bearer = extractBearerToken(request);
  if (bearer) {
    const session = await authenticateSessionToken(bearer, env);
    if (session) return session;
  }

  const url = new URL(request.url);
  const wsToken = url.searchParams.get('wsToken');
  if (!wsToken) return null;

  const payload = await verifyChatWebSocketToken(wsToken, env.JWT_SECRET);
  if (!payload) return null;

  // The token carries no session, so apply the same account checks a session
  // gets: the account must exist, not be soft-deleted, and the token must not
  // predate a password change (iat is in seconds; round the change down so a
  // token minted in the same second as the change is still rejected).
  let user: UserRecord | null;
  try {
    user = await loadActiveUser(env, payload.uid, payload.iat * 1000, { iatSeconds: true });
  } catch {
    return null;
  }
  if (!user) return null;

  // One-time use: record the jti on first use. A replayed token URL (logs,
  // history, a proxy) is rejected even inside its 60s lifetime. The marker
  // expires shortly after the token itself (KV's minimum TTL is 60s), after
  // which the signature check rejects the token anyway. KV, not a DO, so the
  // markers clean themselves up; the cost is a small window in which two
  // truly simultaneous upgrades with one token could both pass.
  if (!payload.jti || !(await claimChatWebSocketJti(env, payload.jti, payload.exp))) {
    return null;
  }

  return {
    uid: payload.uid,
    username: user.username,
    kind: 'session',
  };
}

const CHAT_WS_JTI_SLACK_SECONDS = 60;

async function claimChatWebSocketJti(env: Env, jti: string, expSeconds: number): Promise<boolean> {
  try {
    const key = `chat-ws-jti:${jti}`;
    if (await env.AUTH_KV.get(key)) return false;
    const remaining = Math.max(0, expSeconds - Math.floor(Date.now() / 1000));
    await env.AUTH_KV.put(key, '1', {
      expirationTtl: Math.max(60, remaining + CHAT_WS_JTI_SLACK_SECONDS),
    });
    return true;
  } catch {
    // Fail closed: if the use can't be recorded, the token isn't accepted.
    return false;
  }
}

/**
 * Authenticate a request to a file-serving route. Accepts either a Bearer
 * JWT (session) or a `?ft=` file token. MUST NOT be used for mutating or
 * account-scope endpoints — `?ft=` is considered a read-only file credential
 * and the returned context is tagged with `kind: 'file'` so downstream code
 * can enforce that boundary.
 */
export async function authenticateFileRequest(
  request: Request,
  env: Env
): Promise<AuthContext | null> {
  // Prefer a full session if the caller provided one.
  const session = await authenticate(request, env);
  if (session) return session;

  const url = new URL(request.url);
  const fileToken = url.searchParams.get('ft');
  if (!fileToken) return null;

  const result = await verifyFileToken(fileToken, env.JWT_SECRET);
  if (!result) return null;
  return { uid: result.uid, username: '', kind: 'file' };
}

/**
 * Issue a short-lived file token for the given auth context.
 * Called by the /api/file-token endpoint.
 */
export async function issueFileToken(
  env: Env,
  uid: string
): Promise<string> {
  return signFileToken(uid, env.JWT_SECRET);
}

/**
 * Helper to find user by UID using the uid->email index
 */
async function getUserByUid(env: Env, uid: string): Promise<string | null> {
  // Look up UID -> email index
  const indexJson = await env.AUTH_KV.get(`uid:${uid}`);
  if (!indexJson) {
    return null;
  }

  const { email } = JSON.parse(indexJson) as { email: string };

  // Fetch the actual user record
  return await env.AUTH_KV.get(`user:${email}`);
}

/**
 * Load the user record for a credential and check it is still usable:
 * the uid index and user record exist, the account is not soft-deleted, and
 * the credential was not issued before the last password change.
 * Returns null when any check fails.
 *
 * `issuedAtMs` is when the credential was issued. With `iatSeconds`, it came
 * from a whole-second JWT `iat`, so a change within that same second also
 * invalidates it.
 */
export async function loadActiveUser(
  env: Env,
  uid: string,
  issuedAtMs: number | undefined,
  options: { iatSeconds?: boolean } = {},
): Promise<UserRecord | null> {
  const userJson = await getUserByUid(env, uid);
  if (!userJson) return null;
  const user = JSON.parse(userJson) as UserRecord;
  if (user.uid && user.uid !== uid) return null;
  // SECURITY: Reject credentials for soft-deleted accounts. Defense in depth —
  // the login/OAuth/recovery-code paths all check `deletedAt` before minting a
  // token, but if any future code path forgets, every credential check holds.
  if (user.deletedAt) return null;
  if (user.passwordChangedAt && issuedAtMs !== undefined) {
    const changedAt = options.iatSeconds
      ? Math.floor(user.passwordChangedAt / 1000) * 1000
      : user.passwordChangedAt;
    if (options.iatSeconds ? issuedAtMs <= changedAt : issuedAtMs < changedAt) return null;
  }
  return user;
}

/**
 * Middleware that requires a full-session credential. Returns 401 if not
 * authenticated. File tokens (`?ft=`) are NOT accepted — those credentials
 * are scoped to file-serving routes only.
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<Response | AuthContext> {
  const auth = await authenticate(request, env);
  if (!auth || auth.kind !== 'session') {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }
  return auth;
}

// ---------------------------------------------------------------------------
// Route-table auth policy
// ---------------------------------------------------------------------------

/**
 * Auth enforcement vocabulary for the route table (routes/routeTable.ts). The
 * dispatcher resolves the credential for a request BEFORE the route handler
 * runs, according to the route's policy.auth mode.
 */
export type AuthMode =
  | 'none' // public route; no credential resolved
  | 'required' // full-session Bearer credential; 401 without one
  | 'agent-chat' // dual credential: Bearer (HTTP) or one-time wsToken
  // (WebSocket upgrade); upgrades must additionally come from an allowed origin
  | 'file' // Bearer session or short-lived `?ft=` file token; null when absent
  // (public file reads are allowed) — this mode never rejects a request
  | 'handler-scoped'; // capability token / none — the handler enforces access
// itself (game console, app serving, previews, visitor WS)

/**
 * Resolve the credential for a route request according to its auth mode.
 * Returns an AuthContext on success, a Response (401/403) when the mode
 * rejects the request, or null when the mode resolves no credential
 * ('none' / 'handler-scoped') or the credential is legitimately absent
 * ('file' — public reads).
 */
export async function resolveRouteAuth(
  mode: AuthMode,
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<AuthContext | Response | null> {
  switch (mode) {
    case 'none':
    case 'handler-scoped':
      return null;
    case 'required':
      return requireAuth(request, env);
    case 'file':
      return authenticateFileRequest(request, env);
    case 'agent-chat': {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return requireAuth(request, env);
      }

      // WebSocket upgrades carry an Origin browsers set automatically; an
      // upgrade from a disallowed origin is rejected before credentials are
      // examined (mirrors the legacy agent-chat route order).
      const origin = request.headers.get('Origin');
      if (origin && !corsHeaders['Access-Control-Allow-Origin']) {
        return Response.json({ error: 'CORS origin not allowed' }, { status: 403 });
      }

      const auth = await authenticateAgentChatWebSocket(request, env);
      return auth ?? Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
}
