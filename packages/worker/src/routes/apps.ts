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
import type { AppPermissions } from '@eternalos/contracts';
import { readTextWithLimit } from '../utils/limitedBody';
import { signAppCapabilityToken, verifyAppCapabilityToken } from '../utils/jwt';
import { nextFreeDesktopCell } from '../utils/desktopGrid';
import { buildItemPath, pathMatchesGlob as sharedPathMatchesGlob, canReadItem as sharedCanReadItem } from '../utils/fsPolicy';
import {
  broadScopeIds,
  buildGrantApprovals,
  intersectGranted,
  pruneGrantApprovals,
  resolveGrantApprovals,
  sanitizeBroadApprovals,
  sanitizeGranted,
} from '../utils/appScopes';
import { createWorker } from '@cloudflare/worker-bundler';
import {
  AppValidationError,
  assertAppBundleValid,
  type AppValidationIssue,
} from '../utils/appBundleValidation';
import { createAppWorkspace, createWorkerModuleFiles, purgeAppBackend, validateGeneratedApp } from '../agents/tools/appTools';
import {
  ensureRevisionBaseline,
  isValidRevisionId,
  pruneAppRevisions,
  readAppRevision,
  writeAppRevision,
  type AppRevisionWindowConfig,
} from './appRevisions';

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

interface AppRegistryMetadata {
  uid: string;
  version: number;
  granted?: AppGrantedPermissions;
  r2Prefix?: string;
  /** Latest source revision (valid or not) — see routes/appRevisions.ts. */
  current_revision?: string;
  /** Latest revision that passed validation; the installed bundle derives
   *  from a release this pointer's history led to. */
  last_valid_revision?: string;
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
  // Broad scopes within the *declared* set — the ones the install/approval UI
  // must render as explicit warnings (see utils/appScopes.ts).
  const broad = broadScopeIds(requested);
  // Approval metadata per granted scope. Lazy migration: grants recorded
  // before approval metadata existed have no stored entry and read as
  // approved with approvedAt unknown.
  const approvals = resolveGrantApprovals(appMeta.granted ?? {}, appItem.grantedPermissionApprovals);
  if (request.method === 'GET') {
    return Response.json({
      appId,
      requested,
      granted: appMeta.granted ?? {},
      broad,
      approvals,
      rationale: appItem.appManifest.rationale,
    });
  }

  if (request.method !== 'PATCH' && request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let body: { granted?: unknown; broadApprovals?: unknown };
  try {
    body = await request.json() as { granted?: unknown; broadApprovals?: unknown };
  } catch {
    return Response.json({ error: 'A permission selection is required' }, { status: 400 });
  }

  const available = Object.keys(requested).length > 0 ? requested : (appMeta.granted ?? {});
  const requestedGrant = sanitizeGranted(body.granted);

  // Broad-scope rule (design/CORE-ROADMAP.md Workstream 3, Phase B): a grant
  // request that includes a broad scope — a whole-filesystem read/write
  // glob, a wildcard network domain, or all profile fields — is rejected
  // unless it carries that scope's explicit approval tick. Narrow scopes
  // keep today's flow. Nothing here widens grants: the intersection with the
  // declared set below is unchanged.
  const broadInRequest = broadScopeIds(requestedGrant);
  const approvedBroad = sanitizeBroadApprovals(body.broadApprovals);
  const missingApproval = broadInRequest.filter((scope) => !approvedBroad.has(scope));
  if (missingApproval.length > 0) {
    return Response.json({
      error: 'Broad permission scopes require explicit approval',
      broadScopes: missingApproval,
    }, { status: 400 });
  }

  const granted = intersectGranted(available, requestedGrant);
  const previousMeta = appMeta;
  const permissionGrantedAt = Object.keys(granted).length > 0 ? Date.now() : undefined;
  // Approval metadata for every scope in the final granted set: approved
  // now, by this user, with the manifest's rationale as it reads at
  // approval time.
  const nextApprovals = buildGrantApprovals(granted, auth.uid, appItem.appManifest.rationale);
  const updateResponse = await stub.fetch(new Request('http://internal/items', {
    method: 'PATCH',
    body: JSON.stringify([{
      id: appItem.id,
      updates: { grantedPermissions: granted, permissionGrantedAt, grantedPermissionApprovals: nextApprovals },
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
          grantedPermissionApprovals: appItem.grantedPermissionApprovals ?? {},
        },
      }]),
    })).catch(() => {});
    return Response.json({ error: 'Failed to save app permissions' }, { status: 500 });
  }

  return Response.json({ appId, requested, granted, broad, approvals: nextApprovals });
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
    // Same rule as the bridge (EternalService.list): installed apps are not
    // listable by apps — an app holding a broad read grant must not be able
    // to enumerate the user's installed app names and ids.
    if (item.type === 'app') continue;

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
const DEV_DEPLOY_MAX_BODY_BYTES = 6 * 1024 * 1024;

