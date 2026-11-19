import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The preview session drives the real appearance and sound stores (their DOM
// touch points are guarded), so localStorage is stubbed before any store
// import and the service modules are mocked — the uploads, profile PATCH, and
// wallpaper saves are recorded for assertion, exactly like
// appearanceStore.test.ts / installTheme.test.ts do for their seams.

const mocks = vi.hoisted(() => {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as {
    localStorage?: unknown;
    __storageBacking?: Map<string, string>;
    __apiConfigured?: { value: boolean };
  };
  g.localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  g.__storageBacking = backing;
  g.__apiConfigured = { value: true };
  return {
    updateProfile: vi.fn(),
    uploadCursor: vi.fn(),
    uploadSound: vi.fn(),
    deleteCursor: vi.fn(),
    deleteSound: vi.fn(),
    uploadWallpaper: vi.fn(),
    setWallpaper: vi.fn(),
    setWallpaperMode: vi.fn(),
    apiConfigured: g.__apiConfigured,
  };
});

vi.mock('../services/api', () => ({
  // The real export is a boolean constant; a module-level getter keeps the
  // mock reading the live flag per access.
  get isApiConfigured() {
    return mocks.apiConfigured.value;
  },
  updateProfile: mocks.updateProfile,
}));
vi.mock('../services/transport', () => ({
  API_URL: 'http://api.test',
  get isApiConfigured() {
    return mocks.apiConfigured.value;
  },
}));
vi.mock('../services/assets', () => ({
  uploadCursor: mocks.uploadCursor,
  uploadSound: mocks.uploadSound,
  deleteCursor: mocks.deleteCursor,
  deleteSound: mocks.deleteSound,
  getCursorUrl: vi.fn((path: string) => `http://api.test${path}`),
}));
vi.mock('../services/appearance', () => ({
  uploadWallpaper: mocks.uploadWallpaper,
}));
vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: () => ({
      setWallpaper: mocks.setWallpaper,
      setWallpaperMode: mocks.setWallpaperMode,
    }),
  },
}));

import { useAppearanceStore } from '../stores/appearanceStore';
import { useSoundStore } from '../stores/soundStore';
import { useEsthemePreviewStore } from './themePreviewStore';
import { THEME_LINEAGE_TOKEN_KEY } from './importEstheme';
import { exportCurrentTheme } from '../utils/exportTheme';
import { parseEsthemeBundle } from '../utils/estheme';
import { buildFullThemeBundle, buildTestBundle } from './bundleFixtures';
import type { UserProfile } from '../types';

const SEED_APPEARANCE = {
  accentColor: '#111111',
  customCSS: '.user-desktop { color: blue; }',
};

