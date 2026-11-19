import { describe, expect, test } from 'vitest';
import {
  buildEsthemeImportPlan,
  composePreviewAppearance,
  decodeThemeLineage,
  encodeThemeLineage,
  THEME_LINEAGE_TOKEN_KEY,
  ESTHEME_IMPORT_LIMITS,
  type EsthemeImportPlan,
} from './importEstheme';
import type { CustomAppearance } from '../stores/appearanceStore';
import { buildFullThemeBundle, buildTestBundle, bytes, PNG_BYTES } from './bundleFixtures';

// A pre-existing user rice the preview composes on top of.
const USER_RICE: CustomAppearance = {
  accentColor: '#111111',
  desktopColor: '#222222',
  customCSS: '.user-desktop { color: blue; }',
  systemFont: 'geneva',
  variants: { 'window.chrome': 'beveled' },
  designTokens: {
    'cursor.image.grab': '/api/cursors/u1/g/grab.png|1|2',
    'menuBar.background': '#333333',
  },
};

describe('buildEsthemeImportPlan — happy path', () => {
  test('reads every layer of a full bundle', async () => {
    const plan = await buildEsthemeImportPlan(await buildFullThemeBundle());

    expect(plan.manifest.id).toBe('test-theme');
    expect(plan.tokens).toEqual({
      accentColor: '#00ffcc',
      windowOpacity: 90,
      designTokens: { 'window.titleBar.background': '#111111' },
    });
    expect(plan.css).toBe('.user-desktop { color: red; }');
    expect(plan.variants).toEqual({ 'window.titleBar': 'gradient' });
    expect(plan.typography).toEqual({ systemFont: 'chicago', fontSmoothing: false });
    expect(plan.cursors).toEqual([
      { state: 'default', blob: expect.any(Blob), filename: 'default.png', hotspotX: 3, hotspotY: 4 },
      { state: 'pointer', blob: expect.any(Blob), filename: 'pointer.png', hotspotX: 0, hotspotY: 0 },
    ]);
    expect(plan.sounds.map((s) => s.type).sort()).toEqual(['click', 'windowOpen']);
    expect(plan.wallpaper).toEqual({ blob: expect.any(Blob), filename: 'wallpaper.jpg', mode: 'tile' });
    expect(plan.appliedLayers).toEqual([
      'tokens', 'css', 'variants', 'typography', 'cursors', 'sounds', 'wallpaper',
    ]);
    // icons are declared by the format but not applied by this host — warned.
    expect(plan.warnings.some((w) => w.startsWith('icons:'))).toBe(true);
  });

  test('a minimal old-style bundle (strings, no forkedFrom) imports', async () => {
    const plan = await buildEsthemeImportPlan(
      await buildTestBundle(
        { cursors: { default: 'cursors/d.png' }, tokens: 'tokens.json' },
        {
          'tokens.json': JSON.stringify({ accentColor: '#abc' }),
          'cursors/d.png': PNG_BYTES,
        },
      ),
    );
    expect(plan.manifest.forkedFrom).toBeUndefined();
    expect(plan.tokens).toEqual({ accentColor: '#abc' });
    expect(plan.cursors[0]).toMatchObject({ state: 'default', hotspotX: 0, hotspotY: 0 });
  });

  test('carries forkedFrom through to the plan manifest (import shows it)', async () => {
    const plan = await buildEsthemeImportPlan(await buildFullThemeBundle());
    expect(plan.manifest.forkedFrom).toEqual({
      id: 'dreamcore-deluxe', name: 'Dreamcore Deluxe', author: '@bob', version: '1.0.0',
    });
  });
});

