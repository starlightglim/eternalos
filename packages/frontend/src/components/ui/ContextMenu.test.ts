import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;
let onClose: () => void;

/**
 * New / Open / Get Info are enabled; `blocked` is disabled; a divider sits
 * between Open and Get Info. Enabled order for keyboard navigation:
 * New → Open → Get Info (wrapping).
 */
function navItems(): ContextMenuItem[] {
  return [
    { id: 'new', label: 'New', action: vi.fn() },
    { id: 'blocked', label: 'Blocked', disabled: true, action: vi.fn() },
    { id: 'open', label: 'Open', action: vi.fn() },
    { id: 'sep', label: '', divider: true },
    { id: 'info', label: 'Get Info', action: vi.fn() },
  ];
}

async function renderMenu(items: ContextMenuItem[]): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(
      createElement(ContextMenu, { items, position: { x: 20, y: 20 }, onClose })
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

function focusedItem(): TestElement {
  const el = dom.document.activeElement;
  if (!el) throw new Error('no focused element');
  return el;
}

function pressKey(key: string): void {
  act(() => {
    dom.key(focusedItem(), 'keydown', { key });
  });
}

function focusedText(): string | null {
  return dom.document.activeElement?.textContent ?? null;
}

/** Focus an element outside the menu, as the pre-menu focus owner. */
function focusOpener(): TestElement {
  const opener = dom.document.createElement('button');
  dom.document.body.appendChild(opener);
  opener.focus();
  return opener;
}

beforeEach(() => {
  dom = installTestDom();
  onClose = vi.fn<() => void>();
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

test('renders WAI-ARIA menu semantics (roles, disabled, separator, checked)', async () => {
  const items: ContextMenuItem[] = [
    { id: 'new', label: 'New', action: vi.fn() },
    { id: 'blocked', label: 'Blocked', disabled: true },
    { id: 'hidden-on', label: 'Show Hidden', checked: true },
    { id: 'hidden-off', label: 'Hidden Files', checked: false },
    { id: 'sep', label: '', divider: true },
    { id: 'info', label: 'Get Info' },
  ];
  await renderMenu(items);

  const menus = elementsWith(dom.root, 'role', 'menu');
  expect(menus).toHaveLength(1);
  expect(menus[0].getAttribute('aria-orientation')).toBe('vertical');

  const plain = elementsWith(dom.root, 'role', 'menuitem');
  expect(plain.map((el) => el.textContent)).toEqual(['New', 'Blocked', 'Get Info']);

  const disabled = elementsWith(dom.root, 'aria-disabled', 'true');
  expect(disabled).toHaveLength(1);
  expect(disabled[0].textContent).toBe('Blocked');

  const checkboxes = elementsWith(dom.root, 'role', 'menuitemcheckbox');
  expect(checkboxes.map((el) => el.getAttribute('aria-checked'))).toEqual(['true', 'false']);

  expect(elementsWith(dom.root, 'role', 'separator')).toHaveLength(1);
});

test('opens with focus on the first enabled item (roving tabindex)', async () => {
  const items: ContextMenuItem[] = [
    { id: 'a', label: 'A', disabled: true },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];
  await renderMenu(items);

  expect(focusedText()).toBe('B');
  const enabled = elementsWith(dom.root, 'role', 'menuitem');
  expect(focusedItem().getAttribute('tabindex')).toBe('0');
  expect(enabled[0].getAttribute('tabindex')).toBe('-1');
  expect(enabled[2].getAttribute('tabindex')).toBe('-1');
});

test('ArrowDown/ArrowUp move between enabled items, wrapping and skipping disabled ones', async () => {
  await renderMenu(navItems());
  expect(focusedText()).toBe('New');

  pressKey('ArrowDown');
  expect(focusedText()).toBe('Open'); // skipped the disabled item
  pressKey('ArrowDown');
  expect(focusedText()).toBe('Get Info'); // crossed the divider
  pressKey('ArrowDown');
  expect(focusedText()).toBe('New'); // wrapped around the top
  pressKey('ArrowUp');
  expect(focusedText()).toBe('Get Info'); // wrapped around the bottom
  pressKey('ArrowUp');
  expect(focusedText()).toBe('Open');
});

test('Home and End jump to the first and last enabled item', async () => {
  await renderMenu(navItems());

  pressKey('End');
  expect(focusedText()).toBe('Get Info');
  pressKey('Home');
  expect(focusedText()).toBe('New');
});

test('Enter activates the focused item and closes the menu', async () => {
  const items = navItems();
  await renderMenu(items);

  // Navigate first: activation must follow focus, not the initial item.
  pressKey('ArrowDown');
  pressKey('ArrowDown');
  expect(focusedText()).toBe('Get Info');

  pressKey('Enter');
  expect(items[4].action).toHaveBeenCalledTimes(1);
  expect(items[0].action).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Space activates the focused item and closes the menu', async () => {
  const items = navItems();
  await renderMenu(items);

  pressKey(' ');
  expect(items[0].action).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape closes the menu and restores focus to the pre-menu element', async () => {
  const opener = focusOpener();
  expect(dom.document.activeElement).toBe(opener);

  await renderMenu(navItems());
  expect(dom.document.activeElement).not.toBe(opener); // focus moved into the menu

  act(() => {
    dom.key(focusedItem(), 'keydown', { key: 'Escape' });
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(dom.document.activeElement).toBe(opener);
});

test('Tab closes the menu', async () => {
  const opener = focusOpener();
  await renderMenu(navItems());

  act(() => {
    dom.key(focusedItem(), 'keydown', { key: 'Tab' });
  });

  expect(onClose).toHaveBeenCalledTimes(1);
  // Tab deliberately does not restore focus: default is left un-prevented so
  // the browser's own Tab move takes focus out of the menu.
  expect(dom.document.activeElement).not.toBe(opener);
});

test('mouse click on an item still activates it and closes the menu', async () => {
  const items = navItems();
  await renderMenu(items);
  const first = elementsWith(dom.root, 'role', 'menuitem')[0];

  act(() => {
    dom.pointer(first, 'pointerdown', { clientX: 5, clientY: 5 });
    dom.pointer(first, 'pointerup', { clientX: 5, clientY: 5 });
  });
  const click = act(() => dom.click());

  expect(click).not.toBeNull();
  expect(items[0].action).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('mouse click on a disabled item does nothing', async () => {
  const items = navItems();
  await renderMenu(items);
  const disabled = elementsWith(dom.root, 'aria-disabled', 'true')[0];

  act(() => {
    dom.pointer(disabled, 'pointerdown', { clientX: 5, clientY: 5 });
    dom.pointer(disabled, 'pointerup', { clientX: 5, clientY: 5 });
  });
  const click = act(() => dom.click());

  expect(click).not.toBeNull();
  expect(items[1].action).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
