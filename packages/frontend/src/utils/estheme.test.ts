import { expect, test, describe } from 'vitest';
import {
  validateManifest,
  validateManifestAgainstFiles,
  buildEsthemeBundle,
  parseEsthemeBundle,
  isSafeBundlePath,
  cursorSlotPath,
  type EsthemeManifest,
  type EsthemeBuildInput,
} from './estheme';
import { buildFullThemeBundle, buildTestBundle, TEST_META, PNG_BYTES, FULL_THEME_FILES } from '../estheme/bundleFixtures';

// A minimal valid manifest head (everything except the derived `layers`).
const meta: Omit<EsthemeManifest, 'layers'> = {
  formatVersion: 1,
  id: 'my-theme',
  name: 'My Theme',
  version: '1.0.0',
  author: '@alice',
};

function validManifest(overrides: Partial<EsthemeManifest> = {}): EsthemeManifest {
  return { ...meta, layers: {}, ...overrides };
}

// JSZip reads string/ArrayBuffer/Uint8Array directly, but reads a Blob via the
// browser-only FileReader. In node we therefore hand it Uint8Array bytes for
// binary inputs (the production type is Blob; both are valid JSZip inputs).
const bytes = (s: string): Blob => new TextEncoder().encode(s) as unknown as Blob;

