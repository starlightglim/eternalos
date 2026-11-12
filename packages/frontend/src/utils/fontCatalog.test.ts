import { expect, test, describe } from 'vitest';
import {
  FONT_CATALOG,
  resolveFontFamily,
  getFontsByCategory,
  isValidFontId,
} from './fontCatalog';

describe('resolveFontFamily', () => {
  test('resolves a known font id to its family stack', () => {
    expect(resolveFontFamily('chicago', 'geneva')).toBe(FONT_CATALOG.chicago.family);
  });

  test('falls back to the slot default for an unknown id', () => {
    expect(resolveFontFamily('does-not-exist', 'chicago')).toBe(FONT_CATALOG.chicago.family);
  });

  test('falls back to the default when no id is provided', () => {
    expect(resolveFontFamily(undefined, 'geneva')).toBe(FONT_CATALOG.geneva.family);
  });

  test('a hostile font id cannot inject raw text when the fallback is valid', () => {
    // The compiler always passes a valid catalog id as the fallback (a token's
    // defaultValue), so an attacker-controlled font id must resolve to that
    // known stack, never pass through verbatim into font-family.
    const hostile = "x'; } body { display: none } '";
    const out = resolveFontFamily(hostile, 'chicago');
    expect(out).toBe(FONT_CATALOG.chicago.family);
    expect(out).not.toContain('display: none');
  });

  test('both ids unknown → returns the raw id (documented last-resort)', () => {
    expect(resolveFontFamily('mystery', 'also-missing')).toBe('mystery');
  });
});

describe('isValidFontId', () => {
  test('true for catalog ids, false otherwise', () => {
    expect(isValidFontId('vt323')).toBe(true);
    expect(isValidFontId('nope')).toBe(false);
  });
});

describe('getFontsByCategory', () => {
  test('groups every catalog entry under its category and tags each with its id', () => {
    const grouped = getFontsByCategory();
    const total = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);
    expect(total).toBe(Object.keys(FONT_CATALOG).length);
    for (const [category, entries] of Object.entries(grouped)) {
      for (const entry of entries) {
        expect(entry.category).toBe(category);
        expect(FONT_CATALOG[entry.id]).toBeDefined();
      }
    }
  });
});

describe('FONT_CATALOG integrity', () => {
  const allowedCategories = new Set(['system', 'pixel', 'modern', 'mono']);
  test('every entry has a non-empty label + family and a valid category', () => {
    for (const [id, entry] of Object.entries(FONT_CATALOG)) {
      expect(entry.label, id).toBeTruthy();
      expect(entry.family, id).toBeTruthy();
      expect(allowedCategories.has(entry.category), `${id}: ${entry.category}`).toBe(true);
    }
  });

  test('every family stack ends in a generic fallback family', () => {
    // A font stack should always terminate in a generic so text stays visible
    // if every named font fails to load.
    const generics = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
    for (const [id, entry] of Object.entries(FONT_CATALOG)) {
      const last = entry.family.split(',').pop()!.trim().replace(/['"]/g, '');
      expect(generics.includes(last), `${id} stack ends in "${last}"`).toBe(true);
    }
  });
});
