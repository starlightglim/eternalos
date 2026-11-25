import { describe, expect, test } from 'vitest';
import { buildAppTheme, luminance, sanitizeFontStack } from './appTheme';

const passColor = (value: string) => (/^#[0-9a-f]{6}$/i.test(value) || /^rgba?\(/.test(value) ? value : null);

describe('buildAppTheme', () => {
  test('maps desktop variables to app colors, first usable source wins', () => {
    const vars: Record<string, string> = {
      '--surface': ' #ffffff',
      '--text-color': '#111111',
      '--accent': 'linear-gradient(#f00, #00f)', // not a plain color → falls back
      '--selection': '#000080',
      '--selection-text': '#ffffff',
      '--font-geneva': "'Geneva', 'VT323', sans-serif",
      '--font-chicago': "url(https://evil.example/f.woff)",
    };
    const theme = buildAppTheme((name) => vars[name] ?? '', passColor);
    expect(theme.colors.bg).toBe('#ffffff');
    expect(theme.colors.text).toBe('#111111');
    expect(theme.colors.accent).toBe('#000080');
    expect(theme.colors['accent-text']).toBe('#ffffff');
    expect(theme.fonts.font).toBe("'Geneva', 'VT323', sans-serif");
    expect(theme.fonts['font-title']).toBeUndefined();
    expect(theme.scheme).toBe('light');
  });

  test('never passes images, urls or css injection', () => {
    const vars: Record<string, string> = {
      '--surface': 'url(https://evil.example/x.png)',
      '--window-bg': '#202020',
      '--text-color': 'red; background: url(x)',
      '--border': 'rgba(0, 0, 0, 0.5)',
    };
    const theme = buildAppTheme((name) => vars[name] ?? '', passColor);
    expect(theme.colors.bg).toBe('#202020');
    expect(theme.colors.text).toBeUndefined();
    expect(theme.colors.border).toBe('rgba(0, 0, 0, 0.5)');
    expect(theme.scheme).toBe('dark');
  });
});

describe('helpers', () => {
  test('luminance and font stacks', () => {
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(luminance('rgb(0, 0, 0)')).toBe(0);
    expect(luminance('papayawhip')).toBeNull();
    expect(sanitizeFontStack('"Chicago", monospace')).toBe('"Chicago", monospace');
    expect(sanitizeFontStack('a;b')).toBeNull();
    expect(sanitizeFontStack('x(1)')).toBeNull();
  });
});
