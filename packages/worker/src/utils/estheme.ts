/**
 * .estheme manifest schema + validator.
 *
 * An .estheme is a zip bundle with a `manifest.json` conforming to the schema
 * below. See design/04-skin-format.md for the full format specification.
 *
 * This module intentionally does NOT do zip I/O — it validates a manifest
 * object that the caller has already extracted (browser-side with JSZip, or
 * worker-side when receiving an uploaded bundle). Keep this module dependency-
 * free beyond zod so it can be reused from both sides.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field-level schemas
// ---------------------------------------------------------------------------

/** Cursor state slots that can be overridden by a theme. Mirrors CursorState. */
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

/** Sound event slots that can be overridden by a theme. Mirrors SoundType. */
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

/** Item-type icon slots that can be overridden by a theme. */
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

// Path within the zip — forward slashes, no `..`, no leading slash.
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
    version: z.string().regex(semverRegex, 'version must be semver'),
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

// ---------------------------------------------------------------------------
// Top-level manifest
// ---------------------------------------------------------------------------

export const esthemeManifestSchema = z
  .object({
    formatVersion: z.literal(1),

    id: z.string().regex(slugRegex, 'id must be kebab-case'),
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    version: z.string().regex(semverRegex, 'version must be semver'),
    author: z.string().regex(authorRegex, 'author must be @username'),

    extends: z.string().max(128).optional(),

    tags: z.array(z.string().min(1).max(32)).max(10).optional(),

    license: z.string().max(64).optional(),
    homepage: z.string().url().max(512).optional(),
    repo: z.string().url().max(512).optional(),

    minHostVersion: z.string().regex(semverRegex, 'minHostVersion must be semver').optional(),

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
// Validators
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

/**
 * Validate a manifest object (already JSON-parsed). Returns a discriminated
 * result so callers can show per-field errors in the install UI.
 */
export function validateManifest(input: unknown): ValidationResult {
  const parsed = esthemeManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  const errors = parsed.error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.') || '(root)',
    message: issue.message,
  }));
  return { ok: false, errors };
}

/**
 * Validate a parsed manifest AND cross-check that every path it references
 * exists in the supplied file index (names of files inside the zip).
 *
 * Catches the common packaging bug of declaring `layers.css = "theme.css"`
 * but not actually including that file in the zip.
 */
export function validateManifestAgainstFiles(
  input: unknown,
  fileIndex: Set<string>
): ValidationResult {
  const result = validateManifest(input);
  if (!result.ok) return result;

  const missing: { path: string; message: string }[] = [];
  const { layers } = result.manifest;

  const checkFile = (declaredPath: string, layerName: string): void => {
    if (!fileIndex.has(declaredPath)) {
      missing.push({
        path: `layers.${layerName}`,
        message: `file "${declaredPath}" declared but not present in bundle`,
      });
    }
  };

  if (layers.tokens) checkFile(layers.tokens, 'tokens');
  if (layers.css) checkFile(layers.css, 'css');
  if (layers.variants) checkFile(layers.variants, 'variants');
  if (layers.typography) checkFile(layers.typography, 'typography');
  if (layers.wallpaper) {
    checkFile(layers.wallpaper.file, 'wallpaper.file');
    if (layers.wallpaper.mobileFile) {
      checkFile(layers.wallpaper.mobileFile, 'wallpaper.mobileFile');
    }
  }
  if (layers.cursors) {
    for (const [slot, pathValue] of Object.entries(layers.cursors)) {
      checkFile(pathValue, `cursors.${slot}`);
    }
  }
  if (layers.sounds) {
    for (const [slot, pathValue] of Object.entries(layers.sounds)) {
      checkFile(pathValue, `sounds.${slot}`);
    }
  }
  if (layers.icons) {
    for (const [slot, pathValue] of Object.entries(layers.icons)) {
      checkFile(pathValue, `icons.${slot}`);
    }
  }

  if (missing.length > 0) {
    return { ok: false, errors: missing };
  }
  return result;
}

/**
 * Check that a manifest declares at least one meaningful layer. Empty themes
 * are valid by the schema but likely represent a packaging mistake.
 */
export function hasAnyLayer(manifest: EsthemeManifest): boolean {
  const l = manifest.layers;
  return Boolean(
    l.tokens ||
      l.css ||
      l.variants ||
      l.typography ||
      l.wallpaper ||
      l.cursors ||
      l.sounds ||
      l.icons,
  );
}

/**
 * Format validation errors as a single human-readable string (for error
 * responses or toast notifications).
 */
export function formatValidationErrors(errors: ValidationFailure['errors']): string {
  return errors.map((e) => `${e.path}: ${e.message}`).join('; ');
}
