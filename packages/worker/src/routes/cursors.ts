/**
 * Cursor Asset Routes for EternalOS Skin System
 *
 * Handles upload, serving, listing, and deletion of custom cursor images.
 * Follows the same pattern as CSS asset / sound routes.
 *
 * Routes:
 *   POST   /api/cursors                            - Upload cursor image (auth required)
 *   GET    /api/cursors                            - List user's cursors (auth required)
 *   GET    /api/cursors/:uid/:cursorId/:filename   - Serve cursor image (public)
 *   DELETE /api/cursors/:cursorId                  - Delete cursor image (auth required)
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { CursorAssetMeta, CursorState } from '../types';
import { sanitizeFilename } from '../utils/sanitize';

// Allowed cursor image MIME types
const CURSOR_ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/x-icon': 'cur',
  'image/vnd.microsoft.icon': 'cur',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/x-navi-animation': 'ani',
};

// Constraints
const MAX_CURSOR_SIZE = 50 * 1024; // 50KB per cursor image
const MAX_CURSORS_PER_USER = 8; // One per CursorState

// Valid cursor states for validation
const VALID_CURSOR_STATES: CursorState[] = [
  'default', 'pointer', 'grab', 'grabbing', 'text', 'wait', 'move', 'nwse-resize',
];

/**
 * Upload a custom cursor image
 * POST /api/cursors
 *
 * Expects multipart/form-data with:
 * - file: The cursor image (png/svg/cur/gif/webp, max 50KB)
 * - cursorState (optional): Which cursor slot to assign this to
 * - hotspotX (optional): Cursor hotspot X coordinate (default 0)
 * - hotspotY (optional): Cursor hotspot Y coordinate (default 0)
 */
export async function handleCursorUpload(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const cursorState = formData.get('cursorState') as CursorState | null;
    const hotspotXStr = formData.get('hotspotX');
    const hotspotYStr = formData.get('hotspotY');

    if (!file || typeof file === 'string') {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileBlob = file as File;

    // Validate cursor state if provided
    if (cursorState && !VALID_CURSOR_STATES.includes(cursorState)) {
      return Response.json(
        { error: `Invalid cursor state: ${cursorState}. Valid: ${VALID_CURSOR_STATES.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate file type — also detect by extension since browsers often
    // report .cur/.ani files as application/octet-stream or empty
    let mimeType = fileBlob.type;
    if (!CURSOR_ALLOWED_TYPES[mimeType]) {
      const ext = (fileBlob.name || '').split('.').pop()?.toLowerCase();
      const extToMime: Record<string, string> = {
        'cur': 'image/x-icon', 'ico': 'image/x-icon',
        'ani': 'application/x-navi-animation',
        'png': 'image/png', 'gif': 'image/gif',
        'webp': 'image/webp', 'svg': 'image/svg+xml',
      };
      if (ext && extToMime[ext]) {
        mimeType = extToMime[ext];
      }
    }
    if (!CURSOR_ALLOWED_TYPES[mimeType]) {
      return Response.json(
        { error: `Invalid file type: ${fileBlob.type || 'unknown'}. Allowed: PNG, SVG, ICO/CUR, GIF, WebP.` },
        { status: 400 }
      );
    }

    // Validate file size
    if (fileBlob.size > MAX_CURSOR_SIZE) {
      return Response.json(
        { error: `File too large. Maximum cursor image size: ${MAX_CURSOR_SIZE / 1024}KB` },
        { status: 400 }
      );
    }

    // Parse hotspot coordinates
    const hotspotX = hotspotXStr ? Math.max(0, Math.min(64, parseInt(String(hotspotXStr), 10) || 0)) : 0;
    const hotspotY = hotspotYStr ? Math.max(0, Math.min(64, parseInt(String(hotspotYStr), 10) || 0)) : 0;

    // Check existing cursor count via Durable Object
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const listResponse = await stub.fetch(new Request('http://internal/cursors'));
    if (!listResponse.ok) {
      return Response.json({ error: 'Failed to check cursors' }, { status: 500 });
    }

    const { assets } = await listResponse.json() as { assets: CursorAssetMeta[] };

    // If assigning to a cursor state, replace existing one for that state
    if (cursorState) {
      const existingForState = assets.find(a => a.cursorState === cursorState);
      if (existingForState) {
        // Delete the old one from R2
        const oldR2Key = `${auth.uid}/cursors/${existingForState.cursorId}/${existingForState.filename}`;
        await env.ETERNALOS_FILES.delete(oldR2Key);
        // Remove metadata
        await stub.fetch(
          new Request(`http://internal/cursors/${existingForState.cursorId}`, { method: 'DELETE' })
        );
      }
    } else if (assets.length >= MAX_CURSORS_PER_USER) {
      return Response.json(
        { error: `Maximum ${MAX_CURSORS_PER_USER} cursor images allowed. Delete some to upload more.` },
        { status: 400 }
      );
    }

    // Check storage quota
    const quotaCheckResponse = await stub.fetch(
      new Request('http://internal/quota/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSize: fileBlob.size }),
      })
    );

    if (!quotaCheckResponse.ok) {
      return Response.json({ error: 'Failed to check storage quota' }, { status: 500 });
    }

    const quotaCheck = await quotaCheckResponse.json() as { allowed: boolean; quota: { used: number; limit: number } };
    if (!quotaCheck.allowed) {
      return Response.json(
        { error: 'Storage quota exceeded. Delete some files to free up space.' },
        { status: 413 }
      );
    }

    // Generate asset ID and R2 key
    const cursorId = crypto.randomUUID();
    const originalName = fileBlob.name || `cursor.${CURSOR_ALLOWED_TYPES[mimeType]}`;
    const sanitizedName = sanitizeFilename(originalName);
    const r2Key = `${auth.uid}/cursors/${cursorId}/${sanitizedName}`;

    // Upload to R2
    const fileBuffer = await fileBlob.arrayBuffer();
    await env.ETERNALOS_FILES.put(r2Key, fileBuffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        uploadedBy: auth.uid,
        cursorId,
        type: 'cursor',
      },
    });

    // Store metadata in Durable Object
    const meta: CursorAssetMeta = {
      cursorId,
      filename: sanitizedName,
      mimeType,
      size: fileBlob.size,
      uploadedAt: Date.now(),
      cursorState: cursorState || undefined,
      hotspotX,
      hotspotY,
    };

    const addResponse = await stub.fetch(
      new Request('http://internal/cursors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
    );

    if (!addResponse.ok) {
      // Cleanup R2 on failure
      await env.ETERNALOS_FILES.delete(r2Key);
      return Response.json({ error: 'Failed to save cursor metadata' }, { status: 500 });
    }

    return Response.json({
      success: true,
      asset: {
        ...meta,
        url: `/api/cursors/${auth.uid}/${cursorId}/${sanitizedName}`,
      },
    });

  } catch (error) {
    console.error('Cursor upload error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Cursor upload failed' },
      { status: 500 }
    );
  }
}

