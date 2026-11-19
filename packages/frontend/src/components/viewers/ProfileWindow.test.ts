import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

// ProfileWindow renders off the real authStore (persist → localStorage) and
// desktopStore; their module-level `window`/localStorage access needs stubs
// before import, and the API client must be mocked so the refused-save
// matrix can be driven deterministically.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as {
    localStorage?: unknown;
    window?: unknown;
    __profileWindowStorage?: Map<string, string>;
  };
  const localStorageStub = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  g.localStorage = localStorageStub;
  g.__profileWindowStorage = backing;
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

import { ProfileWindow } from './ProfileWindow';
import { useAuthStore } from '../../stores/authStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { updateProfile } from '../../services/api';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';
import type { UserProfile } from '../../types';

const updateProfileMock = vi.mocked(updateProfile);
const storageBacking = (globalThis as unknown as { __profileWindowStorage: Map<string, string> }).__profileWindowStorage;

let dom: TestDom;
let reactRoot: Root | null = null;

/** Depth-first (document order) list of <tag> descendants. */
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

/** Any element anywhere under `from` whose text contains `needle`. */
function anyTextContains(from: TestNode, needle: string): boolean {
  const visit = (node: TestNode): boolean => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if ((child.textContent ?? '').includes(needle)) return true;
        if (visit(child)) return true;
      }
    }
    return false;
  };
  return visit(from);
}

function seedProfile(): UserProfile {
  const profile: UserProfile = {
    uid: 'u1',
    username: 'alice',
    displayName: 'Alice',
    createdAt: 1,
    bio: 'old bio',
    profileLinks: [{ title: 'Site', url: 'https://example.com' }],
  };
  useAuthStore.setState({ profile });
  return profile;
}

async function renderWindow(): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(createElement(ProfileWindow, { isOwner: true }));
  });
}

function clickSave(): void {
  const save = elementsWithTag(dom.root, 'BUTTON').find((b) => b.textContent === 'Save');
  if (!save) throw new Error('Save button not rendered');
  act(() => {
    dom.pointer(save, 'pointerdown', { clientX: 0, clientY: 0 });
    dom.pointer(save, 'pointerup', { clientX: 0, clientY: 0 });
    dom.click();
  });
}

// The forced-failure modes from the Workstream 1 "Good when" acceptance.
const FAILURES = [
  ['offline', () => new TypeError('Failed to fetch')],
  ['401', () => new Error('401 Session expired. Please log in again.')],
  ['429', () => new Error('429 Too many requests')],
  ['500', () => new Error('500 Internal server error')],
] as const;

beforeEach(async () => {
  dom = installTestDom();
  storageBacking.clear();
  updateProfileMock.mockReset();
  updateProfileMock.mockResolvedValue({ success: true, profile: {} });
  useDesktopStore.setState({ items: [] });
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

describe('ProfileWindow save path (bio + links)', () => {
  test.each(FAILURES)('%s: a failed save never shows "Saved!" and keeps the profile rolled back', async (_label, makeError) => {
    updateProfileMock.mockImplementation(() => Promise.reject(makeError()));
    const before = seedProfile();
    await renderWindow();

    await act(async () => {
      clickSave();
    });

    // No successful-looking state…
    expect(anyTextContains(dom.root, 'Saved!'), 'must not claim Saved').toBe(false);
    // …instead the failure is surfaced, matching the watermark/display-name
    // error pattern of the other settings surfaces.
    expect(anyTextContains(dom.root, 'Could not save')).toBe(true);
    // …and the store profile is back at the server-acknowledged values.
    expect(useAuthStore.getState().profile?.bio).toBe(before.bio);
    expect(useAuthStore.getState().profile?.profileLinks).toEqual(before.profileLinks);
    // The PATCH really was attempted.
    expect(updateProfileMock).toHaveBeenCalledWith({ bio: 'old bio' });
  });

  test('an acknowledged save shows "Saved!"', async () => {
    seedProfile();
    await renderWindow();

    await act(async () => {
      clickSave();
    });

    expect(anyTextContains(dom.root, 'Saved!')).toBe(true);
    expect(anyTextContains(dom.root, 'Could not save')).toBe(false);
    expect(useAuthStore.getState().profile?.bio).toBe('old bio');
  });

  test('the save error clears once a save succeeds again', async () => {
    updateProfileMock.mockImplementationOnce(() => Promise.reject(new Error('500 Internal server error')));
    const before = seedProfile();
    await renderWindow();

    await act(async () => {
      clickSave();
    });
    expect(anyTextContains(dom.root, 'Could not save')).toBe(true);
    expect(useAuthStore.getState().profile?.bio).toBe(before.bio);

    await act(async () => {
      clickSave();
    });
    expect(anyTextContains(dom.root, 'Could not save')).toBe(false);
    expect(anyTextContains(dom.root, 'Saved!')).toBe(true);
  });
});
