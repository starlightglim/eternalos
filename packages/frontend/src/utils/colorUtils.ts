/**
 * Shared color utility functions for EternalOS.
 * Single source of truth — no more per-file duplication.
 */

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/**
 * WCAG relative luminance
 */
export function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isDarkColor(hex: string): boolean {
  return getLuminance(hex) < 0.4;
}

export function getContrastingTextColor(bgColor: string): string {
  return isDarkColor(bgColor) ? '#FFFFFF' : '#000000';
}

export function getSecondaryTextColor(bgColor: string): string {
  return isDarkColor(bgColor) ? '#CCCCCC' : '#666666';
}

/**
 * Lighten (percent > 0) or darken (percent < 0) a hex color.
 */
export function adjustColor(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const adjust = (c: number) => {
    const adjusted = Math.round(c + (percent > 0 ? (255 - c) : c) * (percent / 100));
    return Math.max(0, Math.min(255, adjusted));
  };

  return rgbToHex(adjust(rgb.r), adjust(rgb.g), adjust(rgb.b));
}

export function isValidHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value);
}
