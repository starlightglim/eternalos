/**
 * Bazaar Routes — Community asset marketplace for EternalOS
 *
 * Users publish cursor packs, icon packs, sound packs, effect presets,
 * and full skins. Others browse and one-click install.
 *
 * Storage:
 *   R2: bazaar/{packId}/{filename}  — asset files + preview image
 *   KV: bazaar:pack:{packId}        — full pack record (JSON)
 *   BazaarCoordinator ("catalog")   — summary rows, type/author listings,
 *                                     per-user install counts, tombstones.
 *       (The legacy KV `bazaar:type:*` / `bazaar:author:*` indexes are only
 *       read once, to seed the catalogue.)
 *
 * Routes:
 *   POST   /api/bazaar/publish               — Publish a pack
 *   GET    /api/bazaar/browse?type=&q=&page=&limit=&cursor= — Browse/search packs
 *   GET    /api/bazaar/pack/:packId           — Get pack details
 *   POST   /api/bazaar/install/:packId        — Install (increment counter + return config)
 *   DELETE /api/bazaar/pack/:packId           — Unpublish (author only)
 *   GET    /api/bazaar/assets/:packId/:file   — Serve pack asset (public)
 *   GET    /api/bazaar/my-packs               — List your published packs
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { BazaarPack, PackType } from '../types';
import { sanitizeFilename, isFirstPartyAssetUrl } from '../utils/sanitize';
import { validateCartridge } from '../utils/cartridge';
import { setDraftPublishedPack } from './games';
import { validateManifestAgainstFiles, validateManifest, formatValidationErrors } from '../utils/estheme';
import type { EsthemeManifest } from '../utils/estheme';
import {
  BAZAAR_CATALOG_NAME,
  BROWSE_DEFAULT_LIMIT,
  BROWSE_MAX_LIMIT,
  type BazaarPackSummary,
} from '../durable-objects/BazaarCoordinator';

// Path within the zip — forward slashes, no `..`, no leading slash. Mirrors
// `bundlePathRegex` in utils/estheme so this file doesn't need a new export.
const BUNDLE_PATH_REGEX = /^(?!\.\.\/)(?!\/)(?!.*\/\.\.\/)[A-Za-z0-9._\-/]+$/;
// Reserved R2 keys we write ourselves. Assets may never use these paths,
// otherwise a form-field payload would overwrite the server-authoritative
// manifest and our install flow would serve unvalidated metadata.
const RESERVED_ESTHEME_PATHS = new Set(['manifest.json']);

// Constraints
const MAX_PACK_ASSETS = 20;
const MAX_ASSET_SIZE = 500 * 1024; // 500KB per asset
const MAX_PREVIEW_SIZE = 1024 * 1024; // 1MB preview
const MAX_PACKS_PER_USER = 50;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 10;
// Types accepted by the legacy flat-config publish route. Games publish via
// the dedicated /api/bazaar/publish-game route (cartridge validation).
const VALID_PACK_TYPES: PackType[] = ['cursor', 'icon', 'sound', 'effect', 'skin'];
// Types visible to browse/search.
const BROWSE_PACK_TYPES: PackType[] = [...VALID_PACK_TYPES, 'game'];

const ALLOWED_ASSET_TYPES: Record<string, boolean> = {
  'image/png': true, 'image/gif': true, 'image/webp': true,
  'image/svg+xml': true, 'image/x-icon': true, 'image/vnd.microsoft.icon': true,
  'audio/mpeg': true, 'audio/wav': true, 'audio/ogg': true, 'audio/webm': true,
  'image/jpeg': true,
  'application/x-navi-animation': true, // .ani cursor files
};

async function deleteR2Keys(env: Env, keys: string[]): Promise<void> {
  await Promise.allSettled(keys.map((key) => env.ETERNALOS_FILES.delete(key)));
}

// ---------------------------------------------------------------------------
// Catalogue (BazaarCoordinator) access
// ---------------------------------------------------------------------------

interface CatalogResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

async function catalogCall<T>(
  env: Env, path: string, body?: Record<string, unknown>,
): Promise<CatalogResult<T>> {
  const stub = env.BAZAAR_COORDINATOR.get(env.BAZAAR_COORDINATOR.idFromName(BAZAAR_CATALOG_NAME));
  const response = await stub.fetch(`https://bazaar-catalog${path}`, body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data: T;
  try {
    data = await response.json() as T;
  } catch {
    data = {} as T;
  }
  return { ok: response.ok, status: response.status, data };
}

async function catalogAuthorCount(env: Env, uid: string): Promise<number> {
  const result = await catalogCall<{ count?: number }>(env, `/count?uid=${encodeURIComponent(uid)}`);
  if (!result.ok) throw new Error(`Bazaar catalogue count failed (${result.status})`);
  return result.data.count ?? 0;
}

/**
 * Write the pack record and list it in the catalogue. The per-author limit is
 * re-checked atomically by the catalogue; returns a 400 response (after
 * undoing the KV write) when it's hit, or null on success.
 */
