import { expect, test, describe } from 'vitest';
import { normalizeCSSSelectorAliases } from './cssSelectorAliases';

describe('normalizeCSSSelectorAliases', () => {
  test('rewrites each kebab alias to its hashed-module class name', () => {
    expect(normalizeCSSSelectorAliases('.title-bar { color: red; }')).toBe(
      '.titleBar { color: red; }'
    );
    expect(normalizeCSSSelectorAliases('.menu-bar, .window-content {}')).toBe(
      '.menuBar, .windowContent {}'
    );
  });

  test('rewrites an alias anywhere in a descendant selector', () => {
    expect(normalizeCSSSelectorAliases('.user-desktop .close-box:hover {}')).toBe(
      '.user-desktop .closeBox:hover {}'
    );
  });

  test('leaves unrelated classes untouched', () => {
    const css = '.title { color: red; } .window { border: 0; }';
    expect(normalizeCSSSelectorAliases(css)).toBe(css);
  });

  test('does not rewrite a class that merely contains an alias as a suffix', () => {
    // The leading-boundary guard means `.custom-title-bar` (no dot before the
    // alias) is not a `.title-bar` selector and must be left alone.
    const css = '.custom-title-bar { color: red; }';
    expect(normalizeCSSSelectorAliases(css)).toBe(css);
  });

  test('is idempotent (running twice changes nothing more)', () => {
    const once = normalizeCSSSelectorAliases('.title-bar .icon-label {}');
    expect(normalizeCSSSelectorAliases(once)).toBe(once);
  });
});