export async function handleAppDevDeploy(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  let deployedAppId: string | undefined;
  let writtenR2Keys: string[] = [];
  // Revision objects are tracked separately from release keys: on a genuine
  // infra failure both are cleaned up, but on a *validation* failure the
  // revision is the diagnostics record and is deliberately kept.
  let writtenRevisionKeys: string[] = [];
  let previousAppMetadata: Record<string, unknown> | null = null;
  let appMetadataWriteStarted = false;
  // Visible to the catch block so a rejected save can be recorded on the app
  // it targeted (failed saves on an existing app keep the installed bundle
  // and leave a revision carrying the validation diagnostics).
  let isUpdateFlow = false;
  let attemptedSave: {
    name: string;
    description?: string;
    rationale?: string;
    windowConfig: { defaultWidth: number; defaultHeight: number; resizable?: boolean };
    permissions?: unknown;
    files: Record<string, string>;
  } | null = null;

  try {
    // Streamed cap: a chunked body has no Content-Length to check.
    const rawBody = await readTextWithLimit(request, DEV_DEPLOY_MAX_BODY_BYTES);
    if (rawBody === null) {
      return Response.json({ error: 'App deployment payload is too large' }, { status: 413 });
    }

    const body = JSON.parse(rawBody) as {
      appId?: string; // present if updating
      manifest: {
        name: string;
        description?: string;
        version: string;
        windowConfig: { defaultWidth: number; defaultHeight: number; resizable?: boolean };
        permissions?: AppPermissions;
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
    attemptedSave = {
      name: manifest.name,
      description: manifest.description,
      rationale: manifest.rationale,
      windowConfig: manifest.windowConfig,
      permissions: manifest.permissions,
      files,
    };
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
      const appMeta = await env.DESKTOP_KV.get<{ uid: string; version: number; granted?: AppGrantedPermissions; r2Prefix?: string }>(`app:${appId}`, 'json');
      if (!appMeta) {
        return Response.json({ error: 'App not found' }, { status: 404 });
      }
      if (appMeta.uid !== uid) {
        return Response.json({ error: 'Not authorized' }, { status: 403 });
      }
      isUpdate = true;
      isUpdateFlow = true;
      version = await getNextAppVersion(env, uid, appId, appMeta.version || 1);
      // Lazy migration: apps deployed before revisions existed get their
      // current source snapshotted as revision #0 on this first touch, so
      // this update lands on top of a real history instead of starting one.
      await ensureRevisionBaseline(env, uid, appId, appMeta);
      // Re-read so an infra-failure rollback restores the baselined record.
      previousAppMetadata = await env.DESKTOP_KV.get<Record<string, unknown>>(`app:${appId}`, 'json');
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

    // Deterministic post-bundle validation (after compiling, before anything
    // is persisted): bridge surface, declared-permission coverage, asset
    // packaging, sandbox availability, and the compiled worker contract.
    // Throws AppValidationError with every issue at once.
    assertAppBundleValid({
      files: workspace.files,
      manifest: workspace.manifest,
      permissions: requestedPermissions,
      compiled: { mainModule, modules },
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

    // 2b. Write the immutable source revision for this save. Every
    // successful save produces one; the registry below points at it.
    // (design/13: install = freeze a validated revision — this object is
    // the source side of that freeze, bundle.json above the runtime side.)
    const revision = await writeAppRevision(env, uid, appId, {
      kind: 'deploy',
      author: 'human',
      valid: true,
      files: workspace.files,
      name: manifest.name,
      description: manifest.description,
      permissions: requestedPermissions,
      rationale: manifest.rationale,
      windowConfig: manifest.windowConfig,
      appVersion: version,
      summary: isUpdate ? `Deployed v${version}` : `Initial deploy (v${version})`,
    });
    writtenRevisionKeys.push(...revision.keys);

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
        current_revision: revision.revisionId,
        last_valid_revision: revision.revisionId,
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

    let existingAppItem: DesktopItem | undefined;
    if (isUpdate) {
      // Find the existing desktop item by scanning items in the user desktop DO
      const doRes = await stub.fetch(new Request('http://internal/items'));
      if (!doRes.ok) throw new Error('Failed to load existing desktop items');
      if (doRes.ok) {
        const data = await doRes.json<{ items: DesktopItem[] }>();
        existingAppItem = data.items.find((item) => item.type === 'app' && item.appManifest?.appId === appId);
        if (existingAppItem) {
          oldDesktopItemId = existingAppItem.id;
        }
      }

      if (oldDesktopItemId) {
        // Update Desktop Item. Grants only ever narrow here (intersection
        // with the previous stored grant), so keep each surviving scope's
        // approval metadata as it read when the user approved it and drop
        // entries for scopes whose grant fell away.
        const updateResponse = await stub.fetch(
          new Request('http://internal/items', {
            method: 'PATCH',
            body: JSON.stringify([{
              id: oldDesktopItemId,
              updates: {
                name: manifest.name,
                appManifest: appManifestObj,
                grantedPermissions: granted,
                grantedPermissionApprovals: pruneGrantApprovals(
                  existingAppItem?.grantedPermissionApprovals,
                  granted,
                ),
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
      // First free grid cell, like every other new item (a random middle
      // cell often landed under an open window or on top of another icon).
      const snapshotResponse = await stub.fetch(new Request('http://internal/items'));
      const snapshotItems = snapshotResponse.ok ? ((await snapshotResponse.json()) as { items: DesktopItem[] }).items : [];
      const position = nextFreeDesktopCell(snapshotItems, null);
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
            grantedPermissionApprovals: {},
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
    // Cap the revision history: keep the newest MAX_APP_REVISIONS objects,
    // with the registry pointers pinned so they can never be evicted.
    await pruneAppRevisions(env, uid, appId, new Set([revision.revisionId])).catch((error) => {
      console.error('App revision cleanup failed:', error);
    });
    return Response.json({ success: true, appId, version, isUpdate, revision: revision.revisionId });
  } catch (error) {
    if (writtenR2Keys.length > 0) {
      await Promise.allSettled(writtenR2Keys.map((key) => env.ETERNALOS_FILES.delete(key)));
    }
    if (writtenRevisionKeys.length > 0) {
      // Infra failure mid-flight: the revision never became a save. A
      // validation failure takes the branch below instead and keeps its
      // revision (writtenRevisionKeys is only populated on the success path,
      // after validation, so this never deletes a diagnostics record).
      await Promise.allSettled(writtenRevisionKeys.map((key) => env.ETERNALOS_FILES.delete(key)));
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
    // Client-supplied bad bundles are a 4xx, never a 5xx. Every deterministic
    // validation rejection (workspace shape, source gate, post-bundle pass)
    // is a typed AppValidationError and maps to 400 with the structured issue
    // list attached. The prefix match below is only the fallback for plain
    // Error throws that bypass those gates — notably the createAppWorkspace
    // filename/size limits. Anything else (bundler/runtime failures) is a
    // genuine server fault and stays 500.
    if (error instanceof AppValidationError) {
      // A rejected save on an EXISTING app is itself history: nothing above
      // was persisted (all validation runs before any release write), so the
      // installed bundle is untouched — but the attempted source and the
      // diagnostics are recorded as an invalid revision, and only
      // current_revision moves (last_valid_revision does not). Failed
      // creates record nothing: the app was never registered, so there is
      // no history to attach the attempt to.
      let failedRevisionId: string | undefined;
      if (isUpdateFlow && deployedAppId && attemptedSave) {
        try {
          const failed = await writeAppRevision(env, auth.uid, deployedAppId, {
            kind: 'deploy',
            author: 'human',
            valid: false,
            issues: error.issues,
            files: attemptedSave.files,
            name: attemptedSave.name,
            description: attemptedSave.description,
            permissions: sanitizeGranted(attemptedSave.permissions),
            rationale: attemptedSave.rationale,
            windowConfig: attemptedSave.windowConfig,
            summary: 'Failed save — validation rejected',
          });
          failedRevisionId = failed.revisionId;
          const currentMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${deployedAppId}`, 'json');
          if (currentMeta && currentMeta.uid === auth.uid) {
            await env.DESKTOP_KV.put(`app:${deployedAppId}`, JSON.stringify({
              ...currentMeta,
              current_revision: failed.revisionId,
            }));
          }
        } catch (revisionError) {
          console.error('Failed to record invalid app revision:', revisionError);
        }
      }
      const issues: AppValidationIssue[] = error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.file ? { file: issue.file } : {}),
        ...(issue.evidence ? { evidence: issue.evidence } : {}),
        ...(issue.hint ? { hint: issue.hint } : {}),
      }));
      return Response.json(
        { error: message, issues, ...(failedRevisionId ? { revision: failedRevisionId } : {}) },
        { status: 400 },
      );
    }
    const status = /^(App source|App bundle|Invalid app|Duplicate app source|External |Dynamic imports |Imports from |Missing local asset|Source file name|App (reads|writes|deletes|uses|emits|listens))/.test(message) ? 400 : 500;
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
  let appMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
  if (!appMeta) return Response.json({ error: 'App not found' }, { status: 404 });
  if (appMeta.uid !== auth.uid) return Response.json({ error: 'Not authorized' }, { status: 403 });

  // Lazy migration: apps deployed before revisions existed get their current
  // source snapshotted as revision #0 on this first touch (same as the
  // dev-deploy update flow), so the rollback below appends to a real history
  // instead of starting one. Re-read so the record carries the pointers.
  await ensureRevisionBaseline(env, auth.uid, appId, appMeta);
  appMeta = (await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json')) ?? appMeta;

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

  // The rollback revision snapshots the release's saved source, so it needs
  // the same source.json the release writes always carry.
  const sourceObj = await env.ETERNALOS_FILES.get(`${release.r2Prefix}/source.json`);
  const files = sourceObj
    ? await sourceObj.json<Record<string, string>>().catch(() => null)
    : null;
  if (!files) return Response.json({ error: 'Release source not found' }, { status: 409 });

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
  // The rollback appends a revision (kind 'rollback') so the registry's
  // revision pointers can no longer disagree with the installed release:
  // the release being reinstated was validated when it was deployed, so
  // the revision is valid and both pointers move to it. Its parent is the
  // revision the app rolled back FROM — the registry's current_revision at
  // rollback time (the rolled-back-to side is a release, recorded as
  // appVersion). Install = freeze a validated revision.
  const rollbackRevision = await writeAppRevision(env, auth.uid, appId, {
    kind: 'rollback',
    author: 'human',
    valid: true,
    files,
    name: release.name,
    description: release.description,
    permissions: release.permissions,
    rationale: release.rationale,
    ...(appItem.appManifest.windowConfig ? {
      windowConfig: {
        defaultWidth: appItem.appManifest.windowConfig.defaultWidth,
        defaultHeight: appItem.appManifest.windowConfig.defaultHeight,
        resizable: appItem.appManifest.windowConfig.resizable !== false,
      },
    } : {}),
    appVersion: release.version,
    parentRevision: appMeta.current_revision,
    summary: `Rolled back to v${release.version}`,
  });
  const nextMeta: AppRegistryMetadata = {
    ...appMeta,
    version: release.version,
    r2Prefix: release.r2Prefix,
    granted: nextGranted,
    current_revision: rollbackRevision.revisionId,
    last_valid_revision: rollbackRevision.revisionId,
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
  // Grants only ever narrow on rollback (intersection with the release's
  // declared set), so keep surviving scopes' approval metadata and drop the
  // entries for scopes whose grant fell away.
  const nextApprovals = pruneGrantApprovals(appItem.grantedPermissionApprovals, nextGranted);
  const updateResponse = await stub.fetch(new Request('http://internal/items', {
    method: 'PATCH',
    body: JSON.stringify([{
      id: appItem.id,
      updates: {
        name: nextManifest.name,
        appManifest: nextManifest,
        grantedPermissions: nextGranted,
        grantedPermissionApprovals: nextApprovals,
      },
    }]),
  }));

  if (!updateResponse.ok) {
    await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify(previousMeta));
    // Infra failure mid-flight: the revision never became a rollback.
    await Promise.allSettled(rollbackRevision.keys.map((key) => env.ETERNALOS_FILES.delete(key)));
    return Response.json({ error: 'Failed to update app desktop item' }, { status: 500 });
  }

  // Cap the revision history with the new revision pinned (same as
  // dev-deploy).
  await pruneAppRevisions(env, auth.uid, appId, new Set([rollbackRevision.revisionId])).catch((error) => {
    console.error('App revision cleanup failed:', error);
  });

  return Response.json({ success: true, version: release.version, appId });
}

/**
 * POST /api/apps/:appId/revisions/:revisionId/restore
 *
 * Restore a stored source revision: the revision's files are re-validated,
 * re-compiled, and deployed as a NEW release + a NEW revision (kind
 * 'restore', parentRevision = the source). History is never rewritten — the
 * restored-from revision stays exactly as it was.
 *
 * Install = freeze a validated revision, same as dev-deploy: all validation
 * gates run before anything is persisted, so a revision that no longer
 * validates leaves the installed bundle untouched and records the attempt
 * as an invalid revision carrying the diagnostics.
 *
 * Grants never widen — the restored manifest's declared set is intersected
 * with the CURRENT stored grant (the same rule as dev-deploy updates and
 * rollback), so restoring an older, broader declaration cannot re-open a
 * scope the user has since narrowed or never granted.
 */
export async function handleAppRevisionRestore(
  env: Env,
  auth: AuthContext,
  appId: string,
  revisionId: string,
): Promise<Response> {
  const appMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
  if (!appMeta) return Response.json({ error: 'App not found' }, { status: 404 });
  if (appMeta.uid !== auth.uid) return Response.json({ error: 'Not authorized' }, { status: 403 });
  if (!isValidRevisionId(revisionId)) return Response.json({ error: 'Invalid revision ID' }, { status: 400 });

  const uid = auth.uid;
  const revision = await readAppRevision(env, uid, appId, revisionId);
  if (!revision) return Response.json({ error: 'Revision not found' }, { status: 404 });

  // Lazy migration for apps whose registry record predates revisions.
  await ensureRevisionBaseline(env, uid, appId, appMeta);

  const revisionManifest = revision.manifest;
  const files = revision.files;
  const name = typeof revisionManifest.name === 'string' ? revisionManifest.name.trim() : '';
  if (!name || name.length > 80) {
    return Response.json({ error: 'Revision manifest is invalid' }, { status: 400 });
  }

  // The restored window config comes from the revision when it recorded one
  // (dev-deploy saves always do); baseline snapshots of older releases may
  // not, so fall back to the currently installed manifest's dimensions.
  const doId = env.USER_DESKTOP.idFromName(uid);
  const stub = env.USER_DESKTOP.get(doId);
  const itemsResponse = await stub.fetch(new Request('http://internal/items'));
  if (!itemsResponse.ok) return Response.json({ error: 'Failed to load app desktop item' }, { status: 500 });
  const items = (await itemsResponse.json() as { items: DesktopItem[] }).items;
  const appItem = items.find((item) => item.type === 'app' && item.appManifest?.appId === appId && !item.isTrashed);
  if (!appItem?.appManifest) return Response.json({ error: 'App desktop item not found' }, { status: 409 });

  const windowConfig: AppRevisionWindowConfig = revisionManifest.windowConfig
    ?? (appItem.appManifest.windowConfig
      ? {
        defaultWidth: appItem.appManifest.windowConfig.defaultWidth,
        defaultHeight: appItem.appManifest.windowConfig.defaultHeight,
        resizable: appItem.appManifest.windowConfig.resizable !== false,
      }
      : { defaultWidth: 600, defaultHeight: 500, resizable: true });
  if (
    !Number.isInteger(windowConfig.defaultWidth) ||
    windowConfig.defaultWidth < 360 ||
    windowConfig.defaultWidth > 1600 ||
    !Number.isInteger(windowConfig.defaultHeight) ||
    windowConfig.defaultHeight < 320 ||
    windowConfig.defaultHeight > 1200
  ) {
    return Response.json({ error: 'Revision window configuration is invalid' }, { status: 400 });
  }

  const requestedPermissions = sanitizeGranted(revisionManifest.permissions);
  const version = await getNextAppVersion(env, uid, appId, appMeta.version || 1);
  const r2Prefix = `apps/${uid}/${appId}/v${version}`;
  const writtenR2Keys: string[] = [];
  const writtenRevisionKeys: string[] = [];
  const previousAppMetadata = await env.DESKTOP_KV.get<Record<string, unknown>>(`app:${appId}`, 'json');
  let appMetadataWriteStarted = false;

  try {
    // Same gates as dev-deploy, in the same order — the restored source must
    // clear them before anything is persisted or installed.
    validateGeneratedApp({
      name,
      description: revisionManifest.description ?? '',
      files,
      width: windowConfig.defaultWidth,
      height: windowConfig.defaultHeight,
      permissions: requestedPermissions,
      rationale: revisionManifest.rationale,
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
    assertAppBundleValid({
      files: workspace.files,
      manifest: workspace.manifest,
      permissions: requestedPermissions,
      compiled: { mainModule, modules },
    });

    // Deploy the validated revision as a new release.
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
      name,
      description: revisionManifest.description,
      version,
      r2Prefix,
      createdAt: Date.now(),
      permissions: requestedPermissions,
      rationale: revisionManifest.rationale,
    }));
    writtenR2Keys.push(metadataKey);

    // And append the restore revision. The restored-from revision is left
    // untouched — restoring appends, it never rewrites.
    const revisionWrite = await writeAppRevision(env, uid, appId, {
      kind: 'restore',
      author: 'human',
      valid: true,
      files: workspace.files,
      name,
      description: revisionManifest.description,
      permissions: requestedPermissions,
      rationale: revisionManifest.rationale,
      windowConfig,
      appVersion: version,
      parentRevision: revisionId,
      summary: `Restored from revision ${revisionId.slice(-8)}`,
    });
    writtenRevisionKeys.push(...revisionWrite.keys);

    // Registry: grants only ever narrow here (intersection with the current
    // stored grant — the dev-deploy update rule), and both revision pointers
    // move to the new revision.
    const existingMetadata = await env.DESKTOP_KV.get<{ granted?: AppGrantedPermissions }>(`app:${appId}`, 'json');
    const granted = existingMetadata?.granted
      ? intersectGranted(requestedPermissions, existingMetadata.granted)
      : {};
    appMetadataWriteStarted = true;
    await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({
      uid,
      version,
      granted,
      r2Prefix,
      current_revision: revisionWrite.revisionId,
      last_valid_revision: revisionWrite.revisionId,
    }));

    // Desktop item: the restored manifest becomes the installed manifest.
    // Surviving grants keep their approval metadata; scopes whose grant
    // fell away are pruned (same as dev-deploy updates and rollback).
    const appManifestObj = {
      name,
      description: revisionManifest.description,
      version: String(version),
      windowConfig: {
        defaultWidth: windowConfig.defaultWidth,
        defaultHeight: windowConfig.defaultHeight,
        resizable: windowConfig.resizable !== false,
      },
      appId,
      permissions: requestedPermissions,
      rationale: revisionManifest.rationale,
    };
    const updateResponse = await stub.fetch(
      new Request('http://internal/items', {
        method: 'PATCH',
        body: JSON.stringify([{
          id: appItem.id,
          updates: {
            name,
            appManifest: appManifestObj,
            grantedPermissions: granted,
            grantedPermissionApprovals: pruneGrantApprovals(appItem.grantedPermissionApprovals, granted),
          },
        }]),
      })
    );
    if (!updateResponse.ok) throw new Error('Failed to update app desktop item');

    await pruneAppReleases(env, uid, appId, r2Prefix).catch((error) => {
      console.error('App release cleanup failed:', error);
    });
    await pruneAppRevisions(env, uid, appId, new Set([revisionWrite.revisionId])).catch((error) => {
      console.error('App revision cleanup failed:', error);
    });

    return Response.json({
      success: true,
      appId,
      version,
      revisionId: revisionWrite.revisionId,
      restoredFrom: revisionId,
    });
  } catch (error) {
    if (writtenR2Keys.length > 0) {
      await Promise.allSettled(writtenR2Keys.map((key) => env.ETERNALOS_FILES.delete(key)));
    }
    if (writtenRevisionKeys.length > 0) {
      await Promise.allSettled(writtenRevisionKeys.map((key) => env.ETERNALOS_FILES.delete(key)));
    }
    if (appMetadataWriteStarted && previousAppMetadata) {
      await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify(previousAppMetadata));
    }
    console.error('App revision restore error:', error);
    const message = error instanceof Error ? error.message : 'Restore failed';

    if (error instanceof AppValidationError) {
      // The stored source no longer clears the gates. Keep the installed
      // bundle exactly as it was and record the rejected attempt as an
      // invalid revision (kind 'restore', diagnostics attached).
      let failedRevisionId: string | undefined;
      try {
        const failed = await writeAppRevision(env, uid, appId, {
          kind: 'restore',
          author: 'human',
          valid: false,
          issues: error.issues,
          files,
          name,
          description: revisionManifest.description,
          permissions: requestedPermissions,
          rationale: revisionManifest.rationale,
          windowConfig,
          parentRevision: revisionId,
          summary: 'Failed restore — validation rejected',
        });
        failedRevisionId = failed.revisionId;
        const currentMeta = await env.DESKTOP_KV.get<AppRegistryMetadata>(`app:${appId}`, 'json');
        if (currentMeta && currentMeta.uid === uid) {
          await env.DESKTOP_KV.put(`app:${appId}`, JSON.stringify({
            ...currentMeta,
            current_revision: failed.revisionId,
          }));
        }
      } catch (revisionError) {
        console.error('Failed to record invalid app revision:', revisionError);
      }
      const issues: AppValidationIssue[] = error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.file ? { file: issue.file } : {}),
        ...(issue.evidence ? { evidence: issue.evidence } : {}),
        ...(issue.hint ? { hint: issue.hint } : {}),
      }));
      return Response.json(
        { error: message, issues, ...(failedRevisionId ? { revision: failedRevisionId } : {}) },
        { status: 400 },
      );
    }
    const status = /^(App source|App bundle|Invalid app|Duplicate app source|External |Dynamic imports |Imports from |Missing local asset|Source file name|App (reads|writes|deletes|uses|emits|listens))/.test(message) ? 400 : 500;
    return Response.json({ error: message }, { status });
  }
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
  await purgeAppBackend(env, appId).catch((error) => console.error('App backend purge failed:', error));

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

/**
 * GET /api/apps/:appId/backend/logs — recent console output and uncaught
 * exceptions from a full-stack app's server.js (owner only). Static apps
 * return an empty list.
 */
export async function handleAppBackendLogsRoute(
  request: Request,
  env: Env,
  auth: AuthContext,
  appId: string,
): Promise<Response> {
  const appMeta = await env.DESKTOP_KV.get<{ uid: string }>(`app:${appId}`, 'json');
  if (!appMeta) {
    return Response.json({ error: 'App not found' }, { status: 404 });
  }
  if (appMeta.uid !== auth.uid) {
    return Response.json({ error: 'Not authorized' }, { status: 403 });
  }
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
  const logs = await env.APP_RUNNER.getByName(`app:${appId}`).getLogs(Number.isFinite(limit) ? limit : 50);
  return Response.json({ logs });
}
