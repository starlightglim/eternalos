/**
 * File Upload & Serving Routes
 *
 * POST /api/upload - Upload file to R2 and create desktop item
 * GET /api/files/:uid/:itemId/:filename - Serve file from R2
 *
 * Supports images (jpg/png/gif/webp) and text files (txt/md).
 */

import { fileTypeFromBuffer } from 'file-type';
import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { DesktopItem, ImageAnalysisMetadata } from '../types';
import { sanitizeFilename, sanitizeText } from '../utils/sanitize';

// Allowed MIME types for regular file uploads
const ALLOWED_TYPES: Record<string, string> = {
  // Images
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // Text
  'text/plain': 'txt',
  'text/markdown': 'md',
  // Video
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  // Audio
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

// Allowed MIME types for wallpaper uploads (images only)
const WALLPAPER_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

// Allowed MIME types for CSS assets (images for use in custom CSS)
const CSS_ASSET_ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

// Max CSS asset size: 500KB
const MAX_CSS_ASSET_SIZE = 500 * 1024;

// Max CSS assets per user
const MAX_CSS_ASSETS_PER_USER = 25; // Increased for sprite chrome (frame + titlebar + buttons + resize)

// Max file size: 10MB for regular files
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max wallpaper size: 2MB
const MAX_WALLPAPER_SIZE = 2 * 1024 * 1024;

// Max custom icon size: 50KB
const MAX_ICON_SIZE = 50 * 1024;
const MAX_IMAGE_ANALYSIS_SIZE = 2 * 1024 * 1024;
const IMAGE_ANALYSIS_MODEL_FALLBACKS = [
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-3-12b-it',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
] as const;

// Allowed MIME types for custom icons (PNG only for pixel art)
const ICON_ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function extractAIResponseText(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload;
  }

  if (payload && typeof payload === 'object') {
    if ('response' in payload && typeof payload.response === 'string') {
      return payload.response;
    }

    if ('result' in payload && payload.result && typeof payload.result === 'object' && 'response' in payload.result && typeof payload.result.response === 'string') {
      return payload.result.response;
    }
  }

  return null;
}

function extractAIResponseObject(payload: unknown): Record<string, unknown> | null {
  const seen = new Set<unknown>();

  function visit(value: unknown): Record<string, unknown> | null {
    if (!value || seen.has(value)) {
      return null;
    }
    seen.add(value);

    if (typeof value === 'string') {
      return extractJSONObject(value);
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = visit(entry);
        if (found) return found;
      }
      return null;
    }

    if (typeof value !== 'object') {
      return null;
    }

    const record = value as Record<string, unknown>;
    if ('caption' in record || 'tags' in record || 'detectedText' in record || 'dominantColors' in record) {
      return record;
    }

    for (const nested of Object.values(record)) {
      const found = visit(nested);
      if (found) return found;
    }

    return null;
  }

  return visit(payload);
}

function extractJSONObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Continue to fenced/extracted parsing.
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1]) as Record<string, unknown>;
    } catch {
      // Continue to brace extraction.
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeStringList(value: unknown, maxItems: number, maxLength: number, lowercase = false): string[] {
  if (!Array.isArray(value)) return [];

  const deduped = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = sanitizeText(entry, maxLength).trim();
    if (!normalized) continue;
    const finalValue = lowercase ? normalized.toLowerCase() : normalized;
    deduped.add(finalValue);
    if (deduped.size >= maxItems) break;
  }

  return Array.from(deduped);
}

function normalizeHexColors(value: unknown): string[] {
  const colors = normalizeStringList(value, 5, 7, false)
    .map((entry) => entry.toUpperCase())
    .filter((entry) => /^#[0-9A-F]{6}$/.test(entry));

  return Array.from(new Set(colors));
}

function normalizeCaption(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = sanitizeText(value, 180).trim();
  return normalized || undefined;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pLeft = Math.abs(p - left);
  const pUp = Math.abs(p - up);
  const pUpLeft = Math.abs(p - upLeft);

  if (pLeft <= pUp && pLeft <= pUpLeft) return left;
  if (pUp <= pUpLeft) return up;
  return upLeft;
}

function formatHexColor(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function summarizeRgbColors(
  pixels: Array<{ r: number; g: number; b: number; a?: number }>
): string[] {
  if (pixels.length === 0) return [];

  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  const totalPixels = pixels.length;
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / 4096)));

  for (let i = 0; i < pixels.length; i += stride) {
    const pixel = pixels[i];
    if ((pixel.a ?? 255) < 32) continue;

    const key = [
      Math.floor(pixel.r / 32),
      Math.floor(pixel.g / 32),
      Math.floor(pixel.b / 32),
    ].join(':');

    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += pixel.r;
    bucket.g += pixel.g;
    bucket.b += pixel.b;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((bucket) => formatHexColor(bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count));
}

