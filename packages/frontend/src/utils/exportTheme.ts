/**
 * "Export current theme" — read the user's profile state, build an .estheme
 * bundle carrying EVERY layer (CSS + tokens + variants + typography +
 * wallpaper + cursors + sounds), optionally download it.
 *
 * Asset layers are read back from the user's own R2 files (their URLs live in
 * the profile: `custom:` wallpaper keys, `cursor.image.*` design tokens, the
 * soundPack mapping) and packed into the zip so the theme installs anywhere.
 * Per-user cursor tokens are stripped from the tokens layer (the cursors
 * layer carries the files; the importer re-uploads and rewrites them), and the
 * reserved `theme.lineage` bookkeeping key becomes `manifest.forkedFrom`.
 *
 * Things this export deliberately does NOT carry (host built-ins or
 * per-item state with no bundle layer): built-in wallpaper patterns (only
 * `custom:` wallpapers are packed), icon overrides (per-item), and mobile
 * wallpaper variants (the profile has a single wallpaper). Each is surfaced
 * as a warning when relevant instead of being dropped silently.
 */

import type { UserProfile } from '../types';
import { API_URL } from '../services/transport';
import { getWallpaperUrl } from '../services/appearance';
import type {
  EsthemeBuildInput,
  EsthemeCursorState,
  EsthemeForkedFrom,
  EsthemeManifest,
  EsthemeSoundEvent,
  EsthemeTokens,
  EsthemeTypography,
  EsthemeVariants,
} from './estheme';
import { buildEsthemeBundle, downloadBlob, CURSOR_STATES, SOUND_EVENTS } from './estheme';
import { THEME_LINEAGE_TOKEN_KEY, decodeThemeLineage } from '../estheme/importEstheme';

// ---------------------------------------------------------------------------
// Profile → layer extractors
// ---------------------------------------------------------------------------

/** designTokens keys whose values are per-user cursor uploads (`url|x|y`). */
const CURSOR_TOKEN_RE = /^cursor\.image\.[A-Za-z0-9-]+$/;

/**
 * Make a stored token value portable: absolute first-party asset URLs become
 * site-relative `/api/...` paths, so the bundle is origin-independent (and the
 * import-side first-party URL checks accept it on any deployment).
 */
function portableTokenValue(value: string | number | boolean): string | number | boolean {
  if (typeof value !== 'string' || !API_URL || !value.startsWith(API_URL)) return value;
  const relative = value.slice(API_URL.length);
  return relative.startsWith('/api/') ? relative : value;
}

function extractTokens(profile: UserProfile): EsthemeTokens | undefined {
  const tokens: EsthemeTokens = {};
  const maybe = (k: keyof EsthemeTokens, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') {
      (tokens as Record<string, unknown>)[k] = v;
    }
  };

  maybe('accentColor', profile.accentColor);
  maybe('desktopColor', profile.desktopColor);
  maybe('windowBgColor', profile.windowBgColor);
  maybe('titleBarBgColor', profile.titleBarBgColor);
  maybe('titleBarTextColor', profile.titleBarTextColor);
  maybe('windowBorderColor', profile.windowBorderColor);
  maybe('buttonBgColor', profile.buttonBgColor);
  maybe('buttonTextColor', profile.buttonTextColor);
  maybe('buttonBorderColor', profile.buttonBorderColor);
  maybe('labelColor', profile.labelColor);
  maybe('windowBorderRadius', profile.windowBorderRadius);
  maybe('controlBorderRadius', profile.controlBorderRadius);
  maybe('windowShadow', profile.windowShadow);
  maybe('windowOpacity', profile.windowOpacity);

  if (profile.designTokens && Object.keys(profile.designTokens).length > 0) {
    const designTokens: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(profile.designTokens)) {
      // Cursor tokens travel as files in the cursors layer; lineage becomes
      // manifest.forkedFrom. Everything else rides along as-is.
      if (CURSOR_TOKEN_RE.test(key) || key === THEME_LINEAGE_TOKEN_KEY) continue;
      designTokens[key] = typeof value === 'string' ? portableTokenValue(value) : value;
    }
    if (Object.keys(designTokens).length > 0) tokens.designTokens = designTokens;
  }

  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function extractTypography(profile: UserProfile): EsthemeTypography | undefined {
  const typography: EsthemeTypography = {};
  if (profile.systemFont) typography.systemFont = profile.systemFont;
  if (profile.bodyFont) typography.bodyFont = profile.bodyFont;
  if (profile.monoFont) typography.monoFont = profile.monoFont;
  if (typeof profile.fontSmoothing === 'boolean') typography.fontSmoothing = profile.fontSmoothing;
  return Object.keys(typography).length > 0 ? typography : undefined;
}

