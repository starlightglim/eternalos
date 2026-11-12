import { expect, test, describe } from 'vitest';
import { slugify } from './slugify';

/**
 * This slugify feeds `[eos-name="<slug>"]` / `[eos-folder="<slug>"]` attribute
 * selectors, so its output must never contain characters that could break out
 * of the attribute-selector context — only [a-z0-9-].
 */
describe('slugify', () => {
  test('lowercases and hyphenates spaces/punctuation', () => {
    expect(slugify('Sunset Pic')).toBe('sunset-pic');
    expect(slugify('My_Cool.File')).toBe('my-cool-file');
  });

  test('strips emoji and non-ASCII', () => {
    expect(slugify('café ☕ time')).toBe('caf-time');
    expect(slugify('日本語')).toBe('');
  });

  test('collapses repeated separators and trims hyphens', () => {
    expect(slugify('  --a   b!!c-- ')).toBe('a-b-c');
  });

  test('caps length at 50 characters', () => {
    expect(slugify('x'.repeat(200)).length).toBe(50);
  });

  test('output is always attribute-selector-safe ([a-z0-9-] only)', () => {
    for (const input of ['"]; evil { x }', "a'b\"c", '<script>', '../../etc', 'a)b(c']) {
      const out = slugify(input);
      expect(/^[a-z0-9-]*$/.test(out), `slugify(${JSON.stringify(input)}) = ${out}`).toBe(true);
    }
  });
});
