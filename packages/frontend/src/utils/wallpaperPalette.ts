/**
 * "pywal mode": pull a palette out of the wallpaper and turn it into a whole
 * desktop look (windows, title bars, controls, menu bar, scrollbars, icon
 * labels). Apps follow automatically through the --eternal-* theme
 * variables. Pure functions; the Appearance panel does the image loading.
 *
 * Every text/background pair is pushed until it meets WCAG contrast, so a
 * loud wallpaper never produces an unreadable desktop.
 */

import type { CustomAppearance } from '../stores/appearanceStore';

export type RGB = [number, number, number];

export interface PaletteColor {
  rgb: RGB;
  hex: string;
  /** Share of the image (0..1). */
  weight: number;
}

export type RiceMode = 'auto' | 'dark' | 'light';
export type RiceFlavor = 'soft' | 'vivid';

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

export function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

export function luminance([r, g, b]: RGB): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  if (sat === 0) return [lig * 255, lig * 255, lig * 255];
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const conv = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [conv(hue + 1 / 3) * 255, conv(hue) * 255, conv(hue - 1 / 3) * 255];
}

/** Move a color's lightness toward light or dark until it contrasts with `against`. */
export function ensureContrast(color: RGB, against: RGB, minRatio: number): RGB {
  const [h, s, l] = rgbToHsl(color);
  const goLighter = luminance(against) < 0.4;
  let lig = l;
  for (let i = 0; i < 60 && contrast(hslToRgb(h, s, lig), against) < minRatio; i++) {
    lig += goLighter ? 0.02 : -0.02;
    if (lig <= 0 || lig >= 1) break;
  }
  const out = hslToRgb(h, s, Math.max(0, Math.min(1, lig)));
  return contrast(out, against) >= minRatio ? out : goLighter ? [255, 255, 255] : [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Palette extraction (k-means on a pixel sample)
// ---------------------------------------------------------------------------

const dist2 = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * The main colors of an image, most common first. `data` is RGBA (as from
 * getImageData); fully transparent pixels are ignored. Deterministic.
 */
export function extractPalette(data: Uint8ClampedArray | number[], k = 8): PaletteColor[] {
  const pixels: RGB[] = [];
  const count = Math.floor(data.length / 4);
  const stride = Math.max(1, Math.floor(count / 6000));
  for (let i = 0; i < count; i += stride) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    pixels.push([data[o], data[o + 1], data[o + 2]]);
  }
  if (pixels.length === 0) return [];

  // Farthest-point seeding: start from the mean, then repeatedly add the
  // pixel farthest from every chosen center (deterministic k-means++).
  const mean: RGB = [0, 1, 2].map((c) => pixels.reduce((sum, p) => sum + p[c], 0) / pixels.length) as RGB;
  const centers: RGB[] = [mean];
  while (centers.length < Math.min(k, pixels.length)) {
    let best = pixels[0];
    let bestDist = -1;
    for (const p of pixels) {
      const d = Math.min(...centers.map((c) => dist2(p, c)));
      if (d > bestDist) { bestDist = d; best = p; }
    }
    if (bestDist <= 0) break;
    centers.push([...best] as RGB);
  }

  const assign = new Array<number>(pixels.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let changed = false;
    pixels.forEach((p, i) => {
      let bestIndex = 0;
      let bestDist = Infinity;
      centers.forEach((c, j) => {
        const d = dist2(p, c);
        if (d < bestDist) { bestDist = d; bestIndex = j; }
      });
      if (assign[i] !== bestIndex) { assign[i] = bestIndex; changed = true; }
    });
    const sums = centers.map(() => [0, 0, 0, 0]);
    pixels.forEach((p, i) => {
      const s = sums[assign[i]];
      s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3] += 1;
    });
    sums.forEach((s, j) => { if (s[3]) centers[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!changed && iter > 0) break;
  }

  const weights = centers.map(() => 0);
  assign.forEach((j) => { weights[j] += 1; });
  const colors = centers
    .map((rgb, j) => ({ rgb: rgb.map(Math.round) as RGB, weight: weights[j] / pixels.length }))
    .filter((color) => color.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  // Merge near-duplicates.
  const merged: Array<{ rgb: RGB; weight: number }> = [];
  for (const color of colors) {
    const twin = merged.find((m) => dist2(m.rgb, color.rgb) < 18 * 18);
    if (twin) twin.weight += color.weight;
    else merged.push({ ...color });
  }
  return merged.map((color) => ({ ...color, hex: toHex(color.rgb) }));
}

// ---------------------------------------------------------------------------
// Palette → desktop look
// ---------------------------------------------------------------------------

export interface RiceScheme {
  mode: 'dark' | 'light';
  appearance: CustomAppearance;
  /** Named colors for previews. */
  swatches: Record<'background' | 'surface' | 'chrome' | 'text' | 'accent' | 'accent2' | 'border', string>;
}

/** Turn a wallpaper palette into a complete, readable desktop look. */
export function buildRiceScheme(palette: PaletteColor[], options: { mode?: RiceMode; flavor?: RiceFlavor } = {}): RiceScheme {
  const colors = palette.length ? palette : [{ rgb: [96, 96, 112] as RGB, hex: '#606070', weight: 1 }];
  const average: RGB = [0, 1, 2].map((c) => colors.reduce((sum, p) => sum + p.rgb[c] * p.weight, 0) / colors.reduce((sum, p) => sum + p.weight, 0)) as RGB;
  const mode: 'dark' | 'light' = options.mode && options.mode !== 'auto' ? options.mode : luminance(average) < 0.3 ? 'dark' : 'light';
  const vivid = options.flavor === 'vivid';

  // The base hue comes from the wallpaper's biggest color; the accent from its
  // most colorful one (weighted so a single bright pixel doesn't win).
  const [baseHue, baseSat] = rgbToHsl(colors[0].rgb);
  const scored = colors
    .map((color) => {
      const [h, s, l] = rgbToHsl(color.rgb);
      const usable = l > 0.15 && l < 0.85 ? 1 : 0.25;
      return { color, h, s, score: s * Math.sqrt(color.weight) * usable };
    })
    .sort((a, b) => b.score - a.score);
  const accentPick = scored[0];
  const accent2Pick = scored.find((entry) => Math.abs(((entry.h - accentPick.h + 540) % 360) - 180) < 150) ?? scored[1] ?? accentPick;

  const tint = Math.min(baseSat, vivid ? 0.5 : 0.28);
  const L = mode === 'dark'
    ? { desktop: 0.08, window: 0.12, chrome: 0.17, button: 0.21, border: 0.3, text: 0.92 }
    : { desktop: 0.9, window: 0.97, chrome: 0.89, button: 0.93, border: 0.7, text: 0.12 };
  const background = hslToRgb(baseHue, tint * 0.7, L.window);
  const chrome = hslToRgb(baseHue, tint, L.chrome);
  const button = hslToRgb(baseHue, tint * 0.9, L.button);
  const border = hslToRgb(baseHue, tint * 0.8, L.border);
  const desktop = hslToRgb(baseHue, tint, L.desktop);
  const text = ensureContrast(hslToRgb(baseHue, 0.12, L.text), background, 7);
  const chromeText = ensureContrast(hslToRgb(baseHue, 0.12, L.text), chrome, 4.5);
  const buttonText = ensureContrast(hslToRgb(baseHue, 0.12, L.text), button, 4.5);

  const boost = (rgb: RGB): RGB => {
    const [h, s, l] = rgbToHsl(rgb);
    return hslToRgb(h, Math.min(1, s * (vivid ? 1.25 : 0.95) + (vivid ? 0.08 : 0)), l);
  };
  const accent = ensureContrast(boost(accentPick.color.rgb), background, 3.2);
  const accent2 = ensureContrast(boost(accent2Pick.color.rgb), background, 3);
  // Icon labels sit on the wallpaper itself.
  const label: RGB = luminance(average) > 0.35 ? [17, 17, 17] : [250, 250, 250];

  const hex = toHex;
  const appearance: CustomAppearance = {
    accentColor: hex(accent),
    desktopColor: hex(desktop),
    windowBgColor: hex(background),
    titleBarBgColor: hex(chrome),
    titleBarTextColor: hex(chromeText),
    windowBorderColor: hex(border),
    buttonBgColor: hex(button),
    buttonTextColor: hex(buttonText),
    buttonBorderColor: hex(border),
    labelColor: hex(label),
    designTokens: {
      'menuBar.background': hex(chrome),
      'menuBar.textColor': hex(chromeText),
      'surface.content': hex(background),
      'surface.toolbar': hex(chrome),
      'scrollbar.track': hex(background),
      'scrollbar.thumb': hex(ensureContrast(border, background, 1.8)),
      'effects.color': hex(accent2),
    },
  };
  return {
    mode,
    appearance,
    swatches: {
      background: hex(background),
      surface: hex(button),
      chrome: hex(chrome),
      text: hex(text),
      accent: hex(accent),
      accent2: hex(accent2),
      border: hex(border),
    },
  };
}

/** Draw an image small and read its pixels (CORS-enabled URL or object URL). */
export async function paletteFromImageUrl(url: string, k = 8): Promise<PaletteColor[]> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The wallpaper image could not be loaded.'));
    img.src = url;
  });
  const scale = Math.min(1, 96 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot read images.');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return extractPalette(ctx.getImageData(0, 0, canvas.width, canvas.height).data, k);
}