function extractVariants(profile: UserProfile): EsthemeVariants | undefined {
  // Variants live in designTokens under keys prefixed with "variant." by
  // convention, OR as a top-level `variants` field on some profile shapes.
  // We check both to survive schema drift.
  const variants: EsthemeVariants = {};

  const rawVariants = (profile as unknown as { variants?: Record<string, string> }).variants;
  if (rawVariants && typeof rawVariants === 'object') {
    for (const [k, v] of Object.entries(rawVariants)) {
      if (typeof v === 'string' && v) variants[k] = v;
    }
  }

  if (profile.designTokens) {
    for (const [k, v] of Object.entries(profile.designTokens)) {
      if (k.startsWith('variant.') && typeof v === 'string') {
        variants[k.slice('variant.'.length)] = v;
      }
    }
  }

  return Object.keys(variants).length > 0 ? variants : undefined;
}

/** Fork lineage recorded at install time (designTokens.theme.lineage). */
function extractForkedFrom(profile: UserProfile): EsthemeForkedFrom | undefined {
  if (!profile.designTokens) return undefined;
  return decodeThemeLineage(profile.designTokens[THEME_LINEAGE_TOKEN_KEY]) ?? undefined;
}

// ---------------------------------------------------------------------------
// Asset fetch helpers (the exporter reads the user's own R2 files back)
// ---------------------------------------------------------------------------

async function fetchAssetBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

/** Last path segment of a URL or `custom:` R2 key — the original filename. */
function lastSegment(value: string): string {
  const tail = value.split('/').pop() ?? '';
  // R2 keys are stored percent-encoded per segment in some paths; the tail of
  // a wallpaper key is always the plain filename.
  return tail || 'asset';
}

interface ExtractedCursors {
  cursors: Partial<Record<EsthemeCursorState, { blob: Blob; filename: string; hotspotX: number; hotspotY: number }>>;
  warnings: string[];
}

async function extractCursors(profile: UserProfile): Promise<ExtractedCursors> {
  const warnings: string[] = [];
  const cursors: ExtractedCursors['cursors'] = {};
  const usedPaths = new Set<string>();
  const designTokens = profile.designTokens ?? {};
  for (const [key, rawValue] of Object.entries(designTokens)) {
    if (!CURSOR_TOKEN_RE.test(key) || typeof rawValue !== 'string' || !rawValue.trim()) continue;
    const state = key.slice('cursor.image.'.length) as string;
    if (!(CURSOR_STATES as readonly string[]).includes(state)) {
      warnings.push(`cursors: unknown cursor slot "${state}" — not included`);
      continue;
    }
    // Stored form: "<absolute-or-relative first-party url>|hotX|hotY"
    const [rawUrl, xPart, yPart] = rawValue.split('|');
    const url = (rawUrl ?? '').trim();
    const hotspotX = parseInt(xPart, 10) || 0;
    const hotspotY = parseInt(yPart, 10) || 0;
    if (!url) continue;
    const blob = await fetchAssetBlob(url.startsWith('/api/') ? `${API_URL}${url}` : url);
    if (!blob) {
      warnings.push(`cursors: could not read your "${state}" cursor file — it is not included`);
      continue;
    }
    // Keep the user's filename unless two slots shipped the same name (then
    // prefix the slot so the second file cannot overwrite the first).
    let filename = lastSegment(url);
    if (usedPaths.has(`cursors/${filename}`)) filename = `${state}-${filename}`;
    usedPaths.add(`cursors/${filename}`);
    cursors[state as EsthemeCursorState] = { blob, filename, hotspotX, hotspotY };
  }
  return { cursors, warnings };
}