async function extractDecodedFrameDominantColors(fileBuffer: ArrayBuffer, mimeType: string): Promise<string[]> {
  const ImageDecoderCtor = (globalThis as unknown as { ImageDecoder?: new (init: unknown) => any }).ImageDecoder;
  if (!ImageDecoderCtor) {
    return [];
  }

  const supportsType = typeof (ImageDecoderCtor as any).isTypeSupported === 'function'
    ? await (ImageDecoderCtor as any).isTypeSupported(mimeType).catch(() => false)
    : true;

  if (!supportsType) {
    return [];
  }

  const decoder = new ImageDecoderCtor({
    data: new Uint8Array(fileBuffer),
    type: mimeType,
  });

  let frame: any;

  try {
    const decoded = await decoder.decode({ frameIndex: 0 });
    frame = decoded.image;
    const width = frame.displayWidth ?? frame.codedWidth;
    const height = frame.displayHeight ?? frame.codedHeight;

    if (!width || !height) {
      return [];
    }

    const rgba = new Uint8Array(width * height * 4);
    await frame.copyTo(rgba, { format: 'RGBA' });

    const pixels: Array<{ r: number; g: number; b: number; a?: number }> = [];
    const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)));

    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const offset = (y * width + x) * 4;
        pixels.push({
          r: rgba[offset],
          g: rgba[offset + 1],
          b: rgba[offset + 2],
          a: rgba[offset + 3],
        });
      }
    }

    return summarizeRgbColors(pixels);
  } finally {
    try {
      frame?.close?.();
    } catch {
      // Ignore cleanup errors.
    }
    try {
      decoder.close?.();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

async function extractPngDominantColors(fileBuffer: ArrayBuffer): Promise<string[]> {
  const bytes = new Uint8Array(fileBuffer);
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || !pngSignature.every((value, index) => bytes[index] === value)) {
    return [];
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlaceMethod = 0;
  let palette: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    offset += 4;
    const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    offset += 4;

    if (offset + length + 4 > bytes.length) {
      return [];
    }

    const chunk = bytes.slice(offset, offset + length);
    offset += length + 4; // Skip chunk data + CRC

    if (type === 'IHDR') {
      width = readUint32BE(chunk, 0);
      height = readUint32BE(chunk, 4);
      bitDepth = chunk[8];
      colorType = chunk[9];
      interlaceMethod = chunk[12];
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'IDAT') {
      idatChunks.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height || idatChunks.length === 0 || bitDepth !== 8 || interlaceMethod !== 0) {
    return [];
  }

  const bytesPerPixel = colorType === 6
    ? 4
    : colorType === 2
      ? 3
      : colorType === 0
        ? 1
        : colorType === 4
          ? 2
          : colorType === 3
            ? 1
            : 0;

  if (!bytesPerPixel) {
    return [];
  }

  const compressed = new Uint8Array(idatChunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let cursor = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, cursor);
    cursor += chunk.length;
  }

  const inflated = await inflateZlib(compressed);
  const rowLength = width * bytesPerPixel;
  const expectedLength = height * (rowLength + 1);
  if (inflated.length < expectedLength) {
    return [];
  }

  const pixels: Array<{ r: number; g: number; b: number; a?: number }> = [];
  let inflOffset = 0;
  let previousRow = new Uint8Array(rowLength);

  for (let y = 0; y < height; y++) {
    const filterType = inflated[inflOffset++];
    const row = inflated.slice(inflOffset, inflOffset + rowLength);
    inflOffset += rowLength;

    for (let i = 0; i < row.length; i++) {
      const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
      const up = previousRow[i] ?? 0;
      const upLeft = i >= bytesPerPixel ? (previousRow[i - bytesPerPixel] ?? 0) : 0;

      if (filterType === 1) row[i] = (row[i] + left) & 0xff;
      else if (filterType === 2) row[i] = (row[i] + up) & 0xff;
      else if (filterType === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 0xff;
      else if (filterType === 4) row[i] = (row[i] + paethPredictor(left, up, upLeft)) & 0xff;
    }

    for (let x = 0; x < width; x++) {
      const pixelOffset = x * bytesPerPixel;

      if (colorType === 6) {
        pixels.push({
          r: row[pixelOffset],
          g: row[pixelOffset + 1],
          b: row[pixelOffset + 2],
          a: row[pixelOffset + 3],
        });
      } else if (colorType === 2) {
        pixels.push({
          r: row[pixelOffset],
          g: row[pixelOffset + 1],
          b: row[pixelOffset + 2],
        });
      } else if (colorType === 0) {
        const value = row[pixelOffset];
        pixels.push({ r: value, g: value, b: value });
      } else if (colorType === 4) {
        const value = row[pixelOffset];
        pixels.push({ r: value, g: value, b: value, a: row[pixelOffset + 1] });
      } else if (colorType === 3 && palette) {
        const index = row[pixelOffset] * 3;
        if (index + 2 < palette.length) {
          pixels.push({ r: palette[index], g: palette[index + 1], b: palette[index + 2] });
        }
      }
    }

    previousRow = row;
  }

  return summarizeRgbColors(pixels);
}

async function extractDominantColors(fileBuffer: ArrayBuffer, mimeType: string): Promise<string[]> {
  if (mimeType === 'image/png') {
    return extractPngDominantColors(fileBuffer);
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/webp' || mimeType === 'image/gif') {
    return extractDecodedFrameDominantColors(fileBuffer, mimeType);
  }

  return [];
}

function normalizeAnalysisError(error: unknown): string {
  if (error instanceof Error) {
    const message = sanitizeText(error.message, 200);
    const lower = message.toLowerCase();

    if (lower.includes('not found') || lower.includes('no route for') || lower.includes('unsupported')) {
      return 'Workers AI image analysis is unavailable. Check that Wrangler is logged into Cloudflare, the AI binding is remote-enabled, and the model is available on your account.';
    }

    if (lower.includes('agree') || lower.includes('license') || lower.includes('acceptable use')) {
      return 'Workers AI needs Meta license acceptance before image analysis can run. Accept the Llama 3.2 Vision terms once, then retry.';
    }

    return message;
  }
  return 'Image analysis failed';
}

function shouldTryNextImageModel(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  return (
    message.includes('not found') ||
    message.includes('404') ||
    message.includes('model') ||
    message.includes('no route for') ||
    message.includes('unsupported')
  );
}

async function patchItemImageAnalysis(
  stub: DurableObjectStub,
  itemId: string,
  imageAnalysis: ImageAnalysisMetadata
): Promise<void> {
  const response = await stub.fetch(
    new Request('http://internal/items', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: itemId, updates: { imageAnalysis } }]),
    })
  );

  if (!response.ok) {
    throw new Error('Failed to save image analysis metadata');
  }
}