/**
 * Serve a cursor image from R2
 * GET /api/cursors/:uid/:cursorId/:filename
 *
 * Cursor images are always public (visitors see the owner's custom cursors)
 */
export async function handleServeCursor(
  request: Request,
  env: Env,
  uid: string,
  cursorId: string,
  filename: string
): Promise<Response> {
  try {
    const r2Key = `${uid}/cursors/${cursorId}/${filename}`;
    const object = await env.ETERNALOS_FILES.get(r2Key);

    if (!object) {
      return Response.json({ error: 'Cursor not found' }, { status: 404 });
    }

    // Validate Content-Type — only serve known image types
    const storedType = object.httpMetadata?.contentType || '';
    const safeTypes = Object.keys(CURSOR_ALLOWED_TYPES);
    const contentType = safeTypes.includes(storedType) ? storedType : 'application/octet-stream';

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

  } catch (error) {
    console.error('Serve cursor error:', error);
    return Response.json({ error: 'Failed to serve cursor' }, { status: 500 });
  }
}

/**
 * List cursor assets for a user
 * GET /api/cursors
 */
export async function handleListCursors(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const response = await stub.fetch(new Request('http://internal/cursors'));
    if (!response.ok) {
      return Response.json({ error: 'Failed to list cursors' }, { status: 500 });
    }

    const data = await response.json() as { assets: CursorAssetMeta[] };

    // Add full URL path to each asset
    const assetsWithUrls = data.assets.map(asset => ({
      ...asset,
      url: `/api/cursors/${auth.uid}/${asset.cursorId}/${asset.filename}`,
    }));

    return Response.json({ assets: assetsWithUrls });

  } catch (error) {
    console.error('List cursors error:', error);
    return Response.json({ error: 'Failed to list cursors' }, { status: 500 });
  }
}

/**
 * Delete a cursor asset
 * DELETE /api/cursors/:cursorId
 */
export async function handleDeleteCursor(
  request: Request,
  env: Env,
  auth: AuthContext,
  cursorId: string
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    // Get the asset metadata to find the R2 key
    const listResponse = await stub.fetch(new Request('http://internal/cursors'));
    if (!listResponse.ok) {
      return Response.json({ error: 'Failed to find cursor' }, { status: 500 });
    }

    const { assets } = await listResponse.json() as { assets: CursorAssetMeta[] };
    const asset = assets.find(a => a.cursorId === cursorId);
    if (!asset) {
      return Response.json({ error: 'Cursor not found' }, { status: 404 });
    }

    // Delete from R2
    const r2Key = `${auth.uid}/cursors/${cursorId}/${asset.filename}`;
    await env.ETERNALOS_FILES.delete(r2Key);

    // Remove metadata from Durable Object
    const deleteResponse = await stub.fetch(
      new Request(`http://internal/cursors/${cursorId}`, { method: 'DELETE' })
    );

    if (!deleteResponse.ok) {
      return Response.json({ error: 'Failed to delete cursor metadata' }, { status: 500 });
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Delete cursor error:', error);
    return Response.json({ error: 'Failed to delete cursor' }, { status: 500 });
  }
}
