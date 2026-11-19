import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// windowStore registers a top-level `window.addEventListener('resize', …)` at
// import time; in the node test env `window` is otherwise undefined. Define
// minimal browser globals before the module import runs — the full fake DOM
// is installed per-test in beforeEach.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  g.window = { innerWidth: 1280, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} };
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});

// Window renders via the variant slot system and reads the window + appearance
// stores; both persist to localStorage and (via the api module) the server.
// Mock the api surface so nothing leaves the fake DOM, and the sound store so
// no audio plumbing loads in Node.
const api = vi.hoisted(() => ({ saveWindowsToServer: vi.fn(() => Promise.resolve()) }));
vi.mock('../../services/api', () => ({
  isApiConfigured: false,
  getAuthToken: () => null,
  saveWindowsToServer: api.saveWindowsToServer,
}));
vi.mock('../../stores/soundStore', () => ({
  useSoundStore: { getState: () => ({ playSound: vi.fn() }) },
}));

import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from './Window';
import { installTestDom, type TestDom, type TestElement } from './windowTestDom';
import { useWindowStore } from '../../stores/windowStore';

const WINDOW_ID = 'w1';
const INITIAL_POSITION = { x: 100, y: 100 };

function seededWindow() {
  return {
    id: WINDOW_ID,
    title: 'Test Window',
    position: { ...INITIAL_POSITION },
    size: { width: 400, height: 300 },
    zIndex: 5,
    minimized: false,
    maximized: false,
    contentType: 'text' as const,
  };
}

let dom: TestDom;
let reactRoot: Root | null = null;

/** Mount the real Window with a plain, non-interactive div inside its content. */
async function renderWindowWithRow(onRowClick: () => void): Promise<{ row: TestElement; content: TestElement }> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(
      createElement(
        Window,
        {
          id: WINDOW_ID,
          title: 'Test Window',
          position: { ...INITIAL_POSITION },
          size: { width: 400, height: 300 },
          zIndex: 5,
          minimized: false,
          isActive: true,
        },
        createElement('div', { 'data-testid': 'list-row', onClick: onRowClick }, 'List row')
      )
    );
  });
  const row = dom.findDescendant(dom.root, 'data-testid', 'list-row');
  const content = dom.findDescendant(dom.root, 'eos-part', 'content');
  if (!row || !content) throw new Error('Window content did not render');
  return { row, content };
}

beforeEach(() => {
  dom = installTestDom();
  useWindowStore.setState({ windows: [seededWindow()], nextZIndex: 10 });
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
  useWindowStore.setState({ windows: [], nextZIndex: 1 });
});

test('body drag does not swallow a click on a plain div with onClick', async () => {
  const rowClicks = vi.fn();
  const { row } = await renderWindowWithRow(rowClicks);

  // Press on the non-interactive row, release without moving, then click.
  act(() => {
    dom.pointer(row, 'pointerdown', { clientX: 150, clientY: 150 });
  });
  // The press must not be hijacked: no pointer capture — otherwise the
  // browser retargets the release and never delivers the click to the row
  // (this was the old bug: tabs and list rows stopped working).
  expect(dom.captureHolder()).toBeUndefined();
  act(() => {
    dom.pointer(row, 'pointerup', { clientX: 150, clientY: 150 });
  });
  const click = act(() => dom.click({ clientX: 150, clientY: 150 }));

  expect(click).not.toBeNull();
  expect(rowClicks).toHaveBeenCalledTimes(1);
  // And the press never moved the window.
  expect(useWindowStore.getState().windows[0].position).toEqual(INITIAL_POSITION);
});

test('a click still lands after sub-threshold pointer jitter', async () => {
  const rowClicks = vi.fn();
  const { row } = await renderWindowWithRow(rowClicks);

  act(() => {
    dom.pointer(row, 'pointerdown', { clientX: 150, clientY: 150 });
    dom.pointer(row, 'pointermove', { clientX: 152, clientY: 151 }); // < 5px: still a click
    dom.pointer(row, 'pointerup', { clientX: 152, clientY: 151 });
  });
  const click = act(() => dom.click({ clientX: 152, clientY: 151 }));

  expect(click).not.toBeNull();
  expect(rowClicks).toHaveBeenCalledTimes(1);
  expect(useWindowStore.getState().windows[0].position).toEqual(INITIAL_POSITION);
});

test('pointer movement past the threshold still starts a body drag', async () => {
  const rowClicks = vi.fn();
  const { row } = await renderWindowWithRow(rowClicks);

  act(() => {
    dom.pointer(row, 'pointerdown', { clientX: 150, clientY: 150 });
    dom.pointer(row, 'pointermove', { clientX: 200, clientY: 150 }); // 50px: drag begins
    dom.pointer(row, 'pointermove', { clientX: 260, clientY: 150 });
    dom.pointer(row, 'pointerup', { clientX: 260, clientY: 150 });
  });

  // dragOffset = (150,150) - (100,100); final pointer (260,150) → (210,100).
  expect(useWindowStore.getState().windows[0].position).toEqual({ x: 210, y: 100 });
  // The press became a drag, so the row must not also receive a click.
  expect(rowClicks).not.toHaveBeenCalled();
});
