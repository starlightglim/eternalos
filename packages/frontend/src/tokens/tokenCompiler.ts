/**
 * Token Compiler for EternalOS
 *
 * Compiles a resolved token map into CSS output (variables + structured rules).
 * The compiler is PURE — no DOM access. applyCompiledTokens handles DOM mutation.
 */

import { adjustColor, getContrastingTextColor, getSecondaryTextColor } from '../utils/colorUtils';
import { resolveFontFamily } from '../utils/fontCatalog';
import { TOKEN_REGISTRY, getAllCSSVars, type DerivedTransform } from './tokenSchema';

/** Resolve a relative /api/ path to a full URL using the configured API base */
const API_BASE = import.meta.env.VITE_API_URL || '';
function resolveAssetUrl(url: string): string {
  if (!API_BASE || url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/api/')) return `${API_BASE}${url}`;
  return url;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolvedTokens = Record<string, string | number | boolean | undefined>;

export interface CompiledCSS {
  /** CSS custom properties to set on :root */
  cssVars: Map<string, string>;
  /** Structured CSS rules to inject via <style> */
  rules: string[];
  /** Styles to set directly on document.body (font smoothing) */
  bodyStyles: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Derived value transforms
// ---------------------------------------------------------------------------

function applyDerivedTransform(transform: DerivedTransform, value: string): string | null {
  // Derived transforms only work on hex colors
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) return null;

  switch (transform) {
    case 'contrastText':
    case 'selectionText':
      return getContrastingTextColor(value);
    case 'secondaryText':
      return getSecondaryTextColor(value);
    case 'darken18':
      return adjustColor(value, -18);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Compiler (pure — no DOM)
// ---------------------------------------------------------------------------

export function compileTokensToCSS(
  tokens: ResolvedTokens,
  activeVariants?: Record<string, string>
): CompiledCSS {
  const cssVars = new Map<string, string>();
  const rules: string[] = [];
  const bodyStyles = new Map<string, string>();

  // Collect control override declarations (grouped for combined selector)
  const controlDeclarations: string[] = [];
  let controlRadius: number | undefined;
  let hasControlOverrides = false;

  // Collect window declarations (grouped)
  const windowDeclarations: string[] = [];
  let windowRadius = 0;
  let windowShadow = 2;
  let hasWindowOverrides = false;

  // Track title bar stripes
  let hasTitleBarBgOverride = false;

  for (const token of TOKEN_REGISTRY) {
    // Skip conditional tokens whose variant is not active
    if (token.condition && activeVariants) {
      const activeForSlot = activeVariants[token.condition.slotId];
      if (activeForSlot !== token.condition.variantId) continue;
    }

    const value = tokens[token.path];
    if (value === undefined) continue;

    const strValue = String(value);

    // --- CSS Variables ---
    if (token.cssVars) {
      for (const cssVar of token.cssVars) {
        if (token.valueType === 'font') {
          // Font tokens need to resolve the catalog ID to a CSS font-family
          cssVars.set(cssVar, resolveFontFamily(strValue, String(token.defaultValue)));
        } else {
          cssVars.set(cssVar, strValue);
        }
      }
    }

    // --- Derived Variables ---
    if (token.derivedVars) {
      for (const dv of token.derivedVars) {
        const derived = applyDerivedTransform(dv.transform, strValue);
        if (derived) {
          cssVars.set(dv.cssVar, derived);
        }
      }
    }

    // --- Font Smoothing (body style, not CSS var) ---
    if (token.path === 'typography.fontSmoothing') {
      if (value === true) {
        bodyStyles.set('-webkit-font-smoothing', 'antialiased');
        bodyStyles.set('-moz-osx-font-smoothing', 'grayscale');
      } else {
        bodyStyles.set('-webkit-font-smoothing', 'none');
        bodyStyles.set('-moz-osx-font-smoothing', 'unset');
      }
      continue;
    }

    // --- Window shape tokens (special grouped handling) ---
    if (token.path === 'window.border.color') {
      windowDeclarations.push(`border-color: ${strValue};`);
      hasWindowOverrides = true;
    }
    if (token.path === 'window.border.radius') {
      windowRadius = Math.max(0, Math.min(Number(value), 24));
      windowDeclarations.push(`border-radius: ${windowRadius}px; overflow: hidden;`);
      hasWindowOverrides = true;
    }
    if (token.path === 'window.shadow') {
      windowShadow = Math.max(0, Math.min(Number(value), 32));
      const shadowAlpha = Math.min(0.45, 0.14 + windowShadow / 64);
      windowDeclarations.push(`box-shadow: 0 ${Math.max(2, windowShadow / 2)}px ${Math.max(2, windowShadow)}px rgba(0, 0, 0, ${shadowAlpha});`);
      hasWindowOverrides = true;
    }

    // --- Window opacity (special) ---
    if (token.path === 'window.opacity' && Number(value) < 100) {
      const opacity = Math.max(0.3, Math.min(1, Number(value) / 100));
      rules.push(`.user-desktop .window { background: transparent; }`);
      rules.push(`.user-desktop .windowInner { opacity: ${opacity}; }`);
      rules.push(`.user-desktop .window:hover .windowInner, .user-desktop .window:focus-within .windowInner { opacity: 1; }`);
    }

    // --- Title bar (track for stripes opacity) ---
    if (token.path === 'window.titleBar.background') {
      hasTitleBarBgOverride = true;
    }

    // --- Generic CSS rules (for new tokens with cssRule that aren't special-cased) ---
    if (token.cssRule && !token.excludeFromImmune && token.profileKey === null) {
      // New tokens: emit their cssRule directly (not grouped)
      rules.push(`${token.cssRule.selector} { ${token.cssRule.property}: ${strValue}; }`);
    }

    // --- Control overrides (grouped) ---
    if (token.path === 'controls.button.background') {
      controlDeclarations.push(`background: ${strValue};`);
      hasControlOverrides = true;
    }
    if (token.path === 'controls.button.textColor') {
      controlDeclarations.push(`color: ${strValue};`);
      hasControlOverrides = true;
    }
    if (token.path === 'controls.button.borderColor') {
      controlDeclarations.push(`border-color: ${strValue};`);
      hasControlOverrides = true;
    }
    if (token.path === 'controls.borderRadius') {
      controlRadius = Math.max(0, Math.min(Number(value), 24));
      controlDeclarations.push(`border-radius: ${controlRadius}px;`);
      hasControlOverrides = true;
    }
  }

  // --- Emit grouped window rules ---
  if (hasWindowOverrides) {
    rules.push(`.user-desktop .window { ${windowDeclarations.join(' ')} }`);
  }
  if (tokens['window.border.radius'] !== undefined) {
    const r = Math.max(0, windowRadius - 1);
    rules.push(`.user-desktop .windowInner { border-radius: ${r}px; overflow: hidden; }`);
    rules.push(`.user-desktop .titleBar { border-top-left-radius: ${r}px; border-top-right-radius: ${r}px; }`);
  }

  // --- Emit title bar rules ---
  const titleBarDecls: string[] = [];
  if (tokens['window.titleBar.background'] !== undefined) {
    titleBarDecls.push(`background: ${tokens['window.titleBar.background']};`);
  }
  if (tokens['window.titleBar.textColor'] !== undefined) {
    titleBarDecls.push(`color: ${tokens['window.titleBar.textColor']};`);
  }
  if (titleBarDecls.length > 0) {
    rules.push(`.user-desktop [eos-part="titlebar"] { ${titleBarDecls.join(' ')} }`);
  }
  if (tokens['window.titleBar.textColor'] !== undefined) {
    rules.push(`.user-desktop [eos-part="title"] { color: ${tokens['window.titleBar.textColor']}; }`);
  }
  // Title bar stripes: hide if explicitly disabled, dim if bg override
  if (tokens['window.titleBar.stripes'] === false) {
    rules.push(`.user-desktop .titleBarStripes { display: none; }`);
  } else if (hasTitleBarBgOverride) {
    rules.push(`.user-desktop .titleBarStripes { opacity: 0.35; }`);
  }

  // --- Emit label rule ---
  if (tokens['color.label'] !== undefined) {
    rules.push(`.user-desktop [eos-part="label"] { color: ${tokens['color.label']}; }`);
  }

  // --- Emit grouped control rules ---
  if (hasControlOverrides) {
    const notImmune = ':not([data-theme-immune] *)';
    const joined = controlDeclarations.join(' ');
    rules.push(`.user-desktop button${notImmune}, .user-desktop input${notImmune}, .user-desktop select${notImmune}, .user-desktop textarea${notImmune} { ${joined} }`);
    // Window control buttons: only apply border/radius, NOT background/color
    // (background comes from their own token or defaults to white)
    const windowButtonDecls = controlDeclarations.filter(
      (d) => !d.startsWith('background:') && !d.startsWith('color:')
    );
    if (windowButtonDecls.length > 0) {
      rules.push(`.user-desktop [eos-part="close"], .user-desktop [eos-part="zoom"], .user-desktop [eos-part="collapse"] { ${windowButtonDecls.join(' ')} }`);
    }
  }

  // --- Structural: inner bevel ---
  if (tokens['window.innerBevel'] === false) {
    rules.push(`.user-desktop .windowInner { border-color: transparent; }`);
  }

  // --- Structural: border style ---
  if (tokens['window.border.style'] && tokens['window.border.style'] !== 'solid') {
    rules.push(`.user-desktop .window { border-style: ${tokens['window.border.style']}; }`);
  }

  // --- Structural: per-corner radius ---
  const topRadius = tokens['window.border.topRadius'];
  const bottomRadius = tokens['window.border.bottomRadius'];
  if (typeof topRadius === 'number' && topRadius >= 0 && typeof bottomRadius === 'number' && bottomRadius >= 0) {
    rules.push(`.user-desktop .window { border-radius: ${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px; overflow: hidden; }`);
    rules.push(`.user-desktop .windowInner { border-radius: ${Math.max(0, topRadius - 1)}px ${Math.max(0, topRadius - 1)}px ${Math.max(0, bottomRadius - 1)}px ${Math.max(0, bottomRadius - 1)}px; overflow: hidden; }`);
    rules.push(`.user-desktop .titleBar { border-top-left-radius: ${Math.max(0, topRadius - 1)}px; border-top-right-radius: ${Math.max(0, topRadius - 1)}px; }`);
  } else if (typeof topRadius === 'number' && topRadius >= 0) {
    rules.push(`.user-desktop .window { border-radius: ${topRadius}px ${topRadius}px ${windowRadius}px ${windowRadius}px; overflow: hidden; }`);
    rules.push(`.user-desktop .titleBar { border-top-left-radius: ${Math.max(0, topRadius - 1)}px; border-top-right-radius: ${Math.max(0, topRadius - 1)}px; }`);
  } else if (typeof bottomRadius === 'number' && bottomRadius >= 0) {
    rules.push(`.user-desktop .window { border-radius: ${windowRadius}px ${windowRadius}px ${bottomRadius}px ${bottomRadius}px; overflow: hidden; }`);
  }

  // --- Structural: close button shape ---
  const buttonShape = tokens['window.closeButton.shape'];
  if (buttonShape === 'circle') {
    rules.push(`.user-desktop [eos-part="close"], .user-desktop [eos-part="zoom"], .user-desktop [eos-part="collapse"] { border-radius: 50%; }`);
  } else if (buttonShape === 'rounded') {
    rules.push(`.user-desktop [eos-part="close"], .user-desktop [eos-part="zoom"], .user-desktop [eos-part="collapse"] { border-radius: 3px; }`);
  }

  // --- Structural: selected icon style ---
  const selectedStyle = tokens['icon.selectedStyle'];
  if (selectedStyle && selectedStyle !== 'darken') {
    if (selectedStyle === 'highlight') {
      rules.push(`.user-desktop .selected .iconImage { filter: none; outline: 2px solid var(--selection); outline-offset: 2px; }`);
      rules.push(`.user-desktop .selected .iconImage svg { filter: none; }`);
    } else if (selectedStyle === 'outline') {
      rules.push(`.user-desktop .selected .iconImage { filter: none; outline: 2px dashed var(--selection); outline-offset: 1px; }`);
      rules.push(`.user-desktop .selected .iconImage svg { filter: none; }`);
    } else if (selectedStyle === 'none') {
      rules.push(`.user-desktop .selected .iconImage { filter: none; }`);
      rules.push(`.user-desktop .selected .iconImage svg { filter: none; }`);
    }
  }

  // --- Structural: cursor ---
  if (tokens['cursor.style'] && String(tokens['cursor.style']).trim()) {
    rules.push(`.user-desktop { cursor: ${tokens['cursor.style']}; }`);
  }

  // --- Custom cursor images (Skin system) ---
  // Each cursor.image.* token maps to CSS cursor rules on appropriate selectors
  const cursorImageMap: Record<string, { selectors: string[]; fallback: string }> = {
    'cursor.image.default': {
      selectors: ['.user-desktop'],
      fallback: 'default',
    },
    'cursor.image.pointer': {
      selectors: [
        '.user-desktop a',
        '.user-desktop button',
        '.user-desktop [role="button"]',
        '.user-desktop .cursor-pointer',
      ],
      fallback: 'pointer',
    },
    'cursor.image.grab': {
      selectors: ['.user-desktop .titleBar', '.user-desktop [style*="cursor: grab"]'],
      fallback: 'grab',
    },
    'cursor.image.grabbing': {
      selectors: ['.user-desktop .dragging', '.user-desktop [style*="cursor: grabbing"]'],
      fallback: 'grabbing',
    },
    'cursor.image.text': {
      selectors: [
        '.user-desktop input[type="text"]',
        '.user-desktop textarea',
        '.user-desktop [contenteditable]',
      ],
      fallback: 'text',
    },
    'cursor.image.wait': {
      selectors: ['.user-desktop .loading', '.user-desktop [aria-busy="true"]'],
      fallback: 'wait',
    },
    'cursor.image.move': {
      selectors: ['.user-desktop .cursor-move'],
      fallback: 'move',
    },
    'cursor.image.nwse-resize': {
      selectors: ['.user-desktop .resizeHandle', '.user-desktop [style*="cursor: nwse-resize"]'],
      fallback: 'nwse-resize',
    },
  };

  for (const [tokenPath, config] of Object.entries(cursorImageMap)) {
    const cursorUrl = tokens[tokenPath];
    if (cursorUrl && typeof cursorUrl === 'string' && cursorUrl.trim()) {
      // Parse hotspot from the URL or token (stored as JSON: "url|hotspotX|hotspotY")
      let url = cursorUrl;
      let hotX = 0;
      let hotY = 0;
      if (cursorUrl.includes('|')) {
        const parts = cursorUrl.split('|');
        url = parts[0];
        hotX = parseInt(parts[1], 10) || 0;
        hotY = parseInt(parts[2], 10) || 0;
      }
      const resolvedUrl = resolveAssetUrl(url);
      const selector = config.selectors.join(', ');
      rules.push(`${selector} { cursor: url('${resolvedUrl}') ${hotX} ${hotY}, ${config.fallback} !important; }`);
    }
  }

  // --- Sprite chrome (Skin system) ---
  // 1. Assemble border-image-slice from individual slice tokens
  const sTop = Number(tokens['chrome.sprite.sliceTop'] ?? 20);
  const sRight = Number(tokens['chrome.sprite.sliceRight'] ?? 20);
  const sBottom = Number(tokens['chrome.sprite.sliceBottom'] ?? 20);
  const sLeft = Number(tokens['chrome.sprite.sliceLeft'] ?? 20);

  if (tokens['chrome.sprite.sliceTop'] !== undefined || tokens['chrome.sprite.sliceRight'] !== undefined ||
      tokens['chrome.sprite.sliceBottom'] !== undefined || tokens['chrome.sprite.sliceLeft'] !== undefined) {
    cssVars.set('--eos-chrome-sprite-slice', `${sTop} ${sRight} ${sBottom} ${sLeft}`);
    cssVars.set('--eos-chrome-sprite-border-width', `${sTop}px ${sRight}px ${sBottom}px ${sLeft}px`);
  }

  // 2. Wrap all sprite URL values in url() for CSS consumption
  //    The main loop sets raw URL strings; CSS needs url('...')
  for (const [varName, varValue] of cssVars) {
    if (varName.includes('sprite') && typeof varValue === 'string' &&
        varValue.startsWith('/api/') && !varValue.startsWith('url(')) {
      cssVars.set(varName, `url('${resolveAssetUrl(varValue)}')`);
    }
  }

  // 3. Add px units to sprite button dimensions
  if (tokens['buttons.sprite.width'] !== undefined) {
    cssVars.set('--eos-sprite-button-width', `${tokens['buttons.sprite.width']}px`);
  }
  if (tokens['buttons.sprite.height'] !== undefined) {
    cssVars.set('--eos-sprite-button-height', `${tokens['buttons.sprite.height']}px`);
  }

  return { cssVars, rules, bodyStyles };
}

// ---------------------------------------------------------------------------
// DOM application
// ---------------------------------------------------------------------------

const STYLE_ID = 'eternalos-appearance-overrides';

/** Apply compiled CSS to the DOM */
export function applyCompiledTokens(compiled: CompiledCSS): void {
  const root = document.documentElement;

  // Set CSS variables on :root
  for (const [prop, value] of compiled.cssVars) {
    root.style.setProperty(prop, value);
  }

  // Set body styles (font smoothing)
  for (const [prop, value] of compiled.bodyStyles) {
    document.body.style.setProperty(prop, value);
  }

  // Inject structured CSS rules
  document.getElementById(STYLE_ID)?.remove();
  if (compiled.rules.length > 0) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = compiled.rules.join('\n');
    document.head.appendChild(style);
  }
}

/** Clear all CSS set by the token system */
export function clearCompiledTokens(): void {
  const root = document.documentElement;

  // Clear all tracked CSS variables
  for (const cssVar of getAllCSSVars()) {
    root.style.removeProperty(cssVar);
  }

  // Clear font smoothing
  document.body.style.removeProperty('-webkit-font-smoothing');
  document.body.style.removeProperty('-moz-osx-font-smoothing');

  // Remove injected style elements
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById('eternalos-custom-css')?.remove();
}

// ---------------------------------------------------------------------------
// Token resolution from CustomAppearance (backward compat bridge)
// ---------------------------------------------------------------------------

/**
 * Convert a CustomAppearance object (flat fields) to a ResolvedTokens map.
 * This bridges the old interface to the new compiler.
 */
export function resolveTokensFromAppearance(
  appearance: Record<string, unknown>
): ResolvedTokens {
  const tokens: ResolvedTokens = {};

  for (const token of TOKEN_REGISTRY) {
    if (token.profileKey) {
      const value = appearance[token.profileKey];
      if (value !== undefined) {
        tokens[token.path] = value as string | number | boolean;
      }
    }
  }

  // Also merge designTokens blob if present
  const designTokens = appearance['designTokens'];
  if (designTokens && typeof designTokens === 'object') {
    for (const [path, value] of Object.entries(designTokens as Record<string, unknown>)) {
      if (value !== undefined) {
        tokens[path] = value as string | number | boolean;
      }
    }
  }

  return tokens;
}
