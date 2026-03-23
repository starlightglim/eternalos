/**
 * Bazaar Routes — Community asset marketplace for EternalOS
 *
 * Users publish cursor packs, icon packs, sound packs, effect presets,
 * and full skins. Others browse and one-click install.
 *
 * Storage:
 *   R2: bazaar/{packId}/{filename}  — asset files + preview image
 *   KV: bazaar:pack:{packId}        — pack metadata (JSON)
 *       bazaar:type:{type}          — array of packIds sorted by installs
 *       bazaar:author:{uid}         — array of packIds by author
 *
 * Routes:
 *   POST   /api/bazaar/publish               — Publish a pack
 *   GET    /api/bazaar/browse?type=&q=        — Browse/search packs
 *   GET    /api/bazaar/pack/:packId           — Get pack details
 *   POST   /api/bazaar/install/:packId        — Install (increment counter + return config)
 *   DELETE /api/bazaar/pack/:packId           — Unpublish (author only)
 *   GET    /api/bazaar/assets/:packId/:file   — Serve pack asset (public)
 *   GET    /api/bazaar/my-packs               — List your published packs
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { BazaarPack, PackType } from '../types';
import { sanitizeFilename } from '../utils/sanitize';

// Constraints
const MAX_PACK_ASSETS = 20;
const MAX_ASSET_SIZE = 500 * 1024; // 500KB per asset
const MAX_PREVIEW_SIZE = 1024 * 1024; // 1MB preview
const MAX_PACKS_PER_USER = 50;
const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 10;
const VALID_PACK_TYPES: PackType[] = ['cursor', 'icon', 'sound', 'effect', 'skin'];

const ALLOWED_ASSET_TYPES: Record<string, boolean> = {
  'image/png': true, 'image/gif': true, 'image/webp': true,
  'image/svg+xml': true, 'image/x-icon': true, 'image/vnd.microsoft.icon': true,
  'audio/mpeg': true, 'audio/wav': true, 'audio/ogg': true, 'audio/webm': true,
  'image/jpeg': true,
  'application/x-navi-animation': true, // .ani cursor files
};

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export async function handleBazaarPublish(
  request: Request, env: Env, auth: AuthContext
): Promise<Response> {
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

    let manifest: {
      type: PackType; name: string; description: string;
      tags: string[]; config: Record<string, string | number | boolean>;
    };
    try {
      manifest = JSON.parse(manifestStr);
    } catch {
      return Response.json({ error: 'Invalid manifest JSON' }, { status: 400 });
    }

    // Validate manifest
    if (!VALID_PACK_TYPES.includes(manifest.type)) {
      return Response.json({ error: `Invalid type. Must be: ${VALID_PACK_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!manifest.name || manifest.name.length > MAX_NAME_LENGTH) {
      return Response.json({ error: `Name required, max ${MAX_NAME_LENGTH} chars` }, { status: 400 });
    }
    if (manifest.description && manifest.description.length > MAX_DESCRIPTION_LENGTH) {
      return Response.json({ error: `Description max ${MAX_DESCRIPTION_LENGTH} chars` }, { status: 400 });
    }

    const tags = (manifest.tags || []).slice(0, MAX_TAGS).map(t =>
      String(t).trim().toLowerCase().slice(0, 32)
    ).filter(Boolean);

    // Validate preview
    const previewBlob = preview as File;
    if (previewBlob.size > MAX_PREVIEW_SIZE) {
      return Response.json({ error: 'Preview too large (max 1MB)' }, { status: 400 });
    }

    // Check user's pack count
    const authorPacksStr = await env.DESKTOP_KV.get(`bazaar:author:${auth.uid}`);
    const authorPacks: string[] = authorPacksStr ? JSON.parse(authorPacksStr) : [];
    if (authorPacks.length >= MAX_PACKS_PER_USER) {
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

    // Upload preview to R2
    const previewName = sanitizeFilename(previewBlob.name || 'preview.png');
    const previewR2Key = `bazaar/${packId}/${previewName}`;
    await env.ETERNALOS_FILES.put(previewR2Key, await previewBlob.arrayBuffer(), {
      httpMetadata: { contentType: previewBlob.type },
      customMetadata: { type: 'bazaar-preview', packId },
    });
    const previewUrl = `/api/bazaar/assets/${packId}/${previewName}`;

    // Upload assets to R2
    const assets: Record<string, string> = {};
    for (const entry of assetEntries) {
      const filename = sanitizeFilename(entry.file.name || `${entry.key}.png`);
      const r2Key = `bazaar/${packId}/${filename}`;
      await env.ETERNALOS_FILES.put(r2Key, await entry.file.arrayBuffer(), {
        httpMetadata: { contentType: entry.file.type },
        customMetadata: { type: 'bazaar-asset', packId, assetKey: entry.key },
      });
      assets[entry.key] = `/api/bazaar/assets/${packId}/${filename}`;
    }

    // Rewrite config URLs — replace placeholder asset keys with real URLs
    const config = { ...manifest.config };
    for (const [configKey, configVal] of Object.entries(config)) {
      if (typeof configVal === 'string') {
        // Replace {asset:KEY} placeholders with actual URLs
        for (const [assetKey, assetUrl] of Object.entries(assets)) {
          config[configKey] = (config[configKey] as string).replace(`{asset:${assetKey}}`, assetUrl);
        }
      }
    }

    const authorUsername = auth.username;

    // Build pack
    const pack: BazaarPack = {
      packId,
      type: manifest.type,
      name: manifest.name.trim().slice(0, MAX_NAME_LENGTH),
      description: (manifest.description || '').trim().slice(0, MAX_DESCRIPTION_LENGTH),
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

    // Store in KV
    await env.DESKTOP_KV.put(`bazaar:pack:${packId}`, JSON.stringify(pack));

    // Update type index
    const typeIndexStr = await env.DESKTOP_KV.get(`bazaar:type:${manifest.type}`);
    const typeIndex: string[] = typeIndexStr ? JSON.parse(typeIndexStr) : [];
    typeIndex.unshift(packId);
    await env.DESKTOP_KV.put(`bazaar:type:${manifest.type}`, JSON.stringify(typeIndex));

    // Update author index
    authorPacks.unshift(packId);
    await env.DESKTOP_KV.put(`bazaar:author:${auth.uid}`, JSON.stringify(authorPacks));

    return Response.json({ success: true, pack });
  } catch (error) {
    console.error('Bazaar publish error:', error);
    return Response.json({ error: 'Failed to publish pack' }, { status: 500 });
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
    const query = url.searchParams.get('q')?.toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = 20;

    let packIds: string[] = [];

    if (type && VALID_PACK_TYPES.includes(type)) {
      const indexStr = await env.DESKTOP_KV.get(`bazaar:type:${type}`);
      packIds = indexStr ? JSON.parse(indexStr) : [];
    } else {
      // All types — merge all type indexes
      for (const t of VALID_PACK_TYPES) {
        const indexStr = await env.DESKTOP_KV.get(`bazaar:type:${t}`);
        if (indexStr) packIds.push(...JSON.parse(indexStr));
      }
    }

    // Fetch pack details
    const packs: BazaarPack[] = [];
    for (const id of packIds) {
      const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${id}`);
      if (packStr) packs.push(JSON.parse(packStr));
    }

    // Sort by installs descending
    packs.sort((a, b) => b.installs - a.installs);

    // Search filter
    let filtered = packs;
    if (query) {
      filtered = packs.filter(p =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.tags.some(t => t.includes(query)) ||
        p.authorUsername.toLowerCase().includes(query)
      );
    }

    // Paginate
    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const results = filtered.slice(start, start + pageSize);

    return Response.json({ packs: results, total, page, pageSize });
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
  const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${packId}`);
  if (!packStr) return Response.json({ error: 'Pack not found' }, { status: 404 });
  return Response.json({ pack: JSON.parse(packStr) });
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export async function handleBazaarInstall(
  request: Request, env: Env, auth: AuthContext, packId: string
): Promise<Response> {
  const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${packId}`);
  if (!packStr) return Response.json({ error: 'Pack not found' }, { status: 404 });

  const pack: BazaarPack = JSON.parse(packStr);

  // Increment install counter
  pack.installs++;
  pack.updatedAt = Date.now();
  await env.DESKTOP_KV.put(`bazaar:pack:${packId}`, JSON.stringify(pack));

  return Response.json({ success: true, config: pack.config, pack });
}

// ---------------------------------------------------------------------------
// Delete (author only)
// ---------------------------------------------------------------------------

export async function handleBazaarDelete(
  request: Request, env: Env, auth: AuthContext, packId: string
): Promise<Response> {
  const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${packId}`);
  if (!packStr) return Response.json({ error: 'Pack not found' }, { status: 404 });

  const pack: BazaarPack = JSON.parse(packStr);
  if (pack.authorUid !== auth.uid) {
    return Response.json({ error: 'Not authorized' }, { status: 403 });
  }

  // Delete assets from R2
  const r2List = await env.ETERNALOS_FILES.list({ prefix: `bazaar/${packId}/` });
  for (const obj of r2List.objects) {
    await env.ETERNALOS_FILES.delete(obj.key);
  }

  // Remove from KV
  await env.DESKTOP_KV.delete(`bazaar:pack:${packId}`);

  // Remove from type index
  const typeIndexStr = await env.DESKTOP_KV.get(`bazaar:type:${pack.type}`);
  if (typeIndexStr) {
    const typeIndex: string[] = JSON.parse(typeIndexStr);
    const updated = typeIndex.filter(id => id !== packId);
    await env.DESKTOP_KV.put(`bazaar:type:${pack.type}`, JSON.stringify(updated));
  }

  // Remove from author index
  const authorIndexStr = await env.DESKTOP_KV.get(`bazaar:author:${auth.uid}`);
  if (authorIndexStr) {
    const authorIndex: string[] = JSON.parse(authorIndexStr);
    const updated = authorIndex.filter(id => id !== packId);
    await env.DESKTOP_KV.put(`bazaar:author:${auth.uid}`, JSON.stringify(updated));
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
  const authorIndexStr = await env.DESKTOP_KV.get(`bazaar:author:${auth.uid}`);
  const packIds: string[] = authorIndexStr ? JSON.parse(authorIndexStr) : [];

  const packs: BazaarPack[] = [];
  for (const id of packIds) {
    const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${id}`);
    if (packStr) packs.push(JSON.parse(packStr));
  }

  return Response.json({ packs });
}
