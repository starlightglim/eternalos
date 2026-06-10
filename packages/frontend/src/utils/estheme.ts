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

const CURSOR_STATES = [
  'default',
  'pointer',
  'grab',
  'grabbing',
  'text',
  'wait',
  'move',
  'nwse-resize',
] as const;

const SOUND_EVENTS = [
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

const tokensLayerSchema = z
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

const variantsLayerSchema = z.record(z.string().max(64), z.string().max(128));

const typographyLayerSchema = z
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

const cursorsLayerSchema = z
  .record(z.enum(CURSOR_STATES), bundlePath)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'cursors layer declared but empty',
  });

const soundsLayerSchema = z
  .record(z.enum(SOUND_EVENTS), bundlePath)
  .refine((value) => Object.keys(value).length > 0, {
    message: 'sounds layer declared but empty',
  });

const iconsLayerSchema = z
  .record(z.enum(ICON_SLOTS), bundlePath)
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

export const esthemeManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    id: z.string().regex(slugRegex),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    version: z.string().regex(semverRegex),
    author: z.string().regex(authorRegex),
    extends: z.string().max(128).optional(),
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
export type EsthemeTokens = z.infer<typeof tokensLayerSchema>;
export type EsthemeVariants = z.infer<typeof variantsLayerSchema>;
export type EsthemeTypography = z.infer<typeof typographyLayerSchema>;

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

  /** Cursor slots → Blob + filename. */
  cursors?: Partial<Record<(typeof CURSOR_STATES)[number], { blob: Blob; filename: string }>>;

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
    check(pathValue, `cursors.${slot}`);
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
    const cursorMap: Record<string, string> = {};
    for (const [slot, asset] of Object.entries(input.cursors)) {
      if (!asset) continue;
      const path = `cursors/${asset.filename}`;
      zip.file(path, asset.blob);
      cursorMap[slot] = path;
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

export async function parseEsthemeBundle(source: Blob | ArrayBuffer): Promise<ParsedBundle> {
  const zip = await JSZip.loadAsync(source);

  const manifestFile = zip.file('manifest.json');
  if (!manifestFile) {
    throw new Error('Invalid bundle: missing manifest.json');
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(await manifestFile.async('string'));
  } catch {
    throw new Error('Invalid bundle: manifest.json is not valid JSON');
  }

  const fileIndex = new Set<string>();
  zip.forEach((relativePath) => {
    if (relativePath !== 'manifest.json') fileIndex.add(relativePath);
  });

  const validation = validateManifestAgainstFiles(manifestJson, fileIndex);
  if (!validation.ok) {
    throw new Error(
      `Invalid manifest: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    );
  }

  const files = new Map<string, Blob>();
  const entries: { path: string; entry: JSZip.JSZipObject }[] = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir && relativePath !== 'manifest.json') {
      entries.push({ path: relativePath, entry });
    }
  });

  await Promise.all(
    entries.map(async ({ path, entry }) => {
      const blob = await entry.async('blob');
      files.set(path, blob);
    }),
  );

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
