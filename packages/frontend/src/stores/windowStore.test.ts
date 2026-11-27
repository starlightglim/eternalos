import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { WindowState } from '../types';

// windowStore registers a top-level `window.addEventListener('resize', …)` at
// import time; in the node test env `window` is otherwise undefined. Define it
// (and localStorage) before the module import runs. Per-test beforeEach then
// re-stubs these with test-specific values.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});

// windowStore pulls in the API client (network) and the layout helper (reads
// the real DOM); stub both so the restoration logic can be tested in isolation.
const { saveWindowsToServer, desktopState, desktopListeners } = vi.hoisted(() => ({
  saveWindowsToServer: vi.fn(),
  desktopState: { uid: null as string | null, items: [] as Array<{ id: string }>, serverWindows: [] as unknown[] },
  desktopListeners: [] as Array<(s: unknown, prev: unknown) => void>,
}));
vi.mock('../services/api', () => ({
  isApiConfigured: true,
  getAuthToken: () => 'token',
  saveWindowsToServer,
}));
vi.mock('../utils/layout', () => ({ getMenuBarHeight: () => 20 }));
// The store reads the signed-in uid (per-user cache key) and listens for the
// server's copy of the layout from the desktop store.
vi.mock('./desktopStore', () => ({
  useDesktopStore: {
    getState: () => desktopState,
    subscribe: (fn: (s: unknown, prev: unknown) => void) => {
      desktopListeners.push(fn);
      return () => {};
    },
  },
}));

import {
  useWindowStore,
  windowStateKey,
  windowLayoutSignature,
  chooseWindowSource,
  fitWindowToViewport,
  fitWindowsToViewport,
  flushPendingWindowSave,
} from './windowStore';

function setServerWindows(serverWindows: unknown[]) {
  const prev = { ...desktopState };
  desktopState.serverWindows = serverWindows;
  for (const fn of desktopListeners) fn(desktopState, prev);
}

const WINDOW_STATE_KEY = 'eternalos-window-state';
const VIEWPORT = { innerWidth: 1280, innerHeight: 800 };

function makeWindow(overrides: Partial<WindowState> = {}): WindowState {
  return {
    id: 'w1',
    title: 'Note.txt',
    position: { x: 100, y: 100 },
    size: { width: 300, height: 200 },
    zIndex: 1,
    minimized: false,
    maximized: false,
    contentType: 'text',
    contentId: 'note',
    ...overrides,
  };
}

let ls: Record<string, string>;

beforeEach(() => {
  ls = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in ls ? ls[k] : null),
    setItem: (k: string, v: string) => { ls[k] = v; },
    removeItem: (k: string) => { delete ls[k]; },
  });
  vi.stubGlobal('window', VIEWPORT);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  saveWindowsToServer.mockReset();
  saveWindowsToServer.mockResolvedValue(undefined);
  desktopState.uid = null;
  desktopState.items = [];
  desktopState.serverWindows = [];
  useWindowStore.getState().resetOnLogout();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('restores windows from localStorage on reload', () => {
  ls[WINDOW_STATE_KEY] = JSON.stringify({ windows: [makeWindow()], nextZIndex: 3 });
  useWindowStore.getState().loadWindowState(new Set(['note']));
  const windows = useWindowStore.getState().windows;
  expect(windows).toHaveLength(1);
  expect(windows[0].id).toBe('w1');
  expect(windows[0].position).toEqual({ x: 100, y: 100 });
});

test('falls back to server windows when localStorage is empty (new device / cleared cache)', () => {
  const serverWindows = [{
    id: 'w2', title: 'Doc', position: { x: 50, y: 50 }, size: { width: 200, height: 150 },
    zIndex: 1, minimized: false, maximized: false, contentType: 'text', contentId: 'note',
  }];
  useWindowStore.getState().loadWindowState(new Set(['note']), serverWindows as never);
  const windows = useWindowStore.getState().windows;
  expect(windows).toHaveLength(1);
  expect(windows[0].id).toBe('w2');
});

test('drops windows whose content item no longer exists', () => {
  ls[WINDOW_STATE_KEY] = JSON.stringify({
    windows: [makeWindow({ id: 'gone', contentId: 'deleted' }), makeWindow({ id: 'kept', contentId: 'note' })],
    nextZIndex: 3,
  });
  useWindowStore.getState().loadWindowState(new Set(['note']));
  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['kept']);
});

test('discards corrupt localStorage window state without throwing', () => {
  ls[WINDOW_STATE_KEY] = '{ not valid json';
  expect(() => useWindowStore.getState().loadWindowState(new Set())).not.toThrow();
  expect(useWindowStore.getState().windows).toEqual([]);
  expect(WINDOW_STATE_KEY in ls).toBe(false); // corrupt state is cleared
});

test('enforces a minimum window size on resize', () => {
  useWindowStore.setState({ windows: [makeWindow({ id: 'w1' })], nextZIndex: 2 });
  useWindowStore.getState().resizeWindow('w1', { width: 50, height: 50 });
  expect(useWindowStore.getState().windows[0].size).toEqual({ width: 200, height: 150 });
});