describe('validateManifest', () => {
  test('accepts a minimal valid manifest', () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.id).toBe('my-theme');
  });

  test('rejects a malformed author handle', () => {
    const result = validateManifest(validManifest({ author: 'alice' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.path === 'author')).toBe(true);
  });

  test('rejects a non-slug id and a non-semver version', () => {
    expect(validateManifest(validManifest({ id: 'Not A Slug' })).ok).toBe(false);
    expect(validateManifest(validManifest({ version: 'v1' })).ok).toBe(false);
  });

  test('rejects the wrong format version', () => {
    expect(validateManifest(validManifest({ formatVersion: 2 as never })).ok).toBe(false);
  });

  test('rejects unknown top-level keys (strict schema)', () => {
    const result = validateManifest({ ...validManifest(), evil: 'payload' });
    expect(result.ok).toBe(false);
  });

  test('rejects a path-traversal bundle path in a layer', () => {
    const result = validateManifest(validManifest({ layers: { css: '../../etc/passwd' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.path.startsWith('layers'))).toBe(true);
  });

  test('rejects an absolute bundle path in a layer', () => {
    expect(validateManifest(validManifest({ layers: { css: '/etc/passwd' } })).ok).toBe(false);
  });

  test('reports structured { path, message } errors', () => {
    const result = validateManifest({ formatVersion: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors[0]).toHaveProperty('path');
      expect(result.errors[0]).toHaveProperty('message');
    }
  });

  test('accepts a theme that overrides only SOME cursor/sound/icon slots', () => {
    // Regression: zod 4 `z.record(z.enum(...))` is exhaustive and would reject
    // a partial slot map. Themes declare only the slots they override, so these
    // layers must be partial — one cursor + one sound + one icon must validate.
    const result = validateManifest(
      validManifest({
        layers: {
          cursors: { default: 'cursors/d.png' },
          sounds: { click: 'sounds/c.wav' },
          icons: { folder: 'icons/f.png' },
        },
      })
    );
    expect(result.ok).toBe(true);
  });

  test('still rejects an empty cursors layer (declared but no slots)', () => {
    const result = validateManifest(validManifest({ layers: { cursors: {} } }));
    expect(result.ok).toBe(false);
  });
});

describe('forkedFrom lineage field', () => {
  test('accepts a manifest with valid forkedFrom', () => {
    const result = validateManifest(
      validManifest({ forkedFrom: { id: 'dreamcore-deluxe', name: 'Dreamcore Deluxe', author: '@bob', version: '1.0.0' } })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.forkedFrom?.author).toBe('@bob');
  });

  test('old manifests without forkedFrom still validate', () => {
    const result = validateManifest(validManifest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.forkedFrom).toBeUndefined();
  });

  test('rejects a malformed forkedFrom (bad author handle, bad version)', () => {
    const badAuthor = validateManifest(validManifest({ forkedFrom: { id: 'x', author: 'bob' } }));
    expect(badAuthor.ok).toBe(false);
    const badVersion = validateManifest(
      validManifest({ forkedFrom: { id: 'x', author: '@bob', version: 'v1' } })
    );
    expect(badVersion.ok).toBe(false);
  });

  test('rejects unknown keys inside forkedFrom (strict schema)', () => {
    const result = validateManifest(
      validManifest({ forkedFrom: { id: 'x', author: '@bob', evil: 'payload' } as never })
    );
    expect(result.ok).toBe(false);
  });
});

describe('cursor slot values (string + hotspot object forms)', () => {
  test('cursorSlotPath resolves both forms', () => {
    expect(cursorSlotPath('cursors/d.png')).toBe('cursors/d.png');
    expect(cursorSlotPath({ file: 'cursors/d.png', hotspotX: 3, hotspotY: 4 })).toBe('cursors/d.png');
  });

  test('accepts the object form with hotspots in range', () => {
    const result = validateManifest(
      validManifest({ layers: { cursors: { default: { file: 'cursors/d.png', hotspotX: 3, hotspotY: 4 } } } })
    );
    expect(result.ok).toBe(true);
  });

  test('rejects out-of-range hotspots and unknown keys', () => {
    const negative = validateManifest(
      validManifest({ layers: { cursors: { default: { file: 'cursors/d.png', hotspotX: -1 } } } })
    );
    expect(negative.ok).toBe(false);
    const tooBig = validateManifest(
      validManifest({ layers: { cursors: { default: { file: 'cursors/d.png', hotspotY: 65 } } } })
    );
    expect(tooBig.ok).toBe(false);
    const unknownKey = validateManifest(
      validManifest({ layers: { cursors: { default: { file: 'cursors/d.png', url: 'nope' } as never } } })
    );
    expect(unknownKey.ok).toBe(false);
  });

  test('isSafeBundlePath rejects traversal-shaped segments in any position', () => {
    expect(isSafeBundlePath('cursors/d.png')).toBe(true);
    expect(isSafeBundlePath('../evil.png')).toBe(false);
    expect(isSafeBundlePath('cursors/../../evil.png')).toBe(false);
    expect(isSafeBundlePath('cursors/..')).toBe(false);
    expect(isSafeBundlePath('..')).toBe(false);
    expect(isSafeBundlePath('cursors/.')).toBe(false);
    expect(isSafeBundlePath('/abs/path.png')).toBe(false);
    expect(isSafeBundlePath('cursors\\evil.png')).toBe(false);
  });
});

describe('validateManifestAgainstFiles', () => {
  test('fails when a declared layer file is absent from the bundle', () => {
    const manifest = validManifest({ layers: { css: 'theme.css' } });
    const result = validateManifestAgainstFiles(manifest, new Set());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe('layers.css');
      expect(result.errors[0].message).toContain('not in bundle');
    }
  });

  test('passes when every declared file is present', () => {
    const manifest = validManifest({ layers: { css: 'theme.css', tokens: 'tokens.json' } });
    const result = validateManifestAgainstFiles(manifest, new Set(['theme.css', 'tokens.json']));
    expect(result.ok).toBe(true);
  });

  test('checks nested wallpaper + cursor slot paths', () => {
    const manifest = validManifest({
      layers: {
        wallpaper: { file: 'wall.jpg' },
        cursors: { default: 'cursors/d.png' },
      },
    });
    const missing = validateManifestAgainstFiles(manifest, new Set(['wall.jpg']));
    expect(missing.ok).toBe(false); // cursor file absent
    const present = validateManifestAgainstFiles(
      manifest,
      new Set(['wall.jpg', 'cursors/d.png'])
    );
    expect(present.ok).toBe(true);
  });

  test('resolves cursor slot paths in BOTH forms (string and hotspot object)', () => {
    const manifest = validManifest({
      layers: {
        cursors: {
          default: { file: 'cursors/d.png', hotspotX: 3, hotspotY: 4 },
          pointer: 'cursors/p.png',
        },
      },
    });
    const missing = validateManifestAgainstFiles(manifest, new Set(['cursors/p.png']));
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.errors.some((e) => e.path === 'layers.cursors.default')).toBe(true);
    }
    const present = validateManifestAgainstFiles(manifest, new Set(['cursors/d.png', 'cursors/p.png']));
    expect(present.ok).toBe(true);
  });
});

