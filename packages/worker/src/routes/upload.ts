/**
 * File Upload & Serving Routes
 *
 * POST /api/upload - Upload file to R2 and create desktop item
 * GET /api/files/:uid/:itemId/:filename - Serve file from R2
 *
 * Supports images (jpg/png/gif/webp) and text files (txt/md).
 */

import { fileTypeFromBuffer } from 'file-type';
import { ALLOWED_TYPES, MAX_FILE_SIZE } from '../utils/fileTypes';
import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import { acquireAiRequest } from '../middleware/aiUsage';
import type { DesktopItem, ImageAnalysisMetadata, UserRecord } from '../types';
import { sanitizeFilename, sanitizeText } from '../utils/sanitize';

// Allowed MIME types for regular file uploads

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


// Max wallpaper size: 2MB
const MAX_WALLPAPER_SIZE = 2 * 1024 * 1024;

// Max custom icon size: 50KB
const MAX_ICON_SIZE = 50 * 1024;
const MAX_IMAGE_ANALYSIS_SIZE = 2 * 1024 * 1024;
const IMAGE_ANALYSIS_MODEL_FALLBACKS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/meta/llama-3.2-11b-vision-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/google/gemma-3-12b-it',
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

/**
 * The slice of the WebCodecs ImageDecoder API this module uses. Workers
 * types don't declare ImageDecoder (and it may be absent at runtime), so it
 * is read off globalThis through these shapes instead of `any`.
 */
interface DecodedImageFrame {
  displayWidth?: number;
  displayHeight?: number;
  codedWidth?: number;
  codedHeight?: number;
  copyTo(destination: Uint8Array, options?: { format?: string }): Promise<unknown>;
  close?(): void;
}

interface ImageDecoderInstance {
  decode(options?: { frameIndex?: number }): Promise<{ image: DecodedImageFrame }>;
  close?(): void;
}

interface ImageDecoderConstructor {
  new (init: { data: Uint8Array; type: string }): ImageDecoderInstance;
  isTypeSupported?(type: string): Promise<boolean>;
}

