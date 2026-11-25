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
import { sanitizeCustomCSS } from '../utils/cssSanitizer';
import { normalizeCSSSelectorAliases } from '../utils/cssSelectorAliases';
import {
  compileTokensToCSS,
  applyCompiledTokens,
  clearCompiledTokens,
  resolveTokensFromAppearance,
} from '../tokens/tokenCompiler';
import { findTokenDefinition } from '../tokens/tokenSchema';

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
 *
 * A key that is PRESENT with an `undefined` value is an explicit local clear
 * (Appearance "Reset", a preset switch away from a themed rice, or a
 * per-control reset button all set fields to undefined). It is sent as
 * `null`, which the server treats as "remove this saved field" — otherwise
 * previously saved fields would survive the reset and come back on reload.
 * Keys that are simply absent are left out, as before.
 */
export function appearanceToProfileFields(appearance: CustomAppearance): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of APPEARANCE_PROFILE_KEYS) {
    const value = appearance[key];
    if (value !== undefined) {
      fields[key] = value;
    } else if (key in appearance) {
      fields[key] = null;
    }
  }
  if (appearance.designTokens && Object.keys(appearance.designTokens).length > 0) {
    fields['designTokens'] = appearance.designTokens;
  } else if ('designTokens' in appearance && appearance.designTokens === undefined) {
    fields['designTokens'] = null;
  }
  if (appearance.variants && Object.keys(appearance.variants).length > 0) {
    fields['variants'] = appearance.variants;
  } else if ('variants' in appearance && appearance.variants === undefined) {
    fields['variants'] = null;
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
 * Apply the profile returned by a CSS-history revert
 * (POST /api/css-history/:versionId/revert) to the appearance store.
 *
 * The revert endpoint responds with the FULL updated profile, not just the
 * restored customCSS. The restore must therefore flow through
 * profileToAppearance: a hand-rolled field list here previously dropped
 * typography (systemFont/bodyFont/monoFont), windowOpacity, designTokens, and
 * variants — wiping them from the session (and localStorage) until the next
 * full desktop sync.
 */
export function applyCSSRevertProfile(profile: Record<string, unknown>): void {
  useAppearanceStore.getState().loadAppearance(profileToAppearance(profile));
}

/**
 * Update a design token by its path. Routes to the correct storage location:
 * - Tokens with profileKey → flat fields on CustomAppearance
 * - Tokens without profileKey → designTokens blob
 *
 * Uses findTokenDefinition so variant-registered conditional tokens (the
 * sprite/skin system — chrome.sprite.*, buttons.sprite.*, …) route through
 * the same pipeline as registry tokens; unknown paths still no-op.
 */
export function buildTokenUpdate(
  path: string,
  value: string | number | boolean | undefined,
  currentAppearance: CustomAppearance
): Partial<CustomAppearance> {
  const token = findTokenDefinition(path);
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
  const token = findTokenDefinition(path);
  if (!token) return undefined;

  if (token.profileKey) {
    return (appearance as Record<string, unknown>)[token.profileKey] as string | number | boolean | undefined;
  } else {
    return appearance.designTokens?.[path];
  }
}

// ---------------------------------------------------------------------------
// Custom CSS injection
// ---------------------------------------------------------------------------
// The security-critical scoping + sanitization transform lives in
// `utils/cssSanitizer.ts` (pure, unit-tested). This is only the DOM wrapper.

export function applyCustomCSS(css: string | undefined) {
  if (typeof document === 'undefined') return;
  document.getElementById('eternalos-custom-css')?.remove();

  const scopedCSS = sanitizeCustomCSS(css);
  if (!scopedCSS) return;

  const style = document.createElement('style');
  style.id = 'eternalos-custom-css';
  style.textContent = scopedCSS;
  document.head.appendChild(style);
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
  /** Throw away unsaved edits: back to the last saved look. */
  discardChanges: () => void;
  saveAppearance: () => Promise<void>;
  loadAppearance: (appearance: CustomAppearance) => void;
  /**
   * Restore an exact appearance snapshot — the .estheme preview Revert path.
   * Unlike loadAppearance this NEVER persists: the restored state is whatever
   * the user had before the preview (saved or not), so localStorage keeps the
   * last-saved mirror and the unsaved flag is whatever the snapshot carried.
   */
  restoreAppearanceSnapshot: (appearance: CustomAppearance, wasUnsaved: boolean) => void;
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => {
  const initialAppearance = loadSavedAppearance();

  // Apply saved appearance once the store is created. Guard on `document` so
  // importing the store without a DOM (SSR, unit tests) can't throw an
  // unhandled rejection from the microtask — there is nothing to paint anyway.
  if (typeof document !== 'undefined') {
    queueMicrotask(() => {
      applyAppearance(initialAppearance);
    });
  }

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
      // Mark every resettable field as explicitly cleared (present but
      // undefined). The next save turns these into `null` tombstones in the
      // PATCH payload (see appearanceToProfileFields), so the server REMOVES
      // the saved fields instead of keeping them around to resurface on the
      // next reload.
      const cleared: Record<string, unknown> = {};
      for (const key of APPEARANCE_PROFILE_KEYS) {
        cleared[key] = undefined;
      }
      cleared['designTokens'] = undefined;
      cleared['variants'] = undefined;
      set({
        appearance: cleared as CustomAppearance,
        customCSSPreview: undefined,
        customCSSPreviewSummary: undefined,
        hasUnsavedChanges: true,
      });
    },

    discardChanges: () => {
      get().restoreAppearanceSnapshot(get().originalAppearance, false);
      set({ customCSSPreview: undefined, customCSSPreviewSummary: undefined });
    },

    saveAppearance: async () => {
      const { appearance } = get();
      set({ isLoading: true });

      try {
        // Server first: mirror the appearance into localStorage only after
        // the PATCH is acknowledged. Persisting before the request meant a
        // refused save (offline / 401 / 429 / 500) left the unsaved rice in
        // localStorage as if saved — a reload painted it until the next
        // full desktop sync.
        if (isApiConfigured) {
          await updateProfile(appearanceToProfileFields(appearance) as Parameters<typeof updateProfile>[0]);
        }
        // Demo mode (API not configured) has no server that can refuse the
        // save — the local mirror is the source of truth, so it still saves.
        saveLocalAppearance(appearance);

        set({
          originalAppearance: appearance,
          customCSSPreview: undefined,
          customCSSPreviewSummary: undefined,
          hasUnsavedChanges: false,
          isLoading: false,
        });
      } catch (error) {
        console.error('Failed to save appearance:', error);
        // Nothing is committed on failure: the edit stays in `appearance`
        // (still painted as a live preview) and `hasUnsavedChanges` keeps
        // marking it unsaved so the caller's save-failure UX can surface it.
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

    restoreAppearanceSnapshot: (appearance: CustomAppearance, wasUnsaved: boolean) => {
      // Paint the exact pre-preview state without touching persistence: the
      // localStorage mirror still holds the last-saved appearance, and the
      // unsaved flag returns to whatever the snapshot carried (a preview over
      // unsaved manual edits reverts to those unsaved edits).
      applyAppearance(appearance);
      set({ appearance, hasUnsavedChanges: wasUnsaved });
    },
  };
});
