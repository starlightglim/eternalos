import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { DesktopItem, UserProfile } from '../types';

// Same node harness as authStore.test.ts: the stores read localStorage (and
// windowStore touches `window`) at import time.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as {
    localStorage?: unknown;
    window?: unknown;
    __syncStorageBacking?: Map<string, string>;
  };
  g.localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  g.__syncStorageBacking = backing;
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: g.localStorage,
    location: { href: '/desktop' },
  };
});

vi.mock('../services/api', () => ({
  isApiConfigured: true,
  setAuthToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearFileToken: vi.fn(),
  setSessionExpiredHandler: vi.fn(),
  setTokenUpdateHandler: vi.fn(),
  getAuthToken: vi.fn(() => null),
  ensureFileToken: vi.fn(() => Promise.resolve()),
  saveWindowsToServer: vi.fn(),
  signup: vi.fn(),
  login: vi.fn(),
  googleLogin: vi.fn(),
  logout: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn(),
  changeUsername: vi.fn(),
  sendVerificationEmail: vi.fn(),
  createItem: vi.fn(),
  updateItems: vi.fn(),
  deleteItem: vi.fn(),
  analyzeImageItem: vi.fn(),
  uploadFile: vi.fn(),
  fetchDesktop: vi.fn(),
  emptyTrashApi: vi.fn(),
}));

import { syncDesktopOnce } from './useDesktopSync';
import { refreshLookFromServer } from '../utils/refreshLook';
import { useAuthStore, SESSION_EXPIRED_LOGIN_URL } from '../stores/authStore';
import { useDesktopStore } from '../stores/desktopStore';
import { useAppearanceStore } from '../stores/appearanceStore';
import { fetchDesktop, setSessionExpiredHandler, updateProfile } from '../services/api';

const storage = (globalThis as unknown as { __syncStorageBacking: Map<string, string> }).__syncStorageBacking;
const APPEARANCE_KEY = 'eternalos-appearance';
const fetchDesktopMock = vi.mocked(fetchDesktop);

const cachedProfile: UserProfile = {
  uid: 'u1',
  username: 'alice',
  displayName: 'Alice',
  createdAt: 1,
  wallpaper: 'custom:u1/wallpaper/old.jpg',
  accentColor: '#ff0000',
};

const item = (id: string): DesktopItem =>
  ({ id, type: 'text', name: id, parentId: null, position: { x: 0, y: 0 }, isPublic: false, createdAt: 1, updatedAt: 1 }) as unknown as DesktopItem;

function signIn() {
  useAuthStore.setState({
    user: { uid: 'u1', username: 'alice', email: 'a@example.test' },
    profile: { ...cachedProfile },
    token: 't',
    refreshToken: 'r',
  });
  useAppearanceStore.getState().loadAppearance({ accentColor: '#ff0000', customCSS: '.window { color: red }' });
}

beforeEach(() => {
  fetchDesktopMock.mockReset();
  vi.mocked(updateProfile).mockReset();
  useDesktopStore.getState().reset();
  useAppearanceStore.getState().reset();
  useAuthStore.setState({ user: null, profile: null, token: null, refreshToken: null, error: null });
  storage.clear();
});

