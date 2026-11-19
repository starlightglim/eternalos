import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';

// MenuBar pulls in the real stores (windowStore registers a top-level
// window.addEventListener, zustand persist resolves window.localStorage) —
// stub both before any import, like authStore.test.ts does.
vi.hoisted(() => {
  const g = globalThis as unknown as { localStorage?: unknown; window?: unknown };
  const backing = new Map<string, string>();
  g.localStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  g.window = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: g.localStorage,
  };
});

// No network: the desktop/window stores go into local-only mode, which also
// disables the API-gated menu entries (Ask Eternal, Log Out, ...).
vi.mock('../../services/api', () => ({
  isApiConfigured: false,
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

import { MemoryRouter } from 'react-router-dom';
import { MenuBar } from './MenuBar';
import { AlertDialog } from '../ui/AlertDialog';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { installTestDom, TestElement, type TestDom, type KeyInit, type TestEvent, type TestNode } from '../window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;

async function renderMenuBar(extraChild?: ReactElement): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(
      createElement(MemoryRouter, null, createElement(MenuBar), ...(extraChild ? [extraChild] : []))
    );
  });
}

/** Depth-first (document order) list of descendants with attr === value. */
function elementsWith(from: TestNode, name: string, value: string): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if (child.getAttribute(name) === value) found.push(child);
        visit(child);
      }
    }
  };
  visit(from);
  return found;
}

/** The five top-level menuitem elements (apple, File, Edit, View, Special). */
function topLevelTitles(): TestElement[] {
  return elementsWith(dom.root, 'role', 'menuitem').filter(
    (el) => el.getAttribute('aria-haspopup') === 'menu'
  );
}

/** Dropdown menuitems (no aria-haspopup, unlike the top-level entries). */
function dropdownItems(): TestElement[] {
  return elementsWith(dom.root, 'role', 'menuitem').filter(
    (el) => el.getAttribute('aria-haspopup') === null
  );
}

function focusedItem(): TestElement {
  const el = dom.document.activeElement;
  if (!el) throw new Error('no focused element');
  return el;
}

function focusedText(): string | null {
  return dom.document.activeElement?.textContent ?? null;
}

function pressKey(key: string, init?: KeyInit): void {
  act(() => {
    dom.key(focusedItem(), 'keydown', { key, ...init });
  });
}

/** Dispatch a keydown on `target` — it bubbles to the document handler. */
function pressOn(target: TestElement, key: string, init?: KeyInit): TestEvent {
  let event: TestEvent | undefined;
  act(() => {
    event = dom.key(target, 'keydown', { key, ...init });
  });
  return event as TestEvent;
}

/** Two text items on the desktop, alpha selected — the ⌘-commands' target. */
function seedDesktopItems(): void {
  const store = useDesktopStore.getState();
  act(() => {
    store.addItem({
      id: 'alpha', type: 'text' as const, name: 'alpha.txt', parentId: null,
      position: { x: 0, y: 0 }, isPublic: true, createdAt: 1, updatedAt: 1,
    });
    store.addItem({
      id: 'bravo', type: 'text' as const, name: 'bravo.txt', parentId: null,
      position: { x: 1, y: 0 }, isPublic: true, createdAt: 1, updatedAt: 1,
    });
    store.selectItem('alpha', false);
  });
}

function itemNames(): string[] {
  return useDesktopStore.getState().items.map((item) => item.name);
}

function isTrashed(id: string): boolean {
  return useDesktopStore.getState().items.find((item) => item.id === id)?.isTrashed === true;
}

function selection(): string[] {
  return Array.from(useDesktopStore.getState().selectedIds);
}

/** F10 is a document-level shortcut — dispatch it wherever focus is. */
function pressF10(): void {
  act(() => {
    dom.key(dom.document.body, 'keydown', { key: 'F10' });
  });
}

/** Focus an element outside the menubar, as the pre-F10 focus owner. */
function focusOpener(): TestElement {
  const opener = dom.document.createElement('button');
  dom.document.body.appendChild(opener);
  opener.focus();
  return opener;
}

/** Open the File menu by keyboard (F10 → File → Down). */
function openFileMenu(): void {
  pressF10();
  pressKey('ArrowRight');
  pressKey('ArrowDown');
}

