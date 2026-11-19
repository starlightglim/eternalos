/**
 * desktopKeyboard — the document-level desktop shortcut contract, extracted
 * from Desktop.tsx (CORE-ROADMAP W1: the icon-navigation shortcuts used to
 * fire while a modal was open — Enter could open an item underneath an
 * AlertDialog, ⌘⌫ could trash the selection behind a dialog — and while
 * focus was inside a window or a text control).
 *
 * Gates, in order:
 *   1. Text editing: focus in an input/textarea/contenteditable → the keys
 *      belong to that control. (The old handler ignored input/textarea
 *      only; contenteditable is the extension.)
 *   2. Modal: any open `aria-modal="true"` dialog → the whole handler
 *      stands down; the desktop is inert behind a modal. See
 *      utils/modalGate for why the ARIA probe is the one shared signal.
 *   3. Cmd+` window cycling runs from anywhere that is not a text field
 *      or a modal — including from inside a window, which is that
 *      shortcut's natural context (that is current behavior and kept).
 *   4. Window content: once focus is inside a window (the global `window`
 *      class WindowChrome puts on every window root), the desktop icon
 *      shortcuts stand down — Tab/arrows/Enter belong to the focused
 *      control, and ⌘⌫ must not trash the desktop selection from under a
 *      window.
 *
 * The key handling itself is unchanged from the pre-extraction handler:
 * Tab/Enter/Escape/⌘⌫/arrows over the desktop icons, Cmd+` window cycling.
 */

import { useEffect } from 'react';
import { isModalOpen } from '../../utils/modalGate';
import type { DesktopItem } from '../../types';

const ELEMENT_NODE = 1;
/** The global window class (WindowChrome puts it on every window root). */
const WINDOW_CLASS = 'window';
const ARROW_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Open windows, for Cmd+` cycling — the fields the cycling logic reads. */
export interface DesktopShortcutWindow {
  id: string;
  zIndex: number;
  minimized: boolean;
}

/**
 * Everything the shortcut handler needs from the Desktop. Passed field by
 * field so the hook resubscribes exactly when the old inline effect did.
 */
export interface DesktopShortcutContext {
  /** Root-level items as rendered on the desktop (Desktop's rootItems). */
  rootItems: DesktopItem[];
  /** The current desktop selection. */
  selectedIds: ReadonlySet<string>;
  selectItem: (id: string, addToSelection?: boolean) => void;
  deselectAll: () => void;
  /** Open a desktop item — Desktop's double-click handler. */
  openItem: (item: DesktopItem) => void;
  /** ⌘⌫ — trash the selected items. */
  moveToTrash: (ids: string[]) => void;
  /** Escape clears the desktop context menu alongside the selection. */
  closeContextMenu: () => void;
  /** Open windows for Cmd+` cycling. */
  windows: ReadonlyArray<DesktopShortcutWindow>;
  focusWindow: (id: string) => void;
}

/**
 * True when the keydown's target is a text-editing control: the keystroke
 * belongs to that control, not the desktop.
 *
 * Tag names instead of `instanceof HTMLInputElement`/`HTMLTextAreaElement`:
 * identical semantics in the browser (those are exactly the INPUT/TEXTAREA
 * tags), and it also runs under the repo's node-env test DOM, where those
 * globals don't exist. The contenteditable check walks ancestors because
 * the caret can sit in a descendant of the editable root: browsers
 * maintain `isContentEditable` for that case, and the attribute read
 * covers the test DOM (`contenteditable=""` is the "true" state per HTML).
 */
function isTextEditingTarget(target: EventTarget | null): boolean {
  const start = target as Node | null;
  if (start && start.nodeType === ELEMENT_NODE) {
    const tag = (start as Element).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  }
  for (let node = start; node; node = node.parentNode) {
    if (node.nodeType !== ELEMENT_NODE) continue;
    const candidate = node as Element;
    if ((candidate as HTMLElement).isContentEditable) return true;
    const declared = candidate.getAttribute('contenteditable');
    if (declared === 'true' || declared === '') return true;
  }
  return false;
}

/**
 * True when the keydown's target lies inside a window: the desktop icon
 * shortcuts stand down so the focused control keeps its keys. Window roots
 * carry the global `window` class (WindowChrome); the check is a token
 * match, so classes like `windowContent` don't trip it.
 */
function isInsideWindow(target: EventTarget | null): boolean {
  for (let node = target as Node | null; node; node = node.parentNode) {
    if (node.nodeType !== ELEMENT_NODE) continue;
    const declared = (node as Element).getAttribute('class');
    if (declared && declared.split(/\s+/).includes(WINDOW_CLASS)) return true;
  }
  return false;
}

