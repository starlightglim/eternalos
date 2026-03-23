/**
 * Design Token Schema for EternalOS
 *
 * Single source of truth for every customizable visual property.
 * Adding a new property = adding ONE entry to TOKEN_REGISTRY.
 *
 * Each token defines:
 *   - Where it lives on UserProfile (profileKey for legacy, null for designTokens blob)
 *   - How it renders in the Appearance Panel (tab, group, valueType)
 *   - How it compiles to CSS (cssVars, cssRule, derivedVars)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Token value type — determines validation, UI control, and CSS output.
 *
 * - color:    Hex only (#RRGGBB). Rendered with native color picker.
 * - cssColor: Hex, rgb(), hsl(), gradients, images. Rendered with RichColorField.
 * - font:     Font catalog ID. Rendered with FontField.
 * - number:   Bounded numeric. Rendered with SliderField.
 * - boolean:  Toggle. Rendered with checkbox.
 * - cssText:  Free-form CSS (e.g. customCSS). Not rendered in panel.
 */
export type TokenValueType = 'color' | 'cssColor' | 'font' | 'number' | 'boolean' | 'cssText';

export interface NumberConstraints {
  min: number;
  max: number;
  unit: 'px' | '%' | '';
  step?: number;
}

/**
 * Transform applied to a token's value to derive a secondary CSS variable.
 */
export type DerivedTransform =
  | 'contrastText'    // isDarkColor → #FFF / #000
  | 'secondaryText'   // isDarkColor → #CCC / #666
  | 'darken18'        // adjustColor(hex, -18)
  | 'selectionText';  // isDarkColor → #FFF / #000  (alias, same logic)

export interface DerivedVar {
  cssVar: string;
  transform: DerivedTransform;
}

export interface CSSRuleTemplate {
  selector: string;   // e.g. '.user-desktop [eos-part="titlebar"]'
  property: string;   // e.g. 'background'
  important?: boolean;
}

export interface TokenDefinition {
  /** Dot-path identifier, e.g. 'window.titleBar.background' */
  path: string;

  /**
   * Flat key on UserProfile for legacy fields (e.g. 'accentColor').
   * Set to null for tokens stored in the designTokens blob.
   */
  profileKey: string | null;

  // UI metadata
  label: string;
  hint: string;
  tab: 'themes' | 'palette' | 'windows' | 'controls' | 'typography' | 'preview';
  group?: string;

  // Value
  valueType: TokenValueType;
  defaultValue: string | number | boolean;
  numberConstraints?: NumberConstraints;

  // CSS output
  /** CSS custom properties to set on :root */
  cssVars?: string[];
  /** Structured CSS rule to inject */
  cssRule?: CSSRuleTemplate;
  /** Derived CSS variables computed from this token's value */
  derivedVars?: DerivedVar[];

  /**
   * When true, the structured CSS rule is excluded from
   * [data-theme-immune] panels (e.g. Appearance Panel).
   */
  excludeFromImmune?: boolean;

