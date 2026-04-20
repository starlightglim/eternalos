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
import { validateManifestAgainstFiles, validateManifest, formatValidationErrors } from '../utils/estheme';
import type { EsthemeManifest } from '../utils/estheme';

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

    // SECURITY: Validate config keys/values BEFORE they land in KV. On install
    // the client merges non-legacy keys into designTokens and PATCHes /profile;
    // the server-side profile validator is the authoritative gate, but we want
    // to reject obviously-malicious packs here too so they never see installers.
    //   - keys: dotted identifier, <= 100 chars
    //   - values: string/number/bool, strings <= 500 chars, no `{};` (CSS
    //     rule-terminators would enable CSS breakout) and no scheme:// URLs
    //     that don't point at first-party assets
    const bazaarAllowedUrlPrefixes = ['/api/css-assets/', '/api/wallpaper/', '/api/icon/', '/api/sounds/', '/api/cursors/', '/api/bazaar/assets/'];
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
          const bareUrl = cVal.split('|')[0].trim();
          let pathname: string;
          try { pathname = new URL(bareUrl, 'http://localhost').pathname; }
          catch { return Response.json({ error: `Invalid URL for ${cKey}` }, { status: 400 }); }
          if (pathname.includes('..') || !bazaarAllowedUrlPrefixes.some((p) => pathname.startsWith(p))) {
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
  const pack = JSON.parse(packStr) as BazaarPack & { manifestVersion?: number };

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

    // 6. Pack count limit per author
    const authorPacksStr = await env.DESKTOP_KV.get(`bazaar:author:${auth.uid}`);
    const authorPacks: string[] = authorPacksStr ? JSON.parse(authorPacksStr) : [];
    if (authorPacks.length >= MAX_PACKS_PER_USER) {
      return Response.json(
        { error: `Max ${MAX_PACKS_PER_USER} packs per user` },
        { status: 400 }
      );
    }

    // 7. Upload everything to R2
    const packId = crypto.randomUUID();
    const r2Prefix = `bazaar/${packId}`;

    const previewFilename = sanitizeFilename(preview.name || 'preview.png');
    const previewR2Key = `${r2Prefix}/${previewFilename}`;
    await env.ETERNALOS_FILES.put(previewR2Key, await preview.arrayBuffer(), {
      httpMetadata: { contentType: preview.type },
      customMetadata: { type: 'estheme-preview', packId },
    });

    // Store each asset at its declared path within the pack prefix FIRST, so
    // that if any collision slips past path validation, the server-validated
    // manifest write below wins.
    for (const entry of assetFields) {
      const r2Key = `${r2Prefix}/${entry.path}`;
      await env.ETERNALOS_FILES.put(r2Key, await entry.file.arrayBuffer(), {
        httpMetadata: { contentType: entry.file.type || 'application/octet-stream' },
        customMetadata: { type: 'estheme-asset', packId, assetPath: entry.path },
      });
    }

    // Store the validated manifest AFTER assets so its R2 key (manifest.json)
    // cannot be clobbered by an attacker-supplied `file_manifest.json` form
    // field — this ensures installers always read the zod-validated manifest.
    const manifestR2Key = `${r2Prefix}/manifest.json`;
    await env.ETERNALOS_FILES.put(manifestR2Key, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { type: 'estheme-manifest', packId },
    });

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

    // 9. Persist indexes
    await env.DESKTOP_KV.put(`bazaar:pack:${packId}`, JSON.stringify(pack));

    const typeIndexStr = await env.DESKTOP_KV.get(`bazaar:type:skin`);
    const typeIndex: string[] = typeIndexStr ? JSON.parse(typeIndexStr) : [];
    typeIndex.unshift(packId);
    await env.DESKTOP_KV.put(`bazaar:type:skin`, JSON.stringify(typeIndex));

    authorPacks.unshift(packId);
    await env.DESKTOP_KV.put(`bazaar:author:${auth.uid}`, JSON.stringify(authorPacks));

    return Response.json({ success: true, pack, manifest });
  } catch (error) {
    console.error('Bazaar estheme publish error:', error);
    return Response.json({ error: 'Failed to publish theme' }, { status: 500 });
  }
}

/**
 * Suppress TS unused warnings on imports that are only used via type narrowing
 * inside JSON bodies. Compiler sees the types; eslint doesn't always.
 */
export type { EsthemeManifest };