async function analyzeUploadedImage(
  env: Env,
  stub: DurableObjectStub,
  itemId: string,
  mimeType: string,
  fileBuffer: ArrayBuffer
): Promise<void> {
  const analyzedAt = Date.now();
  const candidateModels = [
    env.IMAGE_ANALYSIS_MODEL,
    ...IMAGE_ANALYSIS_MODEL_FALLBACKS,
  ].filter((value, index, array): value is string => !!value && array.indexOf(value) === index);

  if (fileBuffer.byteLength > MAX_IMAGE_ANALYSIS_SIZE) {
    await patchItemImageAnalysis(stub, itemId, {
      status: 'skipped',
      analyzedAt,
      model: candidateModels[0],
      error: `Image exceeds ${MAX_IMAGE_ANALYSIS_SIZE / 1024 / 1024}MB automatic analysis limit`,
    });
    return;
  }

  try {
    const dominantColors = await extractDominantColors(fileBuffer, mimeType).catch((error) => {
      console.warn('Dominant color extraction failed:', error);
      return [];
    });
    const dataUrl = `data:${mimeType};base64,${arrayBufferToBase64(fileBuffer)}`;
    const analysisPrompt = [
      'Analyze this uploaded image for later search and sorting.',
      'Describe the visible subject clearly and keep tags specific.',
      'caption: one short sentence, max 140 characters.',
      'tags: 3 to 8 short lowercase tags describing the image.',
      'detectedText: array of visible text strings from the image, empty if none.',
      'Return JSON only.',
    ].join(' ');
    const guidedJson = {
      type: 'object',
      additionalProperties: false,
      required: ['caption', 'tags', 'detectedText'],
      properties: {
        caption: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        detectedText: { type: 'array', items: { type: 'string' } },
      },
    };
    let resolvedModel = candidateModels[0];
    let lastError: unknown = null;
    let parsed: Record<string, unknown> | null = null;

    for (const model of candidateModels) {
      try {
        const aiResponse = await env.AI.run(model as keyof AiModels, {
          messages: [
            {
              role: 'system',
              content: 'You analyze uploaded images for metadata enrichment. Return structured JSON only.',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: analysisPrompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          guided_json: guidedJson,
        });
        parsed = extractAIResponseObject(aiResponse) ?? (() => {
          const responseText = extractAIResponseText(aiResponse);
          if (!responseText) {
            return null;
          }
          return extractJSONObject(responseText);
        })();

        if (!parsed) {
          lastError = new Error(`Workers AI returned invalid image analysis JSON for ${model}`);
          continue;
        }

        resolvedModel = model;
        lastError = null;
        break;
      } catch (error) {
        if (
          model === '@cf/meta/llama-3.2-11b-vision-instruct' &&
          error instanceof Error &&
          /agree|license|acceptable use/i.test(error.message)
        ) {
          await env.AI.run(model as keyof AiModels, { prompt: 'agree' });
          const aiResponse = await env.AI.run(model as keyof AiModels, {
            messages: [
              {
                role: 'system',
                content: 'You analyze uploaded images for metadata enrichment. Return structured JSON only.',
              },
              {
                role: 'user',
                content: [
                  { type: 'text', text: analysisPrompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            guided_json: guidedJson,
          });
          parsed = extractAIResponseObject(aiResponse) ?? (() => {
            const responseText = extractAIResponseText(aiResponse);
            if (!responseText) {
              return null;
            }
            return extractJSONObject(responseText);
          })();

          if (!parsed) {
            lastError = new Error(`Workers AI returned invalid image analysis JSON for ${model}`);
            continue;
          }

          resolvedModel = model;
          lastError = null;
          break;
        }

        lastError = error;
        if (!shouldTryNextImageModel(error)) {
          throw error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!parsed) {
      throw new Error('Workers AI returned invalid image analysis JSON');
    }

    await patchItemImageAnalysis(stub, itemId, {
      status: 'complete',
      analyzedAt,
      model: resolvedModel,
      caption: normalizeCaption(parsed.caption),
      tags: normalizeStringList(parsed.tags, 8, 32, true),
      detectedText: normalizeStringList(parsed.detectedText, 10, 80, false),
      dominantColors,
    });
  } catch (error) {
    console.error('Image analysis error:', error);
    await patchItemImageAnalysis(stub, itemId, {
      status: 'failed',
      analyzedAt,
      model: candidateModels[0],
      error: normalizeAnalysisError(error),
    });
  }
}

/**
 * Handle file upload
 * POST /api/upload
 *
 * Expects multipart/form-data with:
 * - file: The file to upload
 * - name: (optional) Custom filename
 * - parentId: (optional) Parent folder ID
 * - position: (optional) JSON { x: number, y: number }
 * - isPublic: (optional) "true" or "false"
 */
export async function handleUpload(
  request: Request,
  env: Env,
  auth: AuthContext,
  ctx: ExecutionContext
): Promise<Response> {
  // Hoisted for cleanup in catch block
  let r2Key: string | undefined;
  let releaseQuota: (() => Promise<void>) | undefined;

  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');

    // In Workers environment, formData.get() returns File or string
    if (!file || typeof file === 'string') {
      return Response.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    // file is now a File-like object (Blob with name property)
    const fileBlob = file as File;

    // Validate file type
    const mimeType = fileBlob.type;
    if (!ALLOWED_TYPES[mimeType]) {
      return Response.json(
        { error: `Invalid file type: ${mimeType}. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}` },
        { status: 400 }
      );
    }

    // Validate file size
    if (fileBlob.size > MAX_FILE_SIZE) {
      return Response.json(
        { error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    // Reserve storage quota atomically (prevents race condition with concurrent uploads)
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);
    const quotaReserveResponse = await stub.fetch(
      new Request('http://internal/quota/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSize: fileBlob.size }),
      })
    );

    if (!quotaReserveResponse.ok) {
      return Response.json(
        { error: 'Failed to check storage quota' },
        { status: 500 }
      );
    }

    const quotaCheck = await quotaReserveResponse.json() as { reserved: boolean; quota: { used: number; limit: number; remaining: number } };
    if (!quotaCheck.reserved) {
      const usedMB = (quotaCheck.quota.used / 1024 / 1024).toFixed(1);
      const limitMB = (quotaCheck.quota.limit / 1024 / 1024).toFixed(0);
      return Response.json(
        {
          error: `Storage quota exceeded. You're using ${usedMB}MB of ${limitMB}MB. Delete some files or empty your trash to free up space.`,
          quota: quotaCheck.quota,
        },
        { status: 413 } // 413 Payload Too Large
      );
    }

    // Release quota reservation on any failure path below
    releaseQuota = async () => {
      await stub.fetch(
        new Request('http://internal/quota/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileSize: fileBlob.size }),
        })
      ).catch(() => {});
    };

    // Generate item ID and R2 key
    const itemId = crypto.randomUUID();
    const originalName = fileBlob.name || `file.${ALLOWED_TYPES[mimeType]}`;
    const sanitizedName = sanitizeFilename(originalName);
    r2Key = `${auth.uid}/${itemId}/${sanitizedName}`;

    // Upload to R2
    const fileBuffer = await fileBlob.arrayBuffer();

    // SECURITY: Validate actual file content via magic bytes, not just the declared
    // MIME type (which is trivially spoofed). Text files have no magic bytes, so
    // we only check binary formats (images, video, audio).
    if (!mimeType.startsWith('text/')) {
      const detected = await fileTypeFromBuffer(fileBuffer);
      if (!detected) {
        if (releaseQuota) await releaseQuota();
        return Response.json(
          { error: 'Could not verify file type. The file may be corrupted.' },
          { status: 400 }
        );
      }
      if (!ALLOWED_TYPES[detected.mime]) {
        if (releaseQuota) await releaseQuota();
        return Response.json(
          { error: `File content does not match an allowed type. Detected: ${detected.mime}` },
          { status: 400 }
        );
      }
      // If detected MIME differs from declared, use the detected one (more trustworthy)
      if (detected.mime !== mimeType) {
        console.warn(`MIME mismatch: declared=${mimeType}, detected=${detected.mime}`);
      }
    }

    await env.ETERNALOS_FILES.put(r2Key, fileBuffer, {
      httpMetadata: {
        contentType: mimeType,
      },
      customMetadata: {
        originalName: sanitizedName,
        uploadedBy: auth.uid,
        itemId: itemId,
      },
    });

    // Parse optional metadata from form (sanitize user input)
    const customNameRaw = formData.get('name') as string | null;
    const customName = customNameRaw ? sanitizeText(customNameRaw, 255) : null;
    const parentId = formData.get('parentId') as string | null;
    const positionStr = formData.get('position') as string | null;
    const isPublicStr = formData.get('isPublic') as string | null;

    let position = { x: 0, y: 0 };
    if (positionStr) {
      try {
        position = JSON.parse(positionStr);
      } catch {
        // Use default position
      }
    }

    // Determine item type based on MIME type
    let itemType: 'image' | 'text' | 'video' | 'audio' = 'text';
    if (mimeType.startsWith('image/')) {
      itemType = 'image';
    } else if (mimeType.startsWith('video/')) {
      itemType = 'video';
    } else if (mimeType.startsWith('audio/')) {
      itemType = 'audio';
    }

    // Create desktop item in Durable Object (reuse doId and stub from quota check)
    const itemData = {
      id: itemId, // Use pre-generated ID to match R2 key
      type: itemType,
      name: customName || sanitizedName,
      parentId: parentId || null,
      position,
      isPublic: isPublicStr === 'true',
      r2Key,
      mimeType,
      fileSize: fileBlob.size,
      imageAnalysis: itemType === 'image' ? { status: 'pending' as const } : undefined,
    };

    const doResponse = await stub.fetch(
      new Request('http://internal/items-internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemData),
      })
    );

    if (!doResponse.ok) {
      // Cleanup R2 if DO fails
      await env.ETERNALOS_FILES.delete(r2Key);
      await releaseQuota();
      return Response.json(
        { error: 'Failed to create desktop item' },
        { status: 500 }
      );
    }

    // Upload committed successfully — release the reservation
    // (the actual file size is now tracked in the item's fileSize field)
    await releaseQuota();

    const createdItem = await doResponse.json();

    if (itemType === 'image') {
      ctx.waitUntil(analyzeUploadedImage(env, stub, itemId, mimeType, fileBuffer));
    }

    return Response.json({
      success: true,
      item: createdItem,
    });

  } catch (error) {
    console.error('Upload error:', error);
    // Clean up orphaned R2 file if the upload succeeded but subsequent
    // operations (DO item creation, etc.) failed.
    if (r2Key) {
      await env.ETERNALOS_FILES.delete(r2Key).catch((e) =>
        console.error('Failed to clean up orphaned R2 file:', e)
      );
    }
    // Release any reserved quota
    if (releaseQuota) {
      await releaseQuota();
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    );
  }
}

export async function handleAnalyzeImageItem(
  env: Env,
  auth: AuthContext,
  itemId: string,
  ctx: ExecutionContext
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);
    const itemsResponse = await stub.fetch(new Request('http://internal/items'));

    if (!itemsResponse.ok) {
      return Response.json({ error: 'Failed to load item for analysis' }, { status: 500 });
    }

    const data = await itemsResponse.json() as { items: DesktopItem[] };
    const item = data.items.find((candidate) => candidate.id === itemId);

    if (!item) {
      return Response.json({ error: 'Item not found' }, { status: 404 });
    }

    if (item.type !== 'image' || !item.r2Key || !item.mimeType) {
      return Response.json({ error: 'Only uploaded image files can be analyzed' }, { status: 400 });
    }

    const object = await env.ETERNALOS_FILES.get(item.r2Key);
    if (!object) {
      return Response.json({ error: 'Image file not found' }, { status: 404 });
    }

    const fileBuffer = await object.arrayBuffer();
    await patchItemImageAnalysis(stub, item.id, { status: 'pending' });
    ctx.waitUntil(analyzeUploadedImage(env, stub, item.id, item.mimeType, fileBuffer));

    return Response.json({ success: true, itemId: item.id, status: 'pending' });
  } catch (error) {
    console.error('Analyze image item error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Failed to start image analysis' },
      { status: 500 }
    );
  }
}

/**
 * Serve file from R2
 * GET /api/files/:uid/:itemId/:filename
 *
 * Access control:
 * - Owner (valid JWT with matching uid): always allowed
 * - Anyone else: only if the corresponding desktop item is public
 */
export async function handleServeFile(
  request: Request,
  env: Env,
  fileOwnerUid: string,
  itemId: string,
  filename: string,
  requestingAuth: AuthContext | null
): Promise<Response> {
  try {
    // SECURITY: Validate path segments to prevent traversal attacks
    // After decoding, reject any segment containing '..' or path separators
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return Response.json(
        { error: 'Invalid filename' },
        { status: 400 }
      );
    }
    if (itemId.includes('..') || itemId.includes('/') || itemId.includes('\\')) {
      return Response.json(
        { error: 'Invalid item ID' },
        { status: 400 }
      );
    }

    // Check access permissions and get the item's stored r2Key
    const isOwner = requestingAuth?.uid === fileOwnerUid;

    if (!isOwner) {
      // Not the owner - check if item is public via the authoritative DO
      const isPublic = await checkItemIsPublic(env, fileOwnerUid, itemId);
      if (!isPublic) {
        return Response.json(
          { error: 'Forbidden' },
          { status: 403 }
        );
      }
    }

    // SECURITY: Use the item's stored r2Key from the DO instead of constructing
    // from URL parameters. This prevents IDOR where a valid public itemId is
    // combined with a different filename to access other R2 objects.
    const storedR2Key = await getItemR2Key(env, fileOwnerUid, itemId);
    // Use stored key if available, fall back to constructed key for backwards compat
    const r2Key = storedR2Key || `${fileOwnerUid}/${itemId}/${filename}`;

    // Check for Range request header (needed for video/audio streaming)
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      // Parse Range header (e.g., "bytes=0-999" or "bytes=500-")
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (match) {
        // First, get total file size with head request
        const headResult = await env.ETERNALOS_FILES.head(r2Key);
        if (!headResult) {
          return Response.json(
            { error: 'File not found' },
            { status: 404 }
          );
        }
        const totalSize = headResult.size;
        const contentType = headResult.httpMetadata?.contentType || 'application/octet-stream';
        const etag = headResult.httpEtag;

        const start = parseInt(match[1], 10);
        // If no end specified, serve to end of file
        const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        // Clamp end to file bounds
        const clampedEnd = Math.min(end, totalSize - 1);
        const length = clampedEnd - start + 1;

        // Validate range
        if (start >= totalSize || start < 0) {
          const headers = new Headers();
          headers.set('Content-Range', `bytes */${totalSize}`);
          return new Response(null, { status: 416, headers }); // Range Not Satisfiable
        }

        // Fetch partial content from R2
        const object = await env.ETERNALOS_FILES.get(r2Key, {
          range: { offset: start, length },
        });

        if (!object) {
          return Response.json(
            { error: 'File not found' },
            { status: 404 }
          );
        }

        const headers = new Headers();
        headers.set('Content-Type', contentType);
        headers.set('Content-Length', length.toString());
        headers.set('Content-Range', `bytes ${start}-${clampedEnd}/${totalSize}`);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('ETag', etag);

        return new Response(object.body, { status: 206, headers });
      }
    }

    // No range request - fetch full file
    const object = await env.ETERNALOS_FILES.get(r2Key);

    if (!object) {
      return Response.json(
        { error: 'File not found' },
        { status: 404 }
      );
    }

    // Build response with proper headers
    const headers = new Headers();
    const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
    headers.set('Content-Type', contentType);
    headers.set('Content-Length', object.size.toString());
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);
    // Prevent HTML/SVG files from rendering inline to avoid XSS
    const isInlineSafe = /^(image|video|audio)\//.test(contentType);
    const disposition = isInlineSafe ? 'inline' : `attachment; filename="${encodeURIComponent(filename)}"`;
    headers.set('Content-Disposition', disposition);
    // Always indicate we accept ranges for video/audio
    headers.set('Accept-Ranges', 'bytes');

    // Handle conditional requests
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(object.body, { headers });

  } catch (error) {
    console.error('Serve file error:', error);
    return Response.json(
      { error: 'Failed to serve file' },
      { status: 500 }
    );
  }
}

/**
 * Check if a desktop item is public
 * First tries KV cache, falls back to Durable Object
 */
async function checkItemIsPublic(
  env: Env,
  uid: string,
  itemId: string
): Promise<boolean> {
  // Try KV cache first (public snapshot)
  const cached = await env.DESKTOP_KV.get<{ items: DesktopItem[] }>(`public:${uid}`, 'json');
  if (cached) {
    const item = cached.items.find(i => i.id === itemId);
    if (item) return true; // It's in the public snapshot, so it's public
  }

  // Fall back to Durable Object
  const doId = env.USER_DESKTOP.idFromName(uid);
  const stub = env.USER_DESKTOP.get(doId);
  const response = await stub.fetch(new Request('http://internal/items'));

  if (!response.ok) {
    return false;
  }

  const data = await response.json() as { items: DesktopItem[] };
  const item = data.items.find(i => i.id === itemId);

  return (item?.isPublic ?? false) && !item?.isTrashed;
}

/**
 * Get the stored r2Key for a desktop item.
 * Returns null if item not found or has no r2Key.
 */
async function getItemR2Key(
  env: Env,
  uid: string,
  itemId: string
): Promise<string | null> {
  const doId = env.USER_DESKTOP.idFromName(uid);
  const stub = env.USER_DESKTOP.get(doId);
  const response = await stub.fetch(new Request('http://internal/items'));

  if (!response.ok) return null;

  const data = await response.json() as { items: DesktopItem[] };
  const item = data.items.find(i => i.id === itemId);
  return item?.r2Key ?? null;
}

// Note: sanitizeFilename is now imported from utils/sanitize.ts
// which provides a more comprehensive implementation with:
// - Path traversal prevention (removes .., /, \)
// - Control character removal
// - Problematic character replacement (<>:"|?*)
// - Proper extension handling
// - Length limiting

/**
 * Handle custom wallpaper upload
 * POST /api/wallpaper
 *
 * Expects multipart/form-data with:
 * - file: The wallpaper image file (jpg/png, max 2MB)
 */
export async function handleWallpaperUpload(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return Response.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    const fileBlob = file as File;

    // Validate file type (only jpg/png for wallpapers)
    const mimeType = fileBlob.type;
    if (!WALLPAPER_ALLOWED_TYPES[mimeType]) {
      return Response.json(
        { error: `Invalid file type: ${mimeType}. Only JPG and PNG allowed for wallpapers.` },
        { status: 400 }
      );
    }

    // Validate file size (max 2MB for wallpapers)
    if (fileBlob.size > MAX_WALLPAPER_SIZE) {
      return Response.json(
        { error: `File too large. Maximum wallpaper size: ${MAX_WALLPAPER_SIZE / 1024 / 1024}MB` },
        { status: 400 }
      );
    }

    // Check storage quota (wallpapers count against quota too)
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);
    const quotaCheckResponse = await stub.fetch(
      new Request('http://internal/quota/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSize: fileBlob.size }),
      })
    );

    if (!quotaCheckResponse.ok) {
      return Response.json(
        { error: 'Failed to check storage quota' },
        { status: 500 }
      );
    }

    const quotaCheck = await quotaCheckResponse.json() as { allowed: boolean; quota: { used: number; limit: number; remaining: number } };
    if (!quotaCheck.allowed) {
      const usedMB = (quotaCheck.quota.used / 1024 / 1024).toFixed(1);
      const limitMB = (quotaCheck.quota.limit / 1024 / 1024).toFixed(0);
      return Response.json(
        {
          error: `Storage quota exceeded. You're using ${usedMB}MB of ${limitMB}MB. Delete some files to free up space.`,
          quota: quotaCheck.quota,
        },
        { status: 413 }
      );
    }

    // Get the current wallpaper before uploading new one (so we can clean up the old R2 file)
    const profileResponse1 = await stub.fetch(new Request('http://internal/profile'));
    let oldWallpaperR2Key: string | null = null;
    if (profileResponse1.ok) {
      const profileData = await profileResponse1.json() as { profile?: { wallpaper?: string } };
      const oldWallpaper = profileData.profile?.wallpaper;
      if (oldWallpaper?.startsWith('custom:')) {
        // Extract the R2 key from the wallpaper value: "custom:uid/wallpaperId/filename"
        const oldPath = oldWallpaper.slice('custom:'.length);
        // R2 key format: uid/wallpaper/wallpaperId/filename
        const parts = oldPath.split('/');
        if (parts.length >= 3) {
          oldWallpaperR2Key = `${parts[0]}/wallpaper/${parts[1]}/${parts[2]}`;
        }
      }
    }

    // Generate unique wallpaper ID
    const wallpaperId = crypto.randomUUID();
    const ext = WALLPAPER_ALLOWED_TYPES[mimeType];
    const filename = `wallpaper.${ext}`;
    const r2Key = `${auth.uid}/wallpaper/${wallpaperId}/${filename}`;

    // Upload to R2
    const fileBuffer = await fileBlob.arrayBuffer();
    await env.ETERNALOS_FILES.put(r2Key, fileBuffer, {
      httpMetadata: {
        contentType: mimeType,
      },
      customMetadata: {
        uploadedBy: auth.uid,
        wallpaperId,
        type: 'custom-wallpaper',
      },
    });

    // Update the user's profile with the new wallpaper (reuse doId and stub from quota check)
    // Store just the path parts needed for URL construction (uid/wallpaperId/filename)
    // The "wallpaper" segment is already in the API path, so we don't include it here
    const wallpaperValue = `custom:${auth.uid}/${wallpaperId}/${filename}`;

    const profileResponse = await stub.fetch(
      new Request('http://internal/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallpaper: wallpaperValue }),
      })
    );

    if (!profileResponse.ok) {
      // Cleanup R2 if profile update fails
      await env.ETERNALOS_FILES.delete(r2Key);
      return Response.json(
        { error: 'Failed to update profile with new wallpaper' },
        { status: 500 }
      );
    }

    const updatedProfile = await profileResponse.json();

    // Clean up the old wallpaper file from R2 (prevent orphaned files)
    if (oldWallpaperR2Key) {
      try {
        await env.ETERNALOS_FILES.delete(oldWallpaperR2Key);
      } catch (cleanupError) {
        // Non-critical — old file remains but doesn't affect functionality
        console.error('Failed to clean up old wallpaper:', cleanupError);
      }
    }

    return Response.json({
      success: true,
      wallpaper: wallpaperValue,
      r2Key,
      profile: updatedProfile,
    });

  } catch (error) {
    console.error('Wallpaper upload error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Wallpaper upload failed' },
      { status: 500 }
    );
  }
}

