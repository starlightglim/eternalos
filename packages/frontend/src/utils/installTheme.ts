/**
 * Install a .estheme pack from the bazaar onto the current user's profile.
 *
 * Scope: tokens + CSS + variants + typography. Asset-bearing layers (wallpaper,
 * cursors, sounds, icons) require per-asset uploads to the user's own R2
 * prefix and are deferred — install for those layers no-ops with a warning.
 *
 * Flow:
 *   1. GET /api/bazaar/pack/:packId → { pack, manifest }
 *   2. Fetch any declared layer files that live in R2 (tokens.json, theme.css, etc.)
 *   3. PATCH /api/profile with the assembled appearance fields
 *   4. POST /api/bazaar/install/:packId to increment install counter
 */

import type { EsthemeManifest, EsthemeTokens, EsthemeTypography } from './estheme';

const API_URL = import.meta.env.VITE_API_URL;

export interface InstallResult {
  success: boolean;
  packId: string;
  manifest: EsthemeManifest;
  appliedLayers: string[];
  skippedLayers: string[];
  warnings: string[];
}

interface ProfilePatch {
  // Tokens (flat fields)
  accentColor?: string;
  desktopColor?: string;
  windowBgColor?: string;
  titleBarBgColor?: string;
  titleBarTextColor?: string;
  windowBorderColor?: string;
  buttonBgColor?: string;
  buttonTextColor?: string;
  buttonBorderColor?: string;
  labelColor?: string;
  windowBorderRadius?: number;
  controlBorderRadius?: number;
  windowShadow?: number;
  windowOpacity?: number;
  // Typography
  systemFont?: string;
  bodyFont?: string;
  monoFont?: string;
  fontSmoothing?: boolean;
  // Custom CSS
  customCSS?: string;
  // Extended
  designTokens?: Record<string, string | number | boolean>;
  // Variants
  variants?: Record<string, string>;
}

async function fetchBazaarAsset(packId: string, path: string): Promise<Response> {
  const response = await fetch(`${API_URL}/api/bazaar/assets/${packId}/${path}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch asset ${path}: HTTP ${response.status}`);
  }
  return response;
}

