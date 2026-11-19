// The desktop shortcut contract (CORE-ROADMAP W1): the document-level
// Tab/Enter/Escape/⌘⌫/arrow handler stands down under an open modal, in
// window content, and in text controls — and works on the desktop surface
// otherwise. Drives the real `useDesktopShortcuts` hook (the exact wiring
// Desktop.tsx uses) against the real desktop-store selection, rendering a
// real AlertDialog as the modal fixture, in the repo's node-env test DOM.

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';

import { useDesktopShortcuts } from './desktopKeyboard';
import { AlertDialog } from '../ui/AlertDialog';
import { useDesktopStore } from '../../stores/desktopStore';
import {
  installTestDom,
  type KeyInit,
  type TestDom,
  type TestElement,
  type TestEvent,
} from '../window/windowTestDom';
import type { DesktopItem } from '../../types';

let dom: TestDom;
let reactRoot: Root | null = null;
let openItem: Mock<(item: DesktopItem) => void>;
let moveToTrash: Mock<(ids: string[]) => void>;
let closeContextMenu: Mock<() => void>;
let focusWindow: Mock<(id: string) => void>;
let onAlertClose: Mock<() => void>;

/** Two visible windows, w2 on top — Cmd+` should hand focus to w1. */
const WINDOWS = [
  { id: 'w1', zIndex: 10, minimized: false },
  { id: 'w2', zIndex: 20, minimized: false },
];

function makeItem(id: string, x: number, y: number): DesktopItem {
  return {
    id,
    type: 'text',
    name: `${id}.txt`,
    parentId: null,
    position: { x, y },
    isPublic: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Alpha(0,0), Bravo(1,0), Charlie(2,0) on the root grid, alpha selected. */
function seedDesktop(): void {
  useDesktopStore.setState({
    items: [makeItem('alpha', 0, 0), makeItem('bravo', 1, 0), makeItem('charlie', 2, 0)],
    selectedIds: new Set(['alpha']),
  });
}

function selection(): string[] {
  return Array.from(useDesktopStore.getState().selectedIds);
}

function byId(id: string): TestElement {
  const el = dom.document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function press(target: TestElement, key: string, init?: KeyInit): TestEvent {
  let event: TestEvent | undefined;
  act(() => {
    event = dom.key(target, 'keydown', { key, ...init });
  });
  return event as TestEvent;
}

/** Press a key at whatever currently holds focus (inside a dialog). */
function pressFocused(key: string, init?: KeyInit): TestEvent {
  const el = dom.document.activeElement;
  if (!el) throw new Error('no focused element');
  return press(el, key, init);
}

interface SurfaceProps {
  alert: boolean;
  withWindow: boolean;
}

/**
 * Mirrors Desktop.tsx's wiring of the hook: real store selectors and
 * selection actions, spies for the effectful actions (open / trash /
 * close menu / focus window), and a desktop surface element as the
 * dispatch target. The input / contenteditable / window fragments are
 * the other places focus can sit while the desktop is up.
 */
function TestSurface({ alert, withWindow }: SurfaceProps): ReactElement {
  const items = useDesktopStore((state) => state.items);
  const selectedIds = useDesktopStore((state) => state.selectedIds);
  const selectItem = useDesktopStore((state) => state.selectItem);
  const deselectAll = useDesktopStore((state) => state.deselectAll);
  const rootItems = items.filter(
    (item) => item.parentId === null && !item.isTrashed && item.type !== 'sticker'
  );
  useDesktopShortcuts({
    rootItems,
    selectedIds,
    selectItem,
    deselectAll,
    openItem,
    moveToTrash,
    closeContextMenu,
    windows: WINDOWS,
    focusWindow,
  });

  return createElement(
    'div',
    { id: 'desktop-surface', className: 'user-desktop' },
    createElement('input', { id: 'desk-input' }),
    createElement('div', { id: 'desk-editable' }),
    withWindow &&
      createElement(
        'div',
        { className: 'window' },
        createElement(
          'div',
          { className: 'windowContent' },
          createElement('button', { id: 'in-window-button', type: 'button' }, 'Window control')
        )
      ),
    alert &&
      createElement(AlertDialog, {
        type: 'confirm',
        title: 'Trash this item?',
        message: 'The selection would move to the trash.',
        onClose: onAlertClose,
      })
  );
}

async function renderSurface(props: SurfaceProps): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(createElement(TestSurface, props));
  });
}