test('a resize persists to localStorage and survives reload', async () => {
  vi.useFakeTimers();
  try {
    ls[WINDOW_STATE_KEY] = JSON.stringify({ windows: [makeWindow({ id: 'w1', size: { width: 300, height: 200 } })], nextZIndex: 2 });
    useWindowStore.getState().loadWindowState(new Set(['note']));
    useWindowStore.getState().resizeWindow('w1', { width: 520, height: 420 });
    // Immediate in-memory update.
    expect(useWindowStore.getState().windows[0].size).toEqual({ width: 520, height: 420 });
    // Debounced localStorage write (300ms).
    await vi.advanceTimersByTimeAsync(300);
    // Simulate reload: drop in-memory state and restore from localStorage.
    useWindowStore.setState({ windows: [], nextZIndex: 1 });
    useWindowStore.getState().loadWindowState(new Set(['note']));
    expect(useWindowStore.getState().windows[0]?.size).toEqual({ width: 520, height: 420 });
  } finally {
    vi.useRealTimers();
  }
});

test('clamps an off-screen window back into the viewport', () => {
  ls[WINDOW_STATE_KEY] = JSON.stringify({
    windows: [makeWindow({ position: { x: 5000, y: 5000 }, size: { width: 300, height: 200 } })],
    nextZIndex: 2,
  });
  useWindowStore.getState().loadWindowState(new Set(['note']));
  const w = useWindowStore.getState().windows[0];
  expect(w.position.x).toBeGreaterThanOrEqual(0);
  expect(w.position.y).toBeGreaterThanOrEqual(20); // below the menu bar
  expect(w.position.x + w.size.width).toBeLessThanOrEqual(VIEWPORT.innerWidth);
  expect(w.position.y + w.size.height).toBeLessThanOrEqual(VIEWPORT.innerHeight);
});

const serverWindow = (overrides: Record<string, unknown> = {}) => ({
  id: 'w1', title: 'Note.txt', position: { x: 100, y: 100 }, size: { width: 300, height: 200 },
  zIndex: 1, minimized: false, maximized: false, contentType: 'text', contentId: 'note', ...overrides,
});

test('the cache key is per user', () => {
  expect(windowStateKey(null)).toBe(WINDOW_STATE_KEY);
  expect(windowStateKey('u1')).toBe(`${WINDOW_STATE_KEY}:u1`);
  desktopState.uid = 'u1';
  ls[WINDOW_STATE_KEY] = JSON.stringify({ windows: [makeWindow({ id: 'someone-else' })], nextZIndex: 2 });
  ls[`${WINDOW_STATE_KEY}:u1`] = JSON.stringify({ windows: [makeWindow({ id: 'mine' })], nextZIndex: 2 });
  useWindowStore.getState().loadWindowState(new Set(['note']));
  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['mine']);
  // The old shared cache could belong to another account: dropped.
  expect(WINDOW_STATE_KEY in ls).toBe(false);
});

test('chooseWindowSource: newest layout wins', () => {
  const local = { windows: [makeWindow({ position: { x: 300, y: 300 } })], nextZIndex: 2 };
  const server = [serverWindow()];
  const serverSig = windowLayoutSignature(server as never);
  expect(chooseWindowSource(null, server as never)).toBe('server');
  expect(chooseWindowSource(local, [])).toBe('local');
  // Server still holds what we last synced: our later edits are newer.
  expect(chooseWindowSource({ ...local, serverSig }, server as never)).toBe('local');
  // Server changed since (another device saved): the server is newer.
  expect(chooseWindowSource({ ...local, serverSig: windowLayoutSignature([serverWindow({ id: 'old' })] as never) }, server as never)).toBe('server');
  expect(chooseWindowSource({ ...local, serverSig: null }, server as never)).toBe('server');
  // Legacy entries without a signature keep the local-first rule.
  expect(chooseWindowSource(local, server as never)).toBe('local');
});

test('a layout saved on another device replaces a stale cache', () => {
  desktopState.uid = 'u1';
  const key = `${WINDOW_STATE_KEY}:u1`;
  ls[key] = JSON.stringify({
    windows: [makeWindow({ id: 'stale' })], nextZIndex: 2,
    serverSig: windowLayoutSignature([makeWindow({ id: 'stale' })]),
  });
  useWindowStore.getState().loadWindowState(new Set(['note']), [serverWindow({ id: 'fresh' })] as never);
  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['fresh']);
  expect(JSON.parse(ls[key]).windows[0].id).toBe('fresh');
});

test('the server copy arriving after restore is reconciled', () => {
  desktopState.uid = 'u1';
  desktopState.items = [{ id: 'note' }];
  ls[`${WINDOW_STATE_KEY}:u1`] = JSON.stringify({
    windows: [makeWindow({ id: 'stale' })], nextZIndex: 2,
    serverSig: windowLayoutSignature([makeWindow({ id: 'stale' })]),
  });
  // The desktop restores before the fetch finishes.
  useWindowStore.getState().loadWindowState(new Set(['note']), []);
  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['stale']);
  setServerWindows([serverWindow({ id: 'fresh' })]);
  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['fresh']);
});