describe('buildEsthemeBundle → parseEsthemeBundle round-trip', () => {
  const buildInput: EsthemeBuildInput = {
    meta,
    tokens: { accentColor: '#ff0000', windowOpacity: 90 },
    css: '.user-desktop { color: red; }',
    variants: { 'window.titleBar': 'gradient' },
    typography: { systemFont: 'Chicago', fontSmoothing: false },
    preview: { blob: bytes('fake-png-bytes') },
    readme: '# My Theme',
  };

  test('derives the layer manifest from the inputs', async () => {
    const { manifest } = await buildEsthemeBundle(buildInput);
    expect(manifest.layers.tokens).toBe('tokens.json');
    expect(manifest.layers.css).toBe('theme.css');
    expect(manifest.layers.variants).toBe('variants.json');
    expect(manifest.layers.typography).toBe('typography.json');
  });

  test('a built bundle parses back to the same manifest and files', async () => {
    const { blob, manifest } = await buildEsthemeBundle(buildInput);
    // JSZip.loadAsync reads a Blob via FileReader (browser-only); node has no
    // FileReader, so feed the ArrayBuffer form that parseEsthemeBundle accepts.
    const parsed = await parseEsthemeBundle(await blob.arrayBuffer());

    expect(parsed.manifest).toEqual(manifest);
    // Layer files are present...
    expect(parsed.files.has('tokens.json')).toBe(true);
    expect(parsed.files.has('theme.css')).toBe(true);
    expect(parsed.files.has('variants.json')).toBe(true);
    expect(parsed.files.has('typography.json')).toBe(true);
    expect(parsed.files.has('preview.png')).toBe(true);
    expect(parsed.files.has('readme.md')).toBe(true);
    // ...and their contents survived intact.
    const css = await parsed.files.get('theme.css')!.text();
    expect(css).toBe('.user-desktop { color: red; }');
    const tokens = JSON.parse(await parsed.files.get('tokens.json')!.text());
    expect(tokens).toEqual({ accentColor: '#ff0000', windowOpacity: 90 });
  });

  test('omits layers for inputs that are absent or empty', async () => {
    const { manifest } = await buildEsthemeBundle({
      meta,
      tokens: {},
      css: '   ',
      preview: { blob: bytes('x') },
    });
    expect(manifest.layers.tokens).toBeUndefined();
    expect(manifest.layers.css).toBeUndefined();
  });

  test('enforces the bundle size limit', async () => {
    await expect(
      buildEsthemeBundle(buildInput, { maxBytes: 10 })
    ).rejects.toThrow(/exceeds limit/);
  });
});

describe('parseEsthemeBundle rejects tampered / invalid bundles', () => {
  // ArrayBuffer output so parseEsthemeBundle can read it in node (see above).
  test('a bundle missing manifest.json is rejected', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('theme.css', 'body { color: red; }');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/missing manifest\.json/);
  });

  test('a manifest referencing a missing file is rejected', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    // Manifest claims a css layer, but theme.css is not in the bundle.
    zip.file('manifest.json', JSON.stringify(validManifest({ layers: { css: 'theme.css' } })));
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/Invalid manifest/);
  });

  test('a non-JSON manifest is rejected', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('manifest.json', 'not json {');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/not valid JSON/);
  });
});

