import { expect, test, describe } from 'vitest';
import {
  validateManifest,
  validateManifestAgainstFiles,
  buildEsthemeBundle,
  parseEsthemeBundle,
  type EsthemeManifest,
  type EsthemeBuildInput,
} from './estheme';

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
