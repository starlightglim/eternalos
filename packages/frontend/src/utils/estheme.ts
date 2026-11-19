/**
 * .estheme bundle format — frontend utilities.
 *
 * Build / parse .estheme zip bundles on the client (for export, drag-drop
 * install, preview). See design/04-skin-format.md for format details.
 *
 * NOTE: The zod schema here duplicates packages/worker/src/utils/estheme.ts.
 * When we add a shared package (design/ROADMAP.md mentions this), move the
 * schema there and import from both sides. Until then keep the two files in
 * sync manually — diffing is cheap, a shared package refactor isn't.
 */

import JSZip from 'jszip';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema (mirror of worker/src/utils/estheme.ts)
// ---------------------------------------------------------------------------

export const CURSOR_STATES = [
  'default',
  'pointer',
  'grab',
  'grabbing',
  'text',
  'wait',
  'move',
  'nwse-resize',
] as const;

export const SOUND_EVENTS = [
  'click',
  'windowOpen',
  'windowClose',
  'folderOpen',
  'drop',
  'trash',
  'emptyTrash',
  'alert',
  'error',
  'startup',
  'select',
] as const;

const ICON_SLOTS = [
  'folder',
  'text',
  'image',
  'video',
  'audio',
  'pdf',
  'link',
  'widget',
  'sticker',
  'app',
] as const;

const semverRegex = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const slugRegex = /^[a-z0-9][a-z0-9-]{0,63}$/;
const authorRegex = /^@[a-z0-9_]{3,20}$/;
const bundlePathRegex = /^(?!\.\.\/)(?!\/)(?!.*\/\.\.\/)[A-Za-z0-9._\-/]+$/;

const bundlePath = z.string().regex(bundlePathRegex, 'Invalid bundle path');
const colorValue = z.string().max(200);

/**
 * True only for a zip-entry-safe bundle path: relative, forward slashes, no
 * `.`/`..` segments, no backslashes or control characters, bounded length.
 * The manifest schema's `bundlePath` regex rejects the dangerous *declared*
 * shapes (`../`, leading `/`); this additionally rejects any entry whose
 * *segments* are `.` or `..` (e.g. a file literally named `..` or
 * `cursors/..`), and is applied to EVERY file in a parsed bundle, not just
 * the ones the manifest references — a hostile zip must not carry traversal-
 * shaped paths at all. (JSZip normalizes `../` segments itself on load; the
 * backslash/control-character shapes it preserves are what this guard
 * actually intercepts, and `isSafeBundlePath` is exported so the rule is
 * pinned regardless of which loader sits in front of it.)
 */
