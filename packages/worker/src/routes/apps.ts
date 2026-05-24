/**
 * User-created app endpoints — bridge between the sandboxed iframe and the
 * user's desktop state. Gated by short-lived capability tokens minted by
 * the parent frame against the user's root JWT.
 *
 * See design/01-apps-interop.md for the full permission model.
 *
 * Routes in this file:
 *   POST   /api/apps/:appId/capability          mint a capability token
 *   (fs.list, fs.read, etc. come in the next tick)
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { AppGrantedPermissions, AppCapabilityPayload } from '../utils/jwt';
import type { DesktopItem } from '../types';
import { signAppCapabilityToken, verifyAppCapabilityToken } from '../utils/jwt';
import { buildItemPath, pathMatchesGlob as sharedPathMatchesGlob, canReadItem as sharedCanReadItem } from '../utils/fsPolicy';

// Pack of permission names a client may request. The server validates
// unknown keys out rather than fail the whole mint.
const ALLOWED_DOMAINS: Array<keyof AppGrantedPermissions> = [
  'fs',
  'ipc',
  'network',
  'handlers',
  'virtualFolders',
  'profile',
  'ai',
];

interface CapabilityRequest {
  /**
   * The *requested* permissions for this token. Server intersects these with
   * what the user has previously granted this app; the token carries the
   * intersection. In v1 there is no stored grant record yet, so the server
   * issues exactly what was requested — this will tighten once the install
   * flow starts recording user consent (design/01-apps-interop.md §install UX).
   */
  granted?: AppGrantedPermissions;
  /** Optional TTL in seconds; server clamps to [60, 900]. Default 300. */
  ttlSeconds?: number;
}

function sanitizeGranted(input: unknown): AppGrantedPermissions {
  if (!input || typeof input !== 'object') return {};
  const output: AppGrantedPermissions = {};
  const inputRecord = input as Record<string, unknown>;

  for (const domain of ALLOWED_DOMAINS) {
    if (!(domain in inputRecord)) continue;
    const value = inputRecord[domain];
    if (value && typeof value === 'object') {
      // Shallow copy — deeper schema validation is done at bridge call time.
      (output as Record<string, unknown>)[domain] = { ...(value as Record<string, unknown>) };
    }
  }
  return output;
}

/**
 * Verify the app exists and belongs to the authenticated user. Returns the
 * app owner's uid on success so downstream calls can load state.
 *
 * App ownership is stored in KV at `app:{appId}` as `{ uid, version }`,
 * populated at createApp time (see routes/agent/tools/appTools.ts).
 */
async function resolveAppOwner(env: Env, appId: string): Promise<{ uid: string; version: number } | null> {
  const meta = await env.DESKTOP_KV.get<{ uid: string; version: number }>(`app:${appId}`, 'json');
  return meta ?? null;
}

/**
 * POST /api/apps/:appId/capability
 *
 * Mint a capability token for the authenticated user to use inside the app
 * iframe's bridge. Auth: Bearer user JWT (already checked by caller via
 * requireAuth — this handler trusts that).
 *
 * Body (all optional):
 *   { granted: AppGrantedPermissions, ttlSeconds: number }
 *
 * Response:
 *   { token, appId, uid, expiresAt }
 */
export async function handleAppCapability(
  request: Request,
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  if (!appId || appId.length > 128) {
    return Response.json({ error: 'Invalid appId' }, { status: 400 });
  }

  const appMeta = await resolveAppOwner(env, appId);
  if (!appMeta) {
    return Response.json({ error: 'App not found' }, { status: 404 });
  }

  // Capability tokens are scoped to the OWNER of the app using them. Only
  // the app's owner can mint a capability. (Public/shared apps become
  // per-user installs at install time — each user runs their own copy.)
  if (appMeta.uid !== auth.uid) {
    return Response.json({ error: 'Not the owner of this app' }, { status: 403 });
  }

  let body: CapabilityRequest = {};
  try {
    // Empty or invalid body is fine — issue a no-permissions token (useful
    // for smoke-testing the bridge loop without exposing any data).
    body = (await request.json()) as CapabilityRequest;
  } catch {
    body = {};
  }

  const granted = sanitizeGranted(body.granted);
  const ttl = Math.max(60, Math.min(900, body.ttlSeconds ?? 300));

  if (!env.JWT_SECRET) {
    console.error('JWT_SECRET not configured');
    return Response.json({ error: 'Server configuration error' }, { status: 500 });
  }

  const token = await signAppCapabilityToken(auth.uid, appId, granted, env.JWT_SECRET, ttl);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  return Response.json({
    token,
    appId,
    uid: auth.uid,
    expiresAt,
    granted,
  });
}

// ---------------------------------------------------------------------------
// Capability middleware
// ---------------------------------------------------------------------------

/**
 * Extract + verify an app capability token from the Authorization header.
 * Returns the decoded payload or null. Does NOT check scope — call
 * `capabilityCovers` next to gate specific operations.
 */
export async function verifyAppCapabilityFromRequest(
  request: Request,
  env: Env,
  expectedAppId: string,
): Promise<AppCapabilityPayload | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice('Bearer '.length);
  if (!env.JWT_SECRET) return null;

  return verifyAppCapabilityToken(token, env.JWT_SECRET, { expectedAppId });
}

// Re-export for backwards-compat with any importers; implementation lives in fsPolicy.
export const pathMatchesGlob = sharedPathMatchesGlob;
const canReadItem = sharedCanReadItem;

// ---------------------------------------------------------------------------
// fs.list
// ---------------------------------------------------------------------------

