import { describe, expect, test } from 'vitest';
import { buildRiceScheme, contrast, extractPalette, type RGB } from './wallpaperPalette';

/** RGBA pixels: `parts` of [color, share]. */
function image(parts: Array<[RGB, number]>, total = 4000): number[] {
  const data: number[] = [];
  for (const [rgb, share] of parts) {
    for (let i = 0; i < Math.round(total * share); i++) data.push(rgb[0], rgb[1], rgb[2], 255);
  }
  return data;
}

const hexRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;

describe('extractPalette', () => {
  test('finds the main colors, most common first, deterministically', () => {
    const data = image([[[20, 30, 80], 0.6], [[240, 120, 30], 0.25], [[230, 230, 230], 0.15]]);
    const palette = extractPalette(data, 6);
    expect(palette.slice(0, 3).map((c) => c.hex)).toEqual(['#141e50', '#f0781e', '#e6e6e6']);
    expect(palette[0].weight).toBeCloseTo(0.6, 1);
    expect(extractPalette(data, 6)).toEqual(palette);
  });

  test('ignores transparent pixels and copes with empty images', () => {
    expect(extractPalette([0, 0, 0, 0, 10, 10, 10, 0])).toEqual([]);
  });
});

describe('buildRiceScheme', () => {
  const night = extractPalette(image([[[12, 18, 40], 0.7], [[200, 60, 160], 0.2], [[60, 200, 220], 0.1]]));
  const beach = extractPalette(image([[[240, 225, 190], 0.6], [[60, 150, 210], 0.3], [[230, 120, 60], 0.1]]));

  test('a dark wallpaper makes a dark desktop, a bright one a light desktop', () => {
    expect(buildRiceScheme(night).mode).toBe('dark');
    expect(buildRiceScheme(beach).mode).toBe('light');
    expect(buildRiceScheme(beach, { mode: 'dark' }).mode).toBe('dark');
  });

  test('everything stays readable', () => {
    for (const palette of [night, beach]) {
      for (const mode of ['dark', 'light'] as const) {
        for (const flavor of ['soft', 'vivid'] as const) {
          const { appearance, swatches } = buildRiceScheme(palette, { mode, flavor });
          const bg = hexRgb(appearance.windowBgColor!);
          expect(contrast(hexRgb(swatches.text), bg)).toBeGreaterThanOrEqual(7);
          expect(contrast(hexRgb(appearance.titleBarTextColor!), hexRgb(appearance.titleBarBgColor!))).toBeGreaterThanOrEqual(4.5);
          expect(contrast(hexRgb(appearance.buttonTextColor!), hexRgb(appearance.buttonBgColor!))).toBeGreaterThanOrEqual(4.5);
          expect(contrast(hexRgb(appearance.accentColor!), bg)).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  test('the accent comes from the wallpaper\'s most colorful color', () => {
    const { appearance } = buildRiceScheme(night, { mode: 'dark' });
    const [r, g, b] = hexRgb(appearance.accentColor!);
    expect(r).toBeGreaterThan(g); // magenta-ish, not the navy background
    expect(b).toBeGreaterThan(g);
    expect(appearance.designTokens?.['menuBar.background']).toBe(appearance.titleBarBgColor);
  });
});