export function isSafeBundlePath(path: string): boolean {
  if (!path || path.length > 200) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (!/^[A-Za-z0-9._\-/]+$/.test(path)) return false;
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export const tokensLayerSchema = z
  .object({
    accentColor: colorValue.optional(),
    desktopColor: colorValue.optional(),
    windowBgColor: colorValue.optional(),
    titleBarBgColor: colorValue.optional(),
    titleBarTextColor: colorValue.optional(),
    windowBorderColor: colorValue.optional(),
    buttonBgColor: colorValue.optional(),
    buttonTextColor: colorValue.optional(),
    buttonBorderColor: colorValue.optional(),
    labelColor: colorValue.optional(),
    windowBorderRadius: z.number().min(0).max(64).optional(),
    controlBorderRadius: z.number().min(0).max(64).optional(),
    windowShadow: z.number().min(0).max(64).optional(),
    windowOpacity: z.number().min(10).max(100).optional(),
    designTokens: z
      .record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();

export const variantsLayerSchema = z.record(z.string().max(64), z.string().max(128));

export const typographyLayerSchema = z
  .object({
    systemFont: z.string().max(64).optional(),
    bodyFont: z.string().max(64).optional(),
    monoFont: z.string().max(64).optional(),
    fontSmoothing: z.boolean().optional(),
  })
  .strict();

const wallpaperLayerSchema = z
  .object({
    file: bundlePath,
    mobileFile: bundlePath.optional(),
    mode: z.enum(['cover', 'tile', 'center']).optional(),
  })
  .strict();

// NOTE: use `partialRecord`, not `record`. This mirror is on zod 4, where
// `z.record(z.enum(...), v)` is EXHAUSTIVE — it requires every enum key — so a
// theme supplying only some cursor/sound/icon slots would be wrongly rejected.
// Themes declare only the slots they override, so these layers must be partial.
// (The worker mirror is on zod 3, where plain `record` is already partial.)
//
// A cursor slot value is either a plain bundle path (the original v1 form) or
// `{ file, hotspotX?, hotspotY? }`. The object form carries the authored
// hotspot so exported cursor packs round-trip their click point instead of
// silently degrading to 0,0; plain-string values keep old bundles importing.
export interface EsthemeCursorSlot {
  file: string;
  hotspotX?: number;
  hotspotY?: number;
}
export type EsthemeCursorLayerValue = string | EsthemeCursorSlot;

/** The bundle path a cursor layer value refers to, in either form. */
export function cursorSlotPath(value: EsthemeCursorLayerValue): string {
  return typeof value === 'string' ? value : value.file;
}

const cursorSlotSchema = z
  .object({
    file: bundlePath,
    hotspotX: z.number().int().min(0).max(64).optional(),
    hotspotY: z.number().int().min(0).max(64).optional(),
  })
  .strict();

const cursorsLayerSchema = z
  .partialRecord(z.enum(CURSOR_STATES), z.union([bundlePath, cursorSlotSchema]))
  .refine((value) => Object.keys(value).length > 0, {
    message: 'cursors layer declared but empty',
  });

const soundsLayerSchema = z
  .partialRecord(z.enum(SOUND_EVENTS), bundlePath)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'sounds layer declared but empty',
  });

const iconsLayerSchema = z
  .partialRecord(z.enum(ICON_SLOTS), bundlePath)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'icons layer declared but empty',
  });

const layersSchema = z
  .object({
    tokens: bundlePath.optional(),
    css: bundlePath.optional(),
    variants: bundlePath.optional(),
    typography: bundlePath.optional(),
    wallpaper: wallpaperLayerSchema.optional(),
    cursors: cursorsLayerSchema.optional(),
    sounds: soundsLayerSchema.optional(),
    icons: iconsLayerSchema.optional(),
  })
  .strict();

const changelogEntrySchema = z
  .object({
    version: z.string().regex(semverRegex),
    date: z.string().max(32),
    notes: z.string().max(500),
  })
  .strict();

const creditsEntrySchema = z
  .object({
    kind: z.enum(['base', 'fork', 'asset', 'contributor', 'inspiration']),
    id: z.string().max(128).optional(),
    name: z.string().max(128).optional(),
    attribution: z.string().max(500).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * Fork lineage — recorded when a theme was exported from a rice that was
 * itself installed from another `.estheme`. Optional in the manifest so
 * formatVersion-1 bundles written before this field exist still import.
 */
export const forkedFromSchema = z
  .object({
    id: z.string().regex(slugRegex),
    name: z.string().min(1).max(80).optional(),
    author: z.string().regex(authorRegex),
    version: z.string().regex(semverRegex).optional(),
  })
  .strict();

export const esthemeManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().regex(slugRegex),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    version: z.string().regex(semverRegex),
    author: z.string().regex(authorRegex),
    extends: z.string().max(128).optional(),
    /** Fork lineage (optional — see forkedFromSchema). */
    forkedFrom: forkedFromSchema.optional(),
    tags: z.array(z.string().min(1).max(32)).max(10).optional(),
    license: z.string().max(64).optional(),
    homepage: z.string().url().max(512).optional(),
    repo: z.string().url().max(512).optional(),
    minHostVersion: z.string().regex(semverRegex).optional(),
    layers: layersSchema,
    changelog: z.array(changelogEntrySchema).max(50).optional(),
    credits: z.array(creditsEntrySchema).max(50).optional(),
  })
  .strict();

