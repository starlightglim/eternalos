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
vi.mock('../services/api', () => ({
  isApiConfigured: true,
  getAuthToken: () => 'token',
  saveWindowsToServer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/layout', () => ({ getMenuBarHeight: () => 20 }));

import { useWindowStore } from './windowStore';

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
  useWindowStore.setState({ windows: [], nextZIndex: 1 });
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
