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
import { createWorker } from '@cloudflare/worker-bundler';
import { createAppWorkspace, createWorkerModuleFiles, validateGeneratedApp } from '../agents/tools/appTools';

// Pack of permission names a client may request. The server validates
// unknown keys out rather than fail the whole mint.
const MAX_APP_RELEASES = 20;

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

  const strings = (value: unknown, maxItems: number, maxLength: number, predicate?: (value: string) => boolean) => {
    if (!Array.isArray(value)) return undefined;
    const result = Array.from(new Set(value.filter((entry): entry is string =>
      typeof entry === 'string' && entry.length > 0 && entry.length <= maxLength && (!predicate || predicate(entry))
    ))).slice(0, maxItems);
    return result.length > 0 ? result : undefined;
  };
  const domain = (name: string, value: Record<string, unknown>) => {
    if (Object.keys(value).length > 0) (output as Record<string, unknown>)[name] = value;
  };

  const fs = inputRecord.fs && typeof inputRecord.fs === 'object' ? inputRecord.fs as Record<string, unknown> : {};
  domain('fs', Object.fromEntries([
    ['read', strings(fs.read, 20, 200)],
    ['write', strings(fs.write, 20, 200)],
    ['delete', strings(fs.delete, 20, 200)],
    ['mimeTypes', strings(fs.mimeTypes, 20, 100)],
    ['readMimeTypes', strings(fs.readMimeTypes, 20, 100)],
    ['writeMimeTypes', strings(fs.writeMimeTypes, 20, 100)],
    ['deleteMimeTypes', strings(fs.deleteMimeTypes, 20, 100)],
  ].filter(([, value]) => value !== undefined)));

  const profile = inputRecord.profile && typeof inputRecord.profile === 'object' ? inputRecord.profile as Record<string, unknown> : {};
  domain('profile', Object.fromEntries([
    ['read', strings(profile.read, 4, 30, (value) => ['username', 'displayName', 'bio', 'avatar'].includes(value))],
  ].filter(([, value]) => value !== undefined)));

  const network = inputRecord.network && typeof inputRecord.network === 'object' ? inputRecord.network as Record<string, unknown> : {};
  domain('network', Object.fromEntries([
    ['outbound', strings(network.outbound, 20, 300, (value) => /^(?:\*|(?:\*\.)?[A-Za-z0-9.-]+)$/.test(value))],
  ].filter(([, value]) => value !== undefined)));

  const ipc = inputRecord.ipc && typeof inputRecord.ipc === 'object' ? inputRecord.ipc as Record<string, unknown> : {};
  domain('ipc', Object.fromEntries([
    ['listen', strings(ipc.listen, 50, 120)],
    ['emit', strings(ipc.emit, 50, 120)],
  ].filter(([, value]) => value !== undefined)));

  const handlers = inputRecord.handlers && typeof inputRecord.handlers === 'object' ? inputRecord.handlers as Record<string, unknown> : {};
  domain('handlers', Object.fromEntries([
    ['mimeTypes', strings(handlers.mimeTypes, 20, 100)],
    ['extensions', strings(handlers.extensions, 20, 30)],
  ].filter(([, value]) => value !== undefined)));

  const virtualFolders = inputRecord.virtualFolders && typeof inputRecord.virtualFolders === 'object' ? inputRecord.virtualFolders as Record<string, unknown> : {};
  domain('virtualFolders', Object.fromEntries([
    ['mountAt', strings(virtualFolders.mountAt, 20, 200)],
  ].filter(([, value]) => value !== undefined)));

  const ai = inputRecord.ai && typeof inputRecord.ai === 'object' ? inputRecord.ai as Record<string, unknown> : {};
  domain('ai', Object.fromEntries([
    ['modes', strings(ai.modes, 3, 20, (value) => ['ask', 'search', 'enrich'].includes(value))],
  ].filter(([, value]) => value !== undefined)));

  return output;
}

interface AppRegistryMetadata {
  uid: string;
  version: number;
  granted?: AppGrantedPermissions;
  r2Prefix?: string;
}

