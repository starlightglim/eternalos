import { expect, test, describe } from 'vitest';
import { resolveTokensFromAppearance, compileTokensToCSS } from './tokenCompiler';
import { getContrastingTextColor, getSecondaryTextColor } from '../utils/colorUtils';

/**
 * Token compiler — the heart of the customization pipeline. These exercise the
 * pure appearance → tokens → CSS transform directly (no DOM). The compiler's
 * correctness is what the whole "customization round-trip" rests on.
 */

describe('resolveTokensFromAppearance', () => {
  test('maps a legacy profile field to its token path', () => {
    const tokens = resolveTokensFromAppearance({ accentColor: '#FF0000' });
    expect(tokens['color.accent']).toBe('#FF0000');
  });

  test('merges the designTokens blob by token path', () => {
    const tokens = resolveTokensFromAppearance({
      accentColor: '#FF0000',
      designTokens: { 'window.titleBar.background': '#123456' },
    });
    expect(tokens['color.accent']).toBe('#FF0000');
    expect(tokens['window.titleBar.background']).toBe('#123456');
  });

  test('ignores undefined fields and non-appearance keys', () => {
    const tokens = resolveTokensFromAppearance({ accentColor: undefined, username: 'bob' });
    expect('color.accent' in tokens).toBe(false);
    expect(Object.values(tokens)).not.toContain('bob');
  });
});

describe('compileTokensToCSS — CSS variables', () => {
  test('a color token sets all of its CSS vars', () => {
    const { cssVars } = compileTokensToCSS({ 'color.accent': '#FF0000' });
    expect(cssVars.get('--selection')).toBe('#FF0000');
    expect(cssVars.get('--accent')).toBe('#FF0000');
  });

  test('derived text colors are computed from a hex background', () => {
    const { cssVars } = compileTokensToCSS({ 'color.windowBg': '#000000' });
    expect(cssVars.get('--window-bg')).toBe('#000000');
    expect(cssVars.get('--window-text-color')).toBe(getContrastingTextColor('#000000')); // #FFFFFF
    expect(cssVars.get('--window-text-secondary')).toBe(getSecondaryTextColor('#000000'));
  });

  test('a light background derives dark text', () => {
    const { cssVars } = compileTokensToCSS({ 'color.windowBg': '#FFFFFF' });
    expect(cssVars.get('--window-text-color')).toBe('#000000');
  });

  test('derived transforms are SKIPPED for non-hex values (gradients/rgba)', () => {
    // The raw var is still set, but the derived text var must not be computed
    // from a value the luminance math can't read — it would otherwise emit a
    // bogus text color.
    const { cssVars } = compileTokensToCSS({ 'color.accent': 'linear-gradient(#fff, #000)' });
    expect(cssVars.get('--accent')).toBe('linear-gradient(#fff, #000)');
    expect(cssVars.has('--selection-text')).toBe(false);
  });
});

describe('compileTokensToCSS — body styles (font smoothing)', () => {
  test('enabled → antialiased', () => {
    const { bodyStyles } = compileTokensToCSS({ 'typography.fontSmoothing': true });
    expect(bodyStyles.get('-webkit-font-smoothing')).toBe('antialiased');
    expect(bodyStyles.get('-moz-osx-font-smoothing')).toBe('grayscale');
  });

  test('disabled → none (pixel-crisp retro fonts)', () => {
    const { bodyStyles } = compileTokensToCSS({ 'typography.fontSmoothing': false });
    expect(bodyStyles.get('-webkit-font-smoothing')).toBe('none');
  });
});

describe('compileTokensToCSS — window opacity', () => {
  test('opacity < 100 makes the window translucent', () => {
    const { rules } = compileTokensToCSS({ 'window.opacity': 90 });
    const joined = rules.join('\n');
    expect(joined).toContain('.windowInner { opacity: 0.9; }');
    expect(joined).toContain('background: transparent;');
  });

  test('opacity 100 emits no translucency rules', () => {
    const { rules } = compileTokensToCSS({ 'window.opacity': 100 });
    expect(rules.join('\n')).not.toContain('opacity:');
  });

  test('very low opacity is clamped to a floor of 0.3', () => {
    const { rules } = compileTokensToCSS({ 'window.opacity': 5 });
    expect(rules.join('\n')).toContain('opacity: 0.3;');
  });
});

describe('compileTokensToCSS — title bar', () => {
  test('emits scoped title-bar background + text rules', () => {
    const { rules } = compileTokensToCSS({
      'window.titleBar.background': '#222222',
      'window.titleBar.textColor': '#ffffff',
    });
    const joined = rules.join('\n');
    expect(joined).toContain('.user-desktop [eos-part="titlebar"]');
    expect(joined).toContain('background: #222222;');
    expect(joined).toContain('.user-desktop [eos-part="title"] { color: #ffffff; }');
  });
});

describe('compileTokensToCSS — custom cursor image (security)', () => {
  test('a first-party cursor asset emits a cursor rule', () => {
    const { rules } = compileTokensToCSS({ 'cursor.image.default': '/api/cursors/arrow.png' });
    const joined = rules.join('\n');
    expect(joined).toMatch(/cursor:\s*url\('[^']*\/api\/cursors\/arrow\.png'\)/);
  });

  test('a cross-origin cursor URL is rejected (no tracking-pixel fetch)', () => {
    const { rules } = compileTokensToCSS({
      'cursor.image.default': 'https://evil.example/pixel.png',
    });
    expect(rules.join('\n')).not.toContain('evil.example');
  });

  test('a path-traversal cursor URL is rejected', () => {
    const { rules } = compileTokensToCSS({
      'cursor.image.default': '/api/cursors/../../secret.png',
    });
    expect(rules.join('\n')).not.toContain('cursor: url(');
  });

  test('a cursor URL with quote/paren breakout chars is rejected', () => {
    const { rules } = compileTokensToCSS({
      'cursor.image.default': "/api/cursors/x.png'); body{display:none}",
    });
    expect(rules.join('\n')).not.toContain('display:none');
  });
});
