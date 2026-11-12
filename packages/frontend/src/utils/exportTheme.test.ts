import { expect, test, describe } from 'vitest';
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
});