export type EsthemeManifest = z.infer<typeof esthemeManifestSchema>;
export type EsthemeForkedFrom = z.infer<typeof forkedFromSchema>;
export type EsthemeTokens = z.infer<typeof tokensLayerSchema>;
export type EsthemeVariants = z.infer<typeof variantsLayerSchema>;
export type EsthemeTypography = z.infer<typeof typographyLayerSchema>;
export type EsthemeCursorState = (typeof CURSOR_STATES)[number];
export type EsthemeSoundEvent = (typeof SOUND_EVENTS)[number];
export type EsthemeIconSlot = (typeof ICON_SLOTS)[number];

// ---------------------------------------------------------------------------
// Builder input types (what the caller hands us to pack)
// ---------------------------------------------------------------------------

/** Per-layer data a caller may include when building an .estheme bundle. */
export interface EsthemeBuildInput {
  /** Required manifest fields; layers are derived from the other inputs. */
  meta: Omit<EsthemeManifest, 'layers'>;

  tokens?: EsthemeTokens;
  css?: string;
  variants?: EsthemeVariants;
  typography?: EsthemeTypography;

  wallpaper?: {
    file: Blob;
    filename: string;           // e.g. "wallpaper.jpg"
    mobileFile?: Blob;
    mobileFilename?: string;
    mode?: 'cover' | 'tile' | 'center';
  };

  /** Cursor slots → Blob + filename (+ authored hotspot, 0–64). */
  cursors?: Partial<
    Record<(typeof CURSOR_STATES)[number], { blob: Blob; filename: string; hotspotX?: number; hotspotY?: number }>
  >;

  /** Sound slots → Blob + filename. */
  sounds?: Partial<Record<(typeof SOUND_EVENTS)[number], { blob: Blob; filename: string }>>;

  /** Icon slots → Blob + filename. */
  icons?: Partial<Record<(typeof ICON_SLOTS)[number], { blob: Blob; filename: string }>>;

  /** Required: preview image at 1200x750. */
  preview: { blob: Blob; filename?: string };

  /** Optional: mobile preview at 400x800. */
  previewMobile?: { blob: Blob; filename?: string };

  /** Optional: readme.md content. */
  readme?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationSuccess {
  ok: true;
  manifest: EsthemeManifest;
}
export interface ValidationFailure {
  ok: false;
  errors: { path: string; message: string }[];
}
export type ValidationResult = ValidationSuccess | ValidationFailure;

export function validateManifest(input: unknown): ValidationResult {
  const parsed = esthemeManifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const errors = parsed.error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.') || '(root)',
    message: issue.message,
  }));
  return { ok: false, errors };
}

export function validateManifestAgainstFiles(
  input: unknown,
  fileIndex: Set<string>,
): ValidationResult {
  const result = validateManifest(input);
  if (!result.ok) return result;

  const missing: { path: string; message: string }[] = [];
  const { layers } = result.manifest;

  const check = (declared: string, layer: string) => {
    if (!fileIndex.has(declared)) {
      missing.push({ path: `layers.${layer}`, message: `file "${declared}" not in bundle` });
    }
  };

  if (layers.tokens) check(layers.tokens, 'tokens');
  if (layers.css) check(layers.css, 'css');
  if (layers.variants) check(layers.variants, 'variants');
  if (layers.typography) check(layers.typography, 'typography');
  if (layers.wallpaper) {
    check(layers.wallpaper.file, 'wallpaper.file');
    if (layers.wallpaper.mobileFile) check(layers.wallpaper.mobileFile, 'wallpaper.mobileFile');
  }
  for (const [slot, pathValue] of Object.entries(layers.cursors ?? {})) {
    check(cursorSlotPath(pathValue as EsthemeCursorLayerValue), `cursors.${slot}`);
  }
  for (const [slot, pathValue] of Object.entries(layers.sounds ?? {})) {
    check(pathValue, `sounds.${slot}`);
  }
  for (const [slot, pathValue] of Object.entries(layers.icons ?? {})) {
    check(pathValue, `icons.${slot}`);
  }

  return missing.length > 0 ? { ok: false, errors: missing } : result;
}

