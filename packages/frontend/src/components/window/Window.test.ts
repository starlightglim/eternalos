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
import { installTestDom, type TestDom, type TestElement, type TestEvent, type KeyInit } from './windowTestDom';
import { useWindowStore } from '../../stores/windowStore';
import { useTilingStore } from '../../stores/tilingStore';
import type { Rect } from '../../utils/tiling';

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

/**
 * Mount the real Window with a plain, non-interactive div inside its content.
 * `opts` overrides the rendered geometry (and re-syncs the seeded store to
 * match — the keyboard handlers read the window's position/size from the
 * store, not from props).
 */
async function renderWindowWithRow(
  onRowClick: () => void,
  opts: { position?: { x: number; y: number }; size?: { width: number; height: number } } = {}
): Promise<{ row: TestElement; content: TestElement }> {
  const position = opts.position ?? { ...INITIAL_POSITION };
  const size = opts.size ?? { width: 400, height: 300 };
  useWindowStore.setState({
    windows: [{ ...seededWindow(), position: { ...position }, size: { ...size } }],
    nextZIndex: 10,
  });

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
          position: { ...position },
          size: { ...size },
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

/** Dispatch a keydown on `target` and return the event (see `dom.key`). */
function pressKey(target: TestElement, init?: KeyInit): TestEvent {
  let event: TestEvent | undefined;
  act(() => {
    event = dom.key(target, 'keydown', init);
  });
  if (!event) throw new Error('keydown did not dispatch');
  return event;
}

/** The rendered element carrying the given eos-part, or a thrown error. */
function findPart(name: string): TestElement {
  const el = dom.findDescendant(dom.root, 'eos-part', name);
  if (!el) throw new Error(`missing [eos-part="${name}"]`);
  return el;
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

// ============================================
// KEYBOARD: move, resize, close from the title bar
// ============================================

test('title bar is a focusable keyboard surface naming the window', async () => {
  await renderWindowWithRow(() => {});
  const titleBar = findPart('titlebar');

  expect(titleBar.getAttribute('tabindex')).toBe('0');
  expect(titleBar.getAttribute('role')).toBe('toolbar');
  expect(titleBar.getAttribute('aria-label')).toBe('Test Window');
  // The content is programmatically focusable (Escape's target) but is not
  // itself a tab stop.
  expect(findPart('content').getAttribute('tabindex')).toBe('-1');

  // Enter/Space on the toolbar itself are inert and must not leak to the
  // document-level shortcuts (Enter there opens the selected desktop icon).
  const enter = pressKey(titleBar, { key: 'Enter' });
  expect(enter.propagationStopped).toBe(true);
  expect(useWindowStore.getState().windows).toHaveLength(1);
});

test('arrow keys move the focused window; Shift is the large step', async () => {
  await renderWindowWithRow(() => {});
  const titleBar = findPart('titlebar');

  act(() => {
    dom.key(titleBar, 'keydown', { key: 'ArrowRight' });
    dom.key(titleBar, 'keydown', { key: 'ArrowDown' });
  });
  expect(useWindowStore.getState().windows[0].position).toEqual({ x: 110, y: 110 });

  act(() => {
    dom.key(titleBar, 'keydown', { key: 'ArrowLeft', shiftKey: true });
    dom.key(titleBar, 'keydown', { key: 'ArrowUp', shiftKey: true });
  });
  expect(useWindowStore.getState().windows[0].position).toEqual({ x: 60, y: 60 });

  // OS-modifier arrows are left to the browser/OS.
  act(() => {
    dom.key(titleBar, 'keydown', { key: 'ArrowRight', metaKey: true });
    dom.key(titleBar, 'keydown', { key: 'ArrowDown', ctrlKey: true });
  });
  expect(useWindowStore.getState().windows[0].position).toEqual({ x: 60, y: 60 });
});

test('keyboard moves respect the viewport clamp the store applies', async () => {
  await renderWindowWithRow(() => {}, { position: { x: 5, y: 25 } });
  const titleBar = findPart('titlebar');

  // Left/top edges (top edge is the menu bar height, 20px in the test DOM).
  act(() => {
    dom.key(titleBar, 'keydown', { key: 'ArrowLeft' });
    dom.key(titleBar, 'keydown', { key: 'ArrowUp' });
  });
  expect(useWindowStore.getState().windows[0].position).toEqual({ x: 0, y: 20 });

  // Right/bottom edges: hundreds of px of overshoot must stop at
  // (1280 - 400, 800 - 300).
  act(() => {
    for (let i = 0; i < 10; i++) dom.key(titleBar, 'keydown', { key: 'ArrowDown', shiftKey: true });
    for (let i = 0; i < 18; i++) dom.key(titleBar, 'keydown', { key: 'ArrowRight', shiftKey: true });
  });
  expect(useWindowStore.getState().windows[0].position).toEqual({ x: 880, y: 500 });
});

test('Alt+arrows resize with the min-size and viewport clamps', async () => {
  await renderWindowWithRow(() => {}, { position: { x: 875, y: 100 } });
  const titleBar = findPart('titlebar');

  // Growth stops at the viewport's right edge (1280 - 875 = 405).
  act(() => {
    dom.key(titleBar, 'keydown', { key: 'ArrowRight', altKey: true });
  });
  expect(useWindowStore.getState().windows[0].size).toEqual({ width: 405, height: 300 });

  act(() => {
    dom.key(titleBar, 'keydown', { key: 'ArrowDown', altKey: true });
  });
  expect(useWindowStore.getState().windows[0].size).toEqual({ width: 405, height: 310 });

  // Shrinking floors at the store's 200×150 minimum.
  act(() => {
    for (let i = 0; i < 5; i++) dom.key(titleBar, 'keydown', { key: 'ArrowLeft', altKey: true, shiftKey: true });
    for (let i = 0; i < 4; i++) dom.key(titleBar, 'keydown', { key: 'ArrowUp', altKey: true, shiftKey: true });
  });
  expect(useWindowStore.getState().windows[0].size).toEqual({ width: 200, height: 150 });
});

test('Escape from the title bar returns focus to the window content', async () => {
  await renderWindowWithRow(() => {});
  const titleBar = findPart('titlebar');
  const content = findPart('content');

  const event = pressKey(titleBar, { key: 'Escape' });

  expect(dom.document.activeElement).toBe(content);
  // The keypress must not reach the document-level shortcuts
  // (Escape there deselects desktop icons).
  expect(event.propagationStopped).toBe(true);
});

test('Alt/Option+W closes the focused window', async () => {
  await renderWindowWithRow(() => {});
  const titleBar = findPart('titlebar');

  // macOS reports Option+W as key="Ω" — the shortcut matches e.code.
  act(() => {
    dom.key(titleBar, 'keydown', { key: 'Ω', code: 'KeyW', altKey: true });
  });
  expect(useWindowStore.getState().windows).toHaveLength(0);

  // Windows/Linux report key="w".
  useWindowStore.setState({ windows: [seededWindow()] });
  act(() => {
    dom.key(titleBar, 'keydown', { key: 'w', code: 'KeyW', altKey: true });
  });
  expect(useWindowStore.getState().windows).toHaveLength(0);
});

test('window buttons are keyboard-reachable and operable', async () => {
  await renderWindowWithRow(() => {});
  const zoom = findPart('zoom');
  const collapse = findPart('collapse');
  const close = findPart('close');

  // Reachable by Tab (tabbable) and named — the ARIA button pattern.
  for (const btn of [close, zoom, collapse]) {
    expect(btn.getAttribute('tabindex')).toBe('0');
    expect(btn.getAttribute('role')).toBe('button');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  }

  // Operable: Space zooms, Enter collapses, Enter closes.
  let event = pressKey(zoom, { key: ' ' });
  expect(useWindowStore.getState().windows[0].maximized).toBe(true);
  expect(event.defaultPrevented).toBe(true);
  expect(event.propagationStopped).toBe(true);

  event = pressKey(collapse, { key: 'Enter' });
  expect(useWindowStore.getState().windows[0].collapsed).toBe(true);

  event = pressKey(close, { key: 'Enter' });
  expect(useWindowStore.getState().windows).toHaveLength(0);
  expect(event.defaultPrevented).toBe(true);
});

test('Tab stays native inside the window and never reaches the desktop icon cycler', async () => {
  await renderWindowWithRow(() => {});
  const titleBar = findPart('titlebar');
  const content = findPart('content');

  const fromTitleBar = pressKey(titleBar, { key: 'Tab' });
  expect(fromTitleBar.propagationStopped).toBe(true);
  expect(fromTitleBar.defaultPrevented).toBe(false); // native focus order preserved

  const fromContent = pressKey(content, { key: 'Tab' });
  expect(fromContent.propagationStopped).toBe(true);
  expect(fromContent.defaultPrevented).toBe(false);
});

// ============================================
// CANCELLATION + ACCESSIBILITY
// ============================================

test('pointercancel mid-drag releases the window and un-pauses tiling', async () => {
  const { row } = await renderWindowWithRow(() => {});
  const tile = { x: 0, y: 0, width: 400, height: 300 } as unknown as Rect;
  act(() => {
    useTilingStore.getState().setLayout(true, [WINDOW_ID], { [WINDOW_ID]: tile });
  });

  act(() => {
    dom.pointer(row, 'pointerdown', { clientX: 150, clientY: 150 });
    dom.pointer(row, 'pointermove', { clientX: 200, clientY: 150 }); // drag begins
  });
  expect(useTilingStore.getState().dragging).toBe(WINDOW_ID);

  act(() => {
    dom.pointer(row, 'pointercancel', { clientX: 200, clientY: 150 });
  });
  expect(useTilingStore.getState().dragging).toBeNull();
  const afterCancel = useWindowStore.getState().windows[0].position;

  // Later movement with the button still reported down must not move it.
  act(() => {
    dom.pointer(row, 'pointermove', { clientX: 400, clientY: 300 });
  });
  expect(useWindowStore.getState().windows[0].position).toEqual(afterCancel);

  act(() => {
    useTilingStore.getState().setLayout(false, [], {});
  });
});

test('window root is a non-modal dialog labelled by its title', async () => {
  await renderWindowWithRow(() => {});
  let root = findPart('content').parentNode as TestElement | null;
  while (root && root.getAttribute?.('role') !== 'dialog') root = root.parentNode as TestElement | null;
  if (!root) throw new Error('no role=dialog ancestor');
  expect(root.getAttribute('aria-modal')).toBe('false');
  const titleId = root.getAttribute('aria-labelledby');
  expect(titleId).toBeTruthy();
  expect(findPart('title').getAttribute('id')).toBe(titleId);
  expect(root.getAttribute('class')).toContain('window');
});
