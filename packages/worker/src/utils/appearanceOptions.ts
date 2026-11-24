/**
 * Appearance values the assistant may set (changeAppearance). The ids mirror
 * the frontend's own lists — WALLPAPER_OPTIONS in
 * frontend/src/components/desktop/Desktop.tsx and FONT_CATALOG in
 * frontend/src/utils/fontCatalog.ts; test/appearanceOptions.test.mjs fails if
 * they drift. Ranges match UserDesktop's profile validation.
 */

export const WALLPAPER_IDS = [
  'default', 'diagonal', 'checkerboard', 'denim', 'crosshatch', 'dots', 'lines',
  'brick', 'weave', 'navy', 'teal', 'purple', 'forest',
] as const;

export const FONT_IDS = [
  'chicago', 'geneva', 'monaco', 'vt323', 'silkscreen', 'pressStart', 'inter',
  'dmSans', 'ibmPlexMono', 'spaceMono', 'courierPrime', 'dmMono',
] as const;

/** Color fields accept any CSS color; desktopColor also takes a gradient. */
export const APPEARANCE_COLOR_FIELDS = [
  'accentColor', 'desktopColor', 'windowBgColor', 'titleBarBgColor', 'titleBarTextColor',
  'windowBorderColor', 'buttonBgColor', 'buttonTextColor', 'buttonBorderColor', 'labelColor',
] as const;

export const APPEARANCE_NUMBER_RANGES = {
  windowBorderRadius: [0, 24],
  controlBorderRadius: [0, 24],
  windowShadow: [0, 32],
  windowOpacity: [30, 100],
} as const;

export const APPEARANCE_FONT_FIELDS = ['systemFont', 'bodyFont', 'monoFont'] as const;

/** A theme's own CSS/tokens override plain colors; clearing them lets a new look show. */
export const CUSTOM_THEME_FIELDS = ['customCSS', 'designTokens', 'variants'] as const;

/** Every profile field changeAppearance can touch (and must restore on undo). */
export const APPEARANCE_TOOL_FIELDS = [
  ...APPEARANCE_COLOR_FIELDS,
  ...APPEARANCE_FONT_FIELDS,
  'fontSmoothing',
  ...(Object.keys(APPEARANCE_NUMBER_RANGES) as Array<keyof typeof APPEARANCE_NUMBER_RANGES>),
  'wallpaper',
  ...CUSTOM_THEME_FIELDS,
] as const;

const LABELS: Record<string, string> = {
  accentColor: 'accent',
  desktopColor: 'desktop',
  windowBgColor: 'window background',
  titleBarBgColor: 'title bars',
  titleBarTextColor: 'title text',
  windowBorderColor: 'window borders',
  buttonBgColor: 'buttons',
  buttonTextColor: 'button text',
  buttonBorderColor: 'button borders',
  labelColor: 'icon labels',
  systemFont: 'system font',
  bodyFont: 'body font',
  monoFont: 'mono font',
  fontSmoothing: 'font smoothing',
  windowBorderRadius: 'window corners',
  controlBorderRadius: 'control corners',
  windowShadow: 'window shadow',
  windowOpacity: 'window opacity',
  wallpaper: 'wallpaper',
};

/** "accent #3d78d2, wallpaper dots, system font inter" — for previews and steps. */
export function describeAppearanceChanges(changes: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [field, value] of Object.entries(changes)) {
    if ((CUSTOM_THEME_FIELDS as readonly string[]).includes(field)) continue;
    const label = LABELS[field] ?? field;
    const text = typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
    parts.push(`${label} ${text.length > 40 ? `${text.slice(0, 39)}…` : text}`);
  }
  if (CUSTOM_THEME_FIELDS.some((field) => field in changes)) parts.push('removes the current custom theme CSS');
  return parts.join(', ');
}
