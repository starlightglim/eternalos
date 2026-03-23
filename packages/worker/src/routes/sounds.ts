/**
 * Sound Asset Routes for EternalOS Skin System
 *
 * Handles upload, serving, listing, and deletion of custom sound files.
 * Follows the same pattern as CSS asset routes.
 *
 * Routes:
 *   POST   /api/sounds                          - Upload sound file (auth required)
 *   GET    /api/sounds                          - List user's sounds (auth required)
 *   GET    /api/sounds/:uid/:soundId/:filename  - Serve sound file (public)
 *   DELETE /api/sounds/:soundId                 - Delete sound file (auth required)
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { SoundAssetMeta, SoundType } from '../types';
import { sanitizeFilename } from '../utils/sanitize';

// Allowed audio MIME types
const SOUND_ALLOWED_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

// Constraints
const MAX_SOUND_SIZE = 200 * 1024; // 200KB per sound file
const MAX_SOUNDS_PER_USER = 12; // One per SoundType

/**
 * Upload a custom sound file
 * POST /api/sounds
 *
 * Expects multipart/form-data with:
 * - file: The audio file (mp3/wav/ogg/webm, max 200KB)
 * - soundType (optional): Which sound slot to assign this to
 */
export async function handleSoundUpload(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const soundType = formData.get('soundType') as SoundType | null;

    if (!file || typeof file === 'string') {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileBlob = file as File;

    // Validate file type
    const mimeType = fileBlob.type;
    if (!SOUND_ALLOWED_TYPES[mimeType]) {
      return Response.json(
        { error: `Invalid file type: ${mimeType}. Allowed: MP3, WAV, OGG, WebM.` },
        { status: 400 }
      );
    }

    // Validate file size
    if (fileBlob.size > MAX_SOUND_SIZE) {
      return Response.json(
        { error: `File too large. Maximum sound file size: ${MAX_SOUND_SIZE / 1024}KB` },
        { status: 400 }
      );
    }

    // Check existing sound count via Durable Object
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const listResponse = await stub.fetch(new Request('http://internal/sounds'));
    if (!listResponse.ok) {
      return Response.json({ error: 'Failed to check sounds' }, { status: 500 });
    }

    const { assets } = await listResponse.json() as { assets: SoundAssetMeta[] };
    if (assets.length >= MAX_SOUNDS_PER_USER) {
      return Response.json(
        { error: `Maximum ${MAX_SOUNDS_PER_USER} sound files allowed. Delete some to upload more.` },
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
    const soundId = crypto.randomUUID();
    const originalName = fileBlob.name || `sound.${SOUND_ALLOWED_TYPES[mimeType]}`;
    const sanitizedName = sanitizeFilename(originalName);
    const r2Key = `${auth.uid}/sounds/${soundId}/${sanitizedName}`;

    // Upload to R2
    const fileBuffer = await fileBlob.arrayBuffer();
    await env.ETERNALOS_FILES.put(r2Key, fileBuffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        uploadedBy: auth.uid,
        soundId,
        type: 'sound',
      },
    });

    // Store metadata in Durable Object
    const meta: SoundAssetMeta = {
      soundId,
      filename: sanitizedName,
      mimeType,
      size: fileBlob.size,
      uploadedAt: Date.now(),
      soundType: soundType || undefined,
    };

    const addResponse = await stub.fetch(
      new Request('http://internal/sounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
    );

    if (!addResponse.ok) {
      // Cleanup R2 on failure
      await env.ETERNALOS_FILES.delete(r2Key);
      return Response.json({ error: 'Failed to save sound metadata' }, { status: 500 });
    }

    return Response.json({
      success: true,
      asset: {
        ...meta,
        url: `/api/sounds/${auth.uid}/${soundId}/${sanitizedName}`,
      },
    });

  } catch (error) {
    console.error('Sound upload error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Sound upload failed' },
      { status: 500 }
    );
  }
}

