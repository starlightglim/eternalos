/**
 * Custom-CSS sanitization and scoping.
 *
 * Users can ship arbitrary CSS (presets, the CSS editor, imported themes). That
 * CSS is a security surface: a hostile `url()` can exfiltrate or load remote
 * content, and an unscoped rule can repaint chrome the user did not mean to
 * touch. This module is the pure, deterministic transform that makes user CSS
 * safe to inject:
 *
 *   1. `url()` values are restricted to first-party `/api/...` asset prefixes;
 *      anything else (javascript:, data:, remote, protocol-relative) becomes
 *      `url(about:blank)`.
 *   2. `@font-face` is dropped; `@import` is neutralized.
 *   3. Every selector is scoped under `.user-desktop` so user CSS can only
 *      reach the desktop subtree (`:root`/`body`/`html` map to `.user-desktop`
 *      itself, which IS the desktop element).
 *
 * Extracted from `appearanceStore.applyCustomCSS` so the security behavior can
 * be unit-tested without a DOM. `applyCustomCSS` is now a thin wrapper that
 * calls `sanitizeCustomCSS` and injects the result into a `<style>` element.
 */

import { normalizeCSSSelectorAliases } from './cssSelectorAliases';

/** First-party asset routes a user `url()` is allowed to reference. */
export const ALLOWED_CSS_URL_PREFIXES = [
  '/api/css-assets/',
  '/api/wallpaper/',
  '/api/icon/',
  '/api/sounds/',
  '/api/cursors/',
  '/api/bazaar/assets/',
];

/**
 * True only for a same-origin, first-party asset path. Rejects dangerous
 * schemes explicitly, rejects anything with a scheme or protocol-relative
 * authority, and otherwise requires one of the allowed `/api/...` prefixes.
 */
export function isAllowedCSSUrl(urlValue: string): boolean {
  const normalized = urlValue.trim().replace(/^['"]|['"]$/g, '');
  const lowerUrl = normalized.toLowerCase();
  if (
    lowerUrl.startsWith('javascript:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('vbscript:') ||
    lowerUrl.startsWith('file:')
  ) {
    return false;
  }
  if (normalized.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return false;
  }
  return ALLOWED_CSS_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Rewrite every `url(...)` to a first-party asset URL, or to `url(about:blank)`
 * when it is not allowed. Newlines/tabs inside the URL are stripped first so
 * they cannot be used to smuggle a disallowed scheme past the check.
 */
export function sanitizeCSSUrls(css: string): string {
  return css.replace(
    /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi,
    (_match, _quote, urlValue) => {
      const cleanedUrl = urlValue.replace(/[\r\n\t]/g, '').trim();
      if (isAllowedCSSUrl(cleanedUrl)) {
        return `url('${cleanedUrl}')`;
      }
      return 'url(about:blank)';
    }
  );
}

/**
 * Split CSS into top-level `{ selector, body }` rules, tracking brace depth so
 * nested blocks (`@media`, `@supports`) are captured whole. Comments are
 * stripped first. Unbalanced closing braces are ignored rather than throwing.
 */
export function parseTopLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let current = '';
  let selectorEnd = -1;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) selectorEnd = current.length;
      depth++;
      current += ch;
    } else if (ch === '}') {
      if (depth <= 0) {
        depth = 0;
        current = '';
        selectorEnd = -1;
        continue;
      }
      depth--;
      current += ch;
      if (depth === 0) {
        const selector = current.slice(0, selectorEnd).trim();
        const body = current.slice(selectorEnd + 1, current.length - 1).trim();
        if (selector) rules.push({ selector, body });
        current = '';
        selectorEnd = -1;
      }
    } else {
      current += ch;
    }
  }
  return rules;
}

/**
 * Scope every top-level rule under `.user-desktop`. At-rules are handled
 * specially: keyframes pass through untouched, `@media`/`@supports` have their
 * inner rules scoped recursively, and `@font-face` is dropped entirely.
 * `:root`/`body`/`html` collapse to `.user-desktop` (the desktop root element);
 * every other selector is nested beneath it.
 */
export function scopeCSSToUserDesktop(css: string): string {
  if (!css.trim()) return '';
  const rules = parseTopLevelRules(css);
  const scopedRules: string[] = [];

  for (const { selector, body } of rules) {
    if (selector.startsWith('@keyframes') || selector.startsWith('@-webkit-keyframes')) {
      scopedRules.push(`${selector} { ${body} }`);
      continue;
    }
    if (selector.startsWith('@media') || selector.startsWith('@supports')) {
      scopedRules.push(`${selector} { ${scopeCSSToUserDesktop(body)} }`);
      continue;
    }
    if (selector.startsWith('@font-face')) continue;

    const scopedSelectors = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s.startsWith('.user-desktop')) return s;
        if (s === ':root' || s === 'body' || s === 'html') return '.user-desktop';
        return `.user-desktop ${s}`;
      })
      .join(', ');

    scopedRules.push(`${scopedSelectors} { ${body} }`);
  }

  return scopedRules.join('\n');
}

/**
 * The full, DOM-free sanitization pipeline applied to user CSS before it is
 * injected: normalize kebab-case selector aliases, restrict `url()` values to
 * first-party assets, then scope everything under `.user-desktop`. Returns the
 * safe CSS string (empty for empty/blank input).
 */
export function sanitizeCustomCSS(css: string | undefined): string {
  if (!css || !css.trim()) return '';
  const normalizedCSS = normalizeCSSSelectorAliases(css);
  const sanitizedCSS = sanitizeCSSUrls(normalizedCSS);
  return scopeCSSToUserDesktop(sanitizedCSS);
}
