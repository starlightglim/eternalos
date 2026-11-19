import { beforeEach, expect, test, describe, vi } from 'vitest';
import type { CustomAppearance } from './appearanceStore';

// appearanceStore reads localStorage at import time (loadSavedAppearance) and
// pulls in the API client. Stub localStorage before import and mock the API so
// the pure profile↔appearance + token-routing helpers can be tested in node.
// The stub is a recording in-memory implementation (stashed on globalThis by
// vi.hoisted) so tests can also assert what the store persists to survive a
// reload.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as {
    localStorage?: unknown;
    __storageBacking?: Map<string, string>;
  };
  g.localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  g.__storageBacking = backing;
});
vi.mock('../services/api', () => ({
  isApiConfigured: true,
  updateProfile: vi.fn().mockResolvedValue(undefined),
}));

import {
  profileToAppearance,
  appearanceToProfileFields,
  profileHasAppearance,
  buildTokenUpdate,
  getTokenValue,
  APPEARANCE_PROFILE_KEYS,
  applyCSSRevertProfile,
  useAppearanceStore,
} from './appearanceStore';
import { updateProfile } from '../services/api';
import { TOKEN_REGISTRY } from '../tokens/tokenSchema';

/** The in-memory localStorage backing installed by vi.hoisted above. */
const storageBacking = (globalThis as unknown as { __storageBacking: Map<string, string> }).__storageBacking;
const APPEARANCE_STORAGE_KEY = 'eternalos-appearance';

const updateProfileMock = vi.mocked(updateProfile);

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
    storageBacking.clear();
    updateProfileMock.mockClear();
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
    expect(s.customCSSPreviewSummary).toBeUndefined();
    expect(s.hasUnsavedChanges).toBe(true);
  });

  test('resetAppearance drops extended state too (designTokens, variants, fonts, opacity)', () => {
    useAppearanceStore.setState({
      appearance: {
        systemFont: 'chicago',
        windowOpacity: 80,
        designTokens: { 'menuBar.background': '#222' },
        variants: { 'window.titleBar': 'gradient' },
      },
    });
    useAppearanceStore.getState().resetAppearance();
    expect(useAppearanceStore.getState().appearance).toEqual({});
  });

  test('reset keeps the last saved appearance in localStorage until it is saved (unsaved changes are discarded on reload)', () => {
    const saved: CustomAppearance = { accentColor: '#123456', customCSS: '.a { color: red; }' };
    // Simulate the pre-reset save that put this appearance in localStorage.
    storageBacking.set(APPEARANCE_STORAGE_KEY, JSON.stringify(saved));
    useAppearanceStore.setState({ appearance: { ...saved }, originalAppearance: { ...saved } });

    useAppearanceStore.getState().resetAppearance();
    // Reset is a local, unsaved change — persistence still holds the old rice,
    // so a reload before saving discards the reset (by design).
    expect(JSON.parse(storageBacking.get(APPEARANCE_STORAGE_KEY) ?? '{}')).toEqual(saved);
  });

  test('reset then save persists an empty appearance locally and sends no stale fields to the server', async () => {
    const saved: CustomAppearance = {
      accentColor: '#123456',
      customCSS: '.a { color: red; }',
      designTokens: { 'menuBar.background': '#222' },
      variants: { 'window.titleBar': 'gradient' },
    };
    useAppearanceStore.setState({ appearance: { ...saved }, originalAppearance: { ...saved } });
    updateProfileMock.mockClear();

    useAppearanceStore.getState().resetAppearance();
    await useAppearanceStore.getState().saveAppearance();

    const s = useAppearanceStore.getState();
    expect(s.hasUnsavedChanges).toBe(false);
    expect(s.originalAppearance).toEqual({});
    // A reload from localStorage starts from a clean slate.
    expect(storageBacking.get(APPEARANCE_STORAGE_KEY)).toBe('{}');
    // The server PATCH carries only defined fields — reset sends no stale
    // values and no leftover designTokens/variants blobs. (The server-side
    // profile keeps previously saved fields; clearing them requires explicit
    // tombstones the PATCH protocol does not have yet.)
    expect(updateProfileMock).toHaveBeenCalledTimes(1);
    expect(updateProfileMock.mock.calls[0][0]).toEqual({});
  });
});