async function storeAndListPack(env: Env, pack: BazaarPack): Promise<Response | null> {
  await env.DESKTOP_KV.put(`bazaar:pack:${pack.packId}`, JSON.stringify(pack));
  const listed = await catalogCall<{ error?: string; code?: string }>(env, '/add', {
    summary: pack,
    maxPerAuthor: MAX_PACKS_PER_USER,
  });
  if (listed.ok) return null;
  if (listed.data.code === 'pack_limit') {
    await env.DESKTOP_KV.delete(`bazaar:pack:${pack.packId}`).catch(() => {});
    return Response.json({ error: `Max ${MAX_PACKS_PER_USER} packs per user` }, { status: 400 });
  }
  throw new Error(`Bazaar catalogue add failed (${listed.status})`);
}

async function cleanupPublishedPack(
  env: Env,
  packId: string,
  type: PackType,
  authorUid: string,
): Promise<void> {
  await Promise.allSettled([
    env.DESKTOP_KV.delete(`bazaar:pack:${packId}`),
    type === 'game' ? env.DESKTOP_KV.delete(`game:${packId}`) : Promise.resolve(),
    catalogCall(env, '/remove', { packId, authorUid }),
  ]);
}

/**
 * Account purge: unlist every pack the author has in the catalogue and return
 * their ids (the caller deletes records and R2 assets).
 */
export async function removeAuthorFromBazaarCatalog(env: Env, uid: string): Promise<string[]> {
  const result = await catalogCall<{ packIds?: string[] }>(env, '/remove-author', { uid });
  if (!result.ok) throw new Error(`Bazaar catalogue purge failed (${result.status})`);
  return result.data.packIds ?? [];
}

/**
 * Pick an R2 filename within a pack that no other file in this publish uses,
 * so two assets that sanitize to the same name (or to the preview's name)
 * can't overwrite each other. Adds "-2", "-3", ... before the extension.
 */
