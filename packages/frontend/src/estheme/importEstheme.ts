/**
 * .estheme import — build a validated, apply-ready plan from a bundle.
 *
 * The plan builder is the single validation gate for imported themes. It runs
 * AFTER `parseEsthemeBundle` (zip shape, manifest schema, declared-file
 * cross-check, safe entry paths, total size) and BEFORE anything is applied,
 * so a hostile bundle never reaches the stores:
 *
 *   - theme.css goes through the same `isAllowedCSSUrl` rule manual edits use
 *     (cssSanitizer), but an import REJECTS a disallowed `url()` instead of
 *     neutralizing it — a theme that ships remote references is refused whole.
 *   - tokens.json designTokens are checked against the same rule set the
 *     worker's profile validator enforces on save (dangerous patterns, CSS
 *     punctuation, first-party asset URLs), so a Keep can never 400 later.
 *   - per-file sizes mirror the upload routes' limits (50KB cursor, 200KB
 *     sound, 2MB wallpaper, 50KB CSS) — the uploads on Keep go through those
 *     routes, and rejecting here gives one clear message instead of N.
 *
 * Nothing in this module touches the stores; `themePreviewStore` applies the
 * plan. That keeps the whole validation surface unit-testable without a DOM.
 */

import {
  parseEsthemeBundle,
  tokensLayerSchema,
  variantsLayerSchema,
  typographyLayerSchema,
  cursorSlotPath,
  type EsthemeManifest,
  type EsthemeTokens,
  type EsthemeTypography,
  type EsthemeCursorState,
  type EsthemeSoundEvent,
  type EsthemeCursorLayerValue,
} from '../utils/estheme';
import { isAllowedCSSUrl } from '../utils/cssSanitizer';
import { isFirstPartyAssetUrl } from '../tokens/tokenCompiler';
import { isValidFontId } from '../utils/fontCatalog';
import { registerBuiltinVariants } from '../variants/registerBuiltins';
import { variantRegistry } from '../variants/registry';
import type { SlotId } from '../variants/types';
import type { CustomAppearance } from '../stores/appearanceStore';

// Ensure the builtin window-chrome variants are registered before we filter
// variant selections against the registry. Idempotent.
registerBuiltinVariants();

// ---------------------------------------------------------------------------
// Lineage bookkeeping (fork source of the currently-installed theme)
// ---------------------------------------------------------------------------

/**
 * designTokens key under which the app remembers which .estheme the current
 * rice was installed from. Inert to the token compiler (not a registered
 * token), bounded like every other token value, and persisted through the
 * normal appearance save path — no new server field. Export reads it to fill
 * `manifest.forkedFrom`; import writes it on install.
 */
export const THEME_LINEAGE_TOKEN_KEY = 'theme.lineage';

export interface EsthemeLineage {
  id: string;
  name?: string;
  author: string;
  version?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const AUTHOR_RE = /^@[a-z0-9_]{3,20}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** Encode a lineage record for storage in designTokens. */
export function encodeThemeLineage(lineage: EsthemeLineage): string {
  return JSON.stringify(lineage);
}

/** Decode a stored lineage value; null for anything malformed (fail-soft). */
export function decodeThemeLineage(raw: unknown): EsthemeLineage | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.id !== 'string' || !SLUG_RE.test(value.id)) return null;
  if (typeof value.author !== 'string' || !AUTHOR_RE.test(value.author)) return null;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 80)) return null;
  if (value.version !== undefined && (typeof value.version !== 'string' || !SEMVER_RE.test(value.version))) return null;
  return {
    id: value.id,
    name: typeof value.name === 'string' ? value.name : undefined,
    author: value.author,
    version: typeof value.version === 'string' ? value.version : undefined,
  };
}

// ---------------------------------------------------------------------------
// Import limits — mirror the upload routes' per-category caps
// ---------------------------------------------------------------------------

export const ESTHEME_IMPORT_LIMITS = {
  /** /api/cursors upload route cap. */
  cursorBytes: 50 * 1024,
  /** /api/sounds upload route cap. */
  soundBytes: 200 * 1024,
  /** /api/wallpaper upload route cap. */
  wallpaperBytes: 2 * 1024 * 1024,
  /** customCSS cap (worker UserDesktop.updateProfile). */
  cssBytes: 50 * 1024,
  /** tokens.json / variants.json / typography.json sanity cap. */
  jsonBytes: 64 * 1024,
  /** readme.md cap (display-only, but still bounded). */
  readmeBytes: 64 * 1024,
  /** preview images — display-only; bounded like wallpapers. */
  previewBytes: 2 * 1024 * 1024,
} as const;