/**
 * Serve wallpaper from R2
 * GET /api/wallpaper/:uid/:wallpaperId/:filename
 *
 * Wallpapers are always public (accessible by visitors)
 */
export async function handleServeWallpaper(
  request: Request,
  env: Env,
  uid: string,
  wallpaperId: string,
  filename: string
): Promise<Response> {
  try {
    // SECURITY: Validate path segments to prevent traversal attacks
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return Response.json({ error: 'Invalid filename' }, { status: 400 });
    }
    if (wallpaperId.includes('..') || wallpaperId.includes('/') || wallpaperId.includes('\\')) {
      return Response.json({ error: 'Invalid wallpaper ID' }, { status: 400 });
    }

    // Construct R2 key
    const r2Key = `${uid}/wallpaper/${wallpaperId}/${filename}`;

    // Fetch from R2
    const object = await env.ETERNALOS_FILES.get(r2Key);

    if (!object) {
      return Response.json(
        { error: 'Wallpaper not found' },
        { status: 404 }
      );
    }

    // Build response with proper headers
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('Content-Length', object.size.toString());
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Disposition', 'inline');
    headers.set('Content-Security-Policy', "default-src 'none'");

    // Handle conditional requests
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(object.body, { headers });

  } catch (error) {
    console.error('Serve wallpaper error:', error);
    return Response.json(
      { error: 'Failed to serve wallpaper' },
      { status: 500 }
    );
  }
}