function uniqueFilename(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}${ext}`;
  used.add(candidate);
  return candidate;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export async function handleBazaarPublish(
  request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  const uploadedR2Keys: string[] = [];
  let publishedPackId: string | undefined;
  let publishedType: PackType | undefined;
  try {
    const formData = await request.formData();
    const manifestStr = formData.get('manifest');
    const preview = formData.get('preview');

    if (!manifestStr || typeof manifestStr !== 'string') {
      return Response.json({ error: 'Missing manifest' }, { status: 400 });
    }
    if (!preview || typeof preview === 'string') {
      return Response.json({ error: 'Missing preview image' }, { status: 400 });
    }

    let parsedManifest: unknown;
    try {
      parsedManifest = JSON.parse(manifestStr);
    } catch {
      return Response.json({ error: 'Invalid manifest JSON' }, { status: 400 });
    }
    if (!isPlainObject(parsedManifest)) {
      return Response.json({ error: 'Manifest must be a JSON object' }, { status: 400 });
    }
    const manifest = parsedManifest as {
      type: PackType; name: unknown; description?: unknown;
      tags?: unknown; config?: unknown;
    };

    // Validate manifest. Every field is client-supplied JSON, so check types
    // before calling string/array methods (a non-string name used to 500).
    if (!VALID_PACK_TYPES.includes(manifest.type)) {
      return Response.json({ error: `Invalid type. Must be: ${VALID_PACK_TYPES.join(', ')}` }, { status: 400 });
    }
    publishedType = manifest.type;
    if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > MAX_NAME_LENGTH) {
      return Response.json({ error: `Name required, max ${MAX_NAME_LENGTH} chars` }, { status: 400 });
    }
    const name = manifest.name.trim();
    if (manifest.description !== undefined && manifest.description !== null && typeof manifest.description !== 'string') {
      return Response.json({ error: 'Description must be a string' }, { status: 400 });
    }
    const description = typeof manifest.description === 'string' ? manifest.description : '';
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return Response.json({ error: `Description max ${MAX_DESCRIPTION_LENGTH} chars` }, { status: 400 });
    }
    if (manifest.tags !== undefined && manifest.tags !== null && !Array.isArray(manifest.tags)) {
      return Response.json({ error: 'Tags must be an array' }, { status: 400 });
    }
    if (manifest.config !== undefined && manifest.config !== null && !isPlainObject(manifest.config)) {
      return Response.json({ error: 'Config must be an object' }, { status: 400 });
    }

    const tags = ((manifest.tags as unknown[] | null | undefined) || []).slice(0, MAX_TAGS).map(t =>
      String(t).trim().toLowerCase().slice(0, 32)
    ).filter(Boolean);

    // Validate preview
    const previewBlob = preview as File;
    if (previewBlob.size > MAX_PREVIEW_SIZE) {
      return Response.json({ error: 'Preview too large (max 1MB)' }, { status: 400 });
    }

    // Check user's pack count (fail fast; the catalogue re-checks atomically)
    if (await catalogAuthorCount(env, auth.uid) >= MAX_PACKS_PER_USER) {
      return Response.json({ error: `Max ${MAX_PACKS_PER_USER} packs per user` }, { status: 400 });
    }

    // Collect asset files (fields named asset_*)
    const assetEntries: { key: string; file: File }[] = [];
    for (const [key, value] of formData.entries()) {
      if (key.startsWith('asset_') && typeof value !== 'string') {
        const assetKey = key.slice('asset_'.length);
        const file = value as File;
        if (file.size > MAX_ASSET_SIZE) {
          return Response.json({ error: `Asset "${assetKey}" too large (max 500KB)` }, { status: 400 });
        }
        if (!ALLOWED_ASSET_TYPES[file.type]) {
          return Response.json({ error: `Asset "${assetKey}" has invalid type: ${file.type}` }, { status: 400 });
        }
        assetEntries.push({ key: assetKey, file });
      }
    }
    if (assetEntries.length > MAX_PACK_ASSETS) {
      return Response.json({ error: `Max ${MAX_PACK_ASSETS} assets per pack` }, { status: 400 });
    }

    // Generate pack ID
    const packId = crypto.randomUUID();
    publishedPackId = packId;

    // Upload preview to R2. Every file in the pack gets a distinct name so
    // colliding sanitized names can't overwrite each other.
    const usedNames = new Set<string>();
    const previewName = uniqueFilename(sanitizeFilename(previewBlob.name || 'preview.png'), usedNames);
    const previewR2Key = `bazaar/${packId}/${previewName}`;
    await env.ETERNALOS_FILES.put(previewR2Key, await previewBlob.arrayBuffer(), {
      httpMetadata: { contentType: previewBlob.type },
      customMetadata: { type: 'bazaar-preview', packId },
    });
    uploadedR2Keys.push(previewR2Key);
    const previewUrl = `/api/bazaar/assets/${packId}/${previewName}`;

    // Upload assets to R2
    const assets: Record<string, string> = {};
    for (const entry of assetEntries) {
      const filename = uniqueFilename(sanitizeFilename(entry.file.name || `${entry.key}.png`), usedNames);
      const r2Key = `bazaar/${packId}/${filename}`;
      await env.ETERNALOS_FILES.put(r2Key, await entry.file.arrayBuffer(), {
        httpMetadata: { contentType: entry.file.type },
        customMetadata: { type: 'bazaar-asset', packId, assetKey: entry.key },
      });
      uploadedR2Keys.push(r2Key);
      assets[entry.key] = `/api/bazaar/assets/${packId}/${filename}`;
    }

    // Rewrite config URLs — replace placeholder asset keys with real URLs
    const config = { ...(manifest.config as Record<string, string | number | boolean> | null | undefined) };
    for (const [configKey, configVal] of Object.entries(config)) {
      if (typeof configVal === 'string') {
        // Replace {asset:KEY} placeholders with actual URLs
        for (const [assetKey, assetUrl] of Object.entries(assets)) {
          config[configKey] = (config[configKey] as string).replace(`{asset:${assetKey}}`, assetUrl);
        }
      }
    }

    // SECURITY: Validate config keys/values BEFORE they land in KV. On install
    // the client merges non-legacy keys into designTokens and PATCHes /profile;
    // the server-side profile validator is the authoritative gate, but we want
    // to reject obviously-malicious packs here too so they never see installers.
    //   - keys: dotted identifier, <= 100 chars
    //   - values: string/number/bool, strings <= 500 chars, no `{};` (CSS
    //     rule-terminators would enable CSS breakout) and no URLs outside
    //     first-party asset paths / the API's own origin
    for (const [cKey, cVal] of Object.entries(config)) {
      if (!/^[a-zA-Z][a-zA-Z0-9.\-]*$/.test(cKey) || cKey.length > 100) {
        return Response.json({ error: `Invalid config key: ${cKey}` }, { status: 400 });
      }
      if (typeof cVal !== 'string' && typeof cVal !== 'number' && typeof cVal !== 'boolean') {
        return Response.json({ error: `Invalid config value type for ${cKey}` }, { status: 400 });
      }
      if (typeof cVal === 'string') {
        if (cVal.length > 500) {
          return Response.json({ error: `config value too long for ${cKey}` }, { status: 400 });
        }
        if (/[{};]/.test(cVal)) {
          return Response.json({ error: `config value contains disallowed CSS punctuation for ${cKey}` }, { status: 400 });
        }
        if (cKey.startsWith('cursor.image.') && cVal.trim().length > 0) {
          // Origin-aware allowlist (the old base-parse pathname check let a
          // cross-origin URL with an allowlisted path through). See
          // isFirstPartyAssetUrl in utils/sanitize.ts.
          const bareUrl = cVal.split('|')[0].trim();
          if (!isFirstPartyAssetUrl(bareUrl, new URL(request.url).origin)) {
            return Response.json({ error: `config ${cKey}: URL must reference first-party assets` }, { status: 400 });
          }
        }
      }
    }

    const authorUsername = auth.username;

    // Build pack
    const pack: BazaarPack = {
      packId,
      type: manifest.type,
      name: name.slice(0, MAX_NAME_LENGTH),
      description: description.trim().slice(0, MAX_DESCRIPTION_LENGTH),
      authorUid: auth.uid,
      authorUsername,
      version: '1.0.0',
      previewUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      installs: 0,
      tags,
      assets,
      config,
    };

    // Store in KV + list in the catalogue (serialized type/author indexes)
    const limitError = await storeAndListPack(env, pack);
    if (limitError) {
      await deleteR2Keys(env, uploadedR2Keys);
      return limitError;
    }

    return Response.json({ success: true, pack });
  } catch (error) {
    console.error('Bazaar publish error:', error);
    if (publishedPackId) {
      await deleteR2Keys(env, uploadedR2Keys);
      await cleanupPublishedPack(env, publishedPackId, publishedType ?? 'skin', auth.uid);
    }
    return Response.json({ error: 'Failed to publish pack' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Publish game cartridge
// ---------------------------------------------------------------------------

/**
 * POST /api/bazaar/publish-game
 *
 * Multipart form:
 *   cartridge: JSON string (validated Cartridge format)
 *   preview:   cover image file (required on first publish)
 *   packId:    optional — republish/update an existing game you own
 *
 * Stores cartridge JSON at bazaar/{packId}/cartridge.json and writes the
 * play-route pointer KV `game:{packId}` → { uid, version, r2Key }. The
 * version is a monotonic integer that re-keys the Dynamic Worker isolate
 * cache so updates go live on the next play.
 */
export async function handleBazaarPublishGame(
  request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  const uploadedR2Keys: string[] = [];
  let publishedPackId: string | undefined;
  let republishPackJson: string | undefined;
  let republishGameMeta: { uid: string; version: number; r2Key: string } | null | undefined;
  try {
    const formData = await request.formData();
    const cartridgeStr = formData.get('cartridge');
    const preview = formData.get('preview');
    const existingPackId = formData.get('packId');
    const draftId = formData.get('draftId');

    if (!cartridgeStr || typeof cartridgeStr !== 'string') {
      return Response.json({ error: 'Missing cartridge' }, { status: 400 });
    }

    let rawCartridge: unknown;
    try {
      rawCartridge = JSON.parse(cartridgeStr);
    } catch {
      return Response.json({ error: 'Invalid cartridge JSON' }, { status: 400 });
    }

    const validation = validateCartridge(rawCartridge);
    if (!validation.ok || !validation.cartridge) {
      return Response.json(
        { error: `Invalid cartridge: ${validation.errors[0] ?? 'unknown'}`, details: validation.errors },
        { status: 400 },
      );
    }
    const cartridge = validation.cartridge;
    // Authorship is server-asserted, never client-supplied.
    cartridge.meta.author = auth.username;

    const tags = ['game'];

    // ----- republish path -----
    if (existingPackId && typeof existingPackId === 'string') {
      publishedPackId = existingPackId;
      const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${existingPackId}`);
      if (!packStr) return Response.json({ error: 'Pack not found' }, { status: 404 });
      const pack = JSON.parse(packStr) as BazaarPack;
      if (pack.authorUid !== auth.uid || pack.type !== 'game') {
        return Response.json({ error: 'Not authorized' }, { status: 403 });
      }

      const gameMeta = await env.DESKTOP_KV.get<{ uid: string; version: number; r2Key: string }>(
        `game:${existingPackId}`, 'json'
      );
      republishPackJson = packStr;
      republishGameMeta = gameMeta;
      const nextVersion = (gameMeta?.version ?? 0) + 1;
      const r2Key = `bazaar/${existingPackId}/cartridge.v${nextVersion}.json`;

      await env.ETERNALOS_FILES.put(r2Key, JSON.stringify(cartridge), {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { type: 'bazaar-game-cartridge', packId: existingPackId },
      });
      uploadedR2Keys.push(r2Key);

      if (preview && typeof preview !== 'string') {
        const previewBlob = preview as File;
        if (previewBlob.size > MAX_PREVIEW_SIZE) {
          return Response.json({ error: 'Preview too large (max 1MB)' }, { status: 400 });
        }
        const previewName = `${crypto.randomUUID()}-${sanitizeFilename(previewBlob.name || 'cover.png')}`;
        const previewR2Key = `bazaar/${existingPackId}/${previewName}`;
        await env.ETERNALOS_FILES.put(previewR2Key, await previewBlob.arrayBuffer(), {
          httpMetadata: { contentType: previewBlob.type },
          customMetadata: { type: 'bazaar-preview', packId: existingPackId },
        });
        uploadedR2Keys.push(previewR2Key);
        pack.previewUrl = `/api/bazaar/assets/${existingPackId}/${previewName}`;
      }

      pack.name = cartridge.meta.name;
      pack.description = cartridge.meta.description ?? '';
      pack.version = cartridge.meta.version;
      pack.updatedAt = Date.now();

      // Refresh the catalogue row first: if the pack was deleted meanwhile,
      // its tombstone stops us from writing the KV record back.
      const updated = await catalogCall<{ deleted?: boolean; installs?: number }>(env, '/update', { summary: pack });
      if (updated.ok && typeof updated.data.installs === 'number') pack.installs = updated.data.installs;
      if (!updated.ok && (updated.status !== 404 || updated.data.deleted)) {
        await deleteR2Keys(env, uploadedR2Keys);
        return updated.status === 404 || updated.status === 403
          ? Response.json({ error: updated.status === 404 ? 'Pack not found' : 'Not authorized' }, { status: updated.status })
          : Response.json({ error: 'Failed to publish game' }, { status: 500 });
      }

      await env.DESKTOP_KV.put(`bazaar:pack:${existingPackId}`, JSON.stringify(pack));
      await env.DESKTOP_KV.put(`game:${existingPackId}`, JSON.stringify({
        uid: auth.uid, version: nextVersion, r2Key,
      }));

      if (draftId && typeof draftId === 'string') {
        await setDraftPublishedPack(env, auth.uid, draftId, existingPackId);
      }

      return Response.json({ success: true, pack });
    }

    // ----- first publish -----
    if (!preview || typeof preview === 'string') {
      return Response.json({ error: 'Missing cover image' }, { status: 400 });
    }
    const previewBlob = preview as File;
    if (previewBlob.size > MAX_PREVIEW_SIZE) {
      return Response.json({ error: 'Preview too large (max 1MB)' }, { status: 400 });
    }

    if (await catalogAuthorCount(env, auth.uid) >= MAX_PACKS_PER_USER) {
      return Response.json({ error: `Max ${MAX_PACKS_PER_USER} packs per user` }, { status: 400 });
    }

    const packId = crypto.randomUUID();
    publishedPackId = packId;
    const r2Key = `bazaar/${packId}/cartridge.json`;

    await env.ETERNALOS_FILES.put(r2Key, JSON.stringify(cartridge), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { type: 'bazaar-game-cartridge', packId },
    });
    uploadedR2Keys.push(r2Key);

    // A cover named like a cartridge file (cartridge.json, cartridge.v2.json)
    // would overwrite — or later be overwritten by — the cartridge itself.
    const coverName = sanitizeFilename(previewBlob.name || 'cover.png');
    const previewName = /^cartridge/i.test(coverName) ? `cover-${coverName}` : coverName;
    await env.ETERNALOS_FILES.put(`bazaar/${packId}/${previewName}`, await previewBlob.arrayBuffer(), {
      httpMetadata: { contentType: previewBlob.type },
      customMetadata: { type: 'bazaar-preview', packId },
    });
    uploadedR2Keys.push(`bazaar/${packId}/${previewName}`);

    const pack: BazaarPack = {
      packId,
      type: 'game',
      name: cartridge.meta.name,
      description: cartridge.meta.description ?? '',
      authorUid: auth.uid,
      authorUsername: auth.username,
      version: cartridge.meta.version,
      previewUrl: `/api/bazaar/assets/${packId}/${previewName}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      installs: 0,
      tags,
      assets: { cartridge: `/api/games/play/${packId}/cartridge.json` },
      config: {},
    };

    await env.DESKTOP_KV.put(`game:${packId}`, JSON.stringify({ uid: auth.uid, version: 1, r2Key }));
    const limitError = await storeAndListPack(env, pack);
    if (limitError) {
      await env.DESKTOP_KV.delete(`game:${packId}`).catch(() => {});
      await deleteR2Keys(env, uploadedR2Keys);
      return limitError;
    }

    if (draftId && typeof draftId === 'string') {
      await setDraftPublishedPack(env, auth.uid, draftId, packId);
    }

    return Response.json({ success: true, pack });
  } catch (error) {
    console.error('Bazaar publish-game error:', error);
    await deleteR2Keys(env, uploadedR2Keys);
    if (publishedPackId && republishPackJson) {
      await env.DESKTOP_KV.put(`bazaar:pack:${publishedPackId}`, republishPackJson).catch(() => {});
      if (republishGameMeta) {
        await env.DESKTOP_KV.put(`game:${publishedPackId}`, JSON.stringify(republishGameMeta)).catch(() => {});
      } else {
        await env.DESKTOP_KV.delete(`game:${publishedPackId}`).catch(() => {});
      }
    } else if (publishedPackId) {
      await cleanupPublishedPack(env, publishedPackId, 'game', auth.uid);
    }
    return Response.json({ error: 'Failed to publish game' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

export async function handleBazaarBrowse(
  request: Request, env: Env
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') as PackType | null;
    const query = url.searchParams.get('q')?.trim().slice(0, 100);
    const parsedPage = parseInt(url.searchParams.get('page') || '1', 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const parsedLimit = parseInt(url.searchParams.get('limit') || '', 10);
    const pageSize = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, BROWSE_MAX_LIMIT)
      : BROWSE_DEFAULT_LIMIT;
    const cursor = url.searchParams.get('cursor');

    // One catalogue call: the summary rows are paged/filtered in SQLite, so
    // no per-pack KV reads (an unknown type still means "all types").
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (type && BROWSE_PACK_TYPES.includes(type)) params.set('type', type);
    if (query) params.set('q', query);
    if (cursor) params.set('cursor', cursor.slice(0, 512));
    else params.set('offset', String((page - 1) * pageSize));

    const result = await catalogCall<{ packs: BazaarPackSummary[]; total: number; nextCursor?: string }>(
      env, `/browse?${params}`,
    );
    if (!result.ok) throw new Error(`Bazaar catalogue browse failed (${result.status})`);

    const body: Record<string, unknown> = {
      packs: result.data.packs,
      total: result.data.total,
      page,
      pageSize,
    };
    if (result.data.nextCursor) body.nextCursor = result.data.nextCursor;
    return Response.json(body);
  } catch (error) {
    console.error('Bazaar browse error:', error);
    return Response.json({ error: 'Failed to browse' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Get single pack
// ---------------------------------------------------------------------------

export async function handleBazaarGetPack(
  request: Request, env: Env, packId: string
): Promise<Response> {
  const [packStr, state] = await Promise.all([
    env.DESKTOP_KV.get(`bazaar:pack:${packId}`),
    catalogCall<{ listed?: boolean; deleted?: boolean; installs?: number }>(
      env, `/state?packId=${encodeURIComponent(packId)}`,
    ),
  ]);
  // A tombstoned pack stays gone even if a racing write left its KV record.
  if (!packStr || (state.ok && state.data.deleted)) {
    return Response.json({ error: 'Pack not found' }, { status: 404 });
  }
  const pack = JSON.parse(packStr) as BazaarPack & { manifestVersion?: number };
  // The catalogue owns install counts; the KV copy is no longer updated.
  if (state.ok && typeof state.data.installs === 'number') pack.installs = state.data.installs;

  // If this is a .estheme pack (manifestVersion set at publish), also return
  // the manifest so the client can apply it without a second round trip.
  let manifest: EsthemeManifest | null = null;
  if (pack.manifestVersion === 1) {
    const manifestObj = await env.ETERNALOS_FILES.get(`bazaar/${packId}/manifest.json`);
    if (manifestObj) {
      try {
        const raw = await manifestObj.json();
        // SECURITY: Re-validate the manifest on read. Although publish now
        // writes the validated manifest AFTER asset uploads to defeat path
        // collisions, this is defense in depth: if any future code path
        // writes to `bazaar/{packId}/manifest.json` out-of-band, installers
        // will only ever receive a fully zod-checked manifest.
        const result = validateManifest(raw);
        manifest = result.ok ? result.manifest : null;
      } catch {
        manifest = null;
      }
    }
  }

  return Response.json({ pack, manifest });
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function handleBazaarInstall(
  request: Request, env: Env, auth: AuthContext, packId: string
): Promise<Response> {
  // Counted once per user; deleted or unlisted packs are a 404. The catalogue
  // never writes the KV pack record, so it can't clobber an author update or
  // resurrect a deleted pack.
  const counted = await catalogCall<{ installs?: number; error?: string }>(env, '/install', {
    packId, uid: auth.uid,
  });
  if (!counted.ok) {
    return Response.json(
      { error: counted.data.error || 'Install failed' },
      { status: counted.status === 404 ? 404 : counted.status === 400 ? 400 : 500 },
    );
  }

  const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${packId}`);
  if (!packStr) return Response.json({ error: 'Pack not found' }, { status: 404 });
  const pack = JSON.parse(packStr) as BazaarPack;
  if (typeof counted.data.installs === 'number') pack.installs = counted.data.installs;
  return Response.json({ success: true, config: pack.config, pack });
}

