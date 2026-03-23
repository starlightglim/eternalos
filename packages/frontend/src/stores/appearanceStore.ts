/**
 * Appearance Store for EternalOS
 *
 * Manages all custom appearance settings via a design token system.
 *
 * Architecture:
 *   CustomAppearance → resolveTokens → compileTokensToCSS → applyCompiledTokens → DOM
 *   Profile fields ↔ CustomAppearance via profileToAppearance / appearanceToProfileFields
 *   TOKEN_REGISTRY (tokenSchema.ts) is the single source of truth for all properties.
 */

import { create } from 'zustand';
import { updateProfile, isApiConfigured } from '../services/api';
import { normalizeCSSSelectorAliases } from '../utils/cssSelectorAliases';
import {
  compileTokensToCSS,
  applyCompiledTokens,
  clearCompiledTokens,
  resolveTokensFromAppearance,
} from '../tokens/tokenCompiler';
import { TOKEN_REGISTRY } from '../tokens/tokenSchema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CustomAppearance {
  // Colors
  accentColor?: string;
  desktopColor?: string;
  windowBgColor?: string;
  titleBarBgColor?: string;
  titleBarTextColor?: string;
  windowBorderColor?: string;
  buttonBgColor?: string;
  buttonTextColor?: string;
  buttonBorderColor?: string;
  labelColor?: string;
  // Typography
  systemFont?: string;
  bodyFont?: string;
  monoFont?: string;
  fontSmoothing?: boolean;
  // Shape
  windowBorderRadius?: number;
  controlBorderRadius?: number;
  windowShadow?: number;
  windowOpacity?: number;
  // Custom CSS
  customCSS?: string;
  // Extended design tokens (for new properties beyond legacy fields)
  designTokens?: Record<string, string | number | boolean>;
  // Variant selections per slot (e.g. { 'window.chrome': 'flat', 'window.titleBar': 'gradient' })
  variants?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Profile ↔ Appearance helpers
// ---------------------------------------------------------------------------

/** All legacy appearance field names that map to flat UserProfile fields. */
export const APPEARANCE_PROFILE_KEYS: (keyof CustomAppearance)[] = [
  'accentColor', 'desktopColor', 'windowBgColor',
  'titleBarBgColor', 'titleBarTextColor', 'windowBorderColor',
  'buttonBgColor', 'buttonTextColor', 'buttonBorderColor',
  'labelColor',
  'systemFont', 'bodyFont', 'monoFont', 'fontSmoothing',
  'windowBorderRadius', 'controlBorderRadius', 'windowShadow', 'windowOpacity',
  'customCSS',
];

/**
 * Extract a CustomAppearance from any object that has matching keys
 * (e.g., a UserProfile from the API). Only includes defined values.
 */
export function profileToAppearance(profile: Record<string, unknown>): CustomAppearance {
  const appearance: Record<string, unknown> = {};
  for (const key of APPEARANCE_PROFILE_KEYS) {
    if (profile[key] !== undefined) {
      appearance[key] = profile[key];
    }
  }
  // Also carry over designTokens blob if present
  if (profile['designTokens'] !== undefined) {
    appearance['designTokens'] = profile['designTokens'];
  }
  // Carry over variant selections
  if (profile['variants'] !== undefined) {
    appearance['variants'] = profile['variants'];
  }
  return appearance as CustomAppearance;
}

/**
 * Convert a CustomAppearance into a flat object suitable for updateProfile().
 */
export function appearanceToProfileFields(appearance: CustomAppearance): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of APPEARANCE_PROFILE_KEYS) {
    if (appearance[key] !== undefined) {
      fields[key] = appearance[key];
    }
  }
  if (appearance.designTokens && Object.keys(appearance.designTokens).length > 0) {
    fields['designTokens'] = appearance.designTokens;
  }
  if (appearance.variants && Object.keys(appearance.variants).length > 0) {
    fields['variants'] = appearance.variants;
  }
  return fields;
}

/**
 * Check whether a profile has any appearance settings at all.
 */
export function profileHasAppearance(profile: Record<string, unknown>): boolean {
  return APPEARANCE_PROFILE_KEYS.some((key) => profile[key] !== undefined);
}

// ---------------------------------------------------------------------------
// Apply / Clear — delegates to the token compiler
// ---------------------------------------------------------------------------

/**
 * Apply custom appearance settings to the document.
 * Exported for use in visitor mode (to apply owner's appearance).
 */
export function applyAppearance(appearance: CustomAppearance) {
  // Resolve flat appearance fields to token map
  const tokens = resolveTokensFromAppearance(appearance as Record<string, unknown>);

  // Compile tokens → CSS (pure function, no DOM)
  // Pass active variants so conditional tokens are filtered correctly
  const compiled = compileTokensToCSS(tokens, appearance.variants);

  // Apply to DOM (CSS vars + structured rules + body styles)
  applyCompiledTokens(compiled);

  // Apply custom CSS (separate pipeline: scoping + sanitization)
  applyCustomCSS(appearance.customCSS);
}