/**
 * Handle custom icon upload
 * POST /api/icon
 *
 * Expects multipart/form-data with:
 * - file: The icon image file (PNG only, max 50KB)
 * - itemId: The desktop item ID to associate the icon with
 *
 * Icons are stored at {uid}/icons/{itemId}.png
 * The item's customIcon field is updated to point to the R2 key
 */
export async function handleIconUpload(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get('file');
    const itemId = formData.get('itemId') as string | null;

    if (!file || typeof file === 'string') {
      return Response.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!itemId) {
      return Response.json(
        { error: 'No itemId provided' },
        { status: 400 }
      );
    }

    const fileBlob = file as File;

    // Validate file type (only PNG for icons)
    const mimeType = fileBlob.type;
    if (!ICON_ALLOWED_TYPES[mimeType]) {
      return Response.json(
        { error: `Invalid file type: ${mimeType}. Only PNG files are allowed for custom icons.` },
        { status: 400 }
      );
    }

    // Validate file size (max 50KB for icons)
    if (fileBlob.size > MAX_ICON_SIZE) {
      return Response.json(
        { error: `File too large. Maximum icon size: ${MAX_ICON_SIZE / 1024}KB` },
        { status: 400 }
      );
    }

    // Verify the item exists and belongs to this user
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const itemCheckResponse = await stub.fetch(new Request('http://internal/items'));
    if (!itemCheckResponse.ok) {
      return Response.json(
        { error: 'Failed to verify item ownership' },
        { status: 500 }
      );
    }

    const { items } = await itemCheckResponse.json() as { items: DesktopItem[] };
    const item = items.find(i => i.id === itemId);
    if (!item) {
      return Response.json(
        { error: 'Item not found' },
        { status: 404 }
      );
    }

    // Generate R2 key for the icon
    const r2Key = `${auth.uid}/icons/${itemId}.png`;

    // Upload to R2
    const fileBuffer = await fileBlob.arrayBuffer();
    await env.ETERNALOS_FILES.put(r2Key, fileBuffer, {
      httpMetadata: {
        contentType: mimeType,
      },
      customMetadata: {
        uploadedBy: auth.uid,
        itemId,
        type: 'custom-icon',
      },
    });

    // Update the item's customIcon field to point to the R2 key
    // Use a special prefix to distinguish uploaded icons from library icons
    const customIconValue = `upload:${r2Key}`;

    const updateResponse = await stub.fetch(
      new Request('http://internal/items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          id: itemId,
          updates: { customIcon: customIconValue },
        }]),
      })
    );

    if (!updateResponse.ok) {
      // Cleanup R2 if update fails
      await env.ETERNALOS_FILES.delete(r2Key);
      return Response.json(
        { error: 'Failed to update item with custom icon' },
        { status: 500 }
      );
    }

    const updatedItems = await updateResponse.json() as DesktopItem[];

    return Response.json({
      success: true,
      customIcon: customIconValue,
      r2Key,
      item: updatedItems[0],
    });

  } catch (error) {
    console.error('Icon upload error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'Icon upload failed' },
      { status: 500 }
    );
  }
}

