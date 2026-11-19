import { expect, test, describe, vi, afterEach } from 'vitest';
import { exportCurrentTheme, slugify } from './exportTheme';
import { parseEsthemeBundle, validateManifest } from './estheme';
import type { UserProfile } from '../types';

// JSZip reads Uint8Array directly in node (a Blob needs the browser FileReader),
// so hand the preview in as bytes. parseEsthemeBundle likewise gets ArrayBuffer.
const bytes = (s: string): Blob => new TextEncoder().encode(s) as unknown as Blob;

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    username: 'alice',
    accentColor: '#FF0000',
    customCSS: '.user-desktop { color: red; }',
    systemFont: 'chicago',
    ...overrides,
  } as UserProfile;
}

// A tiny fetch router keyed by URL path. Serves Uint8Array "blobs" — JSZip
// can read those directly in node (a real Blob needs the browser FileReader).
function assetFetchRouter(assets: Record<string, string>) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    const key = Object.keys(assets).find((k) => url.endsWith(k));
    if (!key) return { ok: false, status: 404 } as Response;
    return {
      ok: true,
      status: 200,
      blob: async () => new TextEncoder().encode(assets[key]),
    } as unknown as Response;
  };
}

describe('slugify', () => {
  test('lowercases, strips punctuation, and hyphenates whitespace', () => {
    expect(slugify('My Dreamcore!')).toBe('my-dreamcore');
    expect(slugify('  Hello   World  ')).toBe('hello-world');
    expect(slugify('a__b')).toBe('a-b');
  });

  test('collapses repeated hyphens and trims leading/trailing ones', () => {
    expect(slugify('--a---b--')).toBe('a-b');
  });

  test('produces a non-empty, schema-valid id even from junk input', () => {
    const out = slugify('!!!');
    expect(out).toMatch(/^theme-[a-z0-9]+$/);
  });

  test('caps length at 64 chars', () => {
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  test('always matches the estheme slug rule', () => {
    const slugRegex = /^[a-z0-9][a-z0-9-]{0,63}$/;
    for (const input of ['My Theme', 'über cool!!', '   ', '多字节', '-leading']) {
      expect(slugRegex.test(slugify(input)), `slugify(${JSON.stringify(input)})`).toBe(true);
    }
  });
});

describe('exportCurrentTheme', () => {
  test('builds a valid, re-parseable bundle from a profile', async () => {
    const result = await exportCurrentTheme(profile({ username: 'alice', displayName: 'Alice' }), {
      preview: bytes('png'),
    });
    expect(result.filename).toBe(`${result.manifest.id}-1.0.0.estheme`);
    expect(result.manifest.author).toBe('@alice');
    expect(validateManifest(result.manifest).ok).toBe(true);

    const parsed = await parseEsthemeBundle(await result.blob.arrayBuffer());
    expect(parsed.manifest.id).toBe(result.manifest.id);
    // The profile's colors, css and font made it into the bundle.
    expect(parsed.files.has('tokens.json')).toBe(true);
    expect(parsed.files.has('theme.css')).toBe(true);
    expect(parsed.files.has('typography.json')).toBe(true);
    const css = await parsed.files.get('theme.css')!.text();
    expect(css).toContain('color: red');
  });

  test('derives id from the name and respects explicit options', async () => {
    const result = await exportCurrentTheme(profile(), {
      name: 'Neon Dreams',
      version: '2.1.0',
      preview: bytes('png'),
    });
    expect(result.manifest.id).toBe('neon-dreams');
    expect(result.manifest.name).toBe('Neon Dreams');
    expect(result.filename).toBe('neon-dreams-2.1.0.estheme');
  });

  test('extracts variant.* designTokens into the variants layer', async () => {
    const result = await exportCurrentTheme(
      profile({ designTokens: { 'variant.window.titleBar': 'gradient' } as never }),
      { preview: bytes('png') }
    );
    const parsed = await parseEsthemeBundle(await result.blob.arrayBuffer());
    expect(parsed.manifest.layers.variants).toBeDefined();
    const variants = JSON.parse(await parsed.files.get(parsed.manifest.layers.variants!)!.text());
    expect(variants['window.titleBar']).toBe('gradient');
  });

  test('throws when the profile has nothing themeable', async () => {
    await expect(
      exportCurrentTheme({ username: 'alice' } as UserProfile, { preview: bytes('png') })
    ).rejects.toThrow(/Nothing to export/);
  });

  test('a cursor/sound-only rice is exportable (no tokens/css needed)', async () => {
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = assetFetchRouter({
      '/api/cursors/u1/c/arrow.png': 'cursor-bytes',
      '/api/sounds/u1/s/click.mp3': 'sound-bytes',
    });
    try {
      const result = await exportCurrentTheme(
        profile({
          accentColor: undefined,
          customCSS: undefined,
          systemFont: undefined,
          designTokens: { 'cursor.image.default': '/api/cursors/u1/c/arrow.png|2|3' },
          soundPack: { name: 'Custom', sounds: { click: '/api/sounds/u1/s/click.mp3' } },
        } as never),
        { preview: bytes('png') }
      );
      expect(result.manifest.layers.cursors).toEqual({
        default: { file: 'cursors/arrow.png', hotspotX: 2, hotspotY: 3 },
      });
      expect(result.manifest.layers.sounds).toEqual({ click: 'sounds/click.mp3' });
      expect(result.warnings).toEqual([]);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });
});

describe('exportCurrentTheme — asset layers (wallpaper, cursors, sounds)', () => {
  const FULL_ASSET_PROFILE = profile({
    wallpaper: 'custom:u1/wallpaper/w1/sunset.jpg',
    wallpaperMode: 'tile',
    designTokens: {
      'cursor.image.default': '/api/cursors/u1/c/arrow.png|2|3',
      'menuBar.background': '#123456',
    },
    soundPack: { name: 'Custom', sounds: { click: '/api/sounds/u1/s/click.mp3' } },
  } as never) as UserProfile;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('packs wallpaper, cursors (with hotspots), and sounds into one bundle', async () => {
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = assetFetchRouter({
      '/api/cursors/u1/c/arrow.png': 'cursor-bytes',
      '/api/sounds/u1/s/click.mp3': 'sound-bytes',
      '/api/wallpaper/u1/wallpaper/w1/sunset.jpg': 'wallpaper-bytes',
    });
    try {
      const result = await exportCurrentTheme(FULL_ASSET_PROFILE, { preview: bytes('png') });

      // Original asset filenames are preserved (the manifest points at them).
      expect(result.manifest.layers.wallpaper).toEqual({ file: 'sunset.jpg', mode: 'tile' });
      expect(result.manifest.layers.cursors).toEqual({
        default: { file: 'cursors/arrow.png', hotspotX: 2, hotspotY: 3 },
      });
      expect(result.manifest.layers.sounds).toEqual({ click: 'sounds/click.mp3' });
      expect(result.warnings).toEqual([]);

      const parsed = await parseEsthemeBundle(await result.blob.arrayBuffer());
      expect(await parsed.files.get('sunset.jpg')!.text()).toBe('wallpaper-bytes');
      expect(await parsed.files.get('cursors/arrow.png')!.text()).toBe('cursor-bytes');
      expect(await parsed.files.get('sounds/click.mp3')!.text()).toBe('sound-bytes');

      // The tokens layer keeps the user's other tokens but NOT the per-user
      // cursor tokens (the cursors layer carries the files instead).
      const tokens = JSON.parse(await parsed.files.get('tokens.json')!.text());
      expect(tokens.designTokens).toEqual({ 'menuBar.background': '#123456' });
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });

  test('strips the reserved lineage key from the tokens layer', async () => {
    const result = await exportCurrentTheme(
      profile({ designTokens: { 'theme.lineage': '{"id":"x","author":"@alice"}', 'menuBar.background': '#000' } } as never),
      { preview: bytes('png') }
    );
    const parsed = await parseEsthemeBundle(await result.blob.arrayBuffer());
    const tokens = JSON.parse(await parsed.files.get('tokens.json')!.text());
    expect(tokens.designTokens).toEqual({ 'menuBar.background': '#000' });
  });

  test('records forkedFrom when the current rice was installed from another .estheme', async () => {
    const result = await exportCurrentTheme(
      profile({
        designTokens: {
          'theme.lineage': JSON.stringify({ id: 'dreamcore-deluxe', name: 'Dreamcore Deluxe', author: '@bob', version: '1.0.0' }),
        },
      } as never),
      { preview: bytes('png') }
    );
    expect(result.manifest.forkedFrom).toEqual({
      id: 'dreamcore-deluxe', name: 'Dreamcore Deluxe', author: '@bob', version: '1.0.0',
    });
    expect(validateManifest(result.manifest).ok).toBe(true);
  });

  test('a failed asset read downgrades to a warning instead of failing the export', async () => {
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = assetFetchRouter({}); // everything 404s
    try {
      const result = await exportCurrentTheme(FULL_ASSET_PROFILE, { preview: bytes('png') });
      expect(result.manifest.layers.cursors).toBeUndefined();
      expect(result.manifest.layers.sounds).toBeUndefined();
      expect(result.manifest.layers.wallpaper).toBeUndefined();
      expect(result.warnings.some((w) => w.includes('cursor'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('sound'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('wallpaper'))).toBe(true);
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });

  test('built-in wallpaper patterns are not packed, with a warning', async () => {
    const result = await exportCurrentTheme(
      profile({ wallpaper: 'denim', wallpaperMode: 'cover' } as never),
      { preview: bytes('png') }
    );
    expect(result.manifest.layers.wallpaper).toBeUndefined();
    expect(result.warnings.some((w) => w.includes('built-in patterns'))).toBe(true);
  });
});