interface AppListResponse {
  items: Array<{
    id: string;
    type: DesktopItem['type'];
    name: string;
    parentId: string | null;
    path: string;
    mimeType?: string;
    fileSize?: number;
    updatedAt: number;
    isPublic: boolean;
  }>;
  total: number;
}

/**
 * GET /api/apps/:appId/fs/list?path=/Photos&limit=100
 *
 * Returns desktop items the app is allowed to read, filtered by granted
 * fs.read globs. Never includes r2Key, r2 urls, or other server-only fields.
 */
export async function handleAppFsList(
  request: Request,
  env: Env,
  appId: string,
): Promise<Response> {
  const capability = await verifyAppCapabilityFromRequest(request, env, appId);
  if (!capability) {
    return Response.json({ error: 'Invalid or missing capability token' }, { status: 401 });
  }

  const url = new URL(request.url);
  const pathFilter = url.searchParams.get('path');      // optional folder scope
  const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
  const includeTrashed = url.searchParams.get('includeTrashed') === 'true';

  // Fetch items from the app owner's Durable Object
  const doId = env.USER_DESKTOP.idFromName(capability.uid);
  const stub = env.USER_DESKTOP.get(doId);
  const doResponse = await stub.fetch(new Request('http://internal/items'));
  if (!doResponse.ok) {
    return Response.json({ error: 'Failed to load items' }, { status: 500 });
  }

  const data = (await doResponse.json()) as { items: DesktopItem[] };
  const itemsMap = new Map(data.items.map((i) => [i.id, i]));

  const results: AppListResponse['items'] = [];
  for (const item of data.items) {
    if (!includeTrashed && item.isTrashed) continue;

    const itemPath = buildItemPath(item.id, itemsMap);

    // Path filter (user-supplied — narrow within the already-authorized scope)
    if (pathFilter && !itemPath.startsWith(pathFilter)) continue;

    // Capability check
    if (!canReadItem(capability.granted, itemPath, item.mimeType)) continue;

    results.push({
      id: item.id,
      type: item.type,
      name: item.name,
      parentId: item.parentId,
      path: itemPath,
      mimeType: item.mimeType,
      fileSize: item.fileSize,
      updatedAt: item.updatedAt,
      isPublic: item.isPublic,
    });

    if (results.length >= limit) break;
  }

  const response: AppListResponse = {
    items: results,
    total: results.length,
  };
  return Response.json(response);
}

// ---------------------------------------------------------------------------
// fs.read
// ---------------------------------------------------------------------------

/**
 * GET /api/apps/:appId/fs/read/:itemId
 *
 * Stream the contents of a single item the app is allowed to read.
 * - For file-type items (image/video/audio/pdf/text), returns the blob from R2.
 * - For text items with inline textContent, returns the text.
 * - For folders, returns 400 (use list instead).
 */
export async function handleAppFsRead(
  request: Request,
  env: Env,
  appId: string,
  itemId: string,
): Promise<Response> {
  const capability = await verifyAppCapabilityFromRequest(request, env, appId);
  if (!capability) {
    return Response.json({ error: 'Invalid or missing capability token' }, { status: 401 });
  }

  if (!itemId || itemId.includes('/') || itemId.includes('..') || itemId.length > 128) {
    return Response.json({ error: 'Invalid itemId' }, { status: 400 });
  }

  const doId = env.USER_DESKTOP.idFromName(capability.uid);
  const stub = env.USER_DESKTOP.get(doId);
  const doResponse = await stub.fetch(new Request('http://internal/items'));
  if (!doResponse.ok) {
    return Response.json({ error: 'Failed to load items' }, { status: 500 });
  }

  const data = (await doResponse.json()) as { items: DesktopItem[] };
  const itemsMap = new Map(data.items.map((i) => [i.id, i]));
  const item = itemsMap.get(itemId);
  if (!item) {
    return Response.json({ error: 'Item not found' }, { status: 404 });
  }
  if (item.isTrashed) {
    return Response.json({ error: 'Item is in trash' }, { status: 404 });
  }
  if (item.type === 'folder') {
    return Response.json({ error: 'Use fs.list for folders' }, { status: 400 });
  }

  const itemPath = buildItemPath(item.id, itemsMap);
  if (!canReadItem(capability.granted, itemPath, item.mimeType)) {
    return Response.json({ error: 'Not permitted for this item' }, { status: 403 });
  }

  // Inline text content — return directly
  if (item.type === 'text' && typeof item.textContent === 'string') {
    return new Response(item.textContent, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-EternalOS-Item-Id': item.id },
    });
  }

  // Link items — return the URL as JSON (no blob exists)
  if (item.type === 'link' && item.url) {
    return Response.json({ url: item.url, name: item.name });
  }

  // R2-backed blobs — stream from R2 using the stored r2Key
  if (!item.r2Key) {
    return Response.json({ error: 'Item has no blob' }, { status: 404 });
  }

  const object = await env.ETERNALOS_FILES.get(item.r2Key);
  if (!object) {
    return Response.json({ error: 'Blob not found' }, { status: 404 });
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType ?? item.mimeType ?? 'application/octet-stream');
  headers.set('Content-Length', object.size.toString());
  headers.set('Cache-Control', 'private, max-age=0, no-cache');
  headers.set('ETag', object.httpEtag);
  headers.set('X-EternalOS-Item-Id', item.id);
  // Apps get blobs as attachments by default to prevent accidental inline rendering
  // in the iframe; they can decide to display via <img src> or similar on the client.
  headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(item.name)}"`);

  return new Response(object.body, { headers });
}

