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
import { verifyJWT, signFileToken, verifyFileToken } from '../utils/jwt';

export interface AuthContext {
  uid: string;
  username: string;
}

/**
 * Verify Authorization header and return auth context
 * Returns null if auth fails
 */
export async function authenticate(
  request: Request,
  env: Env
): Promise<AuthContext | null> {
  const authHeader = request.headers.get('Authorization');

  // Check for short-lived file token in query param (for img/video/audio src URLs).
  // File tokens are NOT full JWTs — they only carry uid + expiry and don't need a
  // KV session lookup, keeping media requests fast and avoiding credential leakage.
  const url = new URL(request.url);
  const fileToken = url.searchParams.get('ft');
  if (fileToken) {
    return authenticateFileToken(fileToken, env);
  }

  // Standard Bearer JWT flow
  let token: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice('Bearer '.length);
  }

  if (!token) {
    return null;
  }

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
    }

    return {
      uid: payload.uid,
      username: payload.username,
    };
  } catch {
    return null;
  }
}

/**
 * Verify a short-lived file token (used for media src URLs).
 * Returns a minimal AuthContext with uid only (username set to empty string
 * since file-serving only needs the uid for ownership checks).
 */
async function authenticateFileToken(
  token: string,
  env: Env
): Promise<AuthContext | null> {
  const result = await verifyFileToken(token, env.JWT_SECRET);
  if (!result) return null;
  return { uid: result.uid, username: '' };
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
 * Middleware that requires authentication
 * Returns 401 if not authenticated
 */
export async function requireAuth(
  request: Request,
  env: Env
): Promise<Response | AuthContext> {
  const auth = await authenticate(request, env);
  if (!auth) {
    return Response.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }
  return auth;
}