/**
 * Serve a sound file from R2
 * GET /api/sounds/:uid/:soundId/:filename
 *
 * Sound files are always public (visitors hear the owner's custom sounds)
 */
export async function handleServeSound(
  request: Request,
  env: Env,
  uid: string,
  soundId: string,
  filename: string
): Promise<Response> {
  try {
    const r2Key = `${uid}/sounds/${soundId}/${filename}`;
    const object = await env.ETERNALOS_FILES.get(r2Key);

    if (!object) {
      return Response.json({ error: 'Sound not found' }, { status: 404 });
    }

    // Validate Content-Type — only serve known audio types
    const storedType = object.httpMetadata?.contentType || '';
    const safeAudioTypes = Object.keys(SOUND_ALLOWED_TYPES);
    const contentType = safeAudioTypes.includes(storedType) ? storedType : 'application/octet-stream';

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Length', object.size.toString());
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'");

    // Support range requests for audio streaming
    const range = request.headers.get('Range');
    if (range) {
      const rangeMatch = range.match(/^bytes=(\d+)-(\d*)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : object.size - 1;

        if (start >= object.size) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${object.size}` },
          });
        }

        const rangeObject = await env.ETERNALOS_FILES.get(r2Key, {
          range: { offset: start, length: end - start + 1 },
        });

        if (!rangeObject) {
          return Response.json({ error: 'Sound not found' }, { status: 404 });
        }

        headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
        headers.set('Content-Length', (end - start + 1).toString());
        headers.set('Accept-Ranges', 'bytes');

        return new Response(rangeObject.body, { status: 206, headers });
      }
    }

    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    headers.set('Accept-Ranges', 'bytes');
    return new Response(object.body, { headers });

  } catch (error) {
    console.error('Serve sound error:', error);
    return Response.json({ error: 'Failed to serve sound' }, { status: 500 });
  }
}

/**
 * List sound assets for a user
 * GET /api/sounds
 */
export async function handleListSounds(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const response = await stub.fetch(new Request('http://internal/sounds'));
    if (!response.ok) {
      return Response.json({ error: 'Failed to list sounds' }, { status: 500 });
    }

    const data = await response.json() as { assets: SoundAssetMeta[] };

    // Add full URL path to each asset
    const assetsWithUrls = data.assets.map(asset => ({
      ...asset,
      url: `/api/sounds/${auth.uid}/${asset.soundId}/${asset.filename}`,
    }));

    return Response.json({ assets: assetsWithUrls });

  } catch (error) {
    console.error('List sounds error:', error);
    return Response.json({ error: 'Failed to list sounds' }, { status: 500 });
  }
}

/**
 * Delete a sound asset
 * DELETE /api/sounds/:soundId
 */
export async function handleDeleteSound(
  request: Request,
  env: Env,
  auth: AuthContext,
  soundId: string
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    // Get the asset metadata to find the R2 key
    const listResponse = await stub.fetch(new Request('http://internal/sounds'));
    if (!listResponse.ok) {
      return Response.json({ error: 'Failed to find sound' }, { status: 500 });
    }

    const { assets } = await listResponse.json() as { assets: SoundAssetMeta[] };
    const asset = assets.find(a => a.soundId === soundId);
    if (!asset) {
      return Response.json({ error: 'Sound not found' }, { status: 404 });
    }

    // Delete from R2
    const r2Key = `${auth.uid}/sounds/${soundId}/${asset.filename}`;
    await env.ETERNALOS_FILES.delete(r2Key);

    // Remove metadata from Durable Object
    const deleteResponse = await stub.fetch(
      new Request(`http://internal/sounds/${soundId}`, { method: 'DELETE' })
    );

    if (!deleteResponse.ok) {
      return Response.json({ error: 'Failed to delete sound metadata' }, { status: 500 });
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Delete sound error:', error);
    return Response.json({ error: 'Failed to delete sound' }, { status: 500 });
  }
}