interface AppRelease {
  version: number;
  r2Prefix: string;
  name?: string;
  description?: string;
  createdAt?: number;
  permissions?: AppGrantedPermissions;
  rationale?: string;
  current: boolean;
}

async function listR2Prefix(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ETERNALOS_FILES.list({ prefix, cursor });
    keys.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<void> {
  const keys = await listR2Prefix(env, prefix);
  await Promise.allSettled(keys.map((key) => env.ETERNALOS_FILES.delete(key)));
}

async function getNextAppVersion(env: Env, uid: string, appId: string, currentVersion: number): Promise<number> {
  const metadataKeys = (await listR2Prefix(env, `apps/${uid}/${appId}/`))
    .filter((key) => key.endsWith('/metadata.json') || key === `apps/${uid}/${appId}/metadata.json`);
  let highestVersion = currentVersion;
  for (const key of metadataKeys) {
    const object = await env.ETERNALOS_FILES.get(key);
    if (!object) continue;
    const metadata = await object.json<{ version?: number }>().catch(() => null);
    if (metadata?.version && Number.isInteger(metadata.version)) highestVersion = Math.max(highestVersion, metadata.version);
  }
  return highestVersion + 1;
}

async function pruneAppReleases(env: Env, uid: string, appId: string, currentPrefix: string): Promise<void> {
  const metadataKeys = (await listR2Prefix(env, `apps/${uid}/${appId}/`))
    .filter((key) => key.endsWith('/metadata.json') || key === `apps/${uid}/${appId}/metadata.json`);
  const releases: Array<{ version: number; r2Prefix: string }> = [];
  for (const key of metadataKeys) {
    const object = await env.ETERNALOS_FILES.get(key);
    if (!object) continue;
    const metadata = await object.json<{ version?: number; r2Prefix?: string }>().catch(() => null);
    const r2Prefix = metadata?.r2Prefix || key.slice(0, -'/metadata.json'.length);
    if (metadata?.version && Number.isInteger(metadata.version)) releases.push({ version: metadata.version, r2Prefix });
  }
  releases.sort((left, right) => right.version - left.version);
  const keep = new Set([
    currentPrefix,
    ...releases.slice(0, Math.max(0, MAX_APP_RELEASES - 1)).map((release) => release.r2Prefix),
  ]);
  const stale = Array.from(new Set(releases.map((release) => release.r2Prefix))).filter((prefix) => !keep.has(prefix));
  await Promise.all(stale.map((prefix) => deleteR2Prefix(env, prefix)));
}

async function listAppReleases(env: Env, appId: string, uid: string, appMeta: AppRegistryMetadata): Promise<AppRelease[]> {
  const prefix = `apps/${uid}/${appId}/`;
  const keys = await listR2Prefix(env, prefix);
  const releases: AppRelease[] = [];

  for (const key of keys.filter((candidate) => candidate.endsWith('/metadata.json') || candidate === `${prefix}metadata.json`)) {
    const object = await env.ETERNALOS_FILES.get(key);
    if (!object) continue;

    try {
      const metadata = await object.json<{
        uid?: string;
        id?: string;
        version?: number;
        r2Prefix?: string;
        name?: string;
        description?: string;
        createdAt?: number;
        permissions?: unknown;
        rationale?: string;
      }>();
      const r2Prefix = metadata.r2Prefix || key.slice(0, -'/metadata.json'.length);
      if (metadata.uid && metadata.uid !== uid) continue;
      if (metadata.id && metadata.id !== appId) continue;
      if (typeof metadata.version !== 'number' || !Number.isInteger(metadata.version)
        || (r2Prefix !== prefix.slice(0, -1) && !r2Prefix.startsWith(prefix))) continue;
      const version = metadata.version;
      releases.push({
        version,
        r2Prefix,
        name: metadata.name,
        description: metadata.description,
        createdAt: metadata.createdAt,
        permissions: metadata.permissions === undefined ? undefined : sanitizeGranted(metadata.permissions),
        rationale: metadata.rationale,
        current: metadata.version === appMeta.version && r2Prefix === appMeta.r2Prefix,
      });
    } catch {
      continue;
    }
  }

  if (appMeta.r2Prefix && !releases.some((release) => release.r2Prefix === appMeta.r2Prefix)) {
    releases.push({ version: appMeta.version, r2Prefix: appMeta.r2Prefix, current: true });
  }

  return releases.sort((left, right) => right.version - left.version);
}

/**
 * Verify the app exists and belongs to the authenticated user. Returns the
 * app owner's uid on success so downstream calls can load state.
 *
 * App ownership is stored in KV at `app:{appId}` as `{ uid, version }`,
 * populated at createApp time (see routes/agent/tools/appTools.ts).
 */
async function resolveAppOwner(env: Env, appId: string): Promise<{ uid: string; version: number; granted?: AppGrantedPermissions } | null> {
  const meta = await env.DESKTOP_KV.get<{ uid: string; version: number; granted?: AppGrantedPermissions }>(`app:${appId}`, 'json');
  return meta ?? null;
}

function intersectGranted(
  available: AppGrantedPermissions,
  requested: AppGrantedPermissions,
): AppGrantedPermissions {
  const result: AppGrantedPermissions = {};
  const intersect = (availableValues: string[] | undefined, requestedValues: string[] | undefined) => {
    if (!availableValues || !requestedValues) return undefined;
    return requestedValues.filter((value) => availableValues.includes(value));
  };

  if (available.fs && requested.fs) {
    const fs: NonNullable<AppGrantedPermissions['fs']> = {};
    const read = intersect(available.fs.read, requested.fs.read);
    const write = intersect(available.fs.write, requested.fs.write);
    const del = intersect(available.fs.delete, requested.fs.delete);
    const mimeTypes = intersect(available.fs.mimeTypes, requested.fs.mimeTypes);
    const readMimeTypes = intersect(available.fs.readMimeTypes, requested.fs.readMimeTypes);
    const writeMimeTypes = intersect(available.fs.writeMimeTypes, requested.fs.writeMimeTypes);
    const deleteMimeTypes = intersect(available.fs.deleteMimeTypes, requested.fs.deleteMimeTypes);
    if (read?.length) fs.read = read;
    if (write?.length) fs.write = write;
    if (del?.length) fs.delete = del;
    if (mimeTypes?.length) fs.mimeTypes = mimeTypes;
    if (readMimeTypes?.length) fs.readMimeTypes = readMimeTypes;
    if (writeMimeTypes?.length) fs.writeMimeTypes = writeMimeTypes;
    if (deleteMimeTypes?.length) fs.deleteMimeTypes = deleteMimeTypes;
    if (Object.keys(fs).length) result.fs = fs;
  }

  if (available.profile && requested.profile) {
    const read = (requested.profile.read ?? []).filter((field) => available.profile?.read?.includes(field));
    if (read.length) result.profile = { read };
  }

  if (available.ipc && requested.ipc) {
    const ipc: NonNullable<AppGrantedPermissions['ipc']> = {};
    const listen = intersect(available.ipc.listen, requested.ipc.listen);
    const emit = intersect(available.ipc.emit, requested.ipc.emit);
    if (listen?.length) ipc.listen = listen;
    if (emit?.length) ipc.emit = emit;
    if (Object.keys(ipc).length) result.ipc = ipc;
  }

  if (available.network && requested.network) {
    const outbound = intersect(available.network.outbound, requested.network.outbound);
    if (outbound?.length) result.network = { outbound };
  }

  if (available.handlers && requested.handlers) {
    const handlers: NonNullable<AppGrantedPermissions['handlers']> = {};
    const mimeTypes = intersect(available.handlers.mimeTypes, requested.handlers.mimeTypes);
    const extensions = intersect(available.handlers.extensions, requested.handlers.extensions);
    if (mimeTypes?.length) handlers.mimeTypes = mimeTypes;
    if (extensions?.length) handlers.extensions = extensions;
    if (Object.keys(handlers).length) result.handlers = handlers;
  }

  if (available.virtualFolders && requested.virtualFolders) {
    const mountAt = intersect(available.virtualFolders.mountAt, requested.virtualFolders.mountAt);
    if (mountAt?.length) result.virtualFolders = { mountAt };
  }

  if (available.ai && requested.ai) {
    const modes = intersect(available.ai.modes, requested.ai.modes);
    if (modes?.length) result.ai = { modes: modes as NonNullable<AppGrantedPermissions['ai']>['modes'] };
  }

  return result;
}

function grantsCover(current: AppGrantedPermissions, token: AppGrantedPermissions): boolean {
  const covers = (currentValues: string[] | undefined, tokenValues: string[] | undefined) =>
    !tokenValues || tokenValues.every((value) => currentValues?.includes(value));

  if (token.fs && (!covers(current.fs?.read, token.fs.read)
    || !covers(current.fs?.write, token.fs.write)
    || !covers(current.fs?.delete, token.fs.delete)
    || !covers(current.fs?.mimeTypes, token.fs.mimeTypes)
    || !covers(current.fs?.readMimeTypes, token.fs.readMimeTypes)
    || !covers(current.fs?.writeMimeTypes, token.fs.writeMimeTypes)
    || !covers(current.fs?.deleteMimeTypes, token.fs.deleteMimeTypes))) return false;
  if (token.profile && !covers(current.profile?.read, token.profile.read)) return false;
  if (token.ipc && (!covers(current.ipc?.listen, token.ipc.listen) || !covers(current.ipc?.emit, token.ipc.emit))) return false;
  if (token.network && !covers(current.network?.outbound, token.network.outbound)) return false;
  if (token.handlers && (!covers(current.handlers?.mimeTypes, token.handlers.mimeTypes) || !covers(current.handlers?.extensions, token.handlers.extensions))) return false;
  if (token.virtualFolders && !covers(current.virtualFolders?.mountAt, token.virtualFolders.mountAt)) return false;
  if (token.ai && !covers(current.ai?.modes, token.ai.modes)) return false;
  return true;
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

  const storedGranted = appMeta.granted ?? {};
  const granted = body.granted === undefined
    ? storedGranted
    : intersectGranted(storedGranted, sanitizeGranted(body.granted));
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

export async function handleAppPermissions(
  request: Request,
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  const appMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
  if (!appMeta) return Response.json({ error: 'App not found' }, { status: 404 });
  if (appMeta.uid !== auth.uid) return Response.json({ error: 'Not authorized' }, { status: 403 });

  const stub = env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(auth.uid));
  const itemsResponse = await stub.fetch(new Request('http://internal/items'));
  if (!itemsResponse.ok) return Response.json({ error: 'Failed to load app desktop item' }, { status: 500 });
  const items = (await itemsResponse.json() as { items: DesktopItem[] }).items;
  const appItem = items.find((item) => item.type === 'app' && item.appManifest?.appId === appId && !item.isTrashed);
  if (!appItem?.appManifest) return Response.json({ error: 'App desktop item not found' }, { status: 409 });

  const requested = sanitizeGranted(appItem.appManifest.permissions);
  if (request.method === 'GET') {
    return Response.json({
      appId,
      requested,
      granted: appMeta.granted ?? {},
      rationale: appItem.appManifest.rationale,
    });
  }

  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body: { granted?: unknown };
  try {
    body = await request.json() as { granted?: unknown };
  } catch {
    return Response.json({ error: 'A permission selection is required' }, { status: 400 });
  }

  const available = Object.keys(requested).length > 0 ? requested : (appMeta.granted ?? {});
  const granted = intersectGranted(available, sanitizeGranted(body.granted));
  const previousMeta = appMeta;
  const permissionGrantedAt = Object.keys(granted).length > 0 ? Date.now() : undefined;
  const updateResponse = await stub.fetch(new Request('http://internal/items', {
    method: 'PATCH',
    body: JSON.stringify([{
      id: appItem.id,
      updates: { grantedPermissions: granted, permissionGrantedAt },
    }]),
  }));
  if (!updateResponse.ok) return Response.json({ error: 'Failed to save app permissions' }, { status: 500 });

  try {
    await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({ ...appMeta, granted }));
  } catch {
    await stub.fetch(new Request('http://internal/items', {
      method: 'PATCH',
      body: JSON.stringify([{
        id: appItem.id,
        updates: {
          grantedPermissions: previousMeta.granted ?? {},
          permissionGrantedAt: appItem.permissionGrantedAt,
        },
      }]),
    })).catch(() => {});
    return Response.json({ error: 'Failed to save app permissions' }, { status: 500 });
  }

  return Response.json({ appId, requested, granted });
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

  const payload = await verifyAppCapabilityToken(token, env.JWT_SECRET, { expectedAppId });
  if (!payload) return null;

  const appMeta = await env.DESKTOP_KV.get<{ uid: string; granted?: AppGrantedPermissions }>(`app:${expectedAppId}`, 'json');
  if (!appMeta || appMeta.uid !== payload.uid || !grantsCover(appMeta.granted ?? {}, payload.granted ?? {})) return null;
  return payload;
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

/**
 * POST /api/apps/dev-deploy
 *
 * Developer deployment endpoint. Allows developers to manually upload and compile
 * their application workspaces directly onto their EternalOS desktop.
 *
 * Auth: Bearer user JWT (requireAuth)
 */
export async function handleAppDevDeploy(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  let deployedAppId: string | undefined;
  let writtenR2Keys: string[] = [];
  let previousAppMetadata: Record<string, unknown> | null = null;
  let appMetadataWriteStarted = false;

  try {
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 6 * 1024 * 1024) {
      return Response.json({ error: 'App deployment payload is too large' }, { status: 413 });
    }

    const body = await request.json() as {
      appId?: string; // present if updating
      manifest: {
        name: string;
        description?: string;
        version: string;
        windowConfig: { defaultWidth: number; defaultHeight: number; resizable?: boolean };
        permissions?: any;
        rationale?: string;
      };
      files: Record<string, string>;
    };

    if (
      !body ||
      typeof body !== 'object' ||
      !body.manifest ||
      typeof body.manifest !== 'object' ||
      typeof body.manifest.name !== 'string' ||
      body.manifest.name.trim().length === 0 ||
      body.manifest.name.length > 80 ||
      !body.files ||
      typeof body.files !== 'object' ||
      Array.isArray(body.files) ||
      Object.values(body.files).some((content) => typeof content !== 'string') ||
      !body.manifest.windowConfig ||
      typeof body.manifest.windowConfig !== 'object' ||
      !Number.isInteger(body.manifest.windowConfig.defaultWidth) ||
      body.manifest.windowConfig.defaultWidth < 360 ||
      body.manifest.windowConfig.defaultWidth > 1600 ||
      !Number.isInteger(body.manifest.windowConfig.defaultHeight) ||
      body.manifest.windowConfig.defaultHeight < 320 ||
      body.manifest.windowConfig.defaultHeight > 1200 ||
      typeof body.manifest.version !== 'string' ||
      body.manifest.version.length > 40
    ) {
      return Response.json({ error: 'Invalid app deployment payload' }, { status: 400 });
    }

    const { appId: inputAppId, manifest, files } = body;
    const requestedPermissions = sanitizeGranted(manifest.permissions);
    const uid = auth.uid;

    if (inputAppId && !/^[A-Za-z0-9_-]{1,128}$/.test(inputAppId)) {
      return Response.json({ error: 'Invalid app ID' }, { status: 400 });
    }

    let appId = inputAppId;
    let isUpdate = false;
    let oldDesktopItemId: string | null = null;
    let version = 1;

    if (appId) {
      // Update flow
      const appMeta = await env.DESKTOP_KV.get<{ uid: string; version: number; granted?: any; r2Prefix?: string }>(`app:${appId}`, 'json');
      if (!appMeta) {
        return Response.json({ error: 'App not found' }, { status: 404 });
      }
      if (appMeta.uid !== uid) {
        return Response.json({ error: 'Not authorized' }, { status: 403 });
      }
      previousAppMetadata = appMeta as Record<string, unknown>;
      isUpdate = true;
      version = await getNextAppVersion(env, uid, appId, appMeta.version || 1);
    } else {
      // Create flow
      appId = crypto.randomUUID();
    }

    deployedAppId = appId;
    const r2Prefix = `apps/${uid}/${appId}/v${version}`;

    // 1. Create workspace & bundle
    validateGeneratedApp({
      name: manifest.name.trim(),
      description: manifest.description?.trim() || '',
      files,
      width: manifest.windowConfig.defaultWidth,
      height: manifest.windowConfig.defaultHeight,
      permissions: requestedPermissions,
      rationale: manifest.rationale,
    });
    const workspace = createAppWorkspace(files);
    const workerFiles = createWorkerModuleFiles(workspace, '/api/apps');
    const { mainModule, modules } = await createWorker({
      files: {
        ...workerFiles,
        ['__eternal_worker__.js']: workerFiles['__eternal_worker__.js'].replaceAll('__APP_ID__', appId),
      },
      entryPoint: '__eternal_worker__.js',
    });

    // 2. Write to R2
    const bundleKey = `${r2Prefix}/bundle.json`;
    await env.ETERNALOS_FILES.put(bundleKey, JSON.stringify({ mainModule, modules }));
    writtenR2Keys.push(bundleKey);

    const sourceKey = `${r2Prefix}/source.json`;
    await env.ETERNALOS_FILES.put(sourceKey, JSON.stringify(workspace.files));
    writtenR2Keys.push(sourceKey);

    const metadataKey = `${r2Prefix}/metadata.json`;
    await env.ETERNALOS_FILES.put(metadataKey, JSON.stringify({
      id: appId,
      uid,
      name: manifest.name,
      description: manifest.description,
      version,
      r2Prefix,
      createdAt: Date.now(),
      permissions: requestedPermissions,
      rationale: manifest.rationale,
    }));
    writtenR2Keys.push(metadataKey);

    // 3. Register in KV
    const existingMetadata = isUpdate
      ? await env.DESKTOP_KV.get<{ granted?: AppGrantedPermissions }>(`app:${appId}`, 'json')
      : null;
    const declaredPermissions = requestedPermissions;
    const granted = existingMetadata?.granted
      ? intersectGranted(declaredPermissions, existingMetadata.granted)
      : {};
    appMetadataWriteStarted = true;
    await env.DESKTOP_KV.put(
      `app:${appId}`,
      JSON.stringify({
        uid,
        version,
        granted,
        r2Prefix,
      })
    );

    // 4. Create or Update Desktop Item
    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);

    const appManifestObj = {
      name: manifest.name,
      description: manifest.description,
      version: String(version),
      windowConfig: {
        defaultWidth: manifest.windowConfig?.defaultWidth || 600,
        defaultHeight: manifest.windowConfig?.defaultHeight || 500,
        resizable: manifest.windowConfig?.resizable !== false,
      },
      appId,
      permissions: requestedPermissions,
      rationale: manifest.rationale,
    };

    if (isUpdate) {
      // Find the existing desktop item by scanning items in the user desktop DO
      const doRes = await stub.fetch(new Request('http://internal/items'));
      if (!doRes.ok) throw new Error('Failed to load existing desktop items');
      if (doRes.ok) {
        const data = await doRes.json<{ items: DesktopItem[] }>();
        const existingItem = data.items.find((item) => item.type === 'app' && item.appManifest?.appId === appId);
        if (existingItem) {
          oldDesktopItemId = existingItem.id;
        }
      }

      if (oldDesktopItemId) {
        // Update Desktop Item
        const updateResponse = await stub.fetch(
          new Request('http://internal/items', {
            method: 'PATCH',
            body: JSON.stringify([{
              id: oldDesktopItemId,
              updates: {
                name: manifest.name,
                appManifest: appManifestObj,
                grantedPermissions: granted,
              },
            }]),
          })
        );
        if (!updateResponse.ok) throw new Error('Failed to update app desktop item');
      } else {
        throw new Error('App desktop item not found');
      }
    } else {
      // Create new Desktop Item
      const position = { x: 2 + Math.floor(Math.random() * 4), y: 2 + Math.floor(Math.random() * 4) }; // place it around the middle
      const createResponse = await stub.fetch(
        new Request('http://internal/items', {
          method: 'POST',
          body: JSON.stringify({
            type: 'app',
            name: manifest.name,
            parentId: null,
            position,
            isPublic: false,
            appManifest: appManifestObj,
            grantedPermissions: granted,
            permissionGrantedAt: Date.now(),
          }),
        })
      );
      if (!createResponse.ok) throw new Error('Failed to create app desktop item');
    }

    if (isUpdate) {
      await pruneAppReleases(env, uid, appId, r2Prefix).catch((error) => {
        console.error('App release cleanup failed:', error);
      });
    }
    return Response.json({ success: true, appId, version, isUpdate });
  } catch (error) {
    if (writtenR2Keys.length > 0) {
      await Promise.allSettled(writtenR2Keys.map((key) => env.ETERNALOS_FILES.delete(key)));
    }
    if (appMetadataWriteStarted && deployedAppId) {
      if (previousAppMetadata) {
        await env.DESKTOP_KV.put(`app:${deployedAppId}`, JSON.stringify(previousAppMetadata));
      } else {
        await env.DESKTOP_KV.delete(`app:${deployedAppId}`);
      }
    }
    console.error('Developer deployment error:', error);
    const message = error instanceof Error ? error.message : 'Deployment failed';
    const status = /^(App source|App bundle|Invalid app|Duplicate app source|External |Missing local asset|App (reads|writes|deletes|uses))/.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
}

