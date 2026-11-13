import { beforeEach, expect, test, describe, vi } from 'vitest';
import type { CustomAppearance } from './appearanceStore';

// appearanceStore reads localStorage at import time (loadSavedAppearance) and
// pulls in the API client. Stub localStorage before import and mock the API so
// the pure profile↔appearance + token-routing helpers can be tested in node.
vi.hoisted(() => {
  const g = globalThis as unknown as { localStorage?: unknown };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});
vi.mock('../services/api', () => ({
  isApiConfigured: false,
  updateProfile: vi.fn().mockResolvedValue(undefined),
}));

import {
  profileToAppearance,
  appearanceToProfileFields,
  profileHasAppearance,
  buildTokenUpdate,
  getTokenValue,
  APPEARANCE_PROFILE_KEYS,
  useAppearanceStore,
} from './appearanceStore';
import { TOKEN_REGISTRY } from '../tokens/tokenSchema';

// A legacy flat token (maps to a top-level profile field) and an extended token
// (routed through the designTokens blob). Derived from the registry so these
// tests don't hardcode paths that may be renamed.
const flatToken = TOKEN_REGISTRY.find((t) => t.profileKey)!;
const extToken = TOKEN_REGISTRY.find((t) => !t.profileKey)!;

describe('profile ↔ appearance round-trip', () => {
  test('appearance → profile fields → appearance preserves every legacy field', () => {
    const appearance: CustomAppearance = {
      accentColor: '#ff0000',
      desktopColor: '#111111',
      systemFont: 'Chicago',
      fontSmoothing: false,
      windowBorderRadius: 8,
      windowOpacity: 0.9,
      customCSS: '.user-desktop { color: red; }',
    };
    const roundTripped = profileToAppearance(appearanceToProfileFields(appearance));
    expect(roundTripped).toEqual(appearance);
  });

  test('only defined values are carried across (no undefined keys leak in)', () => {
    const fields = appearanceToProfileFields({ accentColor: '#abc' });
    expect(fields).toEqual({ accentColor: '#abc' });
    expect(Object.keys(fields)).not.toContain('desktopColor');

    const appearance = profileToAppearance({ accentColor: '#abc', unrelated: 'x' });
    expect(appearance).toEqual({ accentColor: '#abc' });
    expect('unrelated' in appearance).toBe(false);
  });

  test('designTokens and variants round-trip when present', () => {
    const appearance: CustomAppearance = {
      designTokens: { 'menuBar.background': '#222' },
      variants: { 'window.titleBar': 'gradient' },
    };
    const roundTripped = profileToAppearance(appearanceToProfileFields(appearance));
    expect(roundTripped.designTokens).toEqual({ 'menuBar.background': '#222' });
    expect(roundTripped.variants).toEqual({ 'window.titleBar': 'gradient' });
  });

  test('empty designTokens/variants blobs are dropped, not persisted as noise', () => {
    const fields = appearanceToProfileFields({
      accentColor: '#abc',
      designTokens: {},
      variants: {},
    });
    expect(fields).toEqual({ accentColor: '#abc' });
    expect('designTokens' in fields).toBe(false);
    expect('variants' in fields).toBe(false);
  });

  test('profileHasAppearance detects any appearance field, and only those', () => {
    expect(profileHasAppearance({ accentColor: '#abc' })).toBe(true);
    expect(profileHasAppearance({ username: 'bob', bio: 'hi' })).toBe(false);
    expect(profileHasAppearance({})).toBe(false);
  });

  test('every declared profile key survives the round-trip', () => {
    // Give each legacy key a placeholder value and confirm none are dropped.
    const appearance = Object.fromEntries(
      APPEARANCE_PROFILE_KEYS.map((k) => [k, k === 'fontSmoothing' ? true : `v-${k}`])
    ) as CustomAppearance;
    const roundTripped = profileToAppearance(appearanceToProfileFields(appearance));
    expect(roundTripped).toEqual(appearance);
  });
});

