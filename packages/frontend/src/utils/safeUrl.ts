/**
 * URL-safety helpers for rendering/opening user-supplied URLs.
 *
 * Item and widget URLs are shown to visitors (as hrefs, via window.open, or in
 * the website viewer's iframe). A `javascript:` (or other non-web) scheme there
 * is stored XSS — it runs in the viewer's / visitor's origin. The server now
 * rejects non-http(s) item URLs on write, but these guards are defense in depth
 * and also cover historical data and any field the server doesn't validate
 * (e.g. widget configs).
 */

/** True only for absolute http(s) URLs (narrows the value to a string). */
export function isHttpUrl(url: string | null | undefined): url is string {
  if (!url || typeof url !== 'string') return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** The URL if it is safe to use as an href, otherwise undefined. */
export function safeHref(url: string | null | undefined): string | undefined {
  return isHttpUrl(url) ? (url as string) : undefined;
}

/** Open a URL in a new tab only if it is a safe http(s) URL; no-op otherwise. */
export function openExternalUrl(url: string | null | undefined): void {
  if (isHttpUrl(url)) {
    window.open(url as string, '_blank', 'noopener,noreferrer');
  }
}