export async function handleAppVersions(
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  const appMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
  if (!appMeta) return Response.json({ error: 'App not found' }, { status: 404 });
  if (appMeta.uid !== auth.uid) return Response.json({ error: 'Not authorized' }, { status: 403 });

  const releases = await listAppReleases(env, appId, auth.uid, appMeta);
  return Response.json({ appId, currentVersion: appMeta.version, releases });
}

export async function handleAppRollback(
  request: Request,
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  const appMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
  if (!appMeta) return Response.json({ error: 'App not found' }, { status: 404 });
  if (appMeta.uid !== auth.uid) return Response.json({ error: 'Not authorized' }, { status: 403 });

  let body: { version?: number };
  try {
    body = await request.json() as { version?: number };
  } catch {
    return Response.json({ error: 'A release version is required' }, { status: 400 });
  }

  if (!Number.isInteger(body.version)) {
    return Response.json({ error: 'A release version is required' }, { status: 400 });
  }

  const releases = await listAppReleases(env, appId, auth.uid, appMeta);
  const release = releases.find((candidate) => candidate.version === body.version);
  if (!release) return Response.json({ error: 'Release not found' }, { status: 404 });
  if (release.current) return Response.json({ success: true, version: release.version });

  const bundle = await env.ETERNALOS_FILES.get(`${release.r2Prefix}/bundle.json`);
  if (!bundle) return Response.json({ error: 'Release bundle not found' }, { status: 409 });

  const doId = env.USER_DESKTOP.idFromName(auth.uid);
  const stub = env.USER_DESKTOP.get(doId);
  const itemsResponse = await stub.fetch(new Request('http://internal/items'));
  if (!itemsResponse.ok) return Response.json({ error: 'Failed to load app desktop item' }, { status: 500 });
  const items = (await itemsResponse.json() as { items: DesktopItem[] }).items;
  const appItem = items.find((item) => item.type === 'app' && item.appManifest?.appId === appId && !item.isTrashed);
  if (!appItem?.appManifest) return Response.json({ error: 'App desktop item not found' }, { status: 409 });

  const previousMeta = appMeta;
  const nextGranted = release.permissions
    ? intersectGranted(release.permissions, appMeta.granted ?? {})
    : (appMeta.granted ?? {});
  const nextMeta: AppRegistryMetadata = {
    ...appMeta,
    version: release.version,
    r2Prefix: release.r2Prefix,
    granted: nextGranted,
  };
  await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify(nextMeta));

  const nextManifest = {
    ...appItem.appManifest,
    name: release.name || appItem.appManifest.name,
    description: release.description ?? appItem.appManifest.description,
    version: String(release.version),
    permissions: release.permissions ?? appItem.appManifest.permissions,
    rationale: release.rationale ?? appItem.appManifest.rationale,
  };
  const updateResponse = await stub.fetch(new Request('http://internal/items', {
    method: 'PATCH',
    body: JSON.stringify([{
      id: appItem.id,
      updates: {
        name: nextManifest.name,
        appManifest: nextManifest,
        grantedPermissions: nextGranted,
      },
    }]),
  }));

  if (!updateResponse.ok) {
    await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify(previousMeta));
    return Response.json({ error: 'Failed to update app desktop item' }, { status: 500 });
  }

  return Response.json({ success: true, version: release.version, appId });
}

