import { afterEach, describe, expect, test, vi } from 'vitest';
import { isHttpUrl, safeHref, openExternalUrl } from './safeUrl';

describe('isHttpUrl', () => {
  test('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('https://example.com/path?q=1#x')).toBe(true);
  });

  test('rejects dangerous and non-web schemes', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('mailto:a@b.com')).toBe(false);
  });

  test('rejects relative URLs, empty, and non-strings', () => {
    expect(isHttpUrl('/relative/path')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false); // no scheme → not an absolute URL
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});

describe('safeHref', () => {
  test('returns the URL for http(s), undefined otherwise', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});

describe('openExternalUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('opens only safe http(s) URLs in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });

    openExternalUrl('https://example.com');
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');

    open.mockClear();
    openExternalUrl('javascript:alert(document.cookie)');
    expect(open).not.toHaveBeenCalled();
  });
});
