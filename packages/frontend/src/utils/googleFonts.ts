/**
 * Google Fonts loader.
 *
 * global.css used to `@import` the Google Fonts stylesheet. A cross-origin
 * @import inside the main stylesheet blocks first paint on a round trip to
 * fonts.googleapis.com. Instead this injects a `<link rel="stylesheet">` from
 * JS, which does not block rendering. The stylesheet only declares
 * `@font-face` rules, so the browser downloads a family's font files only
 * when some text on the page actually uses it (the catalog's optional user
 * fonts, VT323 in the fallback stacks) — fonts load on demand.
 */

/** Google families (with weights) for every non-system font in FONT_CATALOG. */
export const GOOGLE_FONT_FAMILIES: readonly string[] = [
  'VT323',
  'Silkscreen:wght@400;700',
  'Press Start 2P',
  'DM Sans:wght@400;500;700',
  'Inter:wght@400;500;600',
  'Space Mono:wght@400;700',
  'IBM Plex Mono:wght@400;500',
  'Courier Prime:wght@400;700',
  'DM Mono:wght@400;500',
];

export function googleFontsHref(families: readonly string[] = GOOGLE_FONT_FAMILIES): string {
  const params = families.map((f) => `family=${f.replace(/ /g, '+')}`).join('&');
  return `https://fonts.googleapis.com/css2?${params}&display=swap`;
}

const LINK_ATTR = 'data-google-fonts';

/** Inject the Google Fonts stylesheet once. Safe to call repeatedly. */
export function loadGoogleFonts(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc?.head) return;
  if (doc.head.querySelector(`link[${LINK_ATTR}]`)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = googleFontsHref();
  link.setAttribute(LINK_ATTR, '');
  doc.head.appendChild(link);
}