/**
 * Serve custom icon from R2
 * GET /api/icon/:uid/:itemId/:filename
 *
 * Custom icons are always public (visible in visitor mode)
 */
export async function handleServeIcon(
  request: Request,
  env: Env,
  uid: string,
  itemId: string,
  filename: string
): Promise<Response> {
  try {
    // SECURITY: Validate path segments to prevent traversal attacks
    if (itemId.includes('..') || itemId.includes('/') || itemId.includes('\\')) {
      return Response.json({ error: 'Invalid item ID' }, { status: 400 });
    }

    // Construct R2 key
    const r2Key = `${uid}/icons/${itemId}.png`;

    // Fetch from R2
    const object = await env.ETERNALOS_FILES.get(r2Key);

    if (!object) {
      return Response.json(
        { error: 'Icon not found' },
        { status: 404 }
      );
    }

    // Build response with proper headers
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/png');
    headers.set('Content-Length', object.size.toString());
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Disposition', 'inline');
    headers.set('Content-Security-Policy', "default-src 'none'");

    // Handle conditional requests
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(object.body, { headers });

  } catch (error) {
    console.error('Serve icon error:', error);
    return Response.json(
      { error: 'Failed to serve icon' },
      { status: 500 }
    );
  }
}

// ============ CSS Asset Upload & Serving ============