describe('syncDesktopOnce', () => {
  test('server wins: a cleared wallpaper and a reset appearance both reconcile', async () => {
    signIn();
    fetchDesktopMock.mockResolvedValue({
      items: [item('a')],
      profile: { uid: 'u1', username: 'alice', displayName: 'Alice', createdAt: 1, bio: 'hi' },
    });

    expect(await syncDesktopOnce(() => true)).toBe('applied');

    expect(useDesktopStore.getState().items.map((i) => i.id)).toEqual(['a']);
    const profile = useAuthStore.getState().profile!;
    expect(profile.wallpaper).toBeUndefined();
    expect(profile.accentColor).toBeUndefined();
    expect(profile.bio).toBe('hi');
    // No appearance on the server = a reset to defaults, not "keep the cache".
    expect(useAppearanceStore.getState().appearance).toEqual({});
    expect(JSON.parse(storage.get(APPEARANCE_KEY)!)).toEqual({});
  });

  test('writes the profile even when nothing was cached', async () => {
    useAuthStore.setState({ user: { uid: 'u1', username: 'alice', email: 'a@example.test' }, profile: null });
    fetchDesktopMock.mockResolvedValue({
      items: [],
      profile: { uid: 'u1', username: 'alice', displayName: 'Alice', createdAt: 1, wallpaper: 'stars' },
    });
    await syncDesktopOnce(() => true);
    expect(useAuthStore.getState().profile?.wallpaper).toBe('stars');
  });

  test('a response that lands after logout writes nothing', async () => {
    signIn();
    let resolve!: (v: Awaited<ReturnType<typeof fetchDesktop>>) => void;
    fetchDesktopMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    let current = true;
    const pending = syncDesktopOnce(() => current);

    await useAuthStore.getState().logout();
    current = false;
    resolve({ items: [item('old-user')], profile: { ...cachedProfile, wallpaper: 'leak' } });

    expect(await pending).toBe('stale');
    expect(useDesktopStore.getState().items).toEqual([]);
    expect(useAuthStore.getState().profile).toBeNull();
  });

  test('a snapshot fetched before a local edit never reverts it (even once acked)', async () => {
    signIn();
    vi.mocked(updateProfile).mockResolvedValue({ success: true, profile: {} } as never);
    let resolve!: (v: Awaited<ReturnType<typeof fetchDesktop>>) => void;
    fetchDesktopMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const pending = syncDesktopOnce(() => true);

    // Profile edit and appearance save both land (acked) while the fetch is out.
    expect(await useAuthStore.getState().setBio('new bio')).toBe(true);
    useAppearanceStore.getState().updateAppearance({ accentColor: '#00ff00' });
    await useAppearanceStore.getState().saveAppearance();

    resolve({ items: [], profile: { ...cachedProfile, bio: 'old bio', accentColor: '#ff0000' } });
    expect(await pending).toBe('applied');
    expect(useAuthStore.getState().profile?.bio).toBe('new bio');
    expect(useAppearanceStore.getState().appearance.accentColor).toBe('#00ff00');
  });

  test('a failure reports "failed" and clears the loading flag', async () => {
    signIn();
    useDesktopStore.getState().setLoading(true);
    fetchDesktopMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await syncDesktopOnce(() => true)).toBe('failed');
    expect(useDesktopStore.getState().loading).toBe(false);
  });
});

describe('appearance syncFromServer', () => {
  test('unsaved edits survive a server refresh; the server copy becomes the baseline', () => {
    signIn();
    useAppearanceStore.getState().updateAppearance({ accentColor: '#00ff00' });
    useAppearanceStore.getState().syncFromServer({ accentColor: '#0000ff' });

    const state = useAppearanceStore.getState();
    expect(state.appearance.accentColor).toBe('#00ff00');
    expect(state.hasUnsavedChanges).toBe(true);
    expect(state.originalAppearance).toEqual({ accentColor: '#0000ff' });

    state.discardChanges();
    expect(useAppearanceStore.getState().appearance).toEqual({ accentColor: '#0000ff' });
  });

  test('with no unsaved edits the server copy is applied', () => {
    signIn();
    useAppearanceStore.getState().syncFromServer({ accentColor: '#0000ff' });
    expect(useAppearanceStore.getState().appearance).toEqual({ accentColor: '#0000ff' });
  });
});

describe('refreshLookFromServer', () => {
  test('ignores a response that lands after logout', async () => {
    signIn();
    let resolve!: (v: Awaited<ReturnType<typeof fetchDesktop>>) => void;
    fetchDesktopMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const pending = refreshLookFromServer();
    await useAuthStore.getState().logout();
    resolve({ items: [], profile: { ...cachedProfile, accentColor: '#123456' } });
    await pending;
    expect(useAuthStore.getState().profile).toBeNull();
    expect(useAppearanceStore.getState().appearance).toEqual({});
  });
});

describe('logout / session expiry reset the look', () => {
  test('logout clears the appearance store and its localStorage mirror', async () => {
    signIn();
    expect(storage.has(APPEARANCE_KEY)).toBe(true);
    await useAuthStore.getState().logout();
    expect(useAppearanceStore.getState().appearance).toEqual({});
    expect(useAppearanceStore.getState().originalAppearance).toEqual({});
    expect(storage.has(APPEARANCE_KEY)).toBe(false);
  });

  test('session expiry resets the look and redirects with expired=1', () => {
    signIn();
    useAuthStore.getState().initialize();
    const handler = vi.mocked(setSessionExpiredHandler).mock.calls.at(-1)![0] as () => void;
    handler();
    expect(useAppearanceStore.getState().appearance).toEqual({});
    expect(storage.has(APPEARANCE_KEY)).toBe(false);
    expect(window.location.href).toBe(SESSION_EXPIRED_LOGIN_URL);
    expect(SESSION_EXPIRED_LOGIN_URL).toBe('/login?expired=1');
  });
});