beforeEach(() => {
  dom = installTestDom();
  openItem = vi.fn<(item: DesktopItem) => void>();
  moveToTrash = vi.fn<(ids: string[]) => void>();
  closeContextMenu = vi.fn<() => void>();
  focusWindow = vi.fn<(id: string) => void>();
  onAlertClose = vi.fn<() => void>();
  seedDesktop();
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
  useDesktopStore.setState({ items: [], selectedIds: new Set<string>() });
});

test('with an AlertDialog open, Enter/⌘⌫/Tab/arrows do nothing to the desktop', async () => {
  await renderSurface({ alert: true, withWindow: false });

  // The dialog traps focus: keys land on its focused (primary) button.
  expect(dom.document.activeElement?.nodeName).toBe('BUTTON');

  pressFocused('Enter');
  expect(openItem).not.toHaveBeenCalled();
  expect(selection()).toEqual(['alpha']);

  pressFocused('Backspace', { metaKey: true });
  expect(moveToTrash).not.toHaveBeenCalled();
  expect(selection()).toEqual(['alpha']);

  pressFocused('Tab');
  expect(selection()).toEqual(['alpha']);

  pressFocused('ArrowRight');
  expect(selection()).toEqual(['alpha']);

  // Escape belongs to the dialog (its own handler closes it); the desktop
  // neither deselects nor touches its context menu.
  pressFocused('Escape');
  expect(onAlertClose).toHaveBeenCalledTimes(1);
  expect(selection()).toEqual(['alpha']);
  expect(closeContextMenu).not.toHaveBeenCalled();

  // Window cycling is part of the gated handler too.
  pressFocused('`', { metaKey: true });
  expect(focusWindow).not.toHaveBeenCalled();

  // The gate is modal-driven, not target-driven: even keys aimed straight
  // at the desktop surface are ignored while the dialog is up.
  press(byId('desktop-surface'), 'Enter');
  expect(openItem).not.toHaveBeenCalled();
  press(byId('desktop-surface'), 'Backspace', { metaKey: true });
  expect(moveToTrash).not.toHaveBeenCalled();
});

test('with the dialog closed, Tab/Enter/Escape/⌘⌫/arrows work as before', async () => {
  await renderSurface({ alert: false, withWindow: false });
  const surface = byId('desktop-surface');

  // Tab cycles the selection to the next icon (alpha → bravo) and keeps
  // the keystroke from moving focus off the desktop.
  const tab = press(surface, 'Tab');
  expect(tab.defaultPrevented).toBe(true);
  expect(selection()).toEqual(['bravo']);

  // Enter opens the selected item.
  press(surface, 'Enter');
  expect(openItem).toHaveBeenCalledTimes(1);
  expect(openItem.mock.calls[0][0].id).toBe('bravo');
  expect(selection()).toEqual(['bravo']);

  // Escape deselects and closes the desktop context menu.
  press(surface, 'Escape');
  expect(selection()).toEqual([]);
  expect(closeContextMenu).toHaveBeenCalledTimes(1);

  // With no selection, Tab picks the first icon again.
  press(surface, 'Tab');
  expect(selection()).toEqual(['alpha']);

  // Arrows walk the grid from the selected item.
  const arrow = press(surface, 'ArrowRight');
  expect(arrow.defaultPrevented).toBe(true);
  expect(selection()).toEqual(['bravo']);

  // ⌘⌫ trashes the selection and deselects.
  press(surface, 'Backspace', { metaKey: true });
  expect(moveToTrash).toHaveBeenCalledWith(['bravo']);
  expect(selection()).toEqual([]);

  // Cmd+` cycles windows from the desktop surface.
  press(surface, '`', { metaKey: true });
  expect(focusWindow).toHaveBeenCalledWith('w1');
});