/**
 * Handle CSS asset upload
 * POST /api/css-assets
 *
 * Expects multipart/form-data with:
 * - file: The image file (jpg/png/gif/webp, max 500KB)
 *
 * CSS assets are images intended for use in custom CSS (backgrounds, cursors, stickers).
 * They are always publicly accessible since visitors need to load them.
 */
export async function handleCSSAssetUpload(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const fileBlob = file as File;

    // Validate file type
    const mimeType = fileBlob.type;
    if (!CSS_ASSET_ALLOWED_TYPES[mimeType]) {
      return Response.json(
        { error: `Invalid file type: ${mimeType}. Allowed: JPG, PNG, GIF, WebP.` },
        { status: 400 }
      );
    }

    // Validate file size
    if (fileBlob.size > MAX_CSS_ASSET_SIZE) {
      return Response.json(
        { error: `File too large. Maximum CSS asset size: ${MAX_CSS_ASSET_SIZE / 1024}KB` },
        { status: 400 }
      );
    }

    // Check existing asset count via Durable Object
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const listResponse = await stub.fetch(new Request('http://internal/css-assets'));
    if (!listResponse.ok) {
      return Response.json({ error: 'Failed to check CSS assets' }, { status: 500 });
    }

    const { assets } = await listResponse.json() as { assets: CSSAssetMeta[] };
    if (assets.length >= MAX_CSS_ASSETS_PER_USER) {
      return Response.json(
        { error: `Maximum ${MAX_CSS_ASSETS_PER_USER} CSS assets allowed. Delete some assets to upload more.` },
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
    const assetId = crypto.randomUUID();
    const originalName = fileBlob.name || `asset.${CSS_ASSET_ALLOWED_TYPES[mimeType]}`;
    const sanitizedName = sanitizeFilename(originalName);
    const r2Key = `${auth.uid}/css-assets/${assetId}/${sanitizedName}`;

    // Upload to R2
    const fileBuffer = await fileBlob.arrayBuffer();
    await env.ETERNALOS_FILES.put(r2Key, fileBuffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: {
        uploadedBy: auth.uid,
        assetId,
        type: 'css-asset',
      },
    });

    // Store metadata in Durable Object
    const meta: CSSAssetMeta = {
      assetId,
      filename: sanitizedName,
      mimeType,
      size: fileBlob.size,
      uploadedAt: Date.now(),
    };

    const addResponse = await stub.fetch(
      new Request('http://internal/css-assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      })
    );

    if (!addResponse.ok) {
      // Cleanup R2 on failure
      await env.ETERNALOS_FILES.delete(r2Key);
      return Response.json({ error: 'Failed to save CSS asset metadata' }, { status: 500 });
    }

    return Response.json({
      success: true,
      asset: {
        ...meta,
        url: `/api/css-assets/${auth.uid}/${assetId}/${sanitizedName}`,
      },
    });

  } catch (error) {
    console.error('CSS asset upload error:', error);
    return Response.json(
      { error: error instanceof Error ? error.message : 'CSS asset upload failed' },
      { status: 500 }
    );
  }
}

/**
 * Serve CSS asset from R2
 * GET /api/css-assets/:uid/:assetId/:filename
 *
 * CSS assets are always public (visitors see the owner's custom CSS)
 */
export async function handleServeCSSAsset(
  request: Request,
  env: Env,
  uid: string,
  assetId: string,
  filename: string
): Promise<Response> {
  try {
    const r2Key = `${uid}/css-assets/${assetId}/${filename}`;
    const object = await env.ETERNALOS_FILES.get(r2Key);

    if (!object) {
      return Response.json({ error: 'CSS asset not found' }, { status: 404 });
    }

    // Validate Content-Type — only serve known image types from CSS assets
    const storedType = object.httpMetadata?.contentType || '';
    const safeImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const contentType = safeImageTypes.includes(storedType) ? storedType : 'application/octet-stream';

    const headers = new Headers();
    headers.set('Content-Type', contentType);
    headers.set('Content-Length', object.size.toString());
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', object.httpEtag);
    // Security: prevent MIME type sniffing and enforce inline display only
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");

    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch === object.httpEtag) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(object.body, { headers });

  } catch (error) {
    console.error('Serve CSS asset error:', error);
    return Response.json({ error: 'Failed to serve CSS asset' }, { status: 500 });
  }
}