describe('round-trip with every asset kind', () => {
  test('a built bundle with every layer parses back intact', async () => {
    const input: EsthemeBuildInput = {
      meta: TEST_META,
      tokens: { accentColor: '#ff0000', windowOpacity: 90, designTokens: { glowColor: '#fff' } },
      css: '.user-desktop { color: red; }',
      variants: { 'window.titleBar': 'gradient' },
      typography: { systemFont: 'chicago', fontSmoothing: false },
      wallpaper: { file: bytes('fake-jpg') as unknown as Blob, filename: 'wallpaper.jpg', mode: 'tile' },
      cursors: {
        default: { blob: PNG_BYTES as unknown as Blob, filename: 'default.png', hotspotX: 3, hotspotY: 4 },
        pointer: { blob: PNG_BYTES as unknown as Blob, filename: 'pointer.png' },
      },
      sounds: { click: { blob: bytes('mp3') as unknown as Blob, filename: 'click.mp3' } },
      icons: { folder: { blob: PNG_BYTES as unknown as Blob, filename: 'folder.png' } },
      preview: { blob: PNG_BYTES as unknown as Blob, filename: 'preview.png' },
      previewMobile: { blob: PNG_BYTES as unknown as Blob, filename: 'preview-mobile.png' },
      readme: '# Everything, together',
    };

    const { blob, manifest } = await buildEsthemeBundle(input);
    const parsed = await parseEsthemeBundle(await blob.arrayBuffer());

    // The manifest layers point at every packed asset, in the declared forms.
    expect(manifest.layers).toEqual({
      tokens: 'tokens.json',
      css: 'theme.css',
      variants: 'variants.json',
      typography: 'typography.json',
      wallpaper: { file: 'wallpaper.jpg', mode: 'tile' },
      cursors: {
        default: { file: 'cursors/default.png', hotspotX: 3, hotspotY: 4 },
        pointer: 'cursors/pointer.png',
      },
      sounds: { click: 'sounds/click.mp3' },
      icons: { folder: 'icons/folder.png' },
    });
    expect(parsed.manifest).toEqual(manifest);

    // Every file survived, with its content intact.
    for (const path of [
      'tokens.json', 'theme.css', 'variants.json', 'typography.json',
      'wallpaper.jpg', 'cursors/default.png', 'cursors/pointer.png',
      'sounds/click.mp3', 'icons/folder.png', 'preview.png', 'preview-mobile.png', 'readme.md',
    ]) {
      expect(parsed.files.has(path), `missing ${path}`).toBe(true);
    }
    expect(JSON.parse(await parsed.files.get('tokens.json')!.text())).toEqual({
      accentColor: '#ff0000', windowOpacity: 90, designTokens: { glowColor: '#fff' },
    });
    expect(await parsed.files.get('wallpaper.jpg')!.text()).toBe('fake-jpg');
    expect(await parsed.files.get('sounds/click.mp3')!.text()).toBe('mp3');
    expect(await parsed.files.get('readme.md')!.text()).toBe('# Everything, together');
  });

  test('a fixture bundle with forkedFrom parses back with its lineage', async () => {
    const parsed = await parseEsthemeBundle(await buildFullThemeBundle());
    expect(parsed.manifest.forkedFrom).toEqual({
      id: 'dreamcore-deluxe', name: 'Dreamcore Deluxe', author: '@bob', version: '1.0.0',
    });
    expect(parsed.files.size).toBe(Object.keys(FULL_THEME_FILES).length);
  });
});

describe('parseEsthemeBundle hostile-input hardening', () => {
  // JSZip normalizes `../`-style segments itself (on write AND on read), so
  // those shapes cannot reach the parser through this library — the parser's
  // path guard still rejects everything else unsafe a zip can carry.
  test('rejects a zip containing a backslash entry the manifest never references', async () => {
    const buf = await buildTestBundle(
      { css: 'theme.css' },
      { 'theme.css': 'body {}', 'cursors\\evil.png': 'x' },
    );
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/unsafe entry path/);
  });

  test('rejects a zip containing a control-character entry name', async () => {
    const buf = await buildTestBundle(
      { css: 'theme.css' },
      { 'theme.css': 'body {}', 'cur\nsors/bad.png': 'x' },
    );
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/unsafe entry path/);
  });

  test('rejects a bundle whose expanded content exceeds the limit', async () => {
    // 11MB of zeros deflates to almost nothing — the extracted-size cap is
    // what catches it, not the zip's byte size.
    const bomb = new Uint8Array(11 * 1024 * 1024);
    const buf = await buildTestBundle({ css: 'theme.css' }, { 'theme.css': 'body {}', 'big.bin': bomb });
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/expanded content exceeds/);
  });

  test('rejects a bundle with more entries than the file cap', async () => {
    const files: Record<string, string> = { 'theme.css': 'body {}' };
    for (let i = 0; i < 80; i++) files[`filler/${i}.txt`] = 'x';
    const buf = await buildTestBundle({ css: 'theme.css' }, files);
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/files exceeds limit/);
  });

  test('a manifest declaring a path-traversal layer is still rejected by the schema', async () => {
    const buf = await buildTestBundle({ css: '../../etc/passwd' }, { 'theme.css': 'body {}' });
    await expect(parseEsthemeBundle(buf)).rejects.toThrow(/Invalid manifest/);
  });
});