describe('buildEsthemeImportPlan — hostile bundles are rejected whole', () => {
  test('rejects theme.css with an external url()', async () => {
    const buf = await buildTestBundle(
      { css: 'theme.css' },
      { 'theme.css': '.user-desktop { background: url(https://evil.example/x.png); }' },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/not a first-party asset URL/);
  });

  test('rejects theme.css with a javascript: url()', async () => {
    const buf = await buildTestBundle(
      { css: 'theme.css' },
      { 'theme.css': '.user-desktop { background: url(javascript:alert(1)); }' },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/not a first-party asset URL/);
  });

  test('rejects theme.css with @import', async () => {
    const buf = await buildTestBundle(
      { css: 'theme.css' },
      { 'theme.css': '@import url("https://evil.example/t.css");' },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/@import/);
  });

  test('rejects an oversized theme.css', async () => {
    const buf = await buildTestBundle({ css: 'theme.css' }, { 'theme.css': 'a'.repeat(ESTHEME_IMPORT_LIMITS.cssBytes + 1) });
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/exceeds 50KB limit/);
  });

  test('rejects designTokens with an external url()', async () => {
    const buf = await buildTestBundle(
      { tokens: 'tokens.json' },
      {
        'tokens.json': JSON.stringify({
          designTokens: { 'chrome.sprite.url': 'url(https://evil.example/s.png)' },
        }),
      },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/url\(\) must reference first-party assets/);
  });

  test('rejects a cursor token pointing at an external bare URL', async () => {
    const buf = await buildTestBundle(
      { tokens: 'tokens.json' },
      {
        'tokens.json': JSON.stringify({
          designTokens: { 'cursor.image.default': 'https://evil.example/arrow.png|0|0' },
        }),
      },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/designTokens cursor\.image\.default must reference first-party assets/);
  });

  test('rejects designTokens with rule-breaking CSS punctuation', async () => {
    const buf = await buildTestBundle(
      { tokens: 'tokens.json' },
      { 'tokens.json': JSON.stringify({ designTokens: { 'window.border.style': 'solid; } .x { }' } }) },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/disallowed CSS punctuation/);
  });

  test('accepts a first-party relative url() in designTokens', async () => {
    const buf = await buildTestBundle(
      { tokens: 'tokens.json' },
      {
        'tokens.json': JSON.stringify({
          designTokens: {
            'chrome.sprite.url': '/api/css-assets/u1/a/p.png',
            'cursor.image.default': '/api/cursors/u1/c/a.png|2|3',
          },
        }),
      },
    );
    const plan = await buildEsthemeImportPlan(buf);
    expect(plan.tokens?.designTokens).toEqual({
      'chrome.sprite.url': '/api/css-assets/u1/a/p.png',
      'cursor.image.default': '/api/cursors/u1/c/a.png|2|3',
    });
  });

  test('rejects an oversized cursor asset', async () => {
    const buf = await buildTestBundle(
      { cursors: { default: 'cursors/big.png' } },
      { 'cursors/big.png': new Uint8Array(ESTHEME_IMPORT_LIMITS.cursorBytes + 1) },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/exceeds the 50KB limit/);
  });

  test('rejects an oversized sound asset', async () => {
    const buf = await buildTestBundle(
      { sounds: { click: 'sounds/big.mp3' } },
      { 'sounds/big.mp3': new Uint8Array(ESTHEME_IMPORT_LIMITS.soundBytes + 1) },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/exceeds the 200KB limit/);
  });

  test('rejects an oversized wallpaper asset', async () => {
    const buf = await buildTestBundle(
      { wallpaper: { file: 'wall.jpg' } },
      { 'wall.jpg': new Uint8Array(ESTHEME_IMPORT_LIMITS.wallpaperBytes + 1) },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/exceeds the 2048KB limit/);
  });

  test('rejects an unsupported asset extension (cursor .exe)', async () => {
    const buf = await buildTestBundle(
      { cursors: { default: 'cursors/evil.exe' } },
      { 'cursors/evil.exe': bytes('MZ') },
    );
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/unsupported file type/);
  });

  test('rejects a manifest declaring path traversal (schema-level)', async () => {
    const buf = await buildTestBundle({ css: '../../etc/passwd' }, { 'theme.css': 'body {}' });
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/Invalid manifest/);
  });

  test('rejects a bundle with no layers the host can apply', async () => {
    const buf = await buildTestBundle({ icons: { folder: 'icons/f.png' } }, { 'icons/f.png': PNG_BYTES });
    await expect(buildEsthemeImportPlan(buf)).rejects.toThrow(/declares no layers/);
  });
});

describe('buildEsthemeImportPlan — soft edges', () => {
  test('unknown variants are filtered with a warning; known ones kept', async () => {
    const buf = await buildTestBundle(
      { variants: 'variants.json' },
      {
        'variants.json': JSON.stringify({
          'window.titleBar': 'gradient',
          'window.chrome': 'does-not-exist',
        }),
      },
    );
    const plan = await buildEsthemeImportPlan(buf);
    expect(plan.variants).toEqual({ 'window.titleBar': 'gradient' });
    expect(plan.warnings.some((w) => w.includes('does-not-exist'))).toBe(true);
  });

  test('unknown font IDs are dropped with a warning', async () => {
    const buf = await buildTestBundle(
      { typography: 'typography.json' },
      { 'typography.json': JSON.stringify({ systemFont: 'not-a-font', monoFont: 'monaco' }) },
    );
    const plan = await buildEsthemeImportPlan(buf);
    expect(plan.typography).toEqual({ monoFont: 'monaco' });
    expect(plan.warnings.some((w) => w.includes('not-a-font'))).toBe(true);
  });

  test('mobile wallpaper is accepted but warned as not applied', async () => {
    const buf = await buildTestBundle(
      { wallpaper: { file: 'wall.jpg', mobileFile: 'wall-m.jpg', mode: 'center' } },
      { 'wall.jpg': bytes('j'), 'wall-m.jpg': bytes('m') },
    );
    const plan = await buildEsthemeImportPlan(buf);
    expect(plan.wallpaper).toEqual({ blob: expect.any(Blob), filename: 'wall.jpg', mode: 'center' });
    expect(plan.warnings.some((w) => w.includes('mobile wallpaper'))).toBe(true);
  });
});