beforeEach(() => {
  dom = installTestDom();
  // soundStore logs a Web Audio warning per open in the fake DOM; silence it.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  useDesktopStore.getState().reset();
  useWindowStore.setState({ windows: [], nextZIndex: 1 });
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

test('renders WAI-ARIA menubar semantics', async () => {
  await renderMenuBar();

  const bar = elementsWith(dom.root, 'role', 'menubar');
  expect(bar).toHaveLength(1);

  const titles = topLevelTitles();
  expect(titles).toHaveLength(5);
  for (const title of titles) {
    expect(title.getAttribute('aria-haspopup')).toBe('menu');
    expect(title.getAttribute('aria-expanded')).toBe('false');
  }
  // The apple glyph is decorative text — the entry needs a real name.
  expect(titles[0].getAttribute('aria-label')).toBe('Apple');
  expect(titles[1].textContent).toBe('File');

  // Nothing open yet: no dropdown in the tree.
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(0);

  // Open the File menu by keyboard; the dropdown semantics appear.
  openFileMenu();
  expect(titles[1].getAttribute('aria-expanded')).toBe('true');
  const dropdown = elementsWith(dom.root, 'role', 'menu');
  expect(dropdown).toHaveLength(1);
  expect(dropdown[0].getAttribute('aria-orientation')).toBe('vertical');
  expect(elementsWith(dom.root, 'role', 'separator').length).toBeGreaterThan(0);

  // With nothing selected and no windows, Open/Close Window/Get Info are
  // disabled and say so.
  const disabled = elementsWith(dom.root, 'aria-disabled', 'true');
  expect(disabled.map((el) => el.textContent)).toEqual([
    'Open⌘O',
    'Close Window⌘W',
    'Get Info⌘I',
  ]);
});

test('F10 focuses the menubar on the first top-level item', async () => {
  const opener = focusOpener();
  await renderMenuBar();
  expect(dom.document.activeElement).toBe(opener);

  pressF10();

  const titles = topLevelTitles();
  expect(dom.document.activeElement).toBe(titles[0]);
  expect(titles[0].getAttribute('tabindex')).toBe('0');
  expect(titles[1].getAttribute('tabindex')).toBe('-1');
});

test('ArrowLeft/ArrowRight move between top-level menus, wrapping', async () => {
  await renderMenuBar();
  const titles = topLevelTitles();

  pressF10();
  expect(dom.document.activeElement).toBe(titles[0]); // apple

  pressKey('ArrowRight');
  expect(dom.document.activeElement).toBe(titles[1]); // File
  pressKey('ArrowRight');
  expect(dom.document.activeElement).toBe(titles[2]); // Edit
  pressKey('ArrowRight');
  expect(dom.document.activeElement).toBe(titles[3]); // View
  pressKey('ArrowRight');
  expect(dom.document.activeElement).toBe(titles[4]); // Special
  pressKey('ArrowRight');
  expect(dom.document.activeElement).toBe(titles[0]); // wraps to apple
  pressKey('ArrowLeft');
  expect(dom.document.activeElement).toBe(titles[4]); // wraps back to Special
});

test('Down, Enter and Space open the focused menu onto its first enabled item', async () => {
  await renderMenuBar();
  const titles = topLevelTitles();

  pressF10();
  pressKey('ArrowRight'); // File
  pressKey('ArrowDown');
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);
  expect(focusedText()).toBe('New Folder⌘N');
  expect(focusedItem().getAttribute('tabindex')).toBe('0');

  // Escape back to the title, then Enter opens it again.
  pressKey('Escape');
  expect(dom.document.activeElement).toBe(titles[1]);
  pressKey('Enter');
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);
  expect(focusedText()).toBe('New Folder⌘N');

  // Escape back to the title, then Space opens it too.
  pressKey('Escape');
  expect(dom.document.activeElement).toBe(titles[1]);
  pressKey(' ');
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);
  expect(focusedText()).toBe('New Folder⌘N');
});

test('ArrowUp/ArrowDown navigate the dropdown, wrapping and skipping disabled', async () => {
  await renderMenuBar();
  openFileMenu();
  expect(focusedText()).toBe('New Folder⌘N');

  // File menu: Open, Close Window and Get Info are disabled with no
  // selection/windows — navigation must skip them.
  pressKey('ArrowDown');
  expect(focusedText()).toBe('Find...⌘F');
  pressKey('ArrowDown');
  expect(focusedText()).toBe('Export Desktop...');
  pressKey('ArrowDown');
  expect(focusedText()).toBe('New Folder⌘N'); // wraps to the top
  pressKey('ArrowUp');
  expect(focusedText()).toBe('Export Desktop...'); // wraps to the bottom
});

test('Home and End jump within the dropdown', async () => {
  await renderMenuBar();
  openFileMenu();

  pressKey('End');
  expect(focusedText()).toBe('Export Desktop...');
  pressKey('Home');
  expect(focusedText()).toBe('New Folder⌘N');
});