describe('CSS history restore (applyCSSRevertProfile)', () => {
  // POST /api/css-history/:versionId/revert responds with the FULL updated
  // profile. The store must re-apply it through profileToAppearance — a
  // previous hand-rolled field list here dropped typography, windowOpacity,
  // designTokens, and variants, wiping them from the session and from
  // localStorage until the next full desktop sync.
  const revertProfile = {
    uid: 'u1',
    username: 'alice',
    displayName: 'Alice',
    wallpaper: 'classic',
    bio: 'not appearance',
    customCSS: '.window { border-radius: 8px; }',
    accentColor: '#000080',
    desktopColor: '#C0C0C0',
    systemFont: 'chicago',
    bodyFont: 'geneva',
    monoFont: 'monaco',
    fontSmoothing: true,
    windowOpacity: 80,
    designTokens: {
      'cursor.image.default': '/api/cursors/arrow.png|0|0',
      'chrome.sprite.url': '/api/css-assets/u1/a1/frame.png',
    },
    variants: { 'window.titleBar': 'gradient' },
  };

  beforeEach(() => {
    storageBacking.clear();
    updateProfileMock.mockClear();
    useAppearanceStore.setState({
      appearance: { accentColor: '#ff0000', systemFont: 'monaco', customCSS: '.x { color: red; }' },
      originalAppearance: {},
      customCSSPreview: 'live-preview',
      customCSSPreviewSummary: 'preview',
      hasUnsavedChanges: true,
      isLoading: false,
    });
  });

  test('applies the full profile — typography, opacity, designTokens, and variants survive the restore', () => {
    applyCSSRevertProfile(revertProfile);

    const s = useAppearanceStore.getState();
    expect(s.appearance.customCSS).toBe('.window { border-radius: 8px; }');
    expect(s.appearance.systemFont).toBe('chicago');
    expect(s.appearance.bodyFont).toBe('geneva');
    expect(s.appearance.monoFont).toBe('monaco');
    expect(s.appearance.windowOpacity).toBe(80);
    expect(s.appearance.designTokens).toEqual(revertProfile.designTokens);
    expect(s.appearance.variants).toEqual(revertProfile.variants);
    // Non-appearance profile fields never leak into the appearance store.
    expect('bio' in s.appearance).toBe(false);
    expect('username' in s.appearance).toBe(false);
  });

  test('the restored appearance is committed state: previews drop and nothing re-saves to the server', () => {
    applyCSSRevertProfile(revertProfile);

    const s = useAppearanceStore.getState();
    // The revert was already persisted server-side by the endpoint itself.
    expect(s.hasUnsavedChanges).toBe(false);
    expect(s.customCSSPreview).toBeUndefined();
    expect(s.customCSSPreviewSummary).toBeUndefined();
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  test('the restored appearance is persisted to localStorage so it survives reload', () => {
    applyCSSRevertProfile(revertProfile);

    const persisted = JSON.parse(storageBacking.get(APPEARANCE_STORAGE_KEY) ?? 'null');
    expect(persisted).toEqual(profileToAppearance(revertProfile));
    expect(persisted.systemFont).toBe('chicago');
    expect(persisted.designTokens['chrome.sprite.url']).toBe('/api/css-assets/u1/a1/frame.png');
    expect(persisted.variants['window.titleBar']).toBe('gradient');
  });

  test('restoring a profile without customCSS clears it (empty CSS is a valid restore target)', () => {
    applyCSSRevertProfile({ ...revertProfile, customCSS: undefined });
    expect(useAppearanceStore.getState().appearance.customCSS).toBeUndefined();
  });
});
