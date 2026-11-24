import { expect, test } from 'vitest';
import { compileTokensToCSS, resolveTokensFromAppearance } from './tokenCompiler';

// A gradient desktop color used to be set only as background-color, where
// browsers drop it — the desktop went transparent. The plain wallpaper now
// paints --custom-desktop-image, which is set only for gradients.
test('a gradient desktop color also compiles to --custom-desktop-image', () => {
  const gradient = 'linear-gradient(165deg, #241109 0%, #552a15 100%)';
  const vars = compileTokensToCSS(resolveTokensFromAppearance({ desktopColor: gradient })).cssVars;
  expect(vars.get('--custom-desktop-color')).toBe(gradient);
  expect(vars.get('--custom-desktop-image')).toBe(gradient);
});

test('a solid desktop color does not set an image', () => {
  const vars = compileTokensToCSS(resolveTokensFromAppearance({ desktopColor: '#336699' })).cssVars;
  expect(vars.get('--custom-desktop-color')).toBe('#336699');
  expect(vars.has('--custom-desktop-image')).toBe(false);
});
