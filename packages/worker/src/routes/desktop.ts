/**
 * Desktop state routes — thin forwards to the caller's per-user UserDesktop
 * Durable Object (the consistency boundary for items, windows, profile,
 * quota, trash, and CSS history), plus the visitor live-sync WebSocket.
 *
 * All handlers return the raw DO response; the dispatcher decorates them with
 * CORS + security headers. The two exceptions that clean up R2 objects after
 * a successful DO delete re-emit the DO's JSON result.
 *
 * The item create/patch forwards are the one place that inspects the body
 * before passing it on: the DO's internal /items endpoints are trusted by
 * server-side app flows, and the public routes must not hand that trust to
 * a client session (see rejectInvalidItemBody — it refuses server-managed
 * app fields, create bodies that aren't JSON objects, and patch bodies
 * that aren't JSON arrays, answering malformed input with a 400 instead of
 * letting the DO's verbatim request.json() turn it into a 500 — or, for a
 * non-object create body, into a silently created default "Untitled"
 * folder).
 */

import type { Env } from '../index';
import { RATE_LIMIT_WS, checkRateLimit, rateLimitResponse } from '../middleware/rateLimit';
import type { RouteContext, RouteHandlerResult } from './router';
import { requireAuthContext, ROUTE_FALLTHROUGH } from './router';

function userDesktopStub(env: Env, uid: string) {
  return env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid));
}

/**
 * Item fields that only server-side app flows may write: dev-deploy and the
 * agent install (manifest + grants on create), the app permissions route
 * (grants, grant date, approval metadata), and release rollback. All of
 * those call the UserDesktop DO's internal /items endpoints directly. The
 * DO's update allowlist keeps accepting these fields for those callers —
 * but the public routes forward bodies verbatim to the same endpoints, so
 * without a gate here any owner session could rewrite an installed app's
 * manifest (declaring scopes the app never shipped, then granting them
 * through the honest permissions route), forge granted permissions, or
 * fabricate approval dates — skipping the never-grant-more-than-declared
 * rule, the broad-scope approval tick, and the approval audit trail.
 */
const SERVER_MANAGED_ITEM_FIELDS = [
  'appManifest',
  'grantedPermissions',
  'permissionGrantedAt',
  'grantedPermissionApprovals',
] as const;

/**
 * Which server-managed fields a client item payload tries to set. A create
 * body is one item object; a patch body is an array of { id, updates } and
 * only `updates` is ever applied by the DO. Anything the DO would not apply
 * (fields at a patch entry's top level) is ignored here too.
 */
function serverManagedItemFieldsIn(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    const names = payload.flatMap((entry) => serverManagedItemFieldsIn(
      typeof entry === 'object' && entry !== null ? (entry as { updates?: unknown }).updates : null,
    ));
    return [...new Set(names)];
  }
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    return SERVER_MANAGED_ITEM_FIELDS.filter((field) => field in record);
  }
  return [];
}

/**
 * Reject (400) a public item create/patch body the DO must never see:
 *
 *  - non-JSON bodies — the DO's /items endpoints parse the body verbatim
 *    (request.json()) and would turn a malformed one into a 500, but
 *    client-supplied bad input is a client error;
 *  - a create body that isn't a JSON object — the DO spreads the parsed
 *    body into its item defaults, so `42`, `"x"`, `[]`, or `null` would
 *    silently create a default "Untitled" folder;
 *  - a patch body that isn't a JSON array — the DO applies patches by
 *    iterating the parsed value, and a non-iterable one is another 500;
 *  - any body setting the server-managed app fields, naming them (a create
 *    body is one item object; a patch body is an array of { id, updates }
 *    and only `updates` is ever applied by the DO — anything the DO would
 *    not apply is ignored here too).
 *
 * Returns null when the body is clean and the request should be forwarded
 * unchanged.
 */
function rejectInvalidItemBody(body: string, patch: boolean): Response | null {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }
  if (patch && !Array.isArray(payload)) {
    return Response.json(
      { error: 'Patch body must be a JSON array of { id, updates } entries' },
      { status: 400 },
    );
  }
  if (!patch && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    return Response.json({ error: 'Item body must be a JSON object' }, { status: 400 });
  }
  const fields = serverManagedItemFieldsIn(payload);
  if (fields.length === 0) return null;
  return Response.json(
    {
      error: `Item writes may not set ${fields.join(', ')}; app manifests and grants are managed by the app install and permissions routes`,
    },
    { status: 400 },
  );
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
  // App items are created by the install paths (which call the DO directly),
  // never by a client — a manifest or grants on a create body is a forgery.
  // Non-JSON bodies are refused here (the DO's request.json() would 500),
  // and so is valid JSON that isn't an object — the DO would spread `42`,
  // `[]`, or `"x"` into its defaults and silently create an "Untitled"
  // folder.
  const rejection = rejectInvalidItemBody(body, false);
  if (rejection) return rejection;
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/items', {
    method: 'POST',
    body,
  }));
}

/** PATCH /api/desktop/items — apply item updates. */
export async function handleUpdateDesktopItems(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const body = await c.request.text();
  // Ordinary item edits (name, position, isPublic, trash, ...) forward as
  // before; non-JSON bodies, non-array patch bodies, and the server-managed
  // app fields are all refused with 400s before the DO sees them. The DO
  // validates each entry (shape, id, field validators) and applies the batch
  // all-or-nothing, so a bad entry answers a 400 naming its index and
  // nothing is applied.
  const rejection = rejectInvalidItemBody(body, true);
  if (rejection) return rejection;
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
  // Forward the API's own origin so the DO's appearance URL validation can
  // accept same-origin absolute URLs (CursorEditor stores those). The DO
  // never sees the real request. See isFirstPartyAssetUrl in utils/sanitize.ts.
  return userDesktopStub(c.env, auth.uid).fetch(new Request('http://internal/profile', {
    method: 'PATCH',
    headers: { 'X-API-Origin': new URL(c.request.url).origin },
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

  // X-API-Origin: the revert re-validates the stored CSS through
  // updateProfile, which needs the API origin to keep accepting legitimate
  // same-origin absolute asset URLs.
  return userDesktopStub(c.env, auth.uid)
    .fetch(new Request(`http://internal/css-history/${versionId}/revert`, {
      method: 'POST',
      headers: { 'X-API-Origin': new URL(c.request.url).origin },
    }));
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