// ---------------------------------------------------------------------------
// Bundle builder — takes inputs, emits a Blob (zip)
// ---------------------------------------------------------------------------

const MAX_BUNDLE_SIZE_BYTES = 10 * 1024 * 1024;

export interface BuildOptions {
  /** Abort the build if the resulting zip exceeds this size (default 10MB). */
  maxBytes?: number;
}

export async function buildEsthemeBundle(
  input: EsthemeBuildInput,
  options: BuildOptions = {},
): Promise<{ blob: Blob; manifest: EsthemeManifest }> {
  const zip = new JSZip();
  const layers: EsthemeManifest['layers'] = {};

  if (input.tokens && Object.keys(input.tokens).length > 0) {
    zip.file('tokens.json', JSON.stringify(input.tokens, null, 2));
    layers.tokens = 'tokens.json';
  }

  if (input.css && input.css.trim().length > 0) {
    zip.file('theme.css', input.css);
    layers.css = 'theme.css';
  }

  if (input.variants && Object.keys(input.variants).length > 0) {
    zip.file('variants.json', JSON.stringify(input.variants, null, 2));
    layers.variants = 'variants.json';
  }

  if (input.typography && Object.keys(input.typography).length > 0) {
    zip.file('typography.json', JSON.stringify(input.typography, null, 2));
    layers.typography = 'typography.json';
  }

  if (input.wallpaper) {
    zip.file(input.wallpaper.filename, input.wallpaper.file);
    const wallpaper: { file: string; mobileFile?: string; mode?: 'cover' | 'tile' | 'center' } = {
      file: input.wallpaper.filename,
    };
    if (input.wallpaper.mobileFile && input.wallpaper.mobileFilename) {
      zip.file(input.wallpaper.mobileFilename, input.wallpaper.mobileFile);
      wallpaper.mobileFile = input.wallpaper.mobileFilename;
    }
    if (input.wallpaper.mode) wallpaper.mode = input.wallpaper.mode;
    layers.wallpaper = wallpaper;
  }

  if (input.cursors && Object.keys(input.cursors).length > 0) {
    const cursorMap: Record<string, string | EsthemeCursorSlot> = {};
    for (const [slot, asset] of Object.entries(input.cursors)) {
      if (!asset) continue;
      const path = `cursors/${asset.filename}`;
      zip.file(path, asset.blob);
      // Object form whenever the author supplied a hotspot so the click
      // point survives the round-trip; plain string otherwise (v1 form).
      if (asset.hotspotX !== undefined || asset.hotspotY !== undefined) {
        cursorMap[slot] = {
          file: path,
          hotspotX: asset.hotspotX ?? 0,
          hotspotY: asset.hotspotY ?? 0,
        };
      } else {
        cursorMap[slot] = path;
      }
    }
    if (Object.keys(cursorMap).length > 0) {
      layers.cursors = cursorMap as EsthemeManifest['layers']['cursors'];
    }
  }

  if (input.sounds && Object.keys(input.sounds).length > 0) {
    const soundMap: Record<string, string> = {};
    for (const [slot, asset] of Object.entries(input.sounds)) {
      if (!asset) continue;
      const path = `sounds/${asset.filename}`;
      zip.file(path, asset.blob);
      soundMap[slot] = path;
    }
    if (Object.keys(soundMap).length > 0) {
      layers.sounds = soundMap as EsthemeManifest['layers']['sounds'];
    }
  }

  if (input.icons && Object.keys(input.icons).length > 0) {
    const iconMap: Record<string, string> = {};
    for (const [slot, asset] of Object.entries(input.icons)) {
      if (!asset) continue;
      const path = `icons/${asset.filename}`;
      zip.file(path, asset.blob);
      iconMap[slot] = path;
    }
    if (Object.keys(iconMap).length > 0) {
      layers.icons = iconMap as EsthemeManifest['layers']['icons'];
    }
  }

  const previewFilename = input.preview.filename ?? 'preview.png';
  zip.file(previewFilename, input.preview.blob);

  if (input.previewMobile) {
    const mobileName = input.previewMobile.filename ?? 'preview-mobile.png';
    zip.file(mobileName, input.previewMobile.blob);
  }

  if (input.readme) {
    zip.file('readme.md', input.readme);
  }

  const manifest: EsthemeManifest = {
    ...input.meta,
    layers,
  };

  // Final schema check before zipping — catches any mismatch between builder
  // input and manifest validation rules.
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      `Manifest failed validation before packing: ${validation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`,
    );
  }

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    mimeType: 'application/zip',
  });

  const maxBytes = options.maxBytes ?? MAX_BUNDLE_SIZE_BYTES;
  if (blob.size > maxBytes) {
    throw new Error(
      `Bundle size ${Math.round(blob.size / 1024)}KB exceeds limit ${Math.round(maxBytes / 1024)}KB`,
    );
  }

  return { blob, manifest };
}