test('Left/Right inside an open dropdown switch menus, keeping one open', async () => {
  await renderMenuBar();
  const titles = topLevelTitles();
  openFileMenu();
  expect(focusedText()).toBe('New Folder⌘N');

  pressKey('ArrowRight'); // File → Edit
  expect(titles[1].getAttribute('aria-expanded')).toBe('false');
  expect(titles[2].getAttribute('aria-expanded')).toBe('true');
  // The Edit menu has a single enabled entry with nothing selected.
  expect(focusedText()).toBe('Select All⌘A');
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);

  pressKey('ArrowLeft'); // Edit → File
  expect(titles[2].getAttribute('aria-expanded')).toBe('false');
  expect(titles[1].getAttribute('aria-expanded')).toBe('true');
  expect(focusedText()).toBe('New Folder⌘N');
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);
});

test('Escape closes the dropdown and returns focus to the top-level item', async () => {
  await renderMenuBar();
  const titles = topLevelTitles();
  openFileMenu();
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);

  pressKey('Escape');

  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(0);
  expect(titles[1].getAttribute('aria-expanded')).toBe('false');
  expect(dom.document.activeElement).toBe(titles[1]);
});

test('a second Escape restores focus to the pre-menubar element', async () => {
  const opener = focusOpener();
  await renderMenuBar();

  pressF10();
  pressKey('ArrowRight');
  pressKey('ArrowDown');
  pressKey('Escape'); // closes the dropdown, focus on the File title
  expect(dom.document.activeElement).not.toBe(opener);

  pressKey('Escape'); // leaves the menubar entirely
  expect(dom.document.activeElement).toBe(opener);

  // Escape with nothing open exits right away too.
  pressF10();
  pressKey('Escape');
  expect(dom.document.activeElement).toBe(opener);
});

test('Enter activates the focused dropdown item', async () => {
  await renderMenuBar();

  pressF10();
  pressKey('ArrowDown'); // Apple menu, first enabled entry
  expect(focusedText()).toBe('About EternalOS...');

  pressKey('Enter');

  expect(useWindowStore.getState().windows.map((w) => w.id)).toEqual(['about-eternalos']);
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(0);
  // Drain the debounced localStorage save scheduled by openWindow.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
});

test('Duplicate is aria-disabled exactly when the selection is apps-only (dupapp)', async () => {
  await renderMenuBar();
  const store = useDesktopStore.getState();
  const appItem = {
    id: 'app-1', type: 'app' as const, name: 'Installed App', parentId: null,
    position: { x: 0, y: 0 }, isPublic: true, createdAt: 1, updatedAt: 1,
  };
  const textItem = {
    id: 'note-1', type: 'text' as const, name: 'Note', parentId: null,
    position: { x: 1, y: 0 }, isPublic: true, createdAt: 1, updatedAt: 1,
  };
  act(() => {
    store.addItem(appItem);
    store.selectItem('app-1', false);
  });

  // An app-only selection cannot be duplicated (duplicateItems refuses app
  // items) — the Edit menu must reflect it.
  pressF10();
  pressKey('ArrowRight');
  pressKey('ArrowRight'); // Edit
  pressKey('ArrowDown'); // opens Edit (single enabled item: Select All)
  const duplicate = dropdownItems().find((el) => el.textContent === 'Duplicate⌘D');
  expect(duplicate).toBeDefined();
  expect(duplicate?.getAttribute('aria-disabled')).toBe('true');

  // A selection holding something duplicatable enables it again.
  act(() => {
    store.addItem(textItem);
    store.selectItem('note-1', false);
  });
  const duplicateAfter = dropdownItems().find((el) => el.textContent === 'Duplicate⌘D');
  expect(duplicateAfter?.getAttribute('aria-disabled')).toBe(null);
});

test('mouse clicks still open and close the dropdown', async () => {
  await renderMenuBar();
  const titles = topLevelTitles();

  act(() => {
    dom.pointer(titles[1], 'pointerdown', { clientX: 10, clientY: 2 });
    dom.pointer(titles[1], 'pointerup', { clientX: 10, clientY: 2 });
  });
  act(() => {
    dom.click({ clientX: 10, clientY: 10 });
  });
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(1);
  expect(titles[1].getAttribute('aria-expanded')).toBe('true');

  // Clicking the title again toggles it closed.
  act(() => {
    dom.pointer(titles[1], 'pointerdown', { clientX: 10, clientY: 2 });
    dom.pointer(titles[1], 'pointerup', { clientX: 10, clientY: 2 });
  });
  act(() => {
    dom.click({ clientX: 10, clientY: 10 });
  });
  expect(elementsWith(dom.root, 'role', 'menu')).toHaveLength(0);
  expect(titles[1].getAttribute('aria-expanded')).toBe('false');
});