function handleDesktopShortcuts(e: KeyboardEvent, ctx: DesktopShortcutContext): void {
  // 1. Focus is in a text control — keys belong to it.
  if (isTextEditingTarget(e.target)) return;

  // 2. A modal is open — the desktop is inert behind it (Enter must not
  //    open an item underneath an AlertDialog, ⌘⌫ must not trash the
  //    selection while a dialog is up).
  if (isModalOpen()) return;

  // Handle Cmd+` (backtick) to cycle through open windows.
  // Note: Cmd+Tab conflicts with OS/browser tab switching, so we use ` instead.
  // Deliberately not gated on windows: cycling from inside a window is this
  // shortcut's natural context; the gates above are the ones that apply.
  if ((e.metaKey || e.ctrlKey) && (e.key === '`' || e.key === '~')) {
    e.preventDefault();
    const visibleWindows = ctx.windows.filter((w) => !w.minimized);
    if (visibleWindows.length > 1) {
      // Sort by z-index to find current top window
      const sortedWindows = [...visibleWindows].sort((a, b) => b.zIndex - a.zIndex);
      // Focus the next window (wraps around)
      const currentTopIndex = 0; // Top window is first after sorting
      const nextIndex = e.shiftKey
        ? (currentTopIndex - 1 + sortedWindows.length) % sortedWindows.length
        : (currentTopIndex + 1) % sortedWindows.length;
      ctx.focusWindow(sortedWindows[nextIndex].id);
    }
    return;
  }

  // 3. Focus is inside a window's content — icon navigation stands down.
  if (isInsideWindow(e.target)) return;

  // Handle Tab to cycle through desktop icons (no modifier keys)
  if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (ctx.rootItems.length === 0) return;

    const selectedArray = Array.from(ctx.selectedIds);
    if (selectedArray.length === 0) {
      // No selection, select first item
      ctx.selectItem(ctx.rootItems[0].id, false);
    } else {
      // Find current selection in sorted items list and move to next
      const sortedItems = [...ctx.rootItems].sort((a, b) => {
        // Sort by position: top-to-bottom, then left-to-right
        if (a.position.y !== b.position.y) return a.position.y - b.position.y;
        return a.position.x - b.position.x;
      });
      const currentIndex = sortedItems.findIndex((i) => selectedArray.includes(i.id));
      const nextIndex = e.shiftKey
        ? (currentIndex - 1 + sortedItems.length) % sortedItems.length
        : (currentIndex + 1) % sortedItems.length;
      ctx.selectItem(sortedItems[nextIndex].id, false);
    }
    return;
  }

  // Get currently selected items
  const selectedArray = Array.from(ctx.selectedIds);
  if (selectedArray.length === 0 && !ARROW_KEYS.includes(e.key)) {
    return;
  }

  // Handle Enter to open selected item
  if (e.key === 'Enter' && selectedArray.length === 1) {
    const item = ctx.rootItems.find((i) => i.id === selectedArray[0]);
    if (item) {
      e.preventDefault();
      ctx.openItem(item);
    }
    return;
  }

  // Handle Escape to deselect
  if (e.key === 'Escape') {
    ctx.deselectAll();
    ctx.closeContextMenu();
    return;
  }

  // Handle Cmd+Backspace / Cmd+Delete to trash selected items
  // Requires modifier to prevent accidental deletion (matches MenuBar shortcut ⌘⌫)
  if ((e.key === 'Delete' || e.key === 'Backspace') && (e.metaKey || e.ctrlKey) && selectedArray.length > 0) {
    e.preventDefault();
    ctx.moveToTrash(selectedArray);
    ctx.deselectAll();
    return;
  }

  // Handle arrow key navigation
  if (ARROW_KEYS.includes(e.key)) {
    e.preventDefault();

    // If nothing selected, select first item
    if (selectedArray.length === 0 && ctx.rootItems.length > 0) {
      ctx.selectItem(ctx.rootItems[0].id, false);
      return;
    }

    // Get the last selected item's position
    const lastSelected = ctx.rootItems.find((i) => i.id === selectedArray[selectedArray.length - 1]);
    if (!lastSelected) return;

    const { x, y } = lastSelected.position;
    let targetX = x;
    let targetY = y;

    switch (e.key) {
      case 'ArrowUp':
        targetY = y - 1;
        break;
      case 'ArrowDown':
        targetY = y + 1;
        break;
      case 'ArrowLeft':
        targetX = x - 1;
        break;
      case 'ArrowRight':
        targetX = x + 1;
        break;
    }

    // Find item at target position
    const targetItem = ctx.rootItems.find(
      (i) => i.position.x === targetX && i.position.y === targetY
    );

    if (targetItem) {
      ctx.selectItem(targetItem.id, e.shiftKey);
    }
  }
}

/**
 * Registers the document-level desktop shortcuts on behalf of the Desktop.
 * The deps mirror the old inline effect in Desktop.tsx one for one, so the
 * listener resubscribes exactly when it used to.
 */
export function useDesktopShortcuts(ctx: DesktopShortcutContext): void {
  const {
    rootItems,
    selectedIds,
    selectItem,
    deselectAll,
    openItem,
    moveToTrash,
    closeContextMenu,
    windows,
    focusWindow,
  } = ctx;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) =>
      handleDesktopShortcuts(e, {
        rootItems,
        selectedIds,
        selectItem,
        deselectAll,
        openItem,
        moveToTrash,
        closeContextMenu,
        windows,
        focusWindow,
      });
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rootItems, selectedIds, selectItem, deselectAll, openItem, moveToTrash, closeContextMenu, windows, focusWindow]);
}
