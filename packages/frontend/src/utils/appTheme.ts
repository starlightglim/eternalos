/**
 * The desktop theme, as handed to apps (AppViewer → `eternal:theme` message →
 * the app runtime sets `--eternal-*` CSS variables inside the app).
 *
 * Only plain colors and font stacks cross into the app: no gradients, images
 * or url()s, so a theme can never make an app load anything.
 */

export interface AppTheme {
  scheme: 'light' | 'dark';
  colors: Record<string, string>;
  fonts: Record<string, string>;
}

/** App variable name → desktop CSS variables to try, first usable wins. */
export const APP_THEME_COLOR_SOURCES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['bg', ['--surface', '--window-bg']],
  ['surface', ['--surface-raised', '--surface', '--window-bg']],
  ['chrome', ['--surface-chrome', '--title-bar-active', '--platinum']],
  ['text', ['--window-text-color', '--text-color']],
  ['text-muted', ['--window-text-secondary', '--text-color-secondary']],
  ['accent', ['--accent', '--selection']],
  ['accent-text', ['--selection-text']],
  ['selection', ['--selection']],
  ['selection-text', ['--selection-text']],
  ['border', ['--border']],
  ['highlight', ['--highlight']],
  ['shadow', ['--shadow']],
  ['control-bg', ['--control-bg', '--appearance-button-bg', '--white']],
  ['control-text', ['--control-text', '--appearance-button-text', '--text-color']],
  ['control-border', ['--control-border', '--appearance-button-border', '--border']],
  ['title-bar', ['--title-bar-active', '--platinum']],
  ['title-text', ['--appearance-title-text', '--text-color']],
  ['danger', ['--danger']],
  ['success', ['--success']],
];

export const APP_THEME_FONT_SOURCES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['font', ['--font-geneva']],
  ['font-title', ['--font-chicago']],
  ['font-mono', ['--font-monaco']],
];

const UNSAFE_VALUE_RE = /url\(|image|gradient|[;{}<>\\]|\/\*/i;

/** A font stack made of names, quotes, commas and spaces only. */
export function sanitizeFontStack(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return /^[\w\s,'".-]+$/.test(trimmed) ? trimmed : null;
}

/** "#rrggbb" or "rgb(a)(…)" → relative luminance 0..1, or null. */
export function luminance(color: string): number | null {
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  } else if (rgb) {
    [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  } else {
    return null;
  }
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Build the app theme from a CSS-variable reader. `normalizeColor` turns a
 * CSS value into a plain color string (or null if it isn't a solid color).
 */
export function buildAppTheme(
  readVar: (name: string) => string,
  normalizeColor: (value: string) => string | null,
): AppTheme {
  const colors: Record<string, string> = {};
  for (const [name, sources] of APP_THEME_COLOR_SOURCES) {
    for (const source of sources) {
      const raw = readVar(source).trim();
      if (!raw || raw.length > 120 || UNSAFE_VALUE_RE.test(raw)) continue;
      const color = normalizeColor(raw);
      if (color) {
        colors[name] = color;
        break;
      }
    }
  }
  const fonts: Record<string, string> = {};
  for (const [name, sources] of APP_THEME_FONT_SOURCES) {
    for (const source of sources) {
      const font = sanitizeFontStack(readVar(source));
      if (font) {
        fonts[name] = font;
        break;
      }
    }
  }
  const bgLuminance = colors.bg ? luminance(colors.bg) : null;
  return { scheme: bgLuminance !== null && bgLuminance < 0.35 ? 'dark' : 'light', colors, fonts };
}

let colorContext: CanvasRenderingContext2D | null | undefined;

/** Canvas round-trip: any solid CSS color → "#rrggbb" / "rgba(…)"; anything else → null. */
function normalizeCssColor(value: string): string | null {
  if (typeof CSS !== 'undefined' && !CSS.supports('color', value)) return null;
  if (colorContext === undefined) {
    try {
      colorContext = document.createElement('canvas').getContext('2d');
    } catch {
      colorContext = null;
    }
  }
  if (!colorContext) return value;
  colorContext.fillStyle = '#010203';
  colorContext.fillStyle = value;
  const out = String(colorContext.fillStyle);
  // Unchanged sentinel means the canvas rejected it (unless it really was that color).
  if (out === '#010203' && value.replace(/\s/g, '').toLowerCase() !== '#010203') return null;
  return out;
}

/** The theme as the app window sees it (inherits the desktop's variables, incl. theme CSS). */
export function readAppTheme(element: Element): AppTheme {
  const style = getComputedStyle(element);
  return buildAppTheme((name) => style.getPropertyValue(name), normalizeCssColor);
}