// ---------------------------------------------------------------------------
// Bundle parser — reads a .estheme Blob into {manifest, files}
// ---------------------------------------------------------------------------

export interface ParsedBundle {
  manifest: EsthemeManifest;
  /** All files in the bundle keyed by their zip path. */
  files: Map<string, Blob>;
}

/** Hard ceiling on the files a bundle may declare (assets + layers + previews). */
export const MAX_BUNDLE_FILES = 64;

/**
 * Total extracted (uncompressed) bytes a bundle may carry. Mirrors the build
 * limit (`MAX_BUNDLE_SIZE_BYTES`): a hostile zip must not be able to expand
 * past the size the builder would ever emit. Enforced in TWO layers, because
 * the central directory can lie:
 *
 *   1. before inflating anything, the entries' DECLARED uncompressed sizes
 *      are summed and checked (plus a per-entry cap and a plausibility ratio
 *      check) — a classic zip bomb is turned away at the directory;
 *   2. every entry is then inflated through a streaming read that aborts the
 *      moment the running total passes the cap, so a zip whose declared
 *      sizes lie small is still cut off mid-stream instead of being
 *      materialized whole.
 */
export const MAX_BUNDLE_CONTENT_BYTES = 10 * 1024 * 1024;

/**
 * Cap on manifest.json alone. It is the one entry inflated before the
 * manifest's own layer table can be cross-checked, and the only one whose
 * content we JSON.parse — 256KB is two orders of magnitude above the largest
 * manifest the builder can emit (50 changelog + 50 credits entries at their
 * per-field caps stay well under 60KB), so nothing legitimate is lost while
 * a hostile "manifest" costs at most a bounded inflate + parse.
 */
export const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * Ratio gate tuning: only entries DECLARING more than 1MB uncompressed are
 * ratio-checked, and anything above 100:1 expansion is rejected. Why 100:1 —
 * DEFLATE tops out near its theoretical ~1032:1 on crafted input, while the
 * >1MB payloads a real theme carries (JPEG/PNG wallpapers and previews,
 * MP3s) are already compressed and re-deflate at ~1:1, and every text layer
 * the format allows is far below 1MB. No honestly-declared bundle crosses
 * 100:1 above 1MB; a directory claiming triple-digit expansion for a big
 * entry is a bomb signature, not a theme.
 */
const MAX_PLAUSIBLE_RATIO_ENTRY_BYTES = 1024 * 1024;
const MAX_PLAUSIBLE_COMPRESSION_RATIO = 100;

/**
 * The central-directory sizes JSZip records for a loaded entry (`_data` is
 * the internal CompressedObject; JSZip does not expose these through its
 * typings). These are exactly the values a hostile zip can LIE about, which
 * is why nothing security-relevant relies on them alone — the streaming read
 * re-checks every byte as it inflates.
 */
