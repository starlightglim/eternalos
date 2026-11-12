import { expect, test, describe } from 'vitest';
import {
  isAllowedCSSUrl,
  sanitizeCSSUrls,
  scopeCSSToUserDesktop,
  sanitizeCustomCSS,
  ALLOWED_CSS_URL_PREFIXES,
} from './cssSanitizer';

describe('isAllowedCSSUrl', () => {
  test('accepts every first-party asset prefix', () => {
    for (const prefix of ALLOWED_CSS_URL_PREFIXES) {
      expect(isAllowedCSSUrl(`${prefix}abc.png`)).toBe(true);
    }
  });

  test('rejects dangerous schemes regardless of case or quoting', () => {
    expect(isAllowedCSSUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedCSSUrl('JavaScript:alert(1)')).toBe(false);
    expect(isAllowedCSSUrl('"data:text/html,<script>"')).toBe(false);
    expect(isAllowedCSSUrl('VBScript:msgbox')).toBe(false);
    expect(isAllowedCSSUrl('file:///etc/passwd')).toBe(false);
  });

  test('rejects remote and protocol-relative URLs', () => {
    expect(isAllowedCSSUrl('https://evil.example/x.png')).toBe(false);
    expect(isAllowedCSSUrl('http://evil.example/x.png')).toBe(false);
    expect(isAllowedCSSUrl('//evil.example/x.png')).toBe(false);
  });

  test('rejects first-party-looking paths outside the allowlist', () => {
    expect(isAllowedCSSUrl('/api/profile')).toBe(false);
    expect(isAllowedCSSUrl('/etc/passwd')).toBe(false);
    expect(isAllowedCSSUrl('/apiXcss-assets/x')).toBe(false);
  });
});

describe('sanitizeCSSUrls', () => {
  test('keeps an allowed asset url, normalized to single quotes', () => {
    expect(sanitizeCSSUrls('background: url(/api/wallpaper/sky.png)')).toBe(
      "background: url('/api/wallpaper/sky.png')"
    );
    expect(sanitizeCSSUrls('background: url("/api/icon/a.png")')).toBe(
      "background: url('/api/icon/a.png')"
    );
  });

  test('replaces a disallowed url with about:blank', () => {
    expect(sanitizeCSSUrls('background: url(https://evil.example/x.png)')).toBe(
      'background: url(about:blank)'
    );
    // When the url value itself contains a ")" (e.g. `alert(1)`) the match ends
    // early, but the dangerous scheme is still neutralized to about:blank — the
    // only contract that matters. (Trailing `)` is invalid CSS the browser drops.)
    const jsOut = sanitizeCSSUrls("background: url('javascript:alert(1)')");
    expect(jsOut).toContain('url(about:blank)');
    expect(jsOut).not.toContain('javascript:');
  });

  test('strips newlines/tabs that try to smuggle a scheme past the check', () => {
    // A scheme broken across lines must not slip through as "allowed".
    const out = sanitizeCSSUrls('background: url("java\nscript:alert(1)")');
    expect(out).toContain('url(about:blank)');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('script:');
  });

  test('rewrites every url in a multi-url declaration', () => {
    const out = sanitizeCSSUrls(
      'a { background: url(/api/wallpaper/ok.png), url(https://evil.example/x.png); }'
    );
    expect(out).toContain("url('/api/wallpaper/ok.png')");
    expect(out).toContain('url(about:blank)');
    expect(out).not.toContain('evil.example');
  });
});

describe('scopeCSSToUserDesktop', () => {
  test('prefixes a plain selector with .user-desktop', () => {
    expect(scopeCSSToUserDesktop('.window { color: red; }')).toBe(
      '.user-desktop .window { color: red; }'
    );
  });

  test('collapses :root / body / html to the desktop root element', () => {
    expect(scopeCSSToUserDesktop(':root { --accent: blue; }')).toBe(
      '.user-desktop { --accent: blue; }'
    );
    expect(scopeCSSToUserDesktop('body { margin: 0; }')).toBe('.user-desktop { margin: 0; }');
    expect(scopeCSSToUserDesktop('html { font-size: 14px; }')).toBe(
      '.user-desktop { font-size: 14px; }'
    );
  });

  test('does not double-scope selectors already under .user-desktop', () => {
    expect(scopeCSSToUserDesktop('.user-desktop .title-bar { color: red; }')).toBe(
      '.user-desktop .title-bar { color: red; }'
    );
  });

  test('scopes each selector in a comma group independently', () => {
    expect(scopeCSSToUserDesktop('.a, .b { color: red; }')).toBe(
      '.user-desktop .a, .user-desktop .b { color: red; }'
    );
  });

  test('drops @font-face entirely (no remote font loading)', () => {
    const out = scopeCSSToUserDesktop(
      "@font-face { font-family: X; src: url(/api/css-assets/x.woff2); } .a { color: red; }"
    );
    expect(out).not.toContain('@font-face');
    expect(out).toContain('.user-desktop .a { color: red; }');
  });

  test('passes @keyframes through untouched', () => {
    const out = scopeCSSToUserDesktop('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }');
    expect(out).toContain('@keyframes spin');
    expect(out).not.toContain('.user-desktop @keyframes');
  });

  test('scopes the inner rules of a @media block', () => {
    const out = scopeCSSToUserDesktop('@media (max-width: 600px) { .a { color: red; } }');
    expect(out).toBe('@media (max-width: 600px) { .user-desktop .a { color: red; } }');
  });

  test('strips comments before scoping', () => {
    expect(scopeCSSToUserDesktop('/* hi */ .a { color: red; }')).toBe(
      '.user-desktop .a { color: red; }'
    );
  });

  test('ignores an unbalanced closing brace without throwing', () => {
    expect(() => scopeCSSToUserDesktop('} .a { color: red; }')).not.toThrow();
    expect(scopeCSSToUserDesktop('} .a { color: red; }')).toBe('.user-desktop .a { color: red; }');
  });
});

describe('sanitizeCustomCSS (full pipeline)', () => {
  test('returns empty string for blank input', () => {
    expect(sanitizeCustomCSS(undefined)).toBe('');
    expect(sanitizeCustomCSS('')).toBe('');
    expect(sanitizeCustomCSS('   \n\t ')).toBe('');
  });

  test('sanitizes urls AND scopes selectors in one pass', () => {
    const out = sanitizeCustomCSS('body { background: url(https://evil.example/x.png); }');
    expect(out).toContain('.user-desktop');
    expect(out).toContain('url(about:blank)');
    expect(out).not.toContain('evil.example');
  });

  test('a hostile theme cannot escape the desktop or load remote assets', () => {
    const hostile = [
      '@font-face { font-family: evil; src: url(https://evil.example/f.woff2); }',
      'html { background: url("javascript:alert(1)"); }',
      '.window { background-image: url(//evil.example/x.png); }',
    ].join('\n');
    const out = sanitizeCustomCSS(hostile);
    expect(out).not.toContain('@font-face');
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('javascript:');
    // Every surviving rule is scoped under the desktop root.
    for (const rule of out.split('\n').filter(Boolean)) {
      expect(rule.startsWith('.user-desktop')).toBe(true);
    }
  });

  test('a legitimate preset survives intact', () => {
    const out = sanitizeCustomCSS(
      '.user-desktop { background: url(/api/wallpaper/sky.png); } .title-bar { color: #fff; }'
    );
    expect(out).toContain("url('/api/wallpaper/sky.png')");
    // `.title-bar` is a kebab alias normalized to the hashed-module class name.
    expect(out).toContain('.user-desktop .titleBar { color: #fff; }');
  });
});