// Extension allowlists mirroring the upload routes' MIME handling. Zip blobs
// carry no reliable MIME type, so — exactly like the cursor route — the
// extension is authoritative and the mapped MIME is stamped onto the File at
// upload time (browsers report .cur/.ani as octet-stream).
const CURSOR_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  cur: 'image/x-icon',
  ico: 'image/x-icon',
  ani: 'application/x-navi-animation',
  gif: 'image/gif',
  webp: 'image/webp',
};
const SOUND_MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/x-wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
};
const WALLPAPER_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** MIME the upload services should stamp for a bundle asset, by extension. */
export function mimeForAsset(layer: 'cursor' | 'sound' | 'wallpaper', filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const table =
    layer === 'cursor' ? CURSOR_MIME_BY_EXT : layer === 'sound' ? SOUND_MIME_BY_EXT : WALLPAPER_MIME_BY_EXT;
  return table[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface EsthemeCursorAsset {
  state: EsthemeCursorState;
  blob: Blob;
  filename: string;
  hotspotX: number;
  hotspotY: number;
}

export interface EsthemeSoundAsset {
  type: EsthemeSoundEvent;
  blob: Blob;
  filename: string;
}

export interface EsthemeWallpaperAsset {
  blob: Blob;
  filename: string;
  mode?: 'cover' | 'tile' | 'center';
}

export interface EsthemeImportPlan {
  manifest: EsthemeManifest;
  /** Schema-validated layers; absent = the bundle does not override them. */
  tokens?: EsthemeTokens;
  css?: string;
  variants?: Record<string, string>;
  typography?: EsthemeTypography;
  /** Asset files to upload at preview/keep time. */
  cursors: EsthemeCursorAsset[];
  sounds: EsthemeSoundAsset[];
  wallpaper?: EsthemeWallpaperAsset;
  /** Human-readable layer names the banner lists as "will change". */
  appliedLayers: string[];
  /** Non-fatal notices (skipped slots, unsupported layers). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Hostile-content checks
// ---------------------------------------------------------------------------

/** Same url() shape `sanitizeCSSUrls` rewrites — see utils/cssSanitizer.ts. */
const CSS_URL_RE = /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi;

/**
 * Import-time CSS gate: a theme may only ship `url()` values a manual CSS edit
 * could keep (first-party /api/... assets). The sanitizer would neutralize
 * anything else to `url(about:blank)` at paint; for an install we reject the
 * bundle instead, with the offending URL named.
 */
export function assertCssIsInstallable(css: string, label: string): void {
  if (css.length > ESTHEME_IMPORT_LIMITS.cssBytes) {
    throw new Error(`${label}: exceeds ${ESTHEME_IMPORT_LIMITS.cssBytes / 1024}KB limit`);
  }
  if (/@import/i.test(css)) {
    throw new Error(`${label}: contains @import, which is not allowed in themes`);
  }
  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(css)) !== null) {
    const urlValue = match[2].replace(/[\r\n\t]/g, '').trim();
    if (!isAllowedCSSUrl(urlValue)) {
      throw new Error(`${label}: url("${urlValue}") is not a first-party asset URL`);
    }
  }
}

/**
 * Same dangerous-pattern set the worker's profile validator enforces on
 * designTokens (UserDesktop.updateProfile), applied at import so a hostile
 * tokens layer is rejected up front rather than failing (or worse, half-
 * applying) at Keep time.
 */
const DANGEROUS_TOKEN_PATTERNS: RegExp[] = [
  /javascript:/i,
  /expression\s*\(/i,
  /behavior\s*:/i,
  /-moz-binding/i,
  /<script/i,
  /@import/i,
];

/** The worker's designToken url() scan shape (no whitespace inside the URL). */
const TOKEN_URL_RE = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;

export function assertTokensAreInstallable(tokens: EsthemeTokens, label: string): void {
  for (const [key, value] of Object.entries(tokens.designTokens ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9.-]*$/.test(key) || key.length > 100) {
      throw new Error(`${label}: designTokens key "${key}" is not allowed`);
    }
    if (typeof value !== 'string') continue;
    if (value.length > 500) {
      throw new Error(`${label}: designTokens value for "${key}" exceeds 500 chars`);
    }
    for (const pattern of DANGEROUS_TOKEN_PATTERNS) {
      if (pattern.test(value)) {
        throw new Error(`${label}: designTokens value for "${key}" contains a disallowed pattern`);
      }
    }
    // Rule-terminating characters would let a token value break out of the
    // compiler's `selector { prop: value; }` interpolation.
    if (/[{};]/.test(value)) {
      throw new Error(`${label}: designTokens value for "${key}" contains disallowed CSS punctuation`);
    }
    // Cursor tokens are bare URLs (with optional |hotX|hotY suffix) that the
    // compiler wraps in url() itself — check them directly.
    if (key.startsWith('cursor.image.') && value.trim().length > 0) {
      const bareUrl = value.split('|')[0].trim();
      if (!isFirstPartyAssetUrl(bareUrl)) {
        throw new Error(`${label}: designTokens ${key} must reference first-party assets`);
      }
    }
    TOKEN_URL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_URL_RE.exec(value)) !== null) {
      if (!isFirstPartyAssetUrl(match[2])) {
        throw new Error(`${label}: designTokens ${key} url() must reference first-party assets`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Layer readers
// ---------------------------------------------------------------------------

async function readJsonLayer(
  files: Map<string, Blob>,
  path: string | undefined,
  label: string,
): Promise<unknown | undefined> {
  if (!path) return undefined;
  const blob = files.get(path);
  if (!blob) return undefined; // parseEsthemeBundle already cross-checked this
  if (blob.size > ESTHEME_IMPORT_LIMITS.jsonBytes) {
    throw new Error(`${label}: "${path}" exceeds ${ESTHEME_IMPORT_LIMITS.jsonBytes / 1024}KB`);
  }
  try {
    return JSON.parse(await blob.text());
  } catch {
    throw new Error(`${label}: "${path}" is not valid JSON`);
  }
}

interface FilteredVariants {
  variants: Record<string, string>;
  warnings: string[];
}

/** Unknown slots/variants are ignored with a warning (design/04-skin-format.md). */
function filterVariants(raw: Record<string, string>, label: string): FilteredVariants {
  const variants: Record<string, string> = {};
  const warnings: string[] = [];
  for (const [slot, variantId] of Object.entries(raw)) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(slot) || slot.length > 64) {
      warnings.push(`${label}: ignored malformed variant slot "${slot}"`);
      continue;
    }
    if (!variantRegistry.get(slot as SlotId, variantId)) {
      warnings.push(`${label}: unknown variant "${variantId}" for slot "${slot}" — ignored`);
      continue;
    }
    variants[slot] = variantId;
  }
  return { variants, warnings };
}

interface FilteredTypography {
  typography: EsthemeTypography;
  warnings: string[];
}

/** Font IDs must exist in the catalog; unknown IDs are dropped with a warning. */
function filterTypography(raw: EsthemeTypography, label: string): FilteredTypography {
  const typography: EsthemeTypography = {};
  const warnings: string[] = [];
  const maybeFont = (key: 'systemFont' | 'bodyFont' | 'monoFont') => {
    const id = raw[key];
    if (id === undefined) return;
    if (isValidFontId(id)) {
      typography[key] = id;
    } else {
      warnings.push(`${label}: unknown font "${id}" for ${key} — ignored`);
    }
  };
  maybeFont('systemFont');
  maybeFont('bodyFont');
  maybeFont('monoFont');
  if (typeof raw.fontSmoothing === 'boolean') typography.fontSmoothing = raw.fontSmoothing;
  return { typography, warnings };
}

function requireAssetMime(
  blob: Blob,
  filename: string,
  layer: 'cursor' | 'sound' | 'wallpaper',
  maxBytes: number,
): void {
  if (blob.size > maxBytes) {
    throw new Error(`${layer} "${filename}" exceeds the ${Math.round(maxBytes / 1024)}KB limit`);
  }
  if (!mimeForAsset(layer, filename)) {
    throw new Error(`${layer} "${filename}": unsupported file type`);
  }
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export async function buildEsthemeImportPlan(source: Blob | ArrayBuffer): Promise<EsthemeImportPlan> {
  const { manifest, files } = await parseEsthemeBundle(source);
  const layers = manifest.layers;
  const warnings: string[] = [];
  const appliedLayers: string[] = [];

  // --- tokens -------------------------------------------------------------
  let tokens: EsthemeTokens | undefined;
  if (layers.tokens) {
    const rawTokens = await readJsonLayer(files, layers.tokens, 'tokens');
    const parsed = tokensLayerSchema.safeParse(rawTokens);
    if (!parsed.success) {
      throw new Error(`tokens: ${parsed.error.issues[0]?.message ?? 'invalid tokens layer'}`);
    }
    tokens = parsed.data;
    assertTokensAreInstallable(tokens, 'tokens');
    appliedLayers.push('tokens');
  }

  // --- css ----------------------------------------------------------------
  let css: string | undefined;
  if (layers.css) {
    const blob = files.get(layers.css);
    if (blob) {
      css = await blob.text();
      assertCssIsInstallable(css, 'theme.css');
      appliedLayers.push('css');
    }
  }

  // --- variants -----------------------------------------------------------
  let variants: Record<string, string> | undefined;
  if (layers.variants) {
    const rawVariants = await readJsonLayer(files, layers.variants, 'variants');
    const parsed = variantsLayerSchema.safeParse(rawVariants);
    if (!parsed.success) {
      throw new Error(`variants: ${parsed.error.issues[0]?.message ?? 'invalid variants layer'}`);
    }
    const filtered = filterVariants(parsed.data, 'variants');
    warnings.push(...filtered.warnings);
    if (Object.keys(filtered.variants).length > 0) {
      variants = filtered.variants;
      appliedLayers.push('variants');
    }
  }

  // --- typography ----------------------------------------------------------
  let typography: EsthemeTypography | undefined;
  if (layers.typography) {
    const rawTypography = await readJsonLayer(files, layers.typography, 'typography');
    const parsed = typographyLayerSchema.safeParse(rawTypography);
    if (!parsed.success) {
      throw new Error(`typography: ${parsed.error.issues[0]?.message ?? 'invalid typography layer'}`);
    }
    const filtered = filterTypography(parsed.data, 'typography');
    warnings.push(...filtered.warnings);
    typography = filtered.typography;
    if (Object.keys(typography).length > 0) appliedLayers.push('typography');
  }

  // --- cursors -------------------------------------------------------------
  const cursors: EsthemeCursorAsset[] = [];
  if (layers.cursors) {
    for (const [slot, ref] of Object.entries(layers.cursors)) {
      const path = cursorSlotPath(ref as EsthemeCursorLayerValue);
      const blob = files.get(path);
      if (!blob) continue;
      const hotspot =
        typeof ref === 'object' ? { x: ref.hotspotX ?? 0, y: ref.hotspotY ?? 0 } : { x: 0, y: 0 };
      requireAssetMime(blob, path, 'cursor', ESTHEME_IMPORT_LIMITS.cursorBytes);
      cursors.push({
        state: slot as EsthemeCursorState,
        blob,
        filename: path.split('/').pop() ?? path,
        hotspotX: hotspot.x,
        hotspotY: hotspot.y,
      });
    }
    if (cursors.length > 0) appliedLayers.push('cursors');
  }

  // --- sounds ---------------------------------------------------------------
  const sounds: EsthemeSoundAsset[] = [];
  if (layers.sounds) {
    for (const [type, path] of Object.entries(layers.sounds)) {
      const blob = files.get(path);
      if (!blob) continue;
      requireAssetMime(blob, path, 'sound', ESTHEME_IMPORT_LIMITS.soundBytes);
      sounds.push({
        type: type as EsthemeSoundEvent,
        blob,
        filename: path.split('/').pop() ?? path,
      });
    }
    if (sounds.length > 0) appliedLayers.push('sounds');
  }

  // --- wallpaper --------------------------------------------------------------
  let wallpaper: EsthemeWallpaperAsset | undefined;
  if (layers.wallpaper) {
    const blob = files.get(layers.wallpaper.file);
    if (blob) {
      requireAssetMime(blob, layers.wallpaper.file, 'wallpaper', ESTHEME_IMPORT_LIMITS.wallpaperBytes);
      wallpaper = {
        blob,
        filename: layers.wallpaper.file.split('/').pop() ?? layers.wallpaper.file,
        mode: layers.wallpaper.mode,
      };
      appliedLayers.push('wallpaper');
    }
    if (layers.wallpaper.mobileFile) {
      const mobile = files.get(layers.wallpaper.mobileFile);
      if (mobile) {
        requireAssetMime(mobile, layers.wallpaper.mobileFile, 'wallpaper', ESTHEME_IMPORT_LIMITS.wallpaperBytes);
        warnings.push('wallpaper: a mobile wallpaper is included but this host applies one wallpaper — the mobile file is ignored');
      }
    }
  }

  // --- icons (declared by the format, not applied by this host yet) ----------
  if (layers.icons && Object.keys(layers.icons).length > 0) {
    // Validate the files so a hostile bundle can't smuggle oversized/odd
    // assets through a layer we merely warn about.
    for (const path of Object.values(layers.icons)) {
      const blob = files.get(path);
      if (!blob) continue;
      requireAssetMime(blob, path, 'cursor', ESTHEME_IMPORT_LIMITS.cursorBytes);
    }
    warnings.push('icons: this theme declares icon overrides, which are not applied by this host yet');
  }

  if (appliedLayers.length === 0) {
    throw new Error('This bundle declares no layers the host can apply.');
  }

  return { manifest, tokens, css, variants, typography, cursors, sounds, wallpaper, appliedLayers, warnings };
}

// ---------------------------------------------------------------------------
// Preview composition
// ---------------------------------------------------------------------------

/** Flat profile fields the tokens layer owns (everything but designTokens). */
const TOKEN_FIELD_KEYS = [
  'accentColor', 'desktopColor', 'windowBgColor', 'titleBarBgColor', 'titleBarTextColor',
  'windowBorderColor', 'buttonBgColor', 'buttonTextColor', 'buttonBorderColor', 'labelColor',
  'windowBorderRadius', 'controlBorderRadius', 'windowShadow', 'windowOpacity',
] as const satisfies readonly (Exclude<keyof EsthemeTokens, 'designTokens'>)[];

/**
 * Compose the appearance a preview should paint: every layer the bundle
 * declares REPLACES the current state for that layer (an installed theme must
 * apply identically, not merge over the user's old rice); layers the bundle
 * omits are left alone (partial themes — "just the cursors from X" works).
 *
 * `cursorTokens` maps a slot to the token value the preview's uploads
 * produced (`url|hotX|hotY`); slots whose upload failed are simply absent, so
 * the user's current cursor for that slot is kept and the banner warned.
 *
 * The composed appearance always records the imported theme's lineage under
 * `theme.lineage`, so a later "Export current theme" emits `forkedFrom`.
 */
export function composePreviewAppearance(
  current: CustomAppearance,
  plan: EsthemeImportPlan,
  cursorTokens: Partial<Record<EsthemeCursorState, string>>,
): CustomAppearance {
  const composed: Record<string, unknown> = { ...current };

  const lineageToken = encodeThemeLineage({
    id: plan.manifest.id,
    name: plan.manifest.name,
    author: plan.manifest.author,
    version: plan.manifest.version,
  });

  if (plan.tokens) {
    // Wholesale replacement of the tokens state: every flat token field is
    // present-but-undefined unless the theme sets it, and designTokens comes
    // from the theme (plus the preview's cursor uploads + lineage).
    for (const key of TOKEN_FIELD_KEYS) {
      composed[key] = plan.tokens[key];
    }
    const designTokens: Record<string, string | number | boolean> = { ...(plan.tokens.designTokens ?? {}) };
    for (const [state, token] of Object.entries(cursorTokens)) {
      if (token !== undefined) designTokens[`cursor.image.${state}`] = token;
    }
    designTokens[THEME_LINEAGE_TOKEN_KEY] = lineageToken;
    composed.designTokens = designTokens;
  } else {
    // No tokens layer: keep the user's tokens; slot-level cursor uploads
    // still replace their slots, and lineage is still recorded.
    const designTokens: Record<string, string | number | boolean> = { ...(current.designTokens ?? {}) };
    for (const [state, token] of Object.entries(cursorTokens)) {
      if (token !== undefined) designTokens[`cursor.image.${state}`] = token;
    }
    designTokens[THEME_LINEAGE_TOKEN_KEY] = lineageToken;
    composed.designTokens = designTokens;
  }

  if (plan.css !== undefined) composed.customCSS = plan.css;
  if (plan.variants !== undefined) composed.variants = plan.variants;
  if (plan.typography !== undefined) {
    composed.systemFont = plan.typography.systemFont;
    composed.bodyFont = plan.typography.bodyFont;
    composed.monoFont = plan.typography.monoFont;
    composed.fontSmoothing = plan.typography.fontSmoothing;
  }

  return composed as unknown as CustomAppearance;
}