test('typing in an input or contenteditable never triggers desktop shortcuts', async () => {
  await renderSurface({ alert: false, withWindow: false });

  const input = byId('desk-input');
  input.focus();
  expect(dom.document.activeElement).toBe(input);

  press(input, 'a');
  press(input, 'ArrowRight');
  press(input, 'Enter');
  press(input, '`', { metaKey: true });
  const tab = press(input, 'Tab');
  press(input, 'Backspace', { metaKey: true });

  // The keystrokes stay with the control: no selection change, no opens,
  // no trashing, and Tab is not even prevented.
  expect(tab.defaultPrevented).toBe(false);
  expect(selection()).toEqual(['alpha']);
  expect(openItem).not.toHaveBeenCalled();
  expect(moveToTrash).not.toHaveBeenCalled();
  expect(closeContextMenu).not.toHaveBeenCalled();
  expect(focusWindow).not.toHaveBeenCalled();

  // Contenteditable is a text control too (the caret can sit in it).
  const editable = byId('desk-editable');
  editable.setAttribute('contenteditable', 'true');
  editable.focus();
  press(editable, 'Tab');
  press(editable, 'ArrowRight');
  press(editable, 'Enter');
  press(editable, 'Backspace', { metaKey: true });
  expect(selection()).toEqual(['alpha']);
  expect(openItem).not.toHaveBeenCalled();
  expect(moveToTrash).not.toHaveBeenCalled();
});

test('focus inside a window ignores the icon shortcuts but keeps Cmd+` cycling', async () => {
  await renderSurface({ alert: false, withWindow: true });

  const control = byId('in-window-button');
  control.focus();
  expect(dom.document.activeElement).toBe(control);

  press(control, 'Tab');
  press(control, 'ArrowRight');
  press(control, 'Enter');
  press(control, 'Escape');
  press(control, 'Backspace', { metaKey: true });

  expect(selection()).toEqual(['alpha']);
  expect(openItem).not.toHaveBeenCalled();
  expect(moveToTrash).not.toHaveBeenCalled();
  expect(closeContextMenu).not.toHaveBeenCalled();

  // Cmd+` is the window-facing shortcut: cycling from inside a window is
  // its natural context and stays available (current behavior, kept).
  press(control, '`', { metaKey: true });
  expect(focusWindow).toHaveBeenCalledWith('w1');

  // Back on the desktop surface itself, the shortcuts still work.
  press(byId('desktop-surface'), 'ArrowRight');
  expect(selection()).toEqual(['bravo']);
});

test('any open aria-modal dialog gates the shortcuts, not just AlertDialog', async () => {
  await renderSurface({ alert: false, withWindow: false });

  // The DeveloperStudio / LinkDialog shape: a plain role="dialog" with
  // aria-modal="true", not an AlertDialog.
  const dialog = dom.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dom.document.body.appendChild(dialog);

  try {
    press(byId('desktop-surface'), 'Enter');
    expect(openItem).not.toHaveBeenCalled();
    press(byId('desktop-surface'), 'Backspace', { metaKey: true });
    expect(moveToTrash).not.toHaveBeenCalled();
    press(byId('desktop-surface'), 'ArrowRight');
    expect(selection()).toEqual(['alpha']);
  } finally {
    dialog.remove();
  }

  // Once it is gone the desktop keyboard works again.
  press(byId('desktop-surface'), 'Enter');
  expect(openItem).toHaveBeenCalledTimes(1);
});

test('a non-modal role="status" banner (the .estheme preview shape) does not gate', async () => {
  await renderSurface({ alert: false, withWindow: false });

  // EsthemePreviewBanner is role="status" by design — the desktop stays
  // interactive under it, so the shortcuts must keep working.
  const banner = dom.document.createElement('div');
  banner.setAttribute('role', 'status');
  dom.document.body.appendChild(banner);

  try {
    press(byId('desktop-surface'), 'ArrowRight');
    expect(selection()).toEqual(['bravo']);
    press(byId('desktop-surface'), 'Enter');
    expect(openItem).toHaveBeenCalledTimes(1);
    expect(openItem.mock.calls[0][0].id).toBe('bravo');
  } finally {
    banner.remove();
  }
});