const OLD_PACK = { name: 'Old Pack', sounds: { click: '/api/sounds/u1/old/click.mp3' } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateProfile.mockResolvedValue(undefined);
  mocks.uploadCursor.mockImplementation(async (_file: File, state: string) => ({
    success: true,
    asset: { cursorId: `cur-${state}`, url: `/api/cursors/u1/${state}/a.png`, hotspotX: 0, hotspotY: 0 },
  }));
  mocks.uploadSound.mockImplementation(async (_file: File, type: string) => ({
    success: true,
    asset: { soundId: `snd-${type}`, url: `/api/sounds/u1/${type}/a.mp3` },
  }));
  mocks.uploadWallpaper.mockResolvedValue({
    success: true,
    wallpaper: 'custom:u1/wallpaper/w1/wp.jpg',
    r2Key: 'u1/wallpaper/w1/wp.jpg',
    profile: {},
  });
  mocks.setWallpaper.mockResolvedValue(true);
  mocks.setWallpaperMode.mockResolvedValue(true);
  mocks.deleteCursor.mockResolvedValue({ success: true });
  mocks.deleteSound.mockResolvedValue({ success: true });
  mocks.apiConfigured.value = true;

  useAppearanceStore.getState().loadAppearance({ ...SEED_APPEARANCE });
  useSoundStore.getState().setCustomSoundPack({ ...OLD_PACK, sounds: { ...OLD_PACK.sounds } });
  useEsthemePreviewStore.setState({ status: 'idle', info: null, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('beginImport — unsaved preview', () => {
  test('applies every layer as an unsaved preview without any profile PATCH', async () => {
    const ok = await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    expect(ok).toBe(true);

    const { status, info } = useEsthemePreviewStore.getState();
    expect(status).toBe('active');
    expect(info?.name).toBe('Test Theme');
    expect(info?.forkedFrom?.name).toBe('Dreamcore Deluxe');
    expect(info?.appliedLayers).toContain('cursors');
    expect(info?.appliedLayers).toContain('sounds');
    expect(info?.appliedLayers).toContain('wallpaper');

    const appearance = useAppearanceStore.getState().appearance;
    expect(appearance.accentColor).toBe('#00ffcc');
    expect(appearance.customCSS).toBe('.user-desktop { color: red; }');
    expect(appearance.variants).toEqual({ 'window.titleBar': 'gradient' });
    expect(appearance.designTokens).toEqual({
      'window.titleBar.background': '#111111',
      'cursor.image.default': 'http://api.test/api/cursors/u1/default/a.png|3|4',
      'cursor.image.pointer': 'http://api.test/api/cursors/u1/pointer/a.png|0|0',
      [THEME_LINEAGE_TOKEN_KEY]: expect.any(String),
    });
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(true);

    // Sounds are previewed locally (the store mapping is set; nothing saved).
    const pack = useSoundStore.getState().customSoundPack;
    expect(pack?.name).toBe('Test Theme');
    expect(pack?.sounds).toEqual({
      click: '/api/sounds/u1/click/a.mp3',
      windowOpen: '/api/sounds/u1/windowOpen/a.mp3',
    });

    // Assets were uploaded through the normal upload services.
    expect(mocks.uploadCursor).toHaveBeenCalledTimes(2);
    expect(mocks.uploadSound).toHaveBeenCalledTimes(2);
    expect(mocks.uploadWallpaper).not.toHaveBeenCalled(); // wallpaper waits for Keep
    expect(mocks.updateProfile).not.toHaveBeenCalled(); // the preview saves nothing
  });

  test('a rejected (hostile) bundle changes nothing and surfaces the error', async () => {
    const before = useAppearanceStore.getState().appearance;
    const buf = await buildTestBundle(
      { css: 'theme.css' },
      { 'theme.css': '.user-desktop { background: url(https://evil.example/x.png); }' },
    );
    const ok = await useEsthemePreviewStore.getState().beginImport(buf);
    expect(ok).toBe(false);

    const { status, error } = useEsthemePreviewStore.getState();
    expect(status).toBe('idle');
    expect(error).toMatch(/not a first-party asset URL/);
    expect(useAppearanceStore.getState().appearance).toEqual(before);
    expect(useSoundStore.getState().customSoundPack).toEqual(OLD_PACK);
  });

  test('a failed cursor upload keeps the user cursor for that slot and warns', async () => {
    mocks.uploadCursor.mockRejectedValueOnce(new Error('quota'));
    const ok = await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    expect(ok).toBe(true);

    const warnings = useEsthemePreviewStore.getState().info?.warnings ?? [];
    expect(warnings.some((w) => w.includes('could not upload'))).toBe(true);
    // Only one slot uploaded; the failed slot keeps the user's (absent) cursor.
    expect(useAppearanceStore.getState().appearance.designTokens?.['cursor.image.pointer']).toBe(
      'http://api.test/api/cursors/u1/pointer/a.png|0|0',
    );
    expect(useAppearanceStore.getState().appearance.designTokens).not.toHaveProperty('cursor.image.default');
  });

  test('demo mode (no API) previews the offline layers and warns about the rest', async () => {
    mocks.apiConfigured.value = false;
    const ok = await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    expect(ok).toBe(true);

    const warnings = useEsthemePreviewStore.getState().info?.warnings ?? [];
    expect(warnings.some((w) => w.includes('cursors: skipped'))).toBe(true);
    expect(warnings.some((w) => w.includes('sounds: skipped'))).toBe(true);
    expect(warnings.some((w) => w.includes('wallpaper'))).toBe(true);
    expect(useAppearanceStore.getState().appearance.designTokens).not.toHaveProperty('cursor.image.default');
    expect(mocks.uploadCursor).not.toHaveBeenCalled();
  });
});

describe('keep — saves through the normal save paths', () => {
  test('persists appearance, sound pack, and wallpaper via their own save paths', async () => {
    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    const kept = await useEsthemePreviewStore.getState().keep();
    expect(kept).toBe(true);
    expect(useEsthemePreviewStore.getState().status).toBe('idle');

    // 1. Appearance through saveAppearance → PATCH /api/profile with null
    //    tombstones for fields the theme cleared (resetclear semantics).
    const appearanceCall = mocks.updateProfile.mock.calls.find(
      ([payload]) => payload && typeof payload === 'object' && 'accentColor' in (payload as object)
    );
    expect(appearanceCall).toBeDefined();
    const patch = appearanceCall?.[0] as Record<string, unknown>;
    expect(patch.accentColor).toBe('#00ffcc');
    expect(patch.desktopColor).toBeNull(); // theme cleared it → tombstone
    expect(patch.customCSS).toBe('.user-desktop { color: red; }');
    expect((patch.designTokens as Record<string, string>)['cursor.image.default']).toContain('/api/cursors/u1/default/a.png');
    expect((patch.designTokens as Record<string, string>)[THEME_LINEAGE_TOKEN_KEY]).toContain('test-theme');

    // 2. Sounds through saveCustomSoundPack → its own profile PATCH.
    const soundCall = mocks.updateProfile.mock.calls.find(
      ([payload]) => payload && typeof payload === 'object' && 'soundPack' in (payload as object)
    );
    expect(soundCall).toBeDefined();
    expect((soundCall?.[0] as Record<string, unknown>).soundPack).toMatchObject({ name: 'Test Theme' });

    // 3. Wallpaper through upload + the optimistic profile setters.
    expect(mocks.uploadWallpaper).toHaveBeenCalledTimes(1);
    expect(mocks.setWallpaper).toHaveBeenCalledWith('custom:u1/wallpaper/w1/wp.jpg');
    expect(mocks.setWallpaperMode).toHaveBeenCalledWith('tile');

    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(false);
  });

  test('a refused appearance save keeps the preview active with the error surfaced', async () => {
    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());

    mocks.updateProfile.mockRejectedValueOnce(new Error('offline'));
    const kept = await useEsthemePreviewStore.getState().keep();
    expect(kept).toBe(false);

    const { status, error } = useEsthemePreviewStore.getState();
    expect(status).toBe('active');
    expect(error).toMatch(/Could not save: appearance/);
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(true);

    // Retry once the server is reachable again: everything re-saves and the
    // session ends.
    const keptAgain = await useEsthemePreviewStore.getState().keep();
    expect(keptAgain).toBe(true);
    expect(useEsthemePreviewStore.getState().status).toBe('idle');
  });

  test('a refused wallpaper save is surfaced without losing the rest of the theme', async () => {
    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    mocks.setWallpaper.mockResolvedValueOnce(false); // profile PATCH refused

    const kept = await useEsthemePreviewStore.getState().keep();
    expect(kept).toBe(false);
    expect(useEsthemePreviewStore.getState().error).toMatch(/wallpaper/);
    expect(useEsthemePreviewStore.getState().status).toBe('active');
  });
});

describe('revert — exact restore', () => {
  test('restores the exact pre-import appearance (including unsaved edits) and sound pack', async () => {
    // The user had UNSAVED manual edits when they imported.
    useAppearanceStore.getState().updateAppearance({ accentColor: '#999999' });
    const snapshotBefore = { ...useAppearanceStore.getState().appearance };
    const packBefore = useSoundStore.getState().customSoundPack;

    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    expect(useAppearanceStore.getState().appearance.accentColor).toBe('#00ffcc');

    await useEsthemePreviewStore.getState().revert();

    expect(useAppearanceStore.getState().appearance).toEqual(snapshotBefore);
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(true); // was true before import
    expect(useSoundStore.getState().customSoundPack).toEqual(packBefore);

    // The assets the preview uploaded are cleaned up (manual-remove flow).
    expect(mocks.deleteCursor).toHaveBeenCalledWith('cur-default');
    expect(mocks.deleteCursor).toHaveBeenCalledWith('cur-pointer');
    expect(mocks.deleteSound).toHaveBeenCalledWith('snd-click');
    expect(mocks.deleteSound).toHaveBeenCalledWith('snd-windowOpen');
    expect(useEsthemePreviewStore.getState().status).toBe('idle');
  });

  test('reverting over a previously SAVED rice restores the saved flag', async () => {
    useAppearanceStore.getState().loadAppearance({ ...SEED_APPEARANCE });
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(false);

    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    await useEsthemePreviewStore.getState().revert();

    expect(useAppearanceStore.getState().appearance).toEqual(SEED_APPEARANCE);
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(false);
  });

  test('closing without choosing (dismiss) is Revert', async () => {
    useAppearanceStore.getState().updateAppearance({ accentColor: '#999999' });
    const snapshotBefore = { ...useAppearanceStore.getState().appearance };

    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    useEsthemePreviewStore.getState().dismiss();

    expect(useAppearanceStore.getState().appearance).toEqual(snapshotBefore);
    expect(useEsthemePreviewStore.getState().status).toBe('idle');
  });

  test('importing a second theme reverts the first preview, so revert always lands on the user rice', async () => {
    useAppearanceStore.getState().updateAppearance({ accentColor: '#999999' });
    const snapshotBefore = { ...useAppearanceStore.getState().appearance };

    const bundleA = await buildTestBundle(
      { tokens: 'tokens.json' },
      { 'tokens.json': JSON.stringify({ accentColor: '#001100' }) },
    );
    const bundleB = await buildTestBundle(
      { tokens: 'tokens.json' },
      { 'tokens.json': JSON.stringify({ accentColor: '#002200' }) },
    );

    await useEsthemePreviewStore.getState().beginImport(bundleA);
    expect(useAppearanceStore.getState().appearance.accentColor).toBe('#001100');
    await useEsthemePreviewStore.getState().beginImport(bundleB);
    expect(useAppearanceStore.getState().appearance.accentColor).toBe('#002200');

    await useEsthemePreviewStore.getState().revert();
    expect(useAppearanceStore.getState().appearance).toEqual(snapshotBefore);
  });
});

describe('fork lineage — written at install, read at export', () => {
  test('an exported bundle from an installed theme records forkedFrom', async () => {
    await useEsthemePreviewStore.getState().beginImport(await buildFullThemeBundle());
    await useEsthemePreviewStore.getState().keep();

    // The kept appearance carries the lineage token; the exporter turns it
    // into manifest.forkedFrom.
    const kept = useAppearanceStore.getState().appearance;
    expect(kept.designTokens?.[THEME_LINEAGE_TOKEN_KEY]).toContain('"test-theme"');

    const effectiveProfile = {
      username: 'bob',
      displayName: 'Bob',
      ...kept,
    } as UserProfile;

    // The kept cursor tokens point at first-party absolute URLs; the exporter
    // tries to read them back — stub fetch so both fail softly into warnings.
    const origFetch = globalThis.fetch;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ ok: false }) as Response);
    try {
      const result = await exportCurrentTheme(effectiveProfile, { preview: new Uint8Array() as unknown as Blob });
      expect(result.manifest.forkedFrom).toEqual({
        id: 'test-theme',
        name: 'Test Theme',
        author: '@alice',
        version: '1.2.3',
      });

      // The exported tokens layer carries the theme's tokens but NEVER the
      // bookkeeping lineage key or per-user cursor tokens.
      const parsed = await parseEsthemeBundle(await result.blob.arrayBuffer());
      const tokens = JSON.parse(await parsed.files.get('tokens.json')!.text());
      expect(tokens.designTokens).toEqual({ 'window.titleBar.background': '#111111' });
    } finally {
      (globalThis as unknown as { fetch: unknown }).fetch = origFetch;
    }
  });
});