  /**
   * Conditional token: only rendered in Appearance Panel and compiled to CSS
   * when the specified variant is active for the given slot.
   */
  condition?: {
    slotId: string;
    variantId: string;
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOKEN_REGISTRY: TokenDefinition[] = [
  // =========================================================================
  // PALETTE TAB — Core colors
  // =========================================================================
  {
    path: 'color.accent',
    profileKey: 'accentColor',
    label: 'Accent',
    hint: 'Selections, active states, highlights',
    tab: 'palette',
    valueType: 'cssColor',
    defaultValue: '#000080',
    cssVars: ['--selection', '--accent'],
    derivedVars: [
      { cssVar: '--selection-text', transform: 'selectionText' },
    ],
  },
  {
    path: 'color.desktop',
    profileKey: 'desktopColor',
    label: 'Desktop',
    hint: 'Main desktop fill under wallpaper and icons',
    tab: 'palette',
    valueType: 'cssColor',
    defaultValue: '#C0C0C0',
    cssVars: ['--custom-desktop-color'],
    derivedVars: [
      { cssVar: '--desktop-text-color', transform: 'contrastText' },
    ],
  },
  {
    path: 'color.windowBg',
    profileKey: 'windowBgColor',
    label: 'Window Surface',
    hint: 'Window content backgrounds',
    tab: 'palette',
    valueType: 'cssColor',
    defaultValue: '#FFFFFF',
    cssVars: ['--window-bg'],
    derivedVars: [
      { cssVar: '--window-text-color', transform: 'contrastText' },
      { cssVar: '--window-text-secondary', transform: 'secondaryText' },
    ],
  },
  {
    path: 'color.label',
    profileKey: 'labelColor',
    label: 'Labels',
    hint: 'Desktop item labels and similar metadata text',
    tab: 'palette',
    valueType: 'cssColor',
    defaultValue: '#000000',
    cssVars: ['--appearance-label-color'],
    cssRule: { selector: '.user-desktop [eos-part="label"]', property: 'color' },
  },

  // =========================================================================
  // WINDOWS TAB — Title bar, border, shadow
  // =========================================================================
  {
    path: 'window.titleBar.background',
    profileKey: 'titleBarBgColor',
    label: 'Title Bar',
    hint: 'Window title strip color or gradient',
    tab: 'windows',
    group: 'Title Bar',
    valueType: 'cssColor',
    defaultValue: '#C0C0C0',
    cssVars: ['--title-bar-active'],
    derivedVars: [
      { cssVar: '--title-bar-inactive', transform: 'darken18' },
    ],
    cssRule: { selector: '.user-desktop [eos-part="titlebar"]', property: 'background' },
  },
  {
    path: 'window.titleBar.textColor',
    profileKey: 'titleBarTextColor',
    label: 'Title Text',
    hint: 'Window title text color',
    tab: 'windows',
    group: 'Title Bar',
    valueType: 'cssColor',
    defaultValue: '#000000',
    cssVars: ['--appearance-title-text'],
    cssRule: { selector: '.user-desktop [eos-part="title"]', property: 'color' },
  },
  {
    path: 'window.border.color',
    profileKey: 'windowBorderColor',
    label: 'Window Border',
    hint: 'Window outline and frame color',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'cssColor',
    defaultValue: '#000000',
    cssVars: ['--border'],
  },
  {
    path: 'window.border.radius',
    profileKey: 'windowBorderRadius',
    label: 'Window Radius',
    hint: 'Outer rounding of windows',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'number',
    defaultValue: 0,
    numberConstraints: { min: 0, max: 24, unit: 'px' },
    // Compiled via special handling in the compiler (needs inner radius + overflow)
  },
  {
    path: 'window.shadow',
    profileKey: 'windowShadow',
    label: 'Window Shadow',
    hint: 'Depth and shadow softness',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'number',
    defaultValue: 2,
    numberConstraints: { min: 0, max: 32, unit: 'px' },
    // Compiled via special handling (formula-based shadow)
  },
  {
    path: 'window.opacity',
    profileKey: 'windowOpacity',
    label: 'Window Opacity',
    hint: 'Transparency of window content (hover restores full)',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'number',
    defaultValue: 100,
    numberConstraints: { min: 30, max: 100, unit: '%' },
    // Compiled via special handling (opacity + hover rule)
  },

  // =========================================================================
  // CONTROLS TAB — Buttons, inputs
  // =========================================================================
  {
    path: 'controls.button.background',
    profileKey: 'buttonBgColor',
    label: 'Button Fill',
    hint: 'Buttons, inputs, selects, and controls',
    tab: 'controls',
    valueType: 'cssColor',
    defaultValue: '#C0C0C0',
    cssVars: ['--appearance-button-bg'],
    excludeFromImmune: true,
  },
  {
    path: 'controls.button.textColor',
    profileKey: 'buttonTextColor',
    label: 'Button Text',
    hint: 'Button and control label color',
    tab: 'controls',
    valueType: 'cssColor',
    defaultValue: '#000000',
    cssVars: ['--appearance-button-text'],
    excludeFromImmune: true,
  },
  {
    path: 'controls.button.borderColor',
    profileKey: 'buttonBorderColor',
    label: 'Button Border',
    hint: 'Button and control stroke color',
    tab: 'controls',
    valueType: 'cssColor',
    defaultValue: '#000000',
    cssVars: ['--appearance-button-border'],
    excludeFromImmune: true,
  },
  {
    path: 'controls.borderRadius',
    profileKey: 'controlBorderRadius',
    label: 'Control Radius',
    hint: 'Buttons, fields, and window controls',
    tab: 'controls',
    valueType: 'number',
    defaultValue: 3,
    numberConstraints: { min: 0, max: 24, unit: 'px' },
    excludeFromImmune: true,
  },

  // =========================================================================
  // TYPOGRAPHY TAB — Fonts, smoothing
  // =========================================================================
  {
    path: 'typography.systemFont',
    profileKey: 'systemFont',
    label: 'System Font',
    hint: 'Titles, menus, and window chrome',
    tab: 'typography',
    valueType: 'font',
    defaultValue: 'chicago',
    cssVars: ['--font-chicago'],
  },
  {
    path: 'typography.bodyFont',
    profileKey: 'bodyFont',
    label: 'Body Font',
    hint: 'Labels, content, and descriptive text',
    tab: 'typography',
    valueType: 'font',
    defaultValue: 'geneva',
    cssVars: ['--font-geneva'],
  },
  {
    path: 'typography.monoFont',
    profileKey: 'monoFont',
    label: 'Mono Font',
    hint: 'Code, hex values, and fixed-width text',
    tab: 'typography',
    valueType: 'font',
    defaultValue: 'monaco',
    cssVars: ['--font-monaco'],
  },
  {
    path: 'typography.fontSmoothing',
    profileKey: 'fontSmoothing',
    label: 'Font Smoothing',
    hint: 'Crisper retro edges or softer text rendering',
    tab: 'typography',
    valueType: 'boolean',
    defaultValue: false,
    // Special handling in compiler (sets body style, not CSS var)
  },

  // =========================================================================
  // NEW TOKENS — Window chrome (stored in designTokens blob)
  // =========================================================================
  {
    path: 'window.titleBar.height',
    profileKey: null,
    label: 'Title Bar Height',
    hint: 'Height of the window title strip',
    tab: 'windows',
    group: 'Title Bar',
    valueType: 'number',
    defaultValue: 20,
    numberConstraints: { min: 16, max: 40, unit: 'px' },
    cssVars: ['--eos-titlebar-height'],
  },
  {
    path: 'window.titleBar.textShadow',
    profileKey: null,
    label: 'Title Text Shadow',
    hint: 'Shadow behind title text (e.g. 1px 1px 2px rgba(0,0,0,0.5))',
    tab: 'windows',
    group: 'Title Bar',
    valueType: 'cssColor',
    defaultValue: '',
    cssRule: { selector: '.user-desktop [eos-part="title"]', property: 'text-shadow' },
  },
  {
    path: 'window.border.width',
    profileKey: null,
    label: 'Border Width',
    hint: 'Window frame thickness',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'number',
    defaultValue: 2,
    numberConstraints: { min: 1, max: 6, unit: 'px' },
    cssVars: ['--eos-window-border-width'],
  },
  {
    path: 'window.closeButton.size',
    profileKey: null,
    label: 'Button Size',
    hint: 'Width and height of window control buttons',
    tab: 'windows',
    group: 'Window Buttons',
    valueType: 'number',
    defaultValue: 11,
    numberConstraints: { min: 8, max: 24, unit: 'px' },
    cssVars: ['--eos-window-button-size'],
  },

  // =========================================================================
  // NEW TOKENS — Menu bar
  // =========================================================================
  {
    path: 'menuBar.background',
    profileKey: null,
    label: 'Menu Background',
    hint: 'Menu bar background color or gradient',
    tab: 'controls',
    group: 'Menu Bar',
    valueType: 'cssColor',
    defaultValue: '',
    cssVars: ['--eos-menubar-bg'],
  },
  {
    path: 'menuBar.textColor',
    profileKey: null,
    label: 'Menu Text',
    hint: 'Menu bar text color',
    tab: 'controls',
    group: 'Menu Bar',
    valueType: 'cssColor',
    defaultValue: '',
    cssVars: ['--eos-menubar-text'],
  },
  {
    path: 'menuBar.height',
    profileKey: null,
    label: 'Menu Height',
    hint: 'Menu bar height',
    tab: 'controls',
    group: 'Menu Bar',
    valueType: 'number',
    defaultValue: 20,
    numberConstraints: { min: 16, max: 40, unit: 'px' },
    cssVars: ['--menu-bar-height'],
  },

  // =========================================================================
  // NEW TOKENS — Scrollbar
  // =========================================================================
  {
    path: 'scrollbar.track',
    profileKey: null,
    label: 'Track Color',
    hint: 'Scrollbar track background',
    tab: 'controls',
    group: 'Scrollbar',
    valueType: 'cssColor',
    defaultValue: '',
    cssVars: ['--eos-scrollbar-track'],
  },
  {
    path: 'scrollbar.thumb',
    profileKey: null,
    label: 'Thumb Color',
    hint: 'Scrollbar thumb background',
    tab: 'controls',
    group: 'Scrollbar',
    valueType: 'cssColor',
    defaultValue: '',
    cssVars: ['--eos-scrollbar-thumb'],
  },
  {
    path: 'scrollbar.width',
    profileKey: null,
    label: 'Scrollbar Width',
    hint: 'Scrollbar width',
    tab: 'controls',
    group: 'Scrollbar',
    valueType: 'number',
    defaultValue: 16,
    numberConstraints: { min: 8, max: 24, unit: 'px' },
    cssVars: ['--eos-scrollbar-width'],
  },

  // =========================================================================
  // NEW TOKENS — Icons
  // =========================================================================
  {
    path: 'icon.size',
    profileKey: null,
    label: 'Icon Size',
    hint: 'Desktop icon dimensions',
    tab: 'palette',
    group: 'Icons',
    valueType: 'number',
    defaultValue: 32,
    numberConstraints: { min: 16, max: 64, unit: 'px' },
    cssVars: ['--icon-size'],
  },
  {
    path: 'icon.labelSize',
    profileKey: null,
    label: 'Label Size',
    hint: 'Font size for icon labels',
    tab: 'palette',
    group: 'Icons',
    valueType: 'number',
    defaultValue: 9,
    numberConstraints: { min: 8, max: 14, unit: 'px' },
    cssVars: ['--eos-icon-label-size'],
  },
  {
    path: 'icon.labelShadow',
    profileKey: null,
    label: 'Label Shadow',
    hint: 'Text shadow on icon labels (e.g. 1px 1px 2px rgba(0,0,0,0.8))',
    tab: 'palette',
    group: 'Icons',
    valueType: 'cssColor',
    defaultValue: '',
    cssVars: ['--eos-icon-label-shadow'],
  },

  // =========================================================================
  // STRUCTURAL TOKENS — toggles, enums, and layout modifiers
  // =========================================================================
  {
    path: 'window.titleBar.stripes',
    profileKey: null,
    label: 'Title Bar Stripes',
    hint: 'Show classic Mac horizontal lines in the title bar',
    tab: 'windows',
    group: 'Title Bar',
    valueType: 'boolean',
    defaultValue: true,
    // Compiled via special handling (hides .titleBarStripes)
  },
  {
    path: 'window.innerBevel',
    profileKey: null,
    label: 'Inner Bevel',
    hint: 'Classic Mac 3D highlight/shadow inside windows',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'boolean',
    defaultValue: true,
    // Compiled via special handling (removes inner border)
  },
  {
    path: 'window.border.style',
    profileKey: null,
    label: 'Border Style',
    hint: 'solid, double, ridge, groove, inset, outset, or none',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'cssColor',
    defaultValue: 'solid',
    cssVars: ['--eos-window-border-style'],
  },
  {
    path: 'window.border.topRadius',
    profileKey: null,
    label: 'Top Radius',
    hint: 'Top corner rounding (overrides Window Radius for top)',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'number',
    defaultValue: -1,
    numberConstraints: { min: -1, max: 24, unit: 'px' },
    // -1 means "use window.border.radius". Compiled via special handling.
  },
  {
    path: 'window.border.bottomRadius',
    profileKey: null,
    label: 'Bottom Radius',
    hint: 'Bottom corner rounding (overrides Window Radius for bottom)',
    tab: 'windows',
    group: 'Border & Shape',
    valueType: 'number',
    defaultValue: -1,
    numberConstraints: { min: -1, max: 24, unit: 'px' },
    // -1 means "use window.border.radius". Compiled via special handling.
  },
  {
    path: 'window.closeButton.shape',
    profileKey: null,
    label: 'Button Shape',
    hint: 'square, circle, or rounded',
    tab: 'windows',
    group: 'Window Buttons',
    valueType: 'cssColor',
    defaultValue: 'square',
    // Compiled via special handling (border-radius on close/zoom/collapse)
  },
  {
    path: 'icon.selectedStyle',
    profileKey: null,
    label: 'Selected Style',
    hint: 'How selected icons look: darken, highlight, outline, or none',
    tab: 'palette',
    group: 'Icons',
    valueType: 'cssColor',
    defaultValue: 'darken',
    // Compiled via special handling (different CSS filters)
  },
  {
    path: 'cursor.style',
    profileKey: null,
    label: 'Cursor',
    hint: 'default, pointer, crosshair, or a custom CSS cursor value',
    tab: 'palette',
    group: 'Cursor',
    valueType: 'cssColor',
    defaultValue: '',
    cssVars: ['--eos-cursor'],
  },

  // =========================================================================
  // CURSOR IMAGE TOKENS — Custom cursor images per state (Skin system)
  // These are cssText tokens storing URL paths. Compiled via special cursor
  // handling in tokenCompiler.ts to emit cursor: url(...) CSS rules.
  // =========================================================================
  {
    path: 'cursor.image.default',
    profileKey: null,
    label: 'Default Cursor',
    hint: 'Custom cursor image for default/arrow state',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.pointer',
    profileKey: null,
    label: 'Pointer Cursor',
    hint: 'Custom cursor for links and buttons',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.grab',
    profileKey: null,
    label: 'Grab Cursor',
    hint: 'Custom cursor for draggable elements (title bars)',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.grabbing',
    profileKey: null,
    label: 'Grabbing Cursor',
    hint: 'Custom cursor while actively dragging',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.text',
    profileKey: null,
    label: 'Text Cursor',
    hint: 'Custom cursor for text input areas',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.wait',
    profileKey: null,
    label: 'Wait Cursor',
    hint: 'Custom cursor for loading states',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.move',
    profileKey: null,
    label: 'Move Cursor',
    hint: 'Custom cursor for moving items',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },
  {
    path: 'cursor.image.nwse-resize',
    profileKey: null,
    label: 'Resize Cursor',
    hint: 'Custom cursor for resize handles',
    tab: 'controls',
    group: 'Custom Cursors',
    valueType: 'cssText',
    defaultValue: '',
  },

  // =========================================================================
  // DESKTOP EFFECTS (Skin system — visual overlays)
  // Simple ON/OFF toggles. Effect color is the only parameter.
  // =========================================================================
  { path: 'effects.scanlines.enabled', profileKey: null, label: 'Scanlines', hint: 'Horizontal lines (retro CRT look)', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.crt.enabled', profileKey: null, label: 'CRT Curvature', hint: 'Darkened edges like a curved monitor', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.rain.enabled', profileKey: null, label: 'Rain', hint: 'Falling raindrops', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.snow.enabled', profileKey: null, label: 'Snow', hint: 'Drifting snowflakes', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.matrix.enabled', profileKey: null, label: 'Matrix Rain', hint: 'Falling green characters', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.stars.enabled', profileKey: null, label: 'Stars', hint: 'Twinkling stars', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.fireflies.enabled', profileKey: null, label: 'Fireflies', hint: 'Slow-moving glowing dots', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.dust.enabled', profileKey: null, label: 'Dust Motes', hint: 'Tiny floating particles', tab: 'controls', group: 'Desktop Effects', valueType: 'boolean', defaultValue: false },
  { path: 'effects.sparkleTrail.enabled', profileKey: null, label: 'Sparkle Trail', hint: 'Golden sparkles following cursor', tab: 'controls', group: 'Cursor Trails', valueType: 'boolean', defaultValue: false },
  { path: 'effects.rainbowTrail.enabled', profileKey: null, label: 'Rainbow Trail', hint: 'Color-cycling cursor trail', tab: 'controls', group: 'Cursor Trails', valueType: 'boolean', defaultValue: false },
  { path: 'effects.ghostTrail.enabled', profileKey: null, label: 'Ghost Trail', hint: 'Fading cursor echoes', tab: 'controls', group: 'Cursor Trails', valueType: 'boolean', defaultValue: false },
  { path: 'effects.color', profileKey: null, label: 'Effect Color', hint: 'Tint color for effects', tab: 'controls', group: 'Desktop Effects', valueType: 'color', defaultValue: '#FFFFFF' },

  // =========================================================================
  // Custom CSS (not rendered in panel, handled by CSSEditor)
  // =========================================================================
  {
    path: 'customCSS',
    profileKey: 'customCSS',
    label: 'Custom CSS',
    hint: 'User-defined CSS, max 50KB',
    tab: 'preview', // not rendered
    valueType: 'cssText',
    defaultValue: '',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Look up a token by its dot-path */
export function getTokenByPath(path: string): TokenDefinition | undefined {
  return TOKEN_REGISTRY.find((t) => t.path === path);
}

/** All tokens for a given Appearance Panel tab, filtered by active variants */
export function getTokensByTab(
  tab: TokenDefinition['tab'],
  activeVariants?: Record<string, string>
): TokenDefinition[] {
  return TOKEN_REGISTRY.filter((t) => {
    if (t.valueType === 'cssText') return false;
    if (t.tab !== tab) return false;
    // If token has a condition, check if the variant is active
    if (t.condition && activeVariants) {
      const active = activeVariants[t.condition.slotId];
      if (active !== t.condition.variantId) return false;
    }
    return true;
  });
}

/** Group an array of tokens by their `group` field */
export function groupTokensByGroup(tokens: TokenDefinition[]): Map<string, TokenDefinition[]> {
  const map = new Map<string, TokenDefinition[]>();
  for (const token of tokens) {
    const key = token.group ?? '_default';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(token);
  }
  return map;
}

/** All profile keys for tokens that have a legacy flat field */
export function getLegacyProfileKeys(): string[] {
  return TOKEN_REGISTRY
    .filter((t) => t.profileKey !== null)
    .map((t) => t.profileKey!);
}

/** All CSS variables that the token system may set (for clearance) */
export function getAllCSSVars(): string[] {
  const vars = new Set<string>();
  for (const token of TOKEN_REGISTRY) {
    if (token.cssVars) {
      for (const v of token.cssVars) vars.add(v);
    }
    if (token.derivedVars) {
      for (const dv of token.derivedVars) vars.add(dv.cssVar);
    }
  }
  return [...vars];
}

/** Set of all valid token paths (for worker validation) */
export const ALL_TOKEN_PATHS = new Set(TOKEN_REGISTRY.map((t) => t.path));
