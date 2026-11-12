import { expect, test, describe } from 'vitest';
import {
  hexToRgb,
  rgbToHex,
  getLuminance,
  isDarkColor,
  getContrastingTextColor,
  getSecondaryTextColor,
  adjustColor,
  isValidHexColor,
} from './colorUtils';

describe('hexToRgb', () => {
  test('parses 6-digit hex with or without the leading #', () => {
    expect(hexToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('00ff00')).toEqual({ r: 0, g: 255, b: 0 });
  });
  test('returns null for unsupported or invalid input', () => {
    expect(hexToRgb('#fff')).toBeNull(); // 3-digit not supported
    expect(hexToRgb('not-a-color')).toBeNull();
    expect(hexToRgb('#GG0000')).toBeNull();
  });
});

describe('rgbToHex', () => {
  test('round-trips with hexToRgb and zero-pads channels', () => {
    expect(rgbToHex(255, 0, 0)).toBe('#ff0000');
    expect(rgbToHex(1, 2, 3)).toBe('#010203');
    expect(hexToRgb(rgbToHex(18, 52, 86))).toEqual({ r: 18, g: 52, b: 86 });
  });
});

describe('getLuminance', () => {
  test('black is 0, white is 1', () => {
    expect(getLuminance('#000000')).toBe(0);
    expect(getLuminance('#FFFFFF')).toBeCloseTo(1, 5);
  });
  test('invalid input is treated as 0 luminance', () => {
    expect(getLuminance('garbage')).toBe(0);
  });
});

describe('isDarkColor / contrasting text', () => {
  test('dark backgrounds get white text, light backgrounds get black', () => {
    expect(isDarkColor('#000000')).toBe(true);
    expect(isDarkColor('#FFFFFF')).toBe(false);
    expect(getContrastingTextColor('#000080')).toBe('#FFFFFF');
    expect(getContrastingTextColor('#FFFFFF')).toBe('#000000');
  });
  test('secondary text follows the same light/dark split', () => {
    expect(getSecondaryTextColor('#000000')).toBe('#CCCCCC');
    expect(getSecondaryTextColor('#FFFFFF')).toBe('#666666');
  });
});

describe('adjustColor', () => {
  test('lightening raises channels, darkening lowers them', () => {
    const base = '#808080';
    expect(getLuminance(adjustColor(base, 40))).toBeGreaterThan(getLuminance(base));
    expect(getLuminance(adjustColor(base, -40))).toBeLessThan(getLuminance(base));
  });
  test('clamps at the extremes and passes invalid input through unchanged', () => {
    expect(adjustColor('#FFFFFF', 50)).toBe('#ffffff');
    expect(adjustColor('#000000', -50)).toBe('#000000');
    expect(adjustColor('not-hex', 50)).toBe('not-hex');
  });
});

describe('isValidHexColor', () => {
  test('accepts only a #-prefixed 6-digit hex', () => {
    expect(isValidHexColor('#FF00aa')).toBe(true);
    expect(isValidHexColor('FF0000')).toBe(false);
    expect(isValidHexColor('#fff')).toBe(false);
    expect(isValidHexColor('#GG0000')).toBe(false);
  });
});