// ============================================
// ⌘-SHORTCUT GATING (menuguard)
// ============================================

test('with an AlertDialog open, ⌘⌫/⌘D/⌘A and F10 do nothing', async () => {
  seedDesktopItems();
  await renderMenuBar(
    createElement(AlertDialog, {
      type: 'confirm',
      title: 'Trash this item?',
      message: 'The selection would move to the trash.',
      onClose: () => {},
    })
  );

  // The dialog traps focus: keys land on its focused (primary) button.
  expect(dom.document.activeElement?.nodeName).toBe('BUTTON');

  // ⌘⌫ must not trash the selection behind the confirm.
  pressKey('Backspace', { metaKey: true });
  expect(isTrashed('alpha')).toBe(false);
  expect(selection()).toEqual(['alpha']);

  // ⌘D must not duplicate behind it, and ⌘A must not touch the selection.
  pressKey('d', { metaKey: true });
  expect(itemNames()).toEqual(['alpha.txt', 'bravo.txt']);
  pressKey('a', { metaKey: true });
  expect(selection()).toEqual(['alpha']);

  // F10 stands down too — a modal owns the keyboard: focus stays in the
  // dialog, and the menubar's roving tabindex is never armed.
  pressKey('F10');
  expect(dom.document.activeElement?.nodeName).toBe('BUTTON');
  expect(topLevelTitles()[0].getAttribute('tabindex')).toBe('-1');
});

test('any open aria-modal dialog gates the ⌘-commands; closed, they work as before', async () => {
  seedDesktopItems();
  await renderMenuBar();

  // The LinkDialog / DeveloperStudio scaffold shape: a plain role="dialog"
  // with aria-modal="true" — the shared signal, not an AlertDialog special
  // case.
  const dialog = dom.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dom.document.body.appendChild(dialog);

  try {
    pressOn(dom.document.body, 'Backspace', { metaKey: true });
    expect(isTrashed('alpha')).toBe(false);
    pressOn(dom.document.body, 'd', { metaKey: true });
    expect(itemNames()).toEqual(['alpha.txt', 'bravo.txt']);
    pressOn(dom.document.body, 'a', { metaKey: true });
    expect(selection()).toEqual(['alpha']);
  } finally {
    dialog.remove();
  }

  // Once it is gone, the ⌘-commands work exactly as before.
  pressOn(dom.document.body, 'a', { metaKey: true }); // ⌘A selects the desktop
  expect(selection()).toEqual(['alpha', 'bravo']);
  pressOn(dom.document.body, 'd', { metaKey: true }); // ⌘D duplicates the selection
  expect(itemNames()).toEqual(['alpha.txt', 'bravo.txt', 'alpha.txt copy', 'bravo.txt copy']);
  pressOn(dom.document.body, 'Backspace', { metaKey: true }); // ⌘⌫ trashes and deselects
  expect(isTrashed('alpha')).toBe(true);
  expect(isTrashed('bravo')).toBe(true);
  expect(selection()).toEqual([]);
});

test('typing in an input, textarea, select, or contenteditable never triggers the ⌘-commands', async () => {
  seedDesktopItems();
  await renderMenuBar();

  // The keystrokes a user actually types in a control, as the browser
  // delivers them: targeted at the focused control, bubbling to document.
  const commands: Array<[string, KeyInit]> = [
    ['Backspace', { metaKey: true }],
    ['d', { metaKey: true }],
    ['a', { metaKey: true }],
    ['n', { metaKey: true }],
  ];

  const input = dom.document.createElement('input');
  dom.document.body.appendChild(input);
  input.focus();
  expect(dom.document.activeElement).toBe(input);
  for (const [key, init] of commands) {
    const event = pressOn(input, key, init);
    expect(event.defaultPrevented).toBe(false);
  }

  const textarea = dom.document.createElement('textarea');
  dom.document.body.appendChild(textarea);
  textarea.focus();
  for (const [key, init] of commands) {
    pressOn(textarea, key, init);
  }

  const select = dom.document.createElement('select');
  dom.document.body.appendChild(select);
  select.focus();
  for (const [key, init] of commands) {
    pressOn(select, key, init);
  }

  // Contenteditable: the caret can sit in a descendant of the editable root.
  const editable = dom.document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  dom.document.body.appendChild(editable);
  editable.focus();
  for (const [key, init] of commands) {
    pressOn(editable, key, init);
  }

  // The keystrokes stayed with the controls: nothing trashed, nothing
  // duplicated, no New Folder, and the desktop selection untouched.
  expect(isTrashed('alpha')).toBe(false);
  expect(itemNames()).toEqual(['alpha.txt', 'bravo.txt']);
  expect(selection()).toEqual(['alpha']);
});
