import { expect, test, describe } from 'vitest';
import { THEME_PRESETS } from './onboardingPresets';
import { getLuminance, isValidHexColor } from './colorUtils';
import { sanitizeCustomCSS } from './cssSanitizer';
import { resolveTokensFromAppearance, compileTokensToCSS } from '../tokens/tokenCompiler';
import type { CustomAppearance } from '../stores/appearanceStore';

/**
 * Preset readability matrix (Workstream 2, item 1).
 *
 * Every shipped theme preset must render legible chrome. These are the cheapest
 * quality signal to regress, so pin them: structural shape, valid colors, a
 * contrast floor on the authored text/background pairs, and a clean trip
 * through the token + custom-CSS pipelines.
 */

// WCAG contrast ratio. Title-bar text and icon labels are large/bold UI text,
// so 3.0:1 is the "not unreadable" floor (AA for large text / UI components).
const CONTRAST_FLOOR = 3.0;

function contrastRatio(a: string, b: string): number {
  const la = getLuminance(a);
  const lb = getLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// The text/background pairs a preset authors explicitly (window body text is
// derived to max contrast, so it needs no floor check here).
const TEXT_PAIRS: Array<{ label: string; fg: keyof CustomAppearance; bg: keyof CustomAppearance }> = [
  { label: 'title text on title bar', fg: 'titleBarTextColor', bg: 'titleBarBgColor' },
  { label: 'button text on button', fg: 'buttonTextColor', bg: 'buttonBgColor' },
  { label: 'icon label on desktop', fg: 'labelColor', bg: 'desktopColor' },
];

// "Ink" fields — text + accent — that must be a valid 6-digit hex (derived
// text-color transforms and contrast checks only work on hex). Background and
// border fields may intentionally be gradients/rgba (xp, frutigerAero), so they
// are deliberately NOT checked here.
const HEX_COLOR_FIELDS: (keyof CustomAppearance)[] = [
  'accentColor', 'titleBarTextColor', 'buttonTextColor', 'labelColor',
];

test('there are presets and their ids are unique', () => {
  expect(THEME_PRESETS.length).toBeGreaterThan(0);
  const ids = THEME_PRESETS.map((p) => p.id);
  expect(new Set(ids).size).toBe(ids.length);
});

describe.each(THEME_PRESETS.map((p) => [p.id, p] as const))('preset: %s', (_id, preset) => {
  test('has the required structural fields', () => {
    expect(preset.name).toBeTruthy();
    expect(preset.description).toBeTruthy();
    expect(preset.wallpaper).toBeTruthy();
    expect(preset.highlights).toHaveLength(3);
    for (const field of ['desktop', 'titleBar', 'window', 'accent', 'label'] as const) {
      expect(preset.preview[field]).toBeTruthy();
    }
  });

  test('solid-color fields are valid 6-digit hex', () => {
    const a = preset.appearance as Record<string, unknown>;
    for (const field of HEX_COLOR_FIELDS) {
      const value = a[field];
      if (typeof value === 'string') {
        expect(isValidHexColor(value), `${String(field)}="${value}"`).toBe(true);
      }
    }
  });

  test('authored text/background pairs clear the contrast floor', () => {
    const a = preset.appearance as Record<string, unknown>;
    for (const { label, fg, bg } of TEXT_PAIRS) {
      const fv = a[fg];
      const bv = a[bg];
      // Only solid hex-on-hex pairs are checked; gradient/rgba surfaces (xp,
      // frutigerAero) carry their own readable text via customCSS.
      if (typeof fv === 'string' && typeof bv === 'string' && isValidHexColor(fv) && isValidHexColor(bv)) {
        const ratio = contrastRatio(fv, bv);
        expect(ratio, `${label}: ${fv} on ${bv} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          CONTRAST_FLOOR
        );
      }
    }
  });

  test('compiles through the token pipeline without throwing', () => {
    expect(() => {
      const tokens = resolveTokensFromAppearance(preset.appearance as Record<string, unknown>);
      compileTokensToCSS(tokens, preset.appearance.variants);
    }).not.toThrow();
  });

  test('any bundled customCSS survives sanitization and stays scoped', () => {
    const css = preset.appearance.customCSS;
    if (!css) return;
    const out = sanitizeCustomCSS(css);
    expect(out.length).toBeGreaterThan(0);
    // Scoping happened, and nothing slipped the scope or loads a remote asset.
    // (Exhaustive per-selector scope checks live in cssSanitizer.test.ts.)
    expect(out).toContain('.user-desktop');
    expect(out).not.toContain('@font-face');
    expect(out).not.toMatch(/url\(\s*['"]?(https?:|\/\/)/i);
  });
});