describe('buildTokenUpdate token routing', () => {
  test('a legacy (profileKey) token writes a flat field', () => {
    const update = buildTokenUpdate(flatToken.path, '#123456', {});
    expect(update).toEqual({ [flatToken.profileKey as string]: '#123456' });
  });

  test('an extended token writes into the designTokens blob', () => {
    const update = buildTokenUpdate(extToken.path, '#654321', {});
    expect(update).toEqual({ designTokens: { [extToken.path]: '#654321' } });
  });

  test('clearing an extended token to its default removes it from the blob', () => {
    const current: CustomAppearance = { designTokens: { [extToken.path]: '#654321' } };
    const update = buildTokenUpdate(extToken.path, extToken.defaultValue, current);
    // Last key removed → the blob collapses to undefined rather than `{}`.
    expect(update).toEqual({ designTokens: undefined });
  });

  test('clearing one extended token keeps the others in the blob', () => {
    const other = TOKEN_REGISTRY.find((t) => !t.profileKey && t.path !== extToken.path);
    if (!other) return; // only one extended token in the registry
    const current: CustomAppearance = {
      designTokens: { [extToken.path]: '#654321', [other.path]: '#aaa' },
    };
    const update = buildTokenUpdate(extToken.path, '', current);
    expect(update).toEqual({ designTokens: { [other.path]: '#aaa' } });
  });

  test('an unknown token path is a no-op', () => {
    expect(buildTokenUpdate('not.a.real.token', 'x', {})).toEqual({});
  });
});

describe('getTokenValue', () => {
  test('reads a legacy token from its flat field', () => {
    const appearance = { [flatToken.profileKey as string]: '#abcdef' } as CustomAppearance;
    expect(getTokenValue(flatToken.path, appearance)).toBe('#abcdef');
  });

  test('reads an extended token from the designTokens blob', () => {
    const appearance: CustomAppearance = { designTokens: { [extToken.path]: '#fedcba' } };
    expect(getTokenValue(extToken.path, appearance)).toBe('#fedcba');
  });

  test('an unknown token path reads undefined', () => {
    expect(getTokenValue('not.a.real.token', {})).toBeUndefined();
  });
});

describe('appearanceStore CSS + reset actions', () => {
  // DOM side-effects (applyCustomCSS / token apply) are guarded to no-op when
  // `document` is undefined, so these actions run in the node test env and we
  // assert the pure state transitions.
  beforeEach(() => {
    useAppearanceStore.setState({
      appearance: {},
      originalAppearance: {},
      customCSSPreview: undefined,
      customCSSPreviewSummary: undefined,
      hasUnsavedChanges: false,
      isLoading: false,
    });
  });

  test('setCustomCSS stores the CSS, clears any live preview, and marks unsaved', () => {
    useAppearanceStore.setState({ customCSSPreview: 'old', customCSSPreviewSummary: 'prev' });
    useAppearanceStore.getState().setCustomCSS('.window { color: red; }');
    const s = useAppearanceStore.getState();
    expect(s.appearance.customCSS).toContain('.window');
    expect(s.appearance.customCSS).toContain('color: red');
    expect(s.customCSSPreview).toBeUndefined();
    expect(s.customCSSPreviewSummary).toBeUndefined();
    expect(s.hasUnsavedChanges).toBe(true);
  });

  test('setCustomCSSPreview sets a preview without touching the saved appearance', () => {
    useAppearanceStore.getState().setCustomCSSPreview('.window { color: blue; }', 'make it blue');
    const s = useAppearanceStore.getState();
    expect(s.customCSSPreview).toContain('color: blue');
    expect(s.customCSSPreviewSummary).toBe('make it blue');
    // The saved appearance is untouched and nothing is marked unsaved by a preview.
    expect(s.appearance.customCSS).toBeUndefined();
    expect(s.hasUnsavedChanges).toBe(false);
  });

  test('clearCustomCSSPreview drops the preview and its summary', () => {
    useAppearanceStore.getState().setCustomCSSPreview('.x { color: green; }', 'sum');
    useAppearanceStore.getState().clearCustomCSSPreview();
    const s = useAppearanceStore.getState();
    expect(s.customCSSPreview).toBeUndefined();
    expect(s.customCSSPreviewSummary).toBeUndefined();
  });

  test('resetAppearance clears every appearance field and marks unsaved', () => {
    useAppearanceStore.setState({
      appearance: { accentColor: '#ff0000', customCSS: '.a { color: red; }' },
      customCSSPreview: 'live',
      hasUnsavedChanges: false,
    });
    useAppearanceStore.getState().resetAppearance();
    const s = useAppearanceStore.getState();
    expect(s.appearance).toEqual({});
    expect(s.customCSSPreview).toBeUndefined();
    expect(s.hasUnsavedChanges).toBe(true);
  });
});
