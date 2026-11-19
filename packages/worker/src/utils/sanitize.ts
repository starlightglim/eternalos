/**
 * Input Sanitization Utilities
 *
 * Provides sanitization functions for user input to prevent
 * XSS, injection attacks, and other security issues.
 */

/**
 * Sanitize a string for safe display (removes/escapes HTML)
 * Use for: display names, folder names, item names, text content
 */
export function sanitizeText(input: string, maxLength = 1000): string {
  if (!input || typeof input !== 'string') return '';

  // Trim and truncate
  let sanitized = input.trim().slice(0, maxLength);

  // Remove null bytes and other control characters (except newlines and tabs)
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Escape HTML entities to prevent XSS
  sanitized = sanitized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

  return sanitized;
}

/**
 * Sanitize a filename for safe storage and display
 * Use for: uploaded file names, folder names
 */
export function sanitizeFilename(filename: string, maxLength = 255): string {
  if (!filename || typeof filename !== 'string') return 'unnamed';

  // Get the extension first
  const lastDot = filename.lastIndexOf('.');
  const hasExtension = lastDot > 0 && lastDot < filename.length - 1;
  const extension = hasExtension ? filename.slice(lastDot) : '';
  const basename = hasExtension ? filename.slice(0, lastDot) : filename;

  // Remove path traversal attempts
  let sanitized = basename
    .replace(/\.\./g, '')
    .replace(/\//g, '')
    .replace(/\\/g, '');

  // Remove null bytes and control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Replace problematic characters with underscores
  sanitized = sanitized.replace(/[<>:"|?*]/g, '_');

  // Trim whitespace and dots from the start/end
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');

  // Ensure we have a valid filename
  if (!sanitized) {
    sanitized = 'unnamed';
  }

  // Truncate if needed (accounting for extension)
  const maxBasenameLength = maxLength - extension.length;
  if (sanitized.length > maxBasenameLength) {
    sanitized = sanitized.slice(0, maxBasenameLength);
  }

  return sanitized + extension;
}

/**
 * Sanitize a username for storage and URL safety
 * Use for: usernames during registration
 */
export function sanitizeUsername(username: string): string {
  if (!username || typeof username !== 'string') return '';

  // Lowercase and trim
  let sanitized = username.toLowerCase().trim();

  // Remove everything except alphanumeric, underscores, and hyphens
  sanitized = sanitized.replace(/[^a-z0-9_-]/g, '');

  // Ensure it doesn't start with a hyphen or underscore
  sanitized = sanitized.replace(/^[-_]+/, '');

  // Truncate to reasonable length
  sanitized = sanitized.slice(0, 30);

  return sanitized;
}

/**
 * Sanitize an email address
 * Use for: email during registration/login
 */
export function sanitizeEmail(email: string): string {
  if (!email || typeof email !== 'string') return '';

  // Lowercase and trim
  let sanitized = email.toLowerCase().trim();

  // Remove any characters that shouldn't be in an email
  // This is a basic sanitization - validation should be done separately
  sanitized = sanitized.replace(/[\x00-\x1F\x7F<>]/g, '');

  // Truncate to reasonable length
  sanitized = sanitized.slice(0, 254);

  return sanitized;
}

/**
 * Sanitize a display name
 * Use for: user display names
 */
export function sanitizeDisplayName(name: string): string {
  if (!name || typeof name !== 'string') return '';

  // Trim and remove excessive whitespace
  let sanitized = name.trim().replace(/\s+/g, ' ');

  // Remove control characters
  sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, '');

  // Remove HTML-like tags (but keep the content)
  sanitized = sanitized.replace(/<[^>]*>/g, '');

  // Truncate to reasonable length
  sanitized = sanitized.slice(0, 50);

  return sanitized;
}

/**
 * First-party asset routes that appearance URL values (customCSS `url()`,
 * designTokens cursor images, bazaar pack configs) are allowed to reference.
 * Must stay in sync with the frontend `TOKEN_ASSET_PATH_PREFIXES` in
 * `packages/frontend/src/tokens/tokenCompiler.ts`.
 */
export const FIRST_PARTY_ASSET_PREFIXES: readonly string[] = [
  '/api/css-assets/',
  '/api/wallpaper/',
  '/api/icon/',
  '/api/sounds/',
  '/api/cursors/',
  '/api/bazaar/assets/',
];

/** Normalize an origin-ish string to a canonical `URL.origin`, or null. */
function normalizeOrigin(origin?: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

/**
 * SECURITY: validate a URL stored in appearance fields against the
 * first-party asset allowlist.
 *
 * Accepts ONLY:
 *   - relative site-absolute paths ("/api/cursors/x.png"), and
 *   - absolute http(s) URLs whose origin equals the API's own origin
 *     (CursorEditor legitimately stores those).
 *
 * Rejects everything else: cross-origin hosts — even with an allowlisted-
 * looking path ("https://evil.example/api/cursors/beacon.png"), protocol-
 * relative URLs ("//evil.example/…"), backslash tricks, userinfo
 * ("https://api@evil.example"), percent-encoded variants, path traversal,
 * and non-http(s) schemes (data:, javascript:).
 *
 * The old check compared only `new URL(x, base).pathname` against the
 * allowlist, which let any cross-origin URL with an allowlisted path pass —
 * so a stored `cursor.image.*` would be fetched by every visitor's browser
 * (tracking pixel / stored beacon). Origin equality is now authoritative.
 *
 * `apiOrigin` is the API's own origin ("scheme://host"), taken from the
 * incoming request by the routes that proxy one. When it is absent or
 * unparseable (internal callers with no request), absolute URLs are
 * rejected outright — only relative `/api/...` paths are accepted.
 */
export function isFirstPartyAssetUrl(rawUrl: string, apiOrigin?: string | null): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const raw = rawUrl.trim();
  if (!raw) return false;

  // Backslashes and control characters are never legitimate in a stored
  // asset URL. Browsers treat "\" as "/" inside special URLs
  // (https:\evil.example parses as the host evil.example) and strip
  // TAB/LF/CR before parsing, so both can smuggle a different URL past
  // string checks — reject instead of trying to out-parse them. \p{Cc}
  // covers C0 controls (U+0000–U+001F) and DEL/C1 (U+007F–U+009F).
  if (raw.includes('\\') || /\p{Cc}/u.test(raw)) return false;

  // Protocol-relative URLs resolve against the page's scheme with a
  // cross-origin authority; they are never first-party.
  if (raw.startsWith('//')) return false;

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);

  if (hasScheme) {
    // Absolute URL: scheme, origin, and path must all check out.
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    // data:, javascript:, vbscript:, file:, and every other non-http(s)
    // scheme is rejected here.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // No userinfo: "https://api@evil.example" has origin https://evil.example
    // (caught by the origin check), but "https://user@api.example/…" would
    // pass it — and no stored asset URL ever needs credentials.
    if (parsed.username !== '' || parsed.password !== '') return false;
    // The URL must point at the API's own origin; without a known origin,
    // absolute URLs are rejected (fail closed).
    const expectedOrigin = normalizeOrigin(apiOrigin);
    if (!expectedOrigin || parsed.origin !== expectedOrigin) return false;
    // Still an allowlisted first-party route…
    if (!FIRST_PARTY_ASSET_PREFIXES.some((prefix) => parsed.pathname.startsWith(prefix))) {
      return false;
    }
    // …and the decoded path must not smuggle traversal.
    return !decodeLoosely(parsed.pathname).includes('..');
  }

  // Relative reference: must be a site-absolute path (leading "/") onto an
  // allowlisted route. Checked on the RAW value so percent-decoding cannot
  // change the shape afterwards ("%2F%2Fevil.example/…" stays a path).
  if (!FIRST_PARTY_ASSET_PREFIXES.some((prefix) => raw.startsWith(prefix))) return false;

  // Decode (falling back to the raw value when it isn't valid percent-
  // encoding, e.g. a literal "%" in a filename) and re-verify the normalized
  // form: no traversal, and the parsed path stays on an allowlisted route.
  const decoded = decodeLoosely(raw);
  if (decoded.includes('..')) return false;
  let normalized: URL;
  try {
    normalized = new URL(decoded, 'http://internal.invalid');
  } catch {
    return false;
  }
  if (normalized.host !== 'internal.invalid') return false;
  return FIRST_PARTY_ASSET_PREFIXES.some((prefix) => normalized.pathname.startsWith(prefix));
}

/** decodeURIComponent that keeps the input on malformed percent-encoding. */
function decodeLoosely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Validate and sanitize a URL
 * Use for: link items, external URLs
 */
export function sanitizeUrl(url: string): string | null {
  if (!url || typeof url !== 'string') return null;

  // Trim
  const trimmed = url.trim();

  // Check for allowed protocols
  const allowedProtocols = ['http:', 'https:'];

  try {
    const parsed = new URL(trimmed);
    if (!allowedProtocols.includes(parsed.protocol)) {
      return null;
    }
    // Return the normalized URL
    return parsed.href;
  } catch {
    // If it doesn't have a protocol, try adding https://
    if (!trimmed.includes('://')) {
      try {
        const withProtocol = new URL('https://' + trimmed);
        return withProtocol.href;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Sanitize text content for file storage
 * Preserves newlines and tabs but removes dangerous content
 * Use for: text file content
 */
export function sanitizeTextContent(content: string, maxLength = 100000): string {
  if (!content || typeof content !== 'string') return '';

  // Truncate
  let sanitized = content.slice(0, maxLength);

  // Remove null bytes
  sanitized = sanitized.replace(/\x00/g, '');

  return sanitized;
}

/**
 * Sanitize JSON input - parse and validate structure
 * Returns null if invalid
 */
export function sanitizeJsonInput<T>(
  input: string,
  validator: (parsed: unknown) => parsed is T
): T | null {
  try {
    const parsed = JSON.parse(input);
    if (validator(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