function declaredSizes(entry: JSZip.JSZipObject): { uncompressed: number | null; compressed: number | null } {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown; compressedSize?: unknown } })._data;
  if (!data || typeof data !== 'object') return { uncompressed: null, compressed: null };
  const read = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return { uncompressed: read(data.uncompressedSize), compressed: read(data.compressedSize) };
}

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/**
 * Pre-inflation gate: reject bundles whose own central directory admits they
 * are over the content cap — per entry, summed, or by implausible claimed
 * expansion — BEFORE a single byte is inflated. `manifest.json` is skipped
 * here; it carries its own (much smaller) declared cap at read time.
 */
function assertDeclaredSizesAcceptable(entries: { path: string; entry: JSZip.JSZipObject }[]): void {
  let declaredTotal = 0;
  for (const { path, entry } of entries) {
    if (path === 'manifest.json') continue;
    const { uncompressed, compressed } = declaredSizes(entry);
    // A null declared size (entry not backed by a central-directory record)
    // cannot be pre-checked — the streaming cap below still bounds it.
    if (uncompressed === null) continue;
    if (uncompressed > MAX_BUNDLE_CONTENT_BYTES) {
      throw new Error(
        `Invalid bundle: "${path}" declares ${mb(uncompressed)}MB of content, over the ${mb(MAX_BUNDLE_CONTENT_BYTES)}MB limit`,
      );
    }
    if (
      uncompressed > MAX_PLAUSIBLE_RATIO_ENTRY_BYTES &&
      compressed !== null &&
      compressed > 0 &&
      uncompressed / compressed > MAX_PLAUSIBLE_COMPRESSION_RATIO
    ) {
      throw new Error(
        `Invalid bundle: "${path}" declares over ${MAX_PLAUSIBLE_COMPRESSION_RATIO}:1 compression — implausible for theme assets`,
      );
    }
    declaredTotal += uncompressed;
  }
  if (declaredTotal > MAX_BUNDLE_CONTENT_BYTES) {
    throw new Error(
      `Invalid bundle: entries declare ${mb(declaredTotal)}MB of content in total, over the ${mb(MAX_BUNDLE_CONTENT_BYTES)}MB limit`,
    );
  }
}

/**
 * Minimal shape of JSZip's StreamHelper (jszip@3.10.1) as returned by
 * `ZipObject#internalStream(type)` — the machinery `async()` and
 * `nodeStream()` are themselves built on. Not present in JSZip's bundled
 * typings, hence the structural cast.
 */
interface StreamHelperLike {
  on(event: 'data', callback: (chunk: Uint8Array) => void): StreamHelperLike;
  on(event: 'end', callback: () => void): StreamHelperLike;
  on(event: 'error', callback: (error: Error) => void): StreamHelperLike;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Inflate one entry through JSZip's streaming read, counting bytes as chunks
 * arrive and rejecting the moment the running total passes `maxBytes` — an
 * entry is never materialized whole just to be measured.
 *
 * `pause()` stops the block pump between JSZip's 16KB compressed blocks; the
 * pako inflate of the one in-flight block still runs to completion
 * synchronously, so chunks that arrive after the abort are dropped rather
 * than accumulated. Memory therefore stays bounded at the cap (plus one
 * block's transient output) no matter how large the entry really is.
 */
function readEntryBytesCapped(entry: JSZip.JSZipObject, maxBytes: number, failure: () => Error): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let aborted = false;

    const stream = (entry as unknown as { internalStream?: (type: string) => StreamHelperLike }).internalStream?.(
      'uint8array',
    );
    if (!stream) {
      // No streaming surface (a different JSZip): fall back to a capped
      // materialize-then-check read — still bounded, just less eagerly.
      entry
        .async('uint8array')
        .then((bytes) => {
          if (bytes.length > maxBytes) throw failure();
          resolve(bytes);
        })
        .catch((e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
      return;
    }

    stream
      .on('data', (chunk) => {
        if (aborted) return; // in-flight block draining after the abort — drop it
        total += chunk.length;
        if (total > maxBytes) {
          aborted = true;
          try {
            stream.pause();
          } catch {
            // stream already finished — the rejection below is the verdict
          }
          reject(failure());
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (!aborted) reject(error);
      })
      .on('end', () => {
        if (aborted) return;
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(out);
      })
      .resume();
  });
}

export async function parseEsthemeBundle(source: Blob | ArrayBuffer): Promise<ParsedBundle> {
  const zip = await JSZip.loadAsync(source);

  // SECURITY: every entry path must be a safe bundle path — traversal-shaped
  // entries are rejected outright, even when the manifest never references
  // them. A bundle is a bag of paths we later hand to other systems; none of
  // them may be `../`-shaped.
  const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    if (relativePath !== 'manifest.json' && !isSafeBundlePath(relativePath)) {
      throw new Error(`Invalid bundle: unsafe entry path "${relativePath}"`);
    }
    entries.push({ path: relativePath, entry });
  });
  if (entries.length > MAX_BUNDLE_FILES) {
    throw new Error(
      `Invalid bundle: ${entries.length} files exceeds limit ${MAX_BUNDLE_FILES}`,
    );
  }