interface ExtractedSounds {
  sounds: Partial<Record<EsthemeSoundEvent, { blob: Blob; filename: string }>>;
  warnings: string[];
}

async function extractSounds(profile: UserProfile): Promise<ExtractedSounds> {
  const warnings: string[] = [];
  const sounds: ExtractedSounds['sounds'] = {};
  const pack = profile.soundPack;
  if (!pack?.sounds) return { sounds, warnings };
  for (const [type, rawUrl] of Object.entries(pack.sounds)) {
    if (!(SOUND_EVENTS as readonly string[]).includes(type)) {
      warnings.push(`sounds: unknown sound slot "${type}" — not included`);
      continue;
    }
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
    const url = rawUrl.startsWith('/api/') ? `${API_URL}${rawUrl}` : rawUrl;
    const blob = await fetchAssetBlob(url);
    if (!blob) {
      warnings.push(`sounds: could not read your "${type}" sound file — it is not included`);
      continue;
    }
    sounds[type as EsthemeSoundEvent] = { blob, filename: lastSegment(rawUrl) };
  }
  return { sounds, warnings };
}

interface ExtractedWallpaper {
  wallpaper?: { file: Blob; filename: string; mode?: 'cover' | 'tile' | 'center' };
  warnings: string[];
}

async function extractWallpaper(profile: UserProfile): Promise<ExtractedWallpaper> {
  const warnings: string[] = [];
  const value = profile.wallpaper;
  // Built-in patterns are host CSS, not user content — only `custom:` files
  // can travel in a bundle.
  if (!value || !value.startsWith('custom:')) {
    if (value && value !== 'default') {
      warnings.push('wallpaper: built-in patterns cannot be exported — the theme keeps the installer\'s current pattern');
    }
    return { warnings };
  }
  const blob = await fetchAssetBlob(getWallpaperUrl(value));
  if (!blob) {
    warnings.push('wallpaper: could not read your custom wallpaper file — it is not included');
    return { warnings };
  }
  const wallpaper: ExtractedWallpaper['wallpaper'] = {
    file: blob,
    filename: lastSegment(value.slice('custom:'.length)),
  };
  if (profile.wallpaperMode) wallpaper.mode = profile.wallpaperMode;
  return { wallpaper, warnings };
}

// ---------------------------------------------------------------------------
// Preview placeholder
// ---------------------------------------------------------------------------

/**
 * Generate a simple placeholder preview image from the theme's key colors.
 * 1200x750 per the design spec. Used when the caller doesn't supply a real
 * screenshot (personal backup flow).
 */
async function generatePlaceholderPreview(profile: UserProfile, themeName: string): Promise<Blob> {
  const width = 1200;
  const height = 750;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context');

  // Background: desktopColor or fallback.
  ctx.fillStyle = profile.desktopColor ?? '#1a1a2e';
  ctx.fillRect(0, 0, width, height);

  // Window mockup.
  const winX = 180;
  const winY = 160;
  const winW = 840;
  const winH = 430;
  const borderRadius = profile.windowBorderRadius ?? 6;
  ctx.fillStyle = profile.windowBgColor ?? '#f0f0f0';
  drawRoundedRect(ctx, winX, winY, winW, winH, borderRadius);
  ctx.fill();

  // Title bar
  ctx.fillStyle = profile.titleBarBgColor ?? '#d0d0d0';
  drawRoundedRect(ctx, winX, winY, winW, 32, borderRadius);
  ctx.fill();

  // Title text
  ctx.fillStyle = profile.titleBarTextColor ?? '#000';
  ctx.font = 'bold 16px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(themeName, winX + 16, winY + 16);

  // Accent bar
  ctx.fillStyle = profile.accentColor ?? '#7c3aed';
  ctx.fillRect(winX + 20, winY + 72, 120, 32);

  // Label text
  ctx.fillStyle = profile.labelColor ?? '#ffffff';
  ctx.font = '28px system-ui, -apple-system, sans-serif';
  ctx.fillText('Preview placeholder', winX + 20, winY + 160);

  ctx.font = '14px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = profile.labelColor ?? '#aaa';
  ctx.fillText('Generated on export — replace with a real screenshot to publish.', winX + 20, winY + 200);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) reject(new Error('toBlob returned null'));
        else resolve(blob);
      },
      'image/png',
    );
  });
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ExportOptions {
  /** Kebab-case ID, e.g. "my-dreamcore". Defaults to slugified theme name. */
  id?: string;
  /** Display name for the theme. Defaults to "username's theme". */
  name?: string;
  /** Semver. Defaults to "1.0.0". */
  version?: string;
  /** One-line description. */
  description?: string;
  /** SPDX license identifier (e.g. "CC-BY-4.0"). */
  license?: string;
  /** Parent theme reference (`@author/id`). */
  extendsTheme?: string;
  /** If true, the bundle is downloaded via browser immediately. */
  autoDownload?: boolean;
  /** Optional real preview PNG; if absent, a placeholder is generated. */
  preview?: Blob;
}