/**
 * Clear all custom appearance settings from the document.
 * Used when leaving visitor mode to restore the user's own appearance.
 */
export function clearAppearance() {
  clearCompiledTokens();
}

/**
 * Update a design token by its path. Routes to the correct storage location:
 * - Tokens with profileKey → flat fields on CustomAppearance
 * - Tokens without profileKey → designTokens blob
 */
export function buildTokenUpdate(
  path: string,
  value: string | number | boolean | undefined,
  currentAppearance: CustomAppearance
): Partial<CustomAppearance> {
  const token = TOKEN_REGISTRY.find((t) => t.path === path);
  if (!token) return {};

  if (token.profileKey) {
    // Legacy flat field
    return { [token.profileKey]: value };
  } else {
    // Extended token → designTokens blob
    const dt = { ...(currentAppearance.designTokens || {}) };
    if (value === undefined || value === '' || value === token.defaultValue) {
      delete dt[path];
    } else {
      dt[path] = value;
    }
    return { designTokens: Object.keys(dt).length > 0 ? dt : undefined };
  }
}

/**
 * Read a token value from a CustomAppearance by path.
 */
export function getTokenValue(
  path: string,
  appearance: CustomAppearance
): string | number | boolean | undefined {
  const token = TOKEN_REGISTRY.find((t) => t.path === path);
  if (!token) return undefined;

  if (token.profileKey) {
    return (appearance as Record<string, unknown>)[token.profileKey] as string | number | boolean | undefined;
  } else {
    return appearance.designTokens?.[path];
  }
}

// ---------------------------------------------------------------------------
// Custom CSS injection (security scoping + sanitization)
// ---------------------------------------------------------------------------

const ALLOWED_CSS_URL_PREFIXES = [
  '/api/css-assets/',
  '/api/wallpaper/',
  '/api/icon/',
  '/api/sounds/',
  '/api/cursors/',
  '/api/bazaar/assets/',
];

function isAllowedCSSUrl(urlValue: string): boolean {
  const normalized = urlValue.trim().replace(/^['"]|['"]$/g, '');
  const lowerUrl = normalized.toLowerCase();
  if (
    lowerUrl.startsWith('javascript:') ||
    lowerUrl.startsWith('data:') ||
    lowerUrl.startsWith('vbscript:') ||
    lowerUrl.startsWith('file:')
  ) {
    return false;
  }
  if (normalized.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) {
    return false;
  }
  return ALLOWED_CSS_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function sanitizeCSSUrls(css: string): string {
  return css.replace(
    /url\s*\(\s*(['"]?)([^)]*?)\1\s*\)/gi,
    (_match, _quote, urlValue) => {
      const cleanedUrl = urlValue.replace(/[\r\n\t]/g, '').trim();
      if (isAllowedCSSUrl(cleanedUrl)) {
        return `url('${cleanedUrl}')`;
      }
      return 'url(about:blank)';
    }
  );
}

export function applyCustomCSS(css: string | undefined) {
  document.getElementById('eternalos-custom-css')?.remove();
  if (!css || !css.trim()) return;

  const normalizedCSS = normalizeCSSSelectorAliases(css);
  const sanitizedCSS = sanitizeCSSUrls(normalizedCSS);
  const scopedCSS = scopeCSSToUserDesktop(sanitizedCSS);

  const style = document.createElement('style');
  style.id = 'eternalos-custom-css';
  style.textContent = scopedCSS;
  document.head.appendChild(style);
}

function parseTopLevelRules(css: string): Array<{ selector: string; body: string }> {
  const rules: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let current = '';
  let selectorEnd = -1;
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) selectorEnd = current.length;
      depth++;
      current += ch;
    } else if (ch === '}') {
      if (depth <= 0) {
        depth = 0;
        current = '';
        selectorEnd = -1;
        continue;
      }
      depth--;
      current += ch;
      if (depth === 0) {
        const selector = current.slice(0, selectorEnd).trim();
        const body = current.slice(selectorEnd + 1, current.length - 1).trim();
        if (selector) rules.push({ selector, body });
        current = '';
        selectorEnd = -1;
      }
    } else {
      current += ch;
    }
  }
  return rules;
}

function scopeCSSToUserDesktop(css: string): string {
  if (!css.trim()) return '';
  const rules = parseTopLevelRules(css);
  const scopedRules: string[] = [];

  for (const { selector, body } of rules) {
    if (selector.startsWith('@keyframes') || selector.startsWith('@-webkit-keyframes')) {
      scopedRules.push(`${selector} { ${body} }`);
      continue;
    }
    if (selector.startsWith('@media') || selector.startsWith('@supports')) {
      scopedRules.push(`${selector} { ${scopeCSSToUserDesktop(body)} }`);
      continue;
    }
    if (selector.startsWith('@font-face')) continue;

    const scopedSelectors = selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        if (s.startsWith('.user-desktop')) return s;
        if (s === ':root' || s === 'body' || s === 'html') return '.user-desktop';
        return `.user-desktop ${s}`;
      })
      .join(', ');

    scopedRules.push(`${scopedSelectors} { ${body} }`);
  }

  return scopedRules.join('\n');
}

// ---------------------------------------------------------------------------
// Local persistence
// ---------------------------------------------------------------------------

const APPEARANCE_STORAGE_KEY = 'eternalos-appearance';

function loadSavedAppearance(): CustomAppearance {
  try {
    const saved = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // Ignore
  }
  return {};
}

function saveLocalAppearance(appearance: CustomAppearance) {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Ignore
  }
}

