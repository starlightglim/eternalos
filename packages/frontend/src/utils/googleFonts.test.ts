import { describe, expect, it } from 'vitest';
import { FONT_CATALOG } from './fontCatalog';
import { GOOGLE_FONT_FAMILIES, googleFontsHref, loadGoogleFonts } from './googleFonts';

function fakeDocument() {
  const children: Array<{ attrs: Record<string, string>; rel?: string; href?: string }> = [];
  const head = {
    querySelector: (sel: string) =>
      sel === 'link[data-google-fonts]' ? children.find((c) => 'data-google-fonts' in c.attrs) ?? null : null,
    appendChild: (el: (typeof children)[number]) => children.push(el),
  };
  const doc = {
    head,
    createElement: () => {
      const el = { attrs: {} as Record<string, string>, setAttribute: (k: string, v: string) => (el.attrs[k] = v) };
      return el;
    },
  };
  return { doc: doc as unknown as Document, children };
}

describe('googleFonts', () => {
  it('builds the same stylesheet URL the old @import used', () => {
    expect(googleFontsHref()).toBe(
      'https://fonts.googleapis.com/css2?family=VT323&family=Silkscreen:wght@400;700&family=Press+Start+2P' +
        '&family=DM+Sans:wght@400;500;700&family=Inter:wght@400;500;600&family=Space+Mono:wght@400;700' +
        '&family=IBM+Plex+Mono:wght@400;500&family=Courier+Prime:wght@400;700&family=DM+Mono:wght@400;500&display=swap',
    );
  });

  it('covers every non-system font in the catalog', () => {
    const names = GOOGLE_FONT_FAMILIES.map((f) => f.split(':')[0]);
    for (const entry of Object.values(FONT_CATALOG)) {
      if (entry.category === 'system') continue;
      expect(names).toContain(entry.label);
    }
  });

  it('injects one non-blocking stylesheet link, once', () => {
    const { doc, children } = fakeDocument();
    loadGoogleFonts(doc);
    loadGoogleFonts(doc);
    expect(children).toHaveLength(1);
    expect(children[0].rel).toBe('stylesheet');
    expect(children[0].href).toBe(googleFontsHref());
  });

  it('is a no-op without a document', () => {
    expect(() => loadGoogleFonts(undefined)).not.toThrow();
  });
});
