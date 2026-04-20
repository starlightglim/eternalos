/**
 * "Export current theme" — read Zustand state, build an .estheme bundle,
 * optionally download it. See design/04-skin-format.md for format.
 *
 * Scope: tokens + CSS + variants + typography. Wallpaper, cursors, sounds,
 * icons are skipped in this first pass — they require async fetches from R2
 * and are handled in a later pass. A placeholder preview is generated when
 * the caller doesn't supply one (personal backup flow); bazaar publish will
 * pass a real screenshot.
 */

import type { UserProfile } from '../types';
import type { EsthemeManifest, EsthemeTokens, EsthemeTypography, EsthemeVariants } from './estheme';
import { buildEsthemeBundle, downloadBlob } from './estheme';

// ---------------------------------------------------------------------------
// Profile → layer extractors
// ---------------------------------------------------------------------------

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
    tokens.designTokens = { ...profile.designTokens };
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

  const tokens = extractTokens(profile);
  const typography = extractTypography(profile);
  const variants = extractVariants(profile);
  const css = profile.customCSS && profile.customCSS.trim().length > 0 ? profile.customCSS : undefined;

  if (!tokens && !css && !typography && !variants) {
    throw new Error('Nothing to export — your theme has no colors, fonts, variants, or custom CSS.');
  }

  const preview = options.preview ?? (await generatePlaceholderPreview(profile, name));

  const { blob, manifest } = await buildEsthemeBundle({
    meta: {
      formatVersion: 1,
      id,
      name,
      version,
      author,
      description: options.description,
      license: options.license,
      extends: options.extendsTheme,
    },
    tokens,
    css,
    variants,
    typography,
    preview: { blob: preview, filename: 'preview.png' },
  });

  const filename = `${id}-${version}.estheme`;

  if (options.autoDownload) {
    downloadBlob(blob, filename);
  }

  return { blob, manifest, filename };
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