// ---------------------------------------------------------------------------
// Zustand Store
// ---------------------------------------------------------------------------

interface AppearanceStore {
  appearance: CustomAppearance;
  originalAppearance: CustomAppearance;
  customCSSPreview?: string;
  customCSSPreviewSummary?: string;
  isLoading: boolean;
  hasUnsavedChanges: boolean;

  updateAppearance: (updates: Partial<CustomAppearance>) => void;
  setAccentColor: (color: string) => void;
  setDesktopColor: (color: string) => void;
  setWindowBgColor: (color: string) => void;
  setFontSmoothing: (enabled: boolean) => void;
  setCustomCSS: (css: string) => void;
  setCustomCSSPreview: (css: string, summary?: string) => void;
  clearCustomCSSPreview: () => void;
  resetAppearance: () => void;
  saveAppearance: () => Promise<void>;
  loadAppearance: (appearance: CustomAppearance) => void;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => {
  const initialAppearance = loadSavedAppearance();

  queueMicrotask(() => {
    applyAppearance(initialAppearance);
  });

  return {
    appearance: initialAppearance,
    originalAppearance: initialAppearance,
    customCSSPreview: undefined,
    customCSSPreviewSummary: undefined,
    isLoading: false,
    hasUnsavedChanges: false,

    updateAppearance: (updates: Partial<CustomAppearance>) => {
      const newAppearance = { ...get().appearance, ...updates };
      applyAppearance(newAppearance);
      set({ appearance: newAppearance, hasUnsavedChanges: true });
    },

    setAccentColor: (color: string) => {
      get().updateAppearance({ accentColor: color });
    },

    setDesktopColor: (color: string) => {
      get().updateAppearance({ desktopColor: color });
    },

    setWindowBgColor: (color: string) => {
      get().updateAppearance({ windowBgColor: color });
    },

    setFontSmoothing: (enabled: boolean) => {
      get().updateAppearance({ fontSmoothing: enabled });
    },

    setCustomCSS: (css: string) => {
      const normalizedCSS = normalizeCSSSelectorAliases(css);
      const newAppearance = { ...get().appearance, customCSS: normalizedCSS };
      applyCustomCSS(normalizedCSS);
      set({
        appearance: newAppearance,
        customCSSPreview: undefined,
        customCSSPreviewSummary: undefined,
        hasUnsavedChanges: true,
      });
    },

    setCustomCSSPreview: (css: string, summary?: string) => {
      const normalizedCSS = normalizeCSSSelectorAliases(css);
      applyCustomCSS(normalizedCSS);
      set({ customCSSPreview: normalizedCSS, customCSSPreviewSummary: summary });
    },

    clearCustomCSSPreview: () => {
      applyCustomCSS(get().appearance.customCSS);
      set({ customCSSPreview: undefined, customCSSPreviewSummary: undefined });
    },

    resetAppearance: () => {
      clearAppearance();
      set({
        appearance: {},
        customCSSPreview: undefined,
        customCSSPreviewSummary: undefined,
        hasUnsavedChanges: true,
      });
    },

    saveAppearance: async () => {
      const { appearance } = get();
      set({ isLoading: true });

      try {
        saveLocalAppearance(appearance);

        if (isApiConfigured) {
          await updateProfile(appearanceToProfileFields(appearance) as Parameters<typeof updateProfile>[0]);
        }

        set({
          originalAppearance: appearance,
          customCSSPreview: undefined,
          customCSSPreviewSummary: undefined,
          hasUnsavedChanges: false,
          isLoading: false,
        });
      } catch (error) {
        console.error('Failed to save appearance:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    loadAppearance: (appearance: CustomAppearance) => {
      applyAppearance(appearance);
      saveLocalAppearance(appearance);
      set({
        appearance,
        originalAppearance: appearance,
        customCSSPreview: undefined,
        customCSSPreviewSummary: undefined,
        hasUnsavedChanges: false,
      });
    },
  };
});