/**
 * List CSS assets for a user
 * GET /api/css-assets
 */
export async function handleListCSSAssets(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    const response = await stub.fetch(new Request('http://internal/css-assets'));
    if (!response.ok) {
      return Response.json({ error: 'Failed to list CSS assets' }, { status: 500 });
    }

    const data = await response.json() as { assets: CSSAssetMeta[] };

    // Add full URL path to each asset
    const assetsWithUrls = data.assets.map(asset => ({
      ...asset,
      url: `/api/css-assets/${auth.uid}/${asset.assetId}/${asset.filename}`,
    }));

    return Response.json({ assets: assetsWithUrls });

  } catch (error) {
    console.error('List CSS assets error:', error);
    return Response.json({ error: 'Failed to list CSS assets' }, { status: 500 });
  }
}

/**
 * Delete a CSS asset
 * DELETE /api/css-assets/:assetId
 */
export async function handleDeleteCSSAsset(
  request: Request,
  env: Env,
  auth: AuthContext,
  assetId: string
): Promise<Response> {
  try {
    const doId = env.USER_DESKTOP.idFromName(auth.uid);
    const stub = env.USER_DESKTOP.get(doId);

    // Get the asset metadata to find the R2 key
    const listResponse = await stub.fetch(new Request('http://internal/css-assets'));
    if (!listResponse.ok) {
      return Response.json({ error: 'Failed to find CSS asset' }, { status: 500 });
    }

    const { assets } = await listResponse.json() as { assets: CSSAssetMeta[] };
    const asset = assets.find(a => a.assetId === assetId);
    if (!asset) {
      return Response.json({ error: 'CSS asset not found' }, { status: 404 });
    }

    // Delete from R2
    const r2Key = `${auth.uid}/css-assets/${assetId}/${asset.filename}`;
    await env.ETERNALOS_FILES.delete(r2Key);

    // Remove metadata from Durable Object
    const deleteResponse = await stub.fetch(
      new Request(`http://internal/css-assets/${assetId}`, { method: 'DELETE' })
    );

    if (!deleteResponse.ok) {
      return Response.json({ error: 'Failed to delete CSS asset metadata' }, { status: 500 });
    }

    return Response.json({ success: true });

  } catch (error) {
    console.error('Delete CSS asset error:', error);
    return Response.json({ error: 'Failed to delete CSS asset' }, { status: 500 });
  }
}

// CSS Asset metadata type (shared with Durable Object)
export interface CSSAssetMeta {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
}