export async function handleAppDelete(
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  const appMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
  if (!appMeta) return Response.json({ error: 'App not found' }, { status: 404 });
  if (appMeta.uid !== auth.uid) return Response.json({ error: 'Not authorized' }, { status: 403 });

  const doId = env.USER_DESKTOP.idFromName(auth.uid);
  const stub = env.USER_DESKTOP.get(doId);
  const itemsResponse = await stub.fetch(new Request('http://internal/items'));
  if (!itemsResponse.ok) return Response.json({ error: 'Failed to load app desktop item' }, { status: 500 });
  const items = (await itemsResponse.json() as { items: DesktopItem[] }).items;
  const appItem = items.find((item) => item.type === 'app' && item.appManifest?.appId === appId && !item.isTrashed);

  if (appItem) {
    const trashResponse = await stub.fetch(new Request('http://internal/items', {
      method: 'PATCH',
      body: JSON.stringify([{ id: appItem.id, updates: { isTrashed: true, trashedAt: Date.now() } }]),
    }));
    if (!trashResponse.ok) return Response.json({ error: 'Failed to remove app from desktop' }, { status: 500 });
  }

  await deleteR2Prefix(env, `apps/${auth.uid}/${appId}/`);
  await env.DESKTOP_KV.delete(`app:${appId}`);

  const storagePrefix = `app-storage:${auth.uid}:${appId}:`;
  let storageCursor: string | undefined;
  do {
    const storageKeys = await env.DESKTOP_KV.list({ prefix: storagePrefix, cursor: storageCursor });
    await Promise.allSettled(storageKeys.keys.map((key) => env.DESKTOP_KV.delete(key.name)));
    storageCursor = storageKeys.list_complete ? undefined : storageKeys.cursor;
  } while (storageCursor);

  return Response.json({ success: true, appId, deletedDesktopItem: Boolean(appItem) });
}

/**
 * GET /api/apps/:appId/source
 * Returns the raw source files { "index.html": "...", "app.js": "..." } of an app.
 * Auth: Bearer user JWT (requireAuth)
 */
export async function handleGetAppSourceRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  try {
    const uid = auth.uid;

    // Check app ownership in KV
    const appMeta = await env.DESKTOP_KV.get<{ uid: string; r2Prefix?: string }>(`app:${appId}`, 'json');
    if (!appMeta) {
      return Response.json({ error: 'App not found' }, { status: 404 });
    }
    if (appMeta.uid !== uid) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }

    const r2Prefix = appMeta.r2Prefix || `apps/${uid}/${appId}`;
    const sourceObj = await env.ETERNALOS_FILES.get(`${r2Prefix}/source.json`);
    if (!sourceObj) {
      return Response.json({ error: 'Source files not found' }, { status: 404 });
    }

    const sourceText = await sourceObj.text();
    const sourceFiles = JSON.parse(sourceText);

    return Response.json({ success: true, files: sourceFiles });
  } catch (error) {
    console.error('Failed to get app source:', error);
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to retrieve source' }, { status: 500 });
  }
}