  // SECURITY (zip bombs): the central directory is the cheap place to stop a
  // bomb — reject any bundle that already admits (per entry, summed, or by
  // claimed compression ratio) to exceeding the content cap, BEFORE a single
  // byte is inflated. The streaming reads below then bound the bundles whose
  // directory lies.
  assertDeclaredSizesAcceptable(entries);

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid bundle: missing manifest.json');
  }

  // manifest.json gets its own cap: it is inflated before the manifest can
  // be cross-checked against anything, and it is the only entry we
  // JSON.parse. Declared cap first (a hostile directory is caught without
  // inflating), then a capped streaming read for the lying ones.
  const manifestDeclared = declaredSizes(manifestFile).uncompressed;
  if (manifestDeclared !== null && manifestDeclared > MAX_MANIFEST_BYTES) {
    throw new Error(
      `Invalid bundle: manifest.json declares ${Math.round(manifestDeclared / 1024)}KB, over the ${MAX_MANIFEST_BYTES / 1024}KB limit`,
    );
  }
  const manifestBytes = await readEntryBytesCapped(
    manifestFile,
    MAX_MANIFEST_BYTES,
    () => new Error(`Invalid bundle: manifest.json inflates past the ${MAX_MANIFEST_BYTES / 1024}KB limit`),
  );

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new Error('Invalid bundle: manifest.json is not valid JSON');
  }

  const fileIndex = new Set<string>();
  for (const { path } of entries) {
    if (path !== 'manifest.json') fileIndex.add(path);
  }

  const validation = validateManifestAgainstFiles(manifestJson, fileIndex);
  if (!validation.ok) {
    throw new Error(
      `Invalid manifest: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    );
  }

  // SECURITY: inflate sequentially through the streaming read so the running
  // total is enforced WHILE each entry inflates — a zip whose declared sizes
  // lie small is cut off mid-stream (Promise.all would also hold every
  // expansion at once). The per-entry budget is what remains of the cap.
  let totalBytes = 0;
  const files = new Map<string, Blob>();
  for (const { path, entry } of entries) {
    if (path === 'manifest.json') continue;
    const bytes = await readEntryBytesCapped(
      entry,
      MAX_BUNDLE_CONTENT_BYTES - totalBytes,
      () =>
        new Error(
          `Invalid bundle: "${path}" inflates the bundle past the ${mb(MAX_BUNDLE_CONTENT_BYTES)}MB content limit`,
        ),
    );
    totalBytes += bytes.length;
    // BlobPart formally wants ArrayBufferView<ArrayBuffer> under this TS
    // lib; every Blob implementation accepts a Uint8Array at runtime.
    files.set(path, new Blob([bytes as unknown as BlobPart]));
  }

  return { manifest: validation.manifest, files };
}

/**
 * Download a blob as a file via an anchor click. Tiny helper so callers don't
 * need to reinvent the link-create-click-revoke dance.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
