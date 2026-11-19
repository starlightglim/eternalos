import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import { MenuBarDropdown } from './MenuBarDropdown';
import type { MenuItem } from '../../types';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;
let onActivate: (item: MenuItem) => void;
let onEscape: (menuName: string) => void;
let onSwitchMenu: (menuName: string, direction: 1 | -1) => void;

/**
 * New / Open / Get Info are enabled; `blocked` is disabled; a divider sits
 * between Open and Get Info. Enabled order for keyboard navigation:
 * New → Open → Get Info (wrapping).
 */
function navItems(): MenuItem[] {
  return [
    { label: 'New', action: vi.fn() },
    { label: 'Blocked', disabled: true, action: vi.fn() },
    { label: 'Open', action: vi.fn() },
    { label: '', divider: true },
    { label: 'Get Info', action: vi.fn() },
  ];
}

/** The owner's activation policy (MenuBar's handleDropdownItemClick): guard,
 * run the action. Passed in so the tests assert the real wiring. */
function ownerActivate(item: MenuItem): void {
  if (item.disabled || item.divider) return;
  item.action?.();
}

async function renderDropdown(items: MenuItem[]): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(
      createElement(MenuBarDropdown, { menuName: 'file', items, onActivate, onEscape, onSwitchMenu })
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

beforeEach(() => {
  dom = installTestDom();
  onActivate = vi.fn(ownerActivate);
  onEscape = vi.fn();
  onSwitchMenu = vi.fn();
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
  const items: MenuItem[] = [
    { label: 'New', action: vi.fn() },
    { label: 'Blocked', disabled: true },
    { label: 'Show Hidden', checked: true },
    { label: 'Hidden Files', checked: false },
    { label: '', divider: true },
    { label: 'Get Info' },
  ];
  await renderDropdown(items);

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
  const items: MenuItem[] = [
    { label: 'A', disabled: true },
    { label: 'B' },
    { label: 'C' },
  ];
  await renderDropdown(items);

  expect(focusedText()).toBe('B');
  const enabled = elementsWith(dom.root, 'role', 'menuitem');
  expect(focusedItem().getAttribute('tabindex')).toBe('0');
  expect(enabled[0].getAttribute('tabindex')).toBe('-1');
  expect(enabled[2].getAttribute('tabindex')).toBe('-1');
});

test('ArrowDown/ArrowUp move between enabled items, wrapping and skipping disabled ones', async () => {
  await renderDropdown(navItems());
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
  await renderDropdown(navItems());

  pressKey('End');
  expect(focusedText()).toBe('Get Info');
  pressKey('Home');
  expect(focusedText()).toBe('New');
});

test('Enter activates the focused item through onActivate', async () => {
  const items = navItems();
  await renderDropdown(items);

  // Navigate first: activation must follow focus, not the initial item.
  pressKey('ArrowDown');
  pressKey('ArrowDown');
  expect(focusedText()).toBe('Get Info');

  pressKey('Enter');
  expect(onActivate).toHaveBeenCalledTimes(1);
  expect(onActivate).toHaveBeenCalledWith(items[4]);
  expect(items[4].action).toHaveBeenCalledTimes(1);
  expect(items[0].action).not.toHaveBeenCalled();
});

test('Space activates the focused item through onActivate', async () => {
  const items = navItems();
  await renderDropdown(items);

  pressKey(' ');
  expect(onActivate).toHaveBeenCalledWith(items[0]);
  expect(items[0].action).toHaveBeenCalledTimes(1);
});

test('Escape reports onEscape with the menu name', async () => {
  await renderDropdown(navItems());

  pressKey('Escape');
  expect(onEscape).toHaveBeenCalledTimes(1);
  expect(onEscape).toHaveBeenCalledWith('file');
});

test('ArrowLeft/ArrowRight report menu switching with direction', async () => {
  await renderDropdown(navItems());

  pressKey('ArrowRight');
  expect(onSwitchMenu).toHaveBeenCalledWith('file', 1);

  vi.mocked(onSwitchMenu).mockClear();
  pressKey('ArrowLeft');
  expect(onSwitchMenu).toHaveBeenCalledWith('file', -1);
});

test('mouse click on an item activates it through onActivate', async () => {
  const items = navItems();
  await renderDropdown(items);
  const first = elementsWith(dom.root, 'role', 'menuitem')[0];

  act(() => {
    dom.pointer(first, 'pointerdown', { clientX: 5, clientY: 5 });
    dom.pointer(first, 'pointerup', { clientX: 5, clientY: 5 });
  });
  const click = act(() => dom.click());

  expect(click).not.toBeNull();
  expect(onActivate).toHaveBeenCalledWith(items[0]);
  expect(items[0].action).toHaveBeenCalledTimes(1);
});

test('mouse click on a disabled item reaches only the owner guard — no action', async () => {
  const items = navItems();
  await renderDropdown(items);
  const disabled = elementsWith(dom.root, 'aria-disabled', 'true')[0];

  act(() => {
    dom.pointer(disabled, 'pointerdown', { clientX: 5, clientY: 5 });
    dom.pointer(disabled, 'pointerup', { clientX: 5, clientY: 5 });
  });
  const click = act(() => dom.click());

  expect(click).not.toBeNull();
  expect(items[1].action).not.toHaveBeenCalled();
});