test('a late server copy does not undo changes the user already made', () => {
  useWindowStore.getState().loadWindowState(new Set(['note']), []);
  useWindowStore.getState().openWindow(makeWindow({ id: 'opened' }));
  setServerWindows([serverWindow({ id: 'fresh' })]);
  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['opened']);
});

test('nothing is persisted before the layout is restored, and mobile windows never are', async () => {
  vi.useFakeTimers();
  try {
    // Mobile view: the desktop layout is never restored.
    useWindowStore.getState().openWindow(makeWindow({ id: 'mobile-text-note' }));
    await vi.advanceTimersByTimeAsync(2500);
    expect(saveWindowsToServer).not.toHaveBeenCalled();
    expect(WINDOW_STATE_KEY in ls).toBe(false);

    useWindowStore.getState().loadWindowState(new Set(['note']), []);
    useWindowStore.getState().openWindow(makeWindow({ id: 'desk' }));
    useWindowStore.getState().openWindow(makeWindow({ id: 'mobile-image-x' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(JSON.parse(ls[WINDOW_STATE_KEY]).windows.map((w: WindowState) => w.id)).toEqual(['desk']);
    const sent = saveWindowsToServer.mock.calls.at(-1)?.[0] as WindowState[];
    expect(sent.map((w) => w.id)).toEqual(['desk']);
  } finally {
    vi.useRealTimers();
  }
});

test('pagehide flush writes pending saves at once, server save with keepalive', async () => {
  vi.useFakeTimers();
  try {
    ls[WINDOW_STATE_KEY] = JSON.stringify({ windows: [makeWindow()], nextZIndex: 2 });
    useWindowStore.getState().loadWindowState(new Set(['note']));
    useWindowStore.getState().moveWindow('w1', { x: 222, y: 111 });
    flushPendingWindowSave();
    expect(JSON.parse(ls[WINDOW_STATE_KEY]).windows[0].position).toEqual({ x: 222, y: 111 });
    expect(saveWindowsToServer).toHaveBeenCalledTimes(1);
    expect(saveWindowsToServer.mock.calls[0][1]).toEqual({ keepalive: true });
    // The debounced send was consumed by the flush.
    await vi.advanceTimersByTimeAsync(2500);
    expect(saveWindowsToServer).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

test('fitWindowToViewport shrinks oversized windows and keeps the minimum size', () => {
  const big = makeWindow({ position: { x: 900, y: 500 }, size: { width: 2000, height: 1500 } });
  const fitted = fitWindowToViewport(big, 1024, 700);
  expect(fitted.size).toEqual({ width: 1024, height: 680 });
  expect(fitted.position).toEqual({ x: 0, y: 20 });
  const tiny = fitWindowToViewport(makeWindow({ size: { width: 300, height: 200 } }), 120, 100);
  expect(tiny.size).toEqual({ width: 200, height: 150 });
  const max = fitWindowToViewport(makeWindow({ maximized: true }), 800, 600);
  expect(max).toMatchObject({ position: { x: 0, y: 20 }, size: { width: 800, height: 580 } });
  const same = makeWindow();
  expect(fitWindowToViewport(same, 1280, 800)).toBe(same);
});

test('a viewport resize clamps size too and persists it', async () => {
  vi.useFakeTimers();
  try {
    ls[WINDOW_STATE_KEY] = JSON.stringify({ windows: [makeWindow({ size: { width: 900, height: 600 } })], nextZIndex: 2 });
    useWindowStore.getState().loadWindowState(new Set(['note']));
    vi.stubGlobal('window', { innerWidth: 640, innerHeight: 480 });
    fitWindowsToViewport();
    expect(useWindowStore.getState().windows[0].size).toEqual({ width: 640, height: 460 });
    await vi.advanceTimersByTimeAsync(300);
    expect(JSON.parse(ls[WINDOW_STATE_KEY]).windows[0].size).toEqual({ width: 640, height: 460 });
  } finally {
    vi.useRealTimers();
  }
});

test('the old shared cache is adopted only when it matches this account on the server', () => {
  desktopState.uid = 'u1';
  const legacy = [makeWindow({ id: 'legacy', launchFileId: 'f1' } as Partial<WindowState>)];
  ls[WINDOW_STATE_KEY] = JSON.stringify({ windows: legacy, nextZIndex: 2 });
  useWindowStore.getState().loadWindowState(new Set(['note']), [serverWindow({ id: 'legacy' })] as never);
  expect(useWindowStore.getState().windows[0]).toMatchObject({ id: 'legacy', launchFileId: 'f1' });
  expect(WINDOW_STATE_KEY in ls).toBe(false);
});

test('viewport fitting leaves mobile viewers alone', () => {
  useWindowStore.getState().loadWindowState(new Set(['note']), []);
  const mobile = makeWindow({ id: 'mobile-image-x', maximized: true, size: { width: 390, height: 700 }, position: { x: 0, y: 0 } });
  useWindowStore.setState({ windows: [mobile] });
  fitWindowsToViewport();
  expect(useWindowStore.getState().windows[0]).toBe(mobile);
});
