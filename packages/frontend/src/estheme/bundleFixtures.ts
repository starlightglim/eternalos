/**
 * .estheme test fixtures — tiny typed zip builder for the estheme suites
 * (estheme round-trip, import-plan validation, preview Keep/Revert).
 *
 * Bundles are assembled file-by-file so each test controls exactly what a
 * (possibly hostile) bundle contains, including entries the manifest does NOT
 * declare.
 */

import JSZip from 'jszip';
import type { EsthemeManifest } from '../utils/estheme';

/** Minimal valid manifest head (everything except `layers`). */
export const TEST_META: Omit<EsthemeManifest, 'layers'> = {
  formatVersion: 1,
  id: 'test-theme',
  name: 'Test Theme',
  version: '1.2.3',
  author: '@alice',
};

/**
 * Build an .estheme zip. `files` maps zip paths to string or byte contents;
 * `layers` lands verbatim in the manifest (tests can declare layers that
 * reference these files — or deliberately don't).
 */
export async function buildTestBundle(
  layers: EsthemeManifest['layers'],
  files: Record<string, string | Uint8Array>,
  extraManifest: Partial<Omit<EsthemeManifest, 'layers'>> = {},
): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ ...TEST_META, ...extraManifest, layers }));
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: 'arraybuffer' });
}

/** Blob stand-in for node tests (JSZip reads Uint8Array directly). */
export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A valid PNG-ish header so size checks see plausible binary content. */
export const PNG_BYTES = bytes('\x89PNG\r\n\x1a\nfake-png-data');

/**
 * The kitchen-sink bundle: every layer the format defines, with a cursor in
 * the object (hotspot) form, a tiled wallpaper, and fork lineage.
 */
export const FULL_THEME_LAYERS: EsthemeManifest['layers'] = {
  tokens: 'tokens.json',
  css: 'theme.css',
  variants: 'variants.json',
  typography: 'typography.json',
  wallpaper: { file: 'wallpaper.jpg', mode: 'tile' },
  cursors: {
    default: { file: 'cursors/default.png', hotspotX: 3, hotspotY: 4 },
    pointer: 'cursors/pointer.png',
  },
  sounds: { click: 'sounds/click.mp3', windowOpen: 'sounds/open.mp3' },
  icons: { folder: 'icons/folder.png' },
};

export const FULL_THEME_FILES: Record<string, string | Uint8Array> = {
  'tokens.json': JSON.stringify({
    accentColor: '#00ffcc',
    windowOpacity: 90,
    designTokens: { 'window.titleBar.background': '#111111' },
  }),
  'theme.css': '.user-desktop { color: red; }',
  'variants.json': JSON.stringify({ 'window.titleBar': 'gradient' }),
  'typography.json': JSON.stringify({ systemFont: 'chicago', fontSmoothing: false }),
  'wallpaper.jpg': bytes('fake-jpeg-bytes'),
  'cursors/default.png': PNG_BYTES,
  'cursors/pointer.png': PNG_BYTES,
  'sounds/click.mp3': bytes('fake-mp3-bytes'),
  'sounds/open.mp3': bytes('fake-mp3-bytes'),
  'icons/folder.png': PNG_BYTES,
  'preview.png': PNG_BYTES,
};

export async function buildFullThemeBundle(): Promise<ArrayBuffer> {
  return buildTestBundle(FULL_THEME_LAYERS, FULL_THEME_FILES, {
    description: 'A theme with every layer.',
    forkedFrom: { id: 'dreamcore-deluxe', name: 'Dreamcore Deluxe', author: '@bob', version: '1.0.0' },
  });
}
