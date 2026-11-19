import { expect, test, describe, beforeAll, vi, beforeEach, afterEach } from 'vitest';
import { resolveTokensFromAppearance, compileTokensToCSS, isFirstPartyAssetUrl } from './tokenCompiler';
import { getContrastingTextColor, getSecondaryTextColor } from '../utils/colorUtils';
import { registerBuiltinVariants } from '../variants/registerBuiltins';

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

  test('cursor hotspots parsed from the url|x|y format CursorEditor stores', () => {
    // CursorEditor/CursorCreator persist 'url|hotspotX|hotspotY' into the
    // designTokens blob; the compiler must split it back out into the CSS
    // hotspot position with the named fallback retained.
    const { rules } = compileTokensToCSS({
      'cursor.image.default': '/api/cursors/arrow.png|3|2',
    });
    const joined = rules.join('\n');
    expect(joined).toMatch(/cursor:\s*url\('[^']*\/api\/cursors\/arrow\.png'\) 3 2, default !important/);
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

describe('isFirstPartyAssetUrl — origin-aware allowlist', () => {
  const ORIGIN = 'https://api.test';

  test('accepts relative first-party asset paths', () => {
    expect(isFirstPartyAssetUrl('/api/cursors/arrow.png', ORIGIN)).toBe(true);
    expect(isFirstPartyAssetUrl('/api/bazaar/assets/pack1/sky.png', ORIGIN)).toBe(true);
  });

  test('accepts absolute URLs on the API origin (CursorEditor stores those)', () => {
    expect(isFirstPartyAssetUrl('https://api.test/api/cursors/arrow.png', ORIGIN)).toBe(true);
    expect(isFirstPartyAssetUrl('https://api.test:443/api/cursors/arrow.png', ORIGIN)).toBe(true);
  });

  test('rejects cross-origin URLs even with allowlisted-looking paths', () => {
    // The old check compared only the parsed pathname, so this passed.
    expect(isFirstPartyAssetUrl('https://evil.example/api/cursors/beacon.png', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('https://api.test.evil.example/api/cursors/beacon.png', ORIGIN)).toBe(false);
  });

  test('rejects protocol-relative and backslash variants', () => {
    expect(isFirstPartyAssetUrl('//evil.example/api/cursors/beacon.png', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('/\\api/cursors/beacon.png', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('https:\\\\evil.example\\api\\cursors\\beacon.png', ORIGIN)).toBe(false);
  });

  test('rejects userinfo URLs', () => {
    // https://api@evil has origin https://evil — not the API origin.
    expect(isFirstPartyAssetUrl('https://api.test@evil.example/api/cursors/beacon.png', ORIGIN)).toBe(false);
    // Credentials in front of the real API host are never legitimate either.
    expect(isFirstPartyAssetUrl('https://user@api.test/api/cursors/beacon.png', ORIGIN)).toBe(false);
  });

  test('rejects raw and percent-encoded traversal', () => {
    expect(isFirstPartyAssetUrl('/api/cursors/../../secret.png', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('/api/cursors/%2e%2e/%2e%2e/secret.png', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('https://api.test/api/cursors/%2e%2e/%2e%2e/secret.png', ORIGIN)).toBe(false);
    // Encoded slashes must not decode into a protocol-relative authority.
    expect(isFirstPartyAssetUrl('%2F%2Fevil.example/api/cursors/beacon.png', ORIGIN)).toBe(false);
  });

  test('rejects data:, javascript:, and other non-http(s) schemes', () => {
    expect(isFirstPartyAssetUrl('data:image/png;base64,AAAA', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('javascript:alert(1)', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('file:///etc/passwd', ORIGIN)).toBe(false);
  });

  test('rejects first-party routes outside the asset allowlist', () => {
    expect(isFirstPartyAssetUrl('/api/files/x/y.png', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('https://api.test/api/files/x/y.png', ORIGIN)).toBe(false);
  });

  test('fails closed without a known API origin (relative paths only)', () => {
    expect(isFirstPartyAssetUrl('https://api.test/api/cursors/arrow.png', null)).toBe(false);
    expect(isFirstPartyAssetUrl('/api/cursors/arrow.png', null)).toBe(true);
  });

  test('rejects empty and whitespace-only values', () => {
    expect(isFirstPartyAssetUrl('', ORIGIN)).toBe(false);
    expect(isFirstPartyAssetUrl('   ', ORIGIN)).toBe(false);
  });
});

describe('compileTokensToCSS — cursor URL origin allowlist (VITE_API_URL)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'https://api.test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Fresh import so the module picks up the stubbed VITE_API_URL (read at
  // module top level). Same pattern as services/api.test.ts.
  async function loadCompiler() {
    vi.resetModules();
    return await import('./tokenCompiler');
  }

  test('an absolute cursor URL on the configured API origin compiles (CursorEditor format)', async () => {
    const { compileTokensToCSS } = await loadCompiler();
    const { rules } = compileTokensToCSS({
      'cursor.image.default': 'https://api.test/api/cursors/arrow.png|4|2',
    });
    expect(rules.join('\n')).toMatch(
      /cursor:\s*url\('https:\/\/api\.test\/api\/cursors\/arrow\.png'\) 4 2/
    );
  });

  test('a cross-origin cursor URL with an allowlisted-looking path is rejected', async () => {
    // Regression: the old pathname-only check compiled this into a cursor
    // rule, so every visitor's browser fetched the attacker's URL.
    const { compileTokensToCSS } = await loadCompiler();
    const { rules } = compileTokensToCSS({
      'cursor.image.default': 'https://evil.example/api/cursors/beacon.png|0|0',
    });
    expect(rules.join('\n')).not.toContain('evil.example');
  });

  test('protocol-relative, backslash, userinfo, encoded, and data: cursor URLs are rejected', async () => {
    const { compileTokensToCSS } = await loadCompiler();
    const hostile = [
      '//evil.example/api/cursors/beacon.png',
      'https:\\evil.example\\api\\cursors\\beacon.png',
      'https://api.test@evil.example/api/cursors/beacon.png',
      'https://user@api.test/api/cursors/beacon.png',
      '/api/cursors/%2e%2e/%2e%2e/beacon.png',
      'data:image/png;base64,AAAA',
    ];
    for (const value of hostile) {
      const { rules } = compileTokensToCSS({ 'cursor.image.default': value });
      expect(rules.join('\n'), `expected rejection for ${value}`).not.toContain('cursor: url(');
    }
  });

  test('without VITE_API_URL, absolute URLs are rejected and relative paths still compile', async () => {
    // Unstubbed module: no configured origin → fail closed for absolute URLs.
    vi.unstubAllEnvs();
    const { compileTokensToCSS } = await loadCompiler();
    const bad = compileTokensToCSS({ 'cursor.image.default': 'https://api.test/api/cursors/arrow.png' });
    expect(bad.rules.join('\n')).not.toContain('cursor: url(');
    const good = compileTokensToCSS({ 'cursor.image.default': '/api/cursors/arrow.png' });
    expect(good.rules.join('\n')).toMatch(/cursor:\s*url\('/);
  });
});

describe('compileTokensToCSS — conditional (variant-scoped) tokens', () => {
  // Sprite/texture/gradient tokens are registered by variants (the skin
  // system), not by TOKEN_REGISTRY. They used to be invisible to the compiler
  // entirely — even with the token present in designTokens and the variant
  // active, no CSS var was ever emitted. They must now compile exactly like
  // registry tokens, but ONLY while their variant is active.
  beforeAll(() => {
    registerBuiltinVariants();
  });

  test('sprite frame tokens compile when the sprite chrome variant is active', () => {
    const compiled = compileTokensToCSS(
      {
        'chrome.sprite.url': '/api/css-assets/u1/a1/frame.png',
        'chrome.sprite.sliceTop': 12,
      },
      { 'window.chrome': 'sprite' }
    );
    // The URL is wrapped in url() for CSS consumption...
    expect(compiled.cssVars.get('--eos-chrome-sprite-url')).toBe("url('/api/css-assets/u1/a1/frame.png')");
    // ...and the 9-slice is assembled from the four edges (unset → default 20).
    expect(compiled.cssVars.get('--eos-chrome-sprite-slice')).toBe('12 20 20 20');
    expect(compiled.cssVars.get('--eos-chrome-sprite-border-width')).toBe('12px 20px 20px 20px');
  });

  test('sprite button images and dimensions compile under the sprite buttons variant', () => {
    const compiled = compileTokensToCSS(
      {
        'buttons.sprite.close': '/api/css-assets/u1/a1/close.png',
        'buttons.sprite.width': 18,
      },
      { 'window.buttons': 'sprite' }
    );
    expect(compiled.cssVars.get('--eos-sprite-btn-close')).toBe("url('/api/css-assets/u1/a1/close.png')");
    expect(compiled.cssVars.get('--eos-sprite-button-width')).toBe('18px');
  });

  test('sprite title bar texture and resize handle compile under their variants', () => {
    const titleBar = compileTokensToCSS(
      { 'titlebar.sprite.url': '/api/css-assets/u1/a1/tb.png', 'titlebar.sprite.textColor': '#FFFFFF' },
      { 'window.titleBar': 'sprite' }
    );
    expect(titleBar.cssVars.get('--eos-titlebar-sprite-url')).toBe("url('/api/css-assets/u1/a1/tb.png')");
    expect(titleBar.cssVars.get('--eos-titlebar-sprite-text-color')).toBe('#FFFFFF');

    const resize = compileTokensToCSS(
      { 'resize.sprite.url': '/api/css-assets/u1/a1/grip.png' },
      { 'window.resizeHandle': 'sprite' }
    );
    expect(resize.cssVars.get('--eos-sprite-resize-url')).toBe("url('/api/css-assets/u1/a1/grip.png')");
  });

  test('gradient title bar tokens compile under the gradient variant', () => {
    const compiled = compileTokensToCSS(
      { 'window.titleBar.gradientStart': '#4080C0', 'window.titleBar.gradientEnd': '#1A3050' },
      { 'window.titleBar': 'gradient' }
    );
    expect(compiled.cssVars.get('--eos-titlebar-gradient-start')).toBe('#4080C0');
    expect(compiled.cssVars.get('--eos-titlebar-gradient-end')).toBe('#1A3050');
  });

  test('conditional tokens are skipped when a different variant is active', () => {
    const compiled = compileTokensToCSS(
      { 'chrome.sprite.url': '/api/css-assets/u1/a1/frame.png', 'window.titleBar.gradientStart': '#4080C0' },
      { 'window.chrome': 'beveled', 'window.titleBar': 'classic' }
    );
    expect(compiled.cssVars.has('--eos-chrome-sprite-url')).toBe(false);
    expect(compiled.cssVars.has('--eos-titlebar-gradient-start')).toBe(false);
  });

  test('conditional tokens never compile when variants are unspecified', () => {
    // No variants selected → sprite/gradient designTokens must not leak into
    // the DOM; they only come alive with their variant.
    const compiled = compileTokensToCSS({ 'chrome.sprite.url': '/api/css-assets/u1/a1/frame.png' });
    expect(compiled.cssVars.has('--eos-chrome-sprite-url')).toBe(false);
    const withEmptyMap = compileTokensToCSS({ 'chrome.sprite.url': '/api/css-assets/u1/a1/frame.png' }, {});
    expect(withEmptyMap.cssVars.has('--eos-chrome-sprite-url')).toBe(false);
  });

  test('conditional tokens reach the compiler through resolveTokensFromAppearance', () => {
    // Full pipeline: appearance (as persisted on the profile) → tokens → CSS.
    const compiled = compileTokensToCSS(
      resolveTokensFromAppearance({
        designTokens: { 'chrome.sprite.url': '/api/css-assets/u1/a1/frame.png' },
        variants: { 'window.chrome': 'sprite' },
      }),
      { 'window.chrome': 'sprite' }
    );
    expect(compiled.cssVars.get('--eos-chrome-sprite-url')).toBe("url('/api/css-assets/u1/a1/frame.png')");
  });
});