async function extractDecodedFrameDominantColors(fileBuffer: ArrayBuffer, mimeType: string): Promise<string[]> {
  const ImageDecoderCtor = (globalThis as unknown as { ImageDecoder?: ImageDecoderConstructor }).ImageDecoder;
  if (!ImageDecoderCtor) {
    return [];
  }

  const supportsType = typeof ImageDecoderCtor.isTypeSupported === 'function'
    ? await ImageDecoderCtor.isTypeSupported(mimeType).catch(() => false)
    : true;

  if (!supportsType) {
    return [];
  }

  const decoder = new ImageDecoderCtor({
    data: new Uint8Array(fileBuffer),
    type: mimeType,
  });

  let frame: DecodedImageFrame | undefined;

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

/**
 * Automatic analysis of a fresh upload, charged to the account's daily AI
 * budget like every other AI call (middleware/aiUsage.ts). The upload itself
 * already succeeded, so an exhausted budget or an unreachable guard never
 * fails anything: the item is quietly marked `skipped` (the manual /analyze
 * route can run it later) and no provider work is spent.
 */
async function analyzeUploadWithinBudget(
  env: Env,
  uid: string,
  stub: DurableObjectStub,
  itemId: string,
  mimeType: string,
  fileBuffer: ArrayBuffer
): Promise<void> {
  if (fileBuffer.byteLength > MAX_IMAGE_ANALYSIS_SIZE) {
    // Too big to analyze: analyzeUploadedImage marks it skipped without any
    // AI call, so don't charge the budget for it.
    await analyzeUploadedImage(env, stub, itemId, mimeType, fileBuffer);
    return;
  }

  let skipReason: string | null = null;
  try {
    const decision = await acquireAiRequest(env, uid, { slot: false });
    if (!decision.allowed) {
      skipReason = decision.message;
    }
  } catch (error) {
    // Fail closed on a guard outage, like the manual analyze route.
    console.error('AI usage guard unavailable for upload analysis:', error);
    skipReason = 'AI usage could not be verified, so automatic analysis was skipped.';
  }

  if (skipReason) {
    await patchItemImageAnalysis(stub, itemId, {
      status: 'skipped',
      analyzedAt: Date.now(),
      error: skipReason,
    }).catch((error) => console.error('Failed to mark upload analysis skipped:', error));
    return;
  }

  await analyzeUploadedImage(env, stub, itemId, mimeType, fileBuffer);
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

type UploadMimeResolution =
  | { ok: true; mime: string }
  | { ok: false; error: string };

/**
 * Decide the MIME type an upload is stored and served as. Binary formats are
 * sniffed from their magic bytes and the DETECTED type wins over the declared
 * one (a PNG labelled image/jpeg is stored as image/png). Text types have no
 * magic bytes, so a declared text type is kept as is.
 */
export async function resolveUploadMimeType(
  declaredMime: string,
  fileBuffer: ArrayBuffer,
): Promise<UploadMimeResolution> {
  if (declaredMime.startsWith('text/')) {
    return { ok: true, mime: declaredMime };
  }
  const detected = await fileTypeFromBuffer(fileBuffer);
  if (!detected) {
    return { ok: false, error: 'Could not verify file type. The file may be corrupted.' };
  }
  // file-type can append parameters (`audio/ogg; codecs=opus`).
  const detectedMime = detected.mime.split(';')[0].trim();
  if (!ALLOWED_TYPES[detectedMime]) {
    return { ok: false, error: `File content does not match an allowed type. Detected: ${detectedMime}` };
  }
  if (detectedMime === declaredMime) {
    return { ok: true, mime: detectedMime };
  }
  // One container, two media classes: file-type reports every ISO-BMFF file
  // as video/mp4 (AAC .m4a included) and every Ogg as audio/ogg. When only
  // the top-level class differs, the declared type is the better answer.
  const sameContainer = detectedMime.split('/')[1] === declaredMime.split('/')[1];
  if (sameContainer) {
    return { ok: true, mime: declaredMime };
  }
  console.warn(`MIME mismatch: declared=${declaredMime}, detected=${detectedMime}; storing detected`);
  return { ok: true, mime: detectedMime };
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
    const declaredMimeType = fileBlob.type;
    if (!ALLOWED_TYPES[declaredMimeType]) {
      return Response.json(
        { error: `Invalid file type: ${declaredMimeType}. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}` },
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

    const fileBuffer = await fileBlob.arrayBuffer();

    // SECURITY: Validate actual file content via magic bytes, not just the declared
    // MIME type (which is trivially spoofed). Text files have no magic bytes, so
    // we only check binary formats (images, video, audio).
    const detection = await resolveUploadMimeType(declaredMimeType, fileBuffer);
    if (!detection.ok) {
      if (releaseQuota) await releaseQuota();
      return Response.json({ error: detection.error }, { status: 400 });
    }
    // Everything below (stored Content-Type, item type, mimeType field) uses
    // the type the bytes actually are, not the one the client claimed.
    const mimeType = detection.mime;

    // Generate item ID and R2 key
    const itemId = crypto.randomUUID();
    const originalName = fileBlob.name || `file.${ALLOWED_TYPES[mimeType]}`;
    const sanitizedName = sanitizeFilename(originalName);
    r2Key = `${auth.uid}/${itemId}/${sanitizedName}`;

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
      ctx.waitUntil(analyzeUploadWithinBudget(env, auth.uid, stub, itemId, mimeType, fileBuffer));
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

    // Per-account daily AI budget (see middleware/aiUsage.ts). Charged only
    // when the request is valid and analysis is actually about to start, so
    // invalid-item requests stay free; an exhausted budget answers a clear
    // 429 with a friendly message instead of kicking off provider work.
    try {
      const decision = await acquireAiRequest(env, auth.uid, { slot: false });
      if (!decision.allowed) {
        const headers: Record<string, string> = {
          'Retry-After': String(decision.retryAfterSeconds),
        };
        return Response.json({ error: decision.message }, { status: 429, headers });
      }
    } catch (error) {
      // Fail closed on a guard outage, like the per-IP limiter.
      console.error('AI usage guard unavailable for image analysis:', error);
      return Response.json(
        { error: 'AI usage could not be verified, so analysis is unavailable right now. Please try again shortly.' },
        { status: 503 },
      );
    }

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

    // A soft-deleted (or purged) account serves nothing, to anyone. File
    // tokens (`?ft=`) don't re-check the account, so this applies to the
    // owner path too.
    if (!(await isAccountActive(env, fileOwnerUid))) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    // SECURITY: One authoritative lookup in the owner's Durable Object gives
    // both the visibility and the stored r2Key. The key is never built from
    // URL parameters: that allowed IDOR (a public itemId combined with another
    // filename) and served deleted items whose blob was still in R2.
    const lookup = await findDesktopItem(env, fileOwnerUid, itemId);
    if (lookup === 'error') {
      return Response.json({ error: 'Failed to serve file' }, { status: 500 });
    }
    if (!lookup) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const isOwner = requestingAuth?.uid === fileOwnerUid;
    if (!isOwner && (!lookup.isPublic || lookup.isTrashed)) {
      return Response.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
    }

    // Very old items may predate the stored r2Key. The item does exist, so
    // its owner may still reach the conventional key; visitors may not.
    const r2Key = lookup.r2Key ?? (isOwner ? `${fileOwnerUid}/${itemId}/${filename}` : null);
    if (!r2Key) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    // Range requests (video/audio streaming). An unparseable or multi-range
    // header is ignored and the full file is served, as RFC 9110 allows.
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      const headResult = await env.ETERNALOS_FILES.head(r2Key);
      if (!headResult) {
        return Response.json(
          { error: 'File not found' },
          { status: 404 }
        );
      }
      const totalSize = headResult.size;
      const range = parseByteRange(rangeHeader, totalSize);

      if (range.kind === 'unsatisfiable') {
        const headers = new Headers();
        headers.set('Content-Range', `bytes */${totalSize}`);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'private, no-store');
        return new Response(null, { status: 416, headers }); // Range Not Satisfiable
      }

      if (range.kind === 'partial') {
        const length = range.end - range.start + 1;
        const object = await env.ETERNALOS_FILES.get(r2Key, {
          range: { offset: range.start, length },
        });

        if (!object) {
          return Response.json(
            { error: 'File not found' },
            { status: 404 }
          );
        }

        const headers = new Headers();
        const partialType = headResult.httpMetadata?.contentType || 'application/octet-stream';
        headers.set('Content-Type', partialType);
        headers.set('Content-Disposition', /^(image|video|audio)\//.test(partialType)
          ? 'inline'
          : `attachment; filename="${encodeURIComponent(filename)}"`);
        headers.set('Content-Length', length.toString());
        headers.set('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'private, no-store');
        headers.set('ETag', headResult.httpEtag);
        headers.set('X-Content-Type-Options', 'nosniff');

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
    headers.set('Cache-Control', 'private, no-store');
    headers.set('ETag', object.httpEtag);
    // Prevent HTML/SVG files from rendering inline to avoid XSS
    const isInlineSafe = /^(image|video|audio)\//.test(contentType);
    const disposition = isInlineSafe ? 'inline' : `attachment; filename="${encodeURIComponent(filename)}"`;
    headers.set('Content-Disposition', disposition);
    // Defense in depth: never let the browser MIME-sniff a stored blob into a
    // scriptable type (matches the bazaar asset serve route).
    headers.set('X-Content-Type-Options', 'nosniff');
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

export type ByteRangeDecision =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Interpret a `Range` header against an object of `size` bytes.
 *
 * - `bytes=a-b` / `bytes=a-` / `bytes=-n` (suffix) give one inclusive range,
 *   with the end clamped to the last byte.
 * - A reversed range (`bytes=500-100`), a start at/after the end of the
 *   file, a zero-length suffix, or any range on an empty file is
 *   unsatisfiable (416).
 * - Anything else (missing header, other units, multiple ranges, garbage)
 *   is ignored and the full object is served.
 */
export function parseByteRange(header: string | null, size: number): ByteRangeDecision {
  if (!header) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'full' };
  const [, startText, endText] = match;
  if (!startText && !endText) return { kind: 'full' };

  if (!startText) {
    // Suffix range: the last N bytes.
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  if (endText && (!Number.isFinite(requestedEnd) || requestedEnd < start)) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * Whether the account owning `uid` exists and is not soft-deleted
 * (`deletedAt` on the UserRecord at AUTH_KV `user:{email}`, found through
 * the `uid:{uid}` index).
 */
async function isAccountActive(env: Env, uid: string): Promise<boolean> {
  const indexJson = await env.AUTH_KV.get(`uid:${uid}`);
  if (!indexJson) return false;
  try {
    const { email } = JSON.parse(indexJson) as { email?: string };
    if (!email) return false;
    const userJson = await env.AUTH_KV.get(`user:${email}`);
    if (!userJson) return false;
    const user = JSON.parse(userJson) as Pick<UserRecord, 'deletedAt'>;
    return !user.deletedAt;
  } catch {
    return false;
  }
}

/**
 * Load one desktop item from its owner's Durable Object.
 * Returns null when it doesn't exist, 'error' when the DO can't answer.
 */
async function findDesktopItem(
  env: Env,
  uid: string,
  itemId: string
): Promise<DesktopItem | null | 'error'> {
  const doId = env.USER_DESKTOP.idFromName(uid);
  const stub = env.USER_DESKTOP.get(doId);
  const response = await stub.fetch(new Request('http://internal/items'));
  if (!response.ok) return 'error';

  const data = await response.json() as { items: DesktopItem[] };
  return data.items.find((item) => item.id === itemId) ?? null;
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
        // SECURITY: The uid segment in the stored string MUST match the caller's
        // own uid. Otherwise an attacker could PATCH their profile with a victim's
        // wallpaper path and use this upload flow to delete the victim's R2 object
        // (cross-tenant destructive IDOR). Always derive the key from auth.uid.
        if (parts.length >= 3 && parts[0] === auth.uid) {
          const wallpaperIdSegment = parts[1];
          const filenameSegment = parts[2];
          // Defense-in-depth: reject traversal/separator chars in the stored segments
          // before using them in an R2 key.
          const segmentOk = (s: string) =>
            typeof s === 'string' &&
            s.length > 0 &&
            !s.includes('..') &&
            !s.includes('/') &&
            !s.includes('\\');
          if (segmentOk(wallpaperIdSegment) && segmentOk(filenameSegment)) {
            oldWallpaperR2Key = `${auth.uid}/wallpaper/${wallpaperIdSegment}/${filenameSegment}`;
          }
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
    headers.set('X-Content-Type-Options', 'nosniff');

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
 * Icons are stored at {uid}/icons/{itemId}.{version}.png, where version is
 * a hash of the bytes. Icons are served with immutable year-long caching, so
 * every new icon needs a new URL; the frontend derives the URL from the key
 * (`/api/icon/{uid}/{itemId}.{version}/icon.png`). Older icons used the
 * unversioned {uid}/icons/{itemId}.png key, which still serves.
 * The item's customIcon field is updated to point to the R2 key.
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

    // Versioned R2 key: a new icon gets a new key, hence a new URL that no
    // immutable cache entry can shadow.
    const fileBuffer = await fileBlob.arrayBuffer();
    const version = await iconContentVersion(fileBuffer);
    const r2Key = `${auth.uid}/icons/${itemId}.${version}.png`;
    // Only this item's own earlier key: a duplicated item copies its
    // original's customIcon, and that key is still the original's icon.
    const previousIconKey = item.customIcon?.startsWith(`upload:${auth.uid}/icons/${itemId}.`)
      ? item.customIcon.slice('upload:'.length)
      : null;

    // Upload to R2
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
      // Cleanup R2 if update fails (unless the same bytes were already the
      // item's icon: then the key is still in use).
      if (previousIconKey !== r2Key) {
        await env.ETERNALOS_FILES.delete(r2Key);
      }
      return Response.json(
        { error: 'Failed to update item with custom icon' },
        { status: 500 }
      );
    }

    // The item now points at the new key; drop the replaced icon so
    // re-uploads don't pile up orphans. Old unversioned URLs still resolve
    // through the item (see handleServeIcon).
    if (previousIconKey && previousIconKey !== r2Key) {
      await env.ETERNALOS_FILES.delete(previousIconKey).catch((error) =>
        console.warn('Failed to delete replaced icon:', error)
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

/** `{itemId}.{version}` URL segment of a versioned icon. */
const ICON_VERSIONED_SEGMENT = /^.+\.[0-9a-f]{16}$/;

/** Content version of an icon: the first 16 hex chars of its SHA-256. */
async function iconContentVersion(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
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

    if (uid.includes('..') || uid.includes('/') || uid.includes('\\')) {
      return Response.json({ error: 'Invalid icon path' }, { status: 400 });
    }

    // `itemId` is the URL segment: `{itemId}.{version}` for versioned icons
    // (key `{uid}/icons/{itemId}.{version}.png`), or a bare `{itemId}` for
    // the legacy unversioned key.
    let versioned = ICON_VERSIONED_SEGMENT.test(itemId);
    let object = await env.ETERNALOS_FILES.get(`${uid}/icons/${itemId}.png`);

    if (!object) {
      // An old URL whose icon was replaced since: serve the item's current
      // uploaded icon (short-cached), so old links keep working.
      versioned = false;
      const baseItemId = itemId.replace(/\.[0-9a-f]{16}$/, '');
      const item = await findDesktopItem(env, uid, baseItemId);
      const prefix = `upload:${uid}/icons/`;
      if (item && item !== 'error' && item.customIcon?.startsWith(prefix)) {
        object = await env.ETERNALOS_FILES.get(item.customIcon.slice('upload:'.length));
      }
    }

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
    // A versioned URL never changes content, so it can be cached forever. An
    // unversioned (legacy) URL can change on re-upload, so keep it short.
    headers.set(
      'Cache-Control',
      versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate'
    );
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Disposition', 'inline');
    headers.set('Content-Security-Policy', "default-src 'none'");
    headers.set('X-Content-Type-Options', 'nosniff');

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