describe('composePreviewAppearance', () => {
  const basePlan = {} as EsthemeImportPlan;

  test('a present tokens layer replaces the whole tokens state; absent layers are kept', () => {
    const plan: EsthemeImportPlan = {
      ...basePlan,
      manifest: {
        formatVersion: 1, id: 't', name: 'T', version: '1.0.0', author: '@a', layers: {},
      },
      tokens: { accentColor: '#00ffcc', designTokens: { 'window.titleBar.background': '#111111' } },
      css: '.user-desktop { color: red; }',
      cursors: [], sounds: [], appliedLayers: [], warnings: [],
    };
    const composed = composePreviewAppearance(USER_RICE, plan, {
      default: 'http://api.test/api/cursors/u2/c1/a.png|3|4',
    });

    // Tokens layer: theme value where set, explicit clear where not.
    expect(composed.accentColor).toBe('#00ffcc');
    expect(composed.desktopColor).toBeUndefined();
    expect('desktopColor' in composed).toBe(true); // explicit null-tombstone clear
    // designTokens = theme blob + uploaded cursor tokens + lineage.
    expect(composed.designTokens).toEqual({
      'window.titleBar.background': '#111111',
      'cursor.image.default': 'http://api.test/api/cursors/u2/c1/a.png|3|4',
      [THEME_LINEAGE_TOKEN_KEY]: encodeThemeLineage({ id: 't', name: 'T', author: '@a', version: '1.0.0' }),
    });
    // css layer replaced.
    expect(composed.customCSS).toBe('.user-desktop { color: red; }');
    // Absent layers keep the user's values.
    expect(composed.systemFont).toBe('geneva');
    expect(composed.variants).toEqual({ 'window.chrome': 'beveled' });
  });

  test('a cursor-only theme keeps the user rice and replaces only the uploaded slots', () => {
    const plan: EsthemeImportPlan = {
      ...basePlan,
      manifest: {
        formatVersion: 1, id: 'cursor-pack', name: 'Cursor Pack', version: '2.0.0', author: '@b', layers: {},
      },
      cursors: [], sounds: [], appliedLayers: ['cursors'], warnings: [],
    };
    const composed = composePreviewAppearance(USER_RICE, plan, {
      default: '/api/cursors/u2/c1/a.png|0|0',
    });

    expect(composed.accentColor).toBe('#111111');
    expect(composed.customCSS).toBe(USER_RICE.customCSS);
    expect(composed.variants).toEqual(USER_RICE.variants);
    expect(composed.designTokens).toEqual({
      // untouched user token
      'cursor.image.grab': USER_RICE.designTokens!['cursor.image.grab'],
      'menuBar.background': USER_RICE.designTokens!['menuBar.background'],
      // replaced slot
      'cursor.image.default': '/api/cursors/u2/c1/a.png|0|0',
      // lineage of the installed pack
      [THEME_LINEAGE_TOKEN_KEY]: encodeThemeLineage({ id: 'cursor-pack', name: 'Cursor Pack', author: '@b', version: '2.0.0' }),
    });
  });

  test('slots whose upload failed keep the user cursor (absent from cursorTokens)', () => {
    const plan: EsthemeImportPlan = {
      ...basePlan,
      manifest: {
        formatVersion: 1, id: 't', name: 'T', version: '1.0.0', author: '@a', layers: {},
      },
      cursors: [], sounds: [], appliedLayers: [], warnings: [],
    };
    const composed = composePreviewAppearance(USER_RICE, plan, {});
    expect(composed.designTokens?.['cursor.image.grab']).toBe(USER_RICE.designTokens!['cursor.image.grab']);
  });
});

describe('lineage codec', () => {
  test('encode → decode round-trips', () => {
    const lineage = { id: 'dreamcore', name: 'Dreamcore', author: '@alice', version: '1.0.0' };
    expect(decodeThemeLineage(encodeThemeLineage(lineage))).toEqual(lineage);
  });

  test('decode fails soft on malformed values', () => {
    expect(decodeThemeLineage(undefined)).toBeNull();
    expect(decodeThemeLineage('not json')).toBeNull();
    expect(decodeThemeLineage('{"id":"x","author":"bob"}')).toBeNull(); // author must be @handle
    expect(decodeThemeLineage('{"id":"X!","author":"@bob"}')).toBeNull(); // id must be a slug
    expect(decodeThemeLineage(JSON.stringify({ id: 'x', author: '@bob', version: 'v1' }))).toBeNull();
  });
});