// ---------------------------------------------------------------------------
// Delete (author only)
// ---------------------------------------------------------------------------

export async function handleBazaarDelete(
  request: Request, env: Env, auth: AuthContext, packId: string
): Promise<Response> {
  const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${packId}`);
  if (!packStr) {
    // No record, but a stale catalogue row may remain (e.g. an interrupted
    // delete): let the author clear it.
    const removed = await catalogCall<{ removed?: boolean }>(env, '/remove', { packId, authorUid: auth.uid });
    if (removed.ok && removed.data.removed) return Response.json({ success: true });
    if (removed.status === 403) return Response.json({ error: 'Not authorized' }, { status: 403 });
    return Response.json({ error: 'Pack not found' }, { status: 404 });
  }

  const pack: BazaarPack = JSON.parse(packStr);
  if (pack.authorUid !== auth.uid) {
    return Response.json({ error: 'Not authorized' }, { status: 403 });
  }

  // Unlist + tombstone first, so no install or republish can bring it back
  // while the record and assets are being deleted.
  const removed = await catalogCall(env, '/remove', { packId, authorUid: auth.uid });
  if (!removed.ok) {
    return removed.status === 403
      ? Response.json({ error: 'Not authorized' }, { status: 403 })
      : Response.json({ error: 'Failed to delete pack' }, { status: 500 });
  }

  // Delete assets from R2
  let listCursor: string | undefined;
  do {
    const r2List = await env.ETERNALOS_FILES.list({ prefix: `bazaar/${packId}/`, cursor: listCursor });
    const keys = r2List.objects.map((obj) => obj.key);
    if (keys.length > 0) await env.ETERNALOS_FILES.delete(keys);
    listCursor = r2List.truncated ? r2List.cursor : undefined;
  } while (listCursor);

  // Remove from KV
  await env.DESKTOP_KV.delete(`bazaar:pack:${packId}`);

  // Game packs also have a play-route pointer
  if (pack.type === 'game') {
    await env.DESKTOP_KV.delete(`game:${packId}`);
  }

  return Response.json({ success: true });
}

// ---------------------------------------------------------------------------
// Serve asset (public, cacheable)
// ---------------------------------------------------------------------------

export async function handleBazaarServeAsset(
  request: Request, env: Env, packId: string, filename: string
): Promise<Response> {
  const r2Key = `bazaar/${packId}/${filename}`;
  const object = await env.ETERNALOS_FILES.get(r2Key);

  if (!object) return Response.json({ error: 'Asset not found' }, { status: 404 });

  // Validate Content-Type against allowlist — fall back to image/png for image assets
  const storedType = object.httpMetadata?.contentType || '';
  let contentType = storedType;
  if (!ALLOWED_ASSET_TYPES[storedType]) {
    // Guess from file extension
    const ext = filename.split('.').pop()?.toLowerCase();
    const extMap: Record<string, string> = {
      'png': 'image/png', 'gif': 'image/gif', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
      'webp': 'image/webp', 'svg': 'image/svg+xml', 'cur': 'image/x-icon', 'ico': 'image/x-icon',
      'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
    };
    contentType = (ext && extMap[ext]) || 'application/octet-stream';
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Length', object.size.toString());
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// My Packs
// ---------------------------------------------------------------------------

export async function handleBazaarMyPacks(
  request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  // Summary rows from the catalogue (newest first) — one call, no per-pack reads.
  const result = await catalogCall<{ packs?: BazaarPackSummary[] }>(
    env, `/author?uid=${encodeURIComponent(auth.uid)}`,
  );
  if (!result.ok) return Response.json({ error: 'Failed to list packs' }, { status: 500 });
  const packs = result.data.packs ?? [];

  return Response.json({ packs });
}

// ---------------------------------------------------------------------------
// .estheme publish
// ---------------------------------------------------------------------------

/**
 * Publish a .estheme bundle. Client unzips on the client (JSZip) and sends:
 *   - `manifest` form field: the manifest JSON string
 *   - `preview` form field: preview PNG/JPEG Blob (required, ≤1MB)
 *   - `file_<path>` form fields: one per asset referenced by the manifest.
 *     Path matches the zip-relative path from the manifest's layer refs.
 *
 * Why client-unzips: Workers have limited zip libraries and we don't want to
 * pay CPU on every publish. The client already has JSZip for export/install
 * preview anyway.
 *
 * This endpoint:
 *   1. Validates manifest with zod + cross-checks against provided file fields.
 *   2. Verifies author matches authenticated user.
 *   3. Enforces size / count constraints.
 *   4. Uploads manifest.json + assets to R2 at bazaar/{packId}/.
 *   5. Creates a BazaarPack row in KV.
 */
export async function handleBazaarPublishEstheme(
  request: Request, env: Env, auth: AuthContext
): Promise<Response> {
  const uploadedR2Keys: string[] = [];
  let publishedPackId: string | undefined;
  try {
    const formData = await request.formData();

    // 1. Manifest
    const manifestRaw = formData.get('manifest');
    if (typeof manifestRaw !== 'string' || !manifestRaw) {
      return Response.json({ error: 'Missing manifest field' }, { status: 400 });
    }
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestRaw);
    } catch {
      return Response.json({ error: 'Invalid manifest JSON' }, { status: 400 });
    }

    // 2. Collect file fields — anything named "file_*"
    const assetFields: { path: string; file: File }[] = [];
    for (const [key, value] of formData.entries()) {
      if (!key.startsWith('file_')) continue;
      if (typeof value === 'string') continue;
      const file = value as File;
      const path = key.slice('file_'.length);
      if (!path) continue;
      // SECURITY: Validate the asset path against the same regex used for
      // manifest-declared bundle paths. Without this check, a form field like
      // `file_../OTHER_PACK/x.css` writes outside the pack's R2 prefix, and
      // `file_manifest.json` would overwrite the server-validated manifest
      // that we write moments later.
      if (path.length > 200 || !BUNDLE_PATH_REGEX.test(path)) {
        return Response.json(
          { error: `Invalid asset path: ${path}` },
          { status: 400 }
        );
      }
      if (RESERVED_ESTHEME_PATHS.has(path)) {
        return Response.json(
          { error: `Reserved asset path: ${path}` },
          { status: 400 }
        );
      }
      if (file.size > MAX_ASSET_SIZE) {
        return Response.json(
          { error: `Asset "${path}" too large (max ${MAX_ASSET_SIZE / 1024}KB)` },
          { status: 400 }
        );
      }
      // SECURITY: Enforce the same MIME allowlist as the legacy publish flow.
      // Without this an attacker could upload a `text/html` asset and, since
      // the serving handler echoes the stored Content-Type, reference it from
      // the manifest as a "CSS layer" to coax a browser render.
      const fileType = file.type || 'application/octet-stream';
      if (!ALLOWED_ASSET_TYPES[fileType] && fileType !== 'text/css' && fileType !== 'application/json') {
        return Response.json(
          { error: `Asset "${path}" has invalid type: ${fileType}` },
          { status: 400 }
        );
      }
      if (assetFields.some((a) => a.path === path)) {
        return Response.json({ error: `Duplicate asset path: ${path}` }, { status: 400 });
      }
      assetFields.push({ path, file });
    }
    if (assetFields.length > MAX_PACK_ASSETS) {
      return Response.json(
        { error: `Max ${MAX_PACK_ASSETS} assets per pack` },
        { status: 400 }
      );
    }

    // 3. Validate manifest against declared files
    const fileIndex = new Set(assetFields.map((a) => a.path));
    const validation = validateManifestAgainstFiles(manifestJson, fileIndex);
    if (!validation.ok) {
      return Response.json(
        { error: formatValidationErrors(validation.errors), details: validation.errors },
        { status: 400 }
      );
    }
    const manifest = validation.manifest;

    // 4. Author check — manifest.author must match authenticated user
    const expectedAuthor = `@${auth.username}`;
    if (manifest.author !== expectedAuthor) {
      return Response.json(
        { error: `Manifest author (${manifest.author}) does not match authenticated user (${expectedAuthor})` },
        { status: 403 }
      );
    }

    // 5. Preview image
    const previewField = formData.get('preview');
    if (!previewField || typeof previewField === 'string') {
      return Response.json({ error: 'Missing preview image' }, { status: 400 });
    }
    const preview = previewField as File;
    if (preview.size > MAX_PREVIEW_SIZE) {
      return Response.json({ error: 'Preview too large (max 1MB)' }, { status: 400 });
    }
    const allowedPreviewTypes = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowedPreviewTypes.includes(preview.type)) {
      return Response.json(
        { error: `Preview must be PNG/JPEG/WebP; got ${preview.type}` },
        { status: 400 }
      );
    }

    // 6. Pack count limit per author (fail fast; re-checked atomically on list)
    if (await catalogAuthorCount(env, auth.uid) >= MAX_PACKS_PER_USER) {
      return Response.json(
        { error: `Max ${MAX_PACKS_PER_USER} packs per user` },
        { status: 400 }
      );
    }

    // 7. Upload everything to R2
    const packId = crypto.randomUUID();
    publishedPackId = packId;
    const r2Prefix = `bazaar/${packId}`;

    // The preview must not share a key with an asset or the manifest, or one
    // upload would overwrite the other.
    const usedPaths = new Set<string>([...RESERVED_ESTHEME_PATHS, ...assetFields.map((a) => a.path)]);
    const previewFilename = uniqueFilename(sanitizeFilename(preview.name || 'preview.png'), usedPaths);
    const previewR2Key = `${r2Prefix}/${previewFilename}`;
    await env.ETERNALOS_FILES.put(previewR2Key, await preview.arrayBuffer(), {
      httpMetadata: { contentType: preview.type },
      customMetadata: { type: 'estheme-preview', packId },
    });
    uploadedR2Keys.push(previewR2Key);

    // Store each asset at its declared path within the pack prefix FIRST, so
    // that if any collision slips past path validation, the server-validated
    // manifest write below wins.
    for (const entry of assetFields) {
      const r2Key = `${r2Prefix}/${entry.path}`;
      await env.ETERNALOS_FILES.put(r2Key, await entry.file.arrayBuffer(), {
        httpMetadata: { contentType: entry.file.type || 'application/octet-stream' },
        customMetadata: { type: 'estheme-asset', packId, assetPath: entry.path },
      });
      uploadedR2Keys.push(r2Key);
    }

    // Store the validated manifest AFTER assets so its R2 key (manifest.json)
    // cannot be clobbered by an attacker-supplied `file_manifest.json` form
    // field — this ensures installers always read the zod-validated manifest.
    const manifestR2Key = `${r2Prefix}/manifest.json`;
    await env.ETERNALOS_FILES.put(manifestR2Key, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { type: 'estheme-manifest', packId },
    });
    uploadedR2Keys.push(manifestR2Key);

    // 8. Build pack record
    const previewUrl = `/api/bazaar/assets/${packId}/${previewFilename}`;
    const pack: BazaarPack & { manifestVersion: 1; parentPackId?: string } = {
      packId,
      type: 'skin', // Reuse 'skin' type for back-compat with browse/install UI
      name: manifest.name,
      description: manifest.description ?? '',
      authorUid: auth.uid,
      authorUsername: auth.username,
      version: manifest.version,
      previewUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      installs: 0,
      tags: manifest.tags ?? [],
      // Legacy fields — estheme packs don't use them, but keep shape compatible
      assets: {},
      config: {},
      // New fields distinguishing estheme packs
      manifestVersion: 1,
      parentPackId: manifest.extends,
    };

    // 9. Persist record + catalogue listing
    const limitError = await storeAndListPack(env, pack);
    if (limitError) {
      await deleteR2Keys(env, uploadedR2Keys);
      return limitError;
    }

    return Response.json({ success: true, pack, manifest });
  } catch (error) {
    console.error('Bazaar estheme publish error:', error);
    if (publishedPackId) {
      await deleteR2Keys(env, uploadedR2Keys);
      await cleanupPublishedPack(env, publishedPackId, 'skin', auth.uid);
    }
    return Response.json({ error: 'Failed to publish theme' }, { status: 500 });
  }
}

/**
 * Suppress TS unused warnings on imports that are only used via type narrowing
 * inside JSON bodies. Compiler sees the types; eslint doesn't always.
 */
export type { EsthemeManifest };
