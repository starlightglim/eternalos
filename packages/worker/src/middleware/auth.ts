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

    // Check if password was changed after session was issued
    // This invalidates sessions when password changes
    const userJson = await getUserByUid(env, payload.uid);

    if (userJson) {
      const user = JSON.parse(userJson) as UserRecord;
      if (user.passwordChangedAt && session.issuedAt && session.issuedAt < user.passwordChangedAt) {
        // Session was issued before password change - invalidate it
        await env.AUTH_KV.delete(`session:${token}`);
        return null;
      }
      // SECURITY: Reject sessions for soft-deleted accounts. This is defense
      // in depth — the login/OAuth/recovery-code paths all check `deletedAt`
      // before minting a token, but if any future code path forgets (as the
      // original Google callback did), every `requireAuth` route still holds.
      if (user.deletedAt) {
        await env.AUTH_KV.delete(`session:${token}`);
        return null;
      }
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

  return {
    uid: payload.uid,
    username: '',
    kind: 'session',
  };
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
