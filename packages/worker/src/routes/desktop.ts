/**
 * Desktop state routes — thin forwards to the caller's per-user UserDesktop
 * Durable Object (the consistency boundary for items, windows, profile,
 * quota, trash, and CSS history), plus the visitor live-sync WebSocket.
 *
 * All handlers return the raw DO response; the dispatcher decorates them with
 * CORS + security headers. The two exceptions that clean up R2 objects after
 * a successful DO delete re-emit the DO's JSON result.
 */

import type { Env } from '../index';
import { RATE_LIMIT_WS, checkRateLimit, rateLimitResponse } from '../middleware/rateLimit';
import type { RouteContext, RouteHandlerResult } from './router';
import { requireAuthContext, ROUTE_FALLTHROUGH } from './router';

function userDesktopStub(env: Env, uid: string) {
  return env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid));
}

/** GET /api/desktop — load all desktop items. */
export async function handleGetDesktop(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/items'));
}

/** POST /api/desktop/items — create an item. */
export async function handleCreateDesktopItems(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const body = await c.request.text();
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/items', {
    method: 'POST',
    body,
  }));
}

/** PATCH /api/desktop/items — apply item updates. */
export async function handleUpdateDesktopItems(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const body = await c.request.text();
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/items', {
    method: 'PATCH',
    body,
  }));
}

/** DELETE /api/desktop/items/:id — delete an item and clean up its R2 files. */
export async function handleDeleteDesktopItem(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const itemId = c.params[0];
  const doResponse = await userDesktopStub(c.env, auth.uid)
    .fetch(new Request(`http://internal/items/${itemId}`, { method: 'DELETE' }));

  // Clean up R2 files (including cascaded children)
  const result = await doResponse.json() as { deleted: boolean; r2Key?: string; r2Keys?: string[] };
  const keysToDelete = result.r2Keys || (result.r2Key ? [result.r2Key] : []);
  if (keysToDelete.length > 0) {
    await Promise.all(keysToDelete.map((key) => c.env.ETERNALOS_FILES.delete(key)));
  }

  return Response.json(result);
}

/** PUT /api/desktop/windows — persist window state. */
export async function handlePutWindows(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const body = await c.request.text();
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/windows', {
    method: 'PUT',
    body,
  }));
}

/** GET /api/profile */
export async function handleGetProfile(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/profile'));
}

/** PATCH /api/profile */
export async function handlePatchProfile(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const body = await c.request.text();
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/profile', {
    method: 'PATCH',
    body,
  }));
}

/** GET /api/css-history — list saved custom CSS versions. */
export async function handleGetCssHistory(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/css-history'));
}

/** POST /api/css-history/:versionId/revert — restore a saved CSS version. */
export async function handleRevertCssHistory(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const versionId = c.params[0];
  if (!versionId) {
    return Response.json({ error: 'Version ID required' }, { status: 400 });
  }

  return userDesktopStub(c.env, auth.uid)
    .fetch(new Request(`http://internal/css-history/${versionId}/revert`, { method: 'POST' }));
}

/** GET /api/quota — storage quota usage. */
export async function handleGetQuota(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/quota'));
}

/** GET /api/trash — list trashed items. */
export async function handleListTrash(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/trash'));
}

/** POST /api/trash/restore/:id — restore an item from trash. */
export async function handleRestoreTrashItem(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const itemId = c.params[0];
  return userDesktopStub(c.env, auth.uid)
    .fetch(new Request(`http://internal/trash/restore/${itemId}`, { method: 'POST' }));
}

/** DELETE /api/trash — empty trash and clean up R2 files. */
export async function handleEmptyTrash(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const doResponse = await userDesktopStub(c.env, auth.uid)
    .fetch(new Request('http://internal/trash', { method: 'DELETE' }));

  // Clean up R2 files for deleted items
  const result = await doResponse.json() as { deleted: number; r2Keys: string[] };
  if (result.r2Keys.length > 0) {
    await Promise.all(result.r2Keys.map((key) => c.env.ETERNALOS_FILES.delete(key)));
  }

  return Response.json(result);
}

/**
 * /api/ws/:username — visitor live-sync WebSocket, forwarded to the desktop
 * owner's UserDesktop DO. Decorates itself (raw responses, matching the
 * legacy route: its 429/400/404 and the DO response were never CORS-wrapped)
 * and enforces its own connection-rate bucket.
 *
 * Non-upgrade requests fall through to the unmatched-path policy (the legacy
 * route's Upgrade requirement let them drop into the general rate-limited
 * 404).
 */
export async function handleVisitorWebSocket(c: RouteContext): Promise<RouteHandlerResult> {
  if (c.request.headers.get('Upgrade') !== 'websocket') {
    return ROUTE_FALLTHROUGH;
  }

  const wsUsername = c.params[0].toLowerCase();
  if (!wsUsername) {
    return new Response('Username required', { status: 400 });
  }

  // Rate limit WS connection attempts per IP. Each connection keeps a DO
  // warm, so rapid reconnection must be capped to prevent cost inflation.
  const wsRateLimit = await checkRateLimit(c.request, c.env, RATE_LIMIT_WS);
  if (!wsRateLimit.allowed) {
    return rateLimitResponse(wsRateLimit);
  }

  // Look up uid by username (stored as JSON { uid })
  const usernameData = await c.env.AUTH_KV.get<{ uid: string }>(`username:${wsUsername}`, 'json');
  if (!usernameData) {
    return new Response('User not found', { status: 404 });
  }

  // Forward WebSocket upgrade to the owner's Durable Object
  const stub = c.env.USER_DESKTOP.get(c.env.USER_DESKTOP.idFromName(usernameData.uid));
  return stub.fetch(new Request('http://internal/ws', {
    headers: c.request.headers,
  }));
}