export async function installTheme(
  packId: string,
  authToken: string,
): Promise<InstallResult> {
  const warnings: string[] = [];
  const appliedLayers: string[] = [];
  const skippedLayers: string[] = [];

  // 1. Fetch pack + manifest
  const packResponse = await fetch(`${API_URL}/api/bazaar/pack/${packId}`);
  if (!packResponse.ok) {
    throw new Error(`Pack not found: HTTP ${packResponse.status}`);
  }
  const { manifest } = (await packResponse.json()) as { manifest: EsthemeManifest | null };
  if (!manifest) {
    throw new Error('This pack is not a .estheme bundle.');
  }

  const patch: ProfilePatch = {};

  // 2. Tokens
  if (manifest.layers.tokens) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.tokens);
      const tokens = (await res.json()) as EsthemeTokens;
      Object.assign(patch, tokens);
      if (tokens.designTokens) patch.designTokens = tokens.designTokens;
      appliedLayers.push('tokens');
    } catch (e) {
      warnings.push(`Failed to load tokens: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3. CSS
  if (manifest.layers.css) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.css);
      patch.customCSS = await res.text();
      appliedLayers.push('css');
    } catch (e) {
      warnings.push(`Failed to load CSS: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4. Variants
  if (manifest.layers.variants) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.variants);
      const variants = (await res.json()) as Record<string, string>;
      patch.variants = variants;
      appliedLayers.push('variants');
    } catch (e) {
      warnings.push(`Failed to load variants: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 5. Typography
  if (manifest.layers.typography) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.typography);
      const typography = (await res.json()) as EsthemeTypography;
      if (typography.systemFont) patch.systemFont = typography.systemFont;
      if (typography.bodyFont) patch.bodyFont = typography.bodyFont;
      if (typography.monoFont) patch.monoFont = typography.monoFont;
      if (typeof typography.fontSmoothing === 'boolean') patch.fontSmoothing = typography.fontSmoothing;
      appliedLayers.push('typography');
    } catch (e) {
      warnings.push(`Failed to load typography: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 6. Asset-bearing layers — deferred until per-asset upload flow lands
  if (manifest.layers.wallpaper) {
    skippedLayers.push('wallpaper');
    warnings.push('Wallpaper install is deferred — set manually after install for now.');
  }
  if (manifest.layers.cursors && Object.keys(manifest.layers.cursors).length > 0) {
    skippedLayers.push('cursors');
    warnings.push('Cursor install is deferred — cursor pack import coming in a later release.');
  }
  if (manifest.layers.sounds && Object.keys(manifest.layers.sounds).length > 0) {
    skippedLayers.push('sounds');
    warnings.push('Sound install is deferred — sound pack import coming in a later release.');
  }
  if (manifest.layers.icons && Object.keys(manifest.layers.icons).length > 0) {
    skippedLayers.push('icons');
    warnings.push('Icon override install is deferred — per-item icons not yet supported from themes.');
  }

  // 7. PATCH profile (only if we have something to apply)
  if (appliedLayers.length > 0) {
    const profileResponse = await fetch(`${API_URL}/api/profile`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(patch),
    });
    if (!profileResponse.ok) {
      const errText = await profileResponse.text().catch(() => '');
      throw new Error(`Failed to apply theme: HTTP ${profileResponse.status} ${errText}`);
    }
  }

  // 8. Increment install counter (best-effort; non-fatal)
  fetch(`${API_URL}/api/bazaar/install/${packId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  }).catch(() => {
    // Counter update is a nice-to-have — don't block the install on it.
  });

  return {
    success: true,
    packId,
    manifest,
    appliedLayers,
    skippedLayers,
    warnings,
  };
}

/**
 * Preview a theme without committing. Returns the patch that WOULD be applied
 * so a caller can temp-apply via the appearance store and show "Keep / Revert".
 */
export async function previewTheme(packId: string): Promise<{
  manifest: EsthemeManifest;
  patch: ProfilePatch;
  warnings: string[];
}> {
  const warnings: string[] = [];

  const packResponse = await fetch(`${API_URL}/api/bazaar/pack/${packId}`);
  if (!packResponse.ok) {
    throw new Error(`Pack not found: HTTP ${packResponse.status}`);
  }
  const { manifest } = (await packResponse.json()) as { manifest: EsthemeManifest | null };
  if (!manifest) throw new Error('This pack is not a .estheme bundle.');

  const patch: ProfilePatch = {};

  if (manifest.layers.tokens) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.tokens);
      const tokens = (await res.json()) as EsthemeTokens;
      Object.assign(patch, tokens);
      if (tokens.designTokens) patch.designTokens = tokens.designTokens;
    } catch (e) {
      warnings.push(`tokens: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (manifest.layers.css) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.css);
      patch.customCSS = await res.text();
    } catch (e) {
      warnings.push(`css: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (manifest.layers.variants) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.variants);
      patch.variants = (await res.json()) as Record<string, string>;
    } catch (e) {
      warnings.push(`variants: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (manifest.layers.typography) {
    try {
      const res = await fetchBazaarAsset(packId, manifest.layers.typography);
      const typography = (await res.json()) as EsthemeTypography;
      if (typography.systemFont) patch.systemFont = typography.systemFont;
      if (typography.bodyFont) patch.bodyFont = typography.bodyFont;
      if (typography.monoFont) patch.monoFont = typography.monoFont;
      if (typeof typography.fontSmoothing === 'boolean') patch.fontSmoothing = typography.fontSmoothing;
    } catch (e) {
      warnings.push(`typography: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { manifest, patch, warnings };
}
