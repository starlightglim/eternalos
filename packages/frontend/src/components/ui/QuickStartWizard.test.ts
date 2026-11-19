import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

// QuickStartWizard renders off the real appearance/auth/desktop stores. Their
// module-level `window`/localStorage access needs stubs before import, and
// the API client must be mocked so a refused preset save can be driven
// deterministically.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as {
    localStorage?: unknown;
    window?: unknown;
    __wizardStorage?: Map<string, string>;
  };
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  g.localStorage = localStorageStub;
  g.__wizardStorage = backing;
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: localStorageStub,
  };
});

vi.mock('../../services/api', () => ({
  isApiConfigured: true,
  setAuthToken: vi.fn(),
  setRefreshToken: vi.fn(),
  clearFileToken: vi.fn(),
  setSessionExpiredHandler: vi.fn(),
  setTokenUpdateHandler: vi.fn(),
  getAuthToken: vi.fn(() => null),
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

import { QuickStartWizard } from './QuickStartWizard';
import { THEME_PRESETS } from '../../utils/onboardingPresets';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { updateProfile } from '../../services/api';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';

const updateProfileMock = vi.mocked(updateProfile);
/** The localStorage currently installed (the test DOM installs its own shim). */
function liveLocalStorage(): { getItem(key: string): string | null } {
  return globalThis.localStorage;
}

const APPEARANCE_STORAGE_KEY = 'eternalos-appearance';

let dom: TestDom;
let reactRoot: Root | null = null;
let onComplete: () => void;

function elementsWithTag(from: TestNode, tag: string): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if (child.nodeName === tag) found.push(child);
        visit(child);
      }
    }
  };
  visit(from);
  return found;
}

async function renderWizard(): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(createElement(QuickStartWizard, { username: 'alice', onComplete }));
  });
}

function clickApply(): void {
  const apply = elementsWithTag(dom.root, 'BUTTON').find((b) => b.textContent === 'Apply & Continue');
  if (!apply) throw new Error('Apply button not rendered');
  act(() => {
    dom.pointer(apply, 'pointerdown', { clientX: 0, clientY: 0 });
    dom.pointer(apply, 'pointerup', { clientX: 0, clientY: 0 });
    dom.click();
  });
}

beforeEach(async () => {
  dom = installTestDom();
  onComplete = vi.fn<() => void>();
  updateProfileMock.mockReset();
  updateProfileMock.mockResolvedValue({ success: true, profile: {} });
  useDesktopStore.setState({ items: [] });
  useAppearanceStore.setState({
    appearance: {},
    originalAppearance: {},
    customCSSPreview: undefined,
    customCSSPreviewSummary: undefined,
    hasUnsavedChanges: false,
    isLoading: false,
  });
  useAuthStore.setState({
    user: { uid: 'u1', username: 'alice', email: 'a@a.dev' },
    profile: null,
    token: null,
    refreshToken: null,
    loading: false,
    error: null,
    initialized: false,
  });
  await useAuthStore.getState().logout();
  useAuthStore.setState({
    user: { uid: 'u1', username: 'alice', email: 'a@a.dev' },
    profile: { uid: 'u1', username: 'alice', displayName: 'Alice', createdAt: 1, wallpaper: 'default', isNewUser: true },
  });
});

afterEach(async () => {
  if (reactRoot) {
    const root = reactRoot;
    reactRoot = null;
    await act(async () => {
      root.unmount();
    });
  }
  dom.uninstall();
});

describe('QuickStartWizard preset apply (theme selection save)', () => {
  // The forced-failure modes from the Workstream 1 "Good when" acceptance.
  // The appearance save and the wallpaper PATCH are both updateProfile
  // calls; refusing them must leave nothing looking applied or saved.
  const FAILURES = [
    ['offline', () => new TypeError('Failed to fetch')],
    ['401', () => new Error('401 Session expired. Please log in again.')],
    ['429', () => new Error('429 Too many requests')],
    ['500', () => new Error('500 Internal server error')],
  ] as const;

  test.each(FAILURES)('%s: a refused apply reverts to the last server-acknowledged rice', async (_label, makeError) => {
    updateProfileMock.mockImplementation(() => Promise.reject(makeError()));
    await renderWizard();

    await act(async () => {
      clickApply();
    });

    // The preset must NOT be committed anywhere: not as the store's saved
    // appearance…
    const s = useAppearanceStore.getState();
    expect(s.hasUnsavedChanges).toBe(false);
    expect(s.appearance).toEqual({});
    // …not in localStorage (a reload must paint the old rice)…
    expect(JSON.parse(liveLocalStorage().getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual({});
    // …and the wallpaper must not be optimistically adopted either.
    expect(useAuthStore.getState().profile?.wallpaper).toBe('default');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test('an acknowledged appearance with a refused wallpaper PATCH keeps the committed rice and skips the wallpaper', async () => {
    // Call #1 is the appearance save (acked); call #2 is the wallpaper /
    // isNewUser PATCH (refused). The appearance must stay committed (the
    // server has it) while the wallpaper is simply not adopted.
    updateProfileMock
      .mockResolvedValueOnce({ success: true, profile: {} })
      .mockRejectedValueOnce(new Error('429 Too many requests'));
    await renderWizard();

    await act(async () => {
      clickApply();
    });

    const preset = THEME_PRESETS[0];
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(false);
    expect(useAppearanceStore.getState().appearance).toEqual(preset.appearance);
    expect(JSON.parse(liveLocalStorage().getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual(preset.appearance);
    // The refused PATCH leaves the profile untouched — no phantom wallpaper.
    expect(useAuthStore.getState().profile?.wallpaper).toBe('default');
    expect(useAuthStore.getState().profile?.isNewUser).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test('an acknowledged apply commits the preset and the wallpaper', async () => {    await renderWizard();

    await act(async () => {
      clickApply();
    });

    const preset = THEME_PRESETS[0];
    expect(useAppearanceStore.getState().hasUnsavedChanges).toBe(false);
    expect(useAppearanceStore.getState().appearance).toEqual(preset.appearance);
    expect(JSON.parse(liveLocalStorage().getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual(preset.appearance);
    expect(useAuthStore.getState().profile?.wallpaper).toBe(preset.wallpaper);
    expect(useAuthStore.getState().profile?.isNewUser).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