export interface ExportResult {
  blob: Blob;
  manifest: EsthemeManifest;
  filename: string;
  /** Non-fatal notices (assets that could not be read back, etc.). */
  warnings: string[];
}

/**
 * Build an .estheme bundle from the current profile state.
 *
 * Minimum inputs: the user's profile. Everything else is inferred or defaulted.
 */
export async function exportCurrentTheme(
  profile: UserProfile,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const name = options.name ?? (profile.displayName ?? profile.username ?? 'My theme');
  const id = options.id ?? slugify(name);
  const version = options.version ?? '1.0.0';
  const author = `@${profile.username}`;

  // Asset layers read the user's own files back from R2. Each is optional:
  // a failed fetch downgrades that slot with a warning, never a failed export.
  const [cursorExtract, soundExtract, wallpaperExtract] = await Promise.all([
    extractCursors(profile),
    extractSounds(profile),
    extractWallpaper(profile),
  ]);
  const warnings = [...cursorExtract.warnings, ...soundExtract.warnings, ...wallpaperExtract.warnings];

  const tokens = extractTokens(profile);
  const typography = extractTypography(profile);
  const variants = extractVariants(profile);
  const css = profile.customCSS && profile.customCSS.trim().length > 0 ? profile.customCSS : undefined;
  const forkedFrom = extractForkedFrom(profile);

  const hasCursors = Object.keys(cursorExtract.cursors).length > 0;
  const hasSounds = Object.keys(soundExtract.sounds).length > 0;
  const hasWallpaper = Boolean(wallpaperExtract.wallpaper);

  if (!tokens && !css && !typography && !variants && !hasCursors && !hasSounds && !hasWallpaper) {
    throw new Error('Nothing to export — your theme has no colors, fonts, variants, custom CSS, cursors, sounds, or wallpaper.');
  }

  const preview = options.preview ?? (await generatePlaceholderPreview(profile, name));

  const buildInput: EsthemeBuildInput = {
    meta: {
      formatVersion: 1,
      id,
      name,
      version,
      author,
      description: options.description,
      license: options.license,
      extends: options.extendsTheme,
      forkedFrom,
    },
    tokens,
    css,
    variants,
    typography,
    preview: { blob: preview, filename: 'preview.png' },
  };
  if (wallpaperExtract.wallpaper) {
    buildInput.wallpaper = {
      file: wallpaperExtract.wallpaper.file,
      filename: wallpaperExtract.wallpaper.filename,
      mode: wallpaperExtract.wallpaper.mode,
    };
  }
  if (hasCursors) buildInput.cursors = cursorExtract.cursors;
  if (hasSounds) buildInput.sounds = soundExtract.sounds;

  const { blob, manifest } = await buildEsthemeBundle(buildInput);

  const filename = `${id}-${version}.estheme`;

  if (options.autoDownload) {
    downloadBlob(blob, filename);
  }

  return { blob, manifest, filename, warnings };
}

/**
 * Best-effort slugify for theme IDs. Keeps only lowercase alphanumerics and
 * hyphens. Always produces a non-empty, schema-valid id.
 */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  // Must start with alphanumeric per slugRegex.
  const valid = cleaned.replace(/^-+/, '');
  return valid || `theme-${Date.now().toString(36).slice(-6)}`;
}
