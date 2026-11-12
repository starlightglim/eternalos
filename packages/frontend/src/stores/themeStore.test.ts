import { expect, test, describe, vi } from 'vitest';

// themeStore reads localStorage and (guarded) touches the DOM at import. Stub
// localStorage so the pure THEMES table can be imported cleanly in node.
vi.hoisted(() => {
  (globalThis as unknown as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
});

import { THEMES, type ThemeColors } from './themeStore';
import { getLuminance, getContrastingTextColor, isValidHexColor } from '../utils/colorUtils';

const REQUIRED_COLORS: (keyof ThemeColors)[] = [
  'platinum', 'white', 'black', 'shadow', 'highlight', 'selection', 'selectionText',
  'windowBg', 'titleBarActive', 'titleBarInactive', 'border',
];
const OPTIONAL_COLORS: (keyof ThemeColors)[] = [
  'textColor', 'textColorSecondary', 'accent', 'menuBarBg', 'menuBarText',
];

function contrastRatio(a: string, b: string): number {
  const la = getLuminance(a);
  const lb = getLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const CONTRAST_FLOOR = 3.0;

describe.each(Object.entries(THEMES))('built-in theme: %s', (id, theme) => {
  test('id matches its key and has a name + description', () => {
    expect(theme.id).toBe(id);
    expect(theme.name).toBeTruthy();
    expect(theme.description).toBeTruthy();
  });

  test('defines every required color as a valid hex', () => {
    for (const key of REQUIRED_COLORS) {
      const value = theme.colors[key];
      expect(value, `${id}.${String(key)} missing`).toBeTruthy();
      expect(isValidHexColor(value as string), `${id}.${String(key)}=${value}`).toBe(true);
    }
  });

  test('any optional color present is also a valid hex', () => {
    for (const key of OPTIONAL_COLORS) {
      const value = theme.colors[key];
      if (value !== undefined) {
        expect(isValidHexColor(value), `${id}.${String(key)}=${value}`).toBe(true);
      }
    }
  });

  test('selected-item text is legible on the selection color', () => {
    const ratio = contrastRatio(theme.colors.selectionText, theme.colors.selection);
    expect(ratio, `${id} selection ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
  });

  test('body text is legible on the window background', () => {
    // Explicit textColor when set (dark themes), else the derived contrast color.
    const bodyText = theme.colors.textColor ?? getContrastingTextColor(theme.colors.windowBg);
    const ratio = contrastRatio(bodyText, theme.colors.windowBg);
    expect(ratio, `${id} body ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
  });
});

test('all four built-in themes are registered under matching keys', () => {
  expect(Object.keys(THEMES).sort()).toEqual(['macos8', 'macos9', 'next', 'system7']);
  for (const [key, theme] of Object.entries(THEMES)) {
    expect(theme.id).toBe(key);
  }
});
