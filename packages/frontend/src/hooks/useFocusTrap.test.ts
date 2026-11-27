import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement, useRef, type ReactElement } from 'react';
import type { Root } from 'react-dom/client';

import {
  getFocusableElements,
  isNativeEnterTarget,
  nextTrapFocus,
  openTrapCount,
  owningTrap,
  useFocusTrap,
  type FocusTrapOptions,
} from './useFocusTrap';
import { RecoveryCodesDialog } from '../components/ui/RecoveryCodesDialog';
import { LinkDialog } from '../components/ui/LinkDialog';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../components/window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;

function all(from: TestNode, match: (el: TestElement) => boolean): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if (match(child)) found.push(child);
        visit(child);
      }
    }
  };
  visit(from);
  return found;
}

const byRole = (role: string) => all(dom.root, (el) => el.getAttribute('role') === role);
const buttons = () => all(dom.root, (el) => el.nodeName === 'BUTTON');
const focused = () => dom.document.activeElement as TestElement;

function press(key: string, init: { shiftKey?: boolean } = {}, target: TestElement = focused()) {
  let defaultPrevented = false;
  act(() => {
    defaultPrevented = dom.key(target, 'keydown', { key, shiftKey: init.shiftKey }).defaultPrevented;
  });
  return defaultPrevented;
}

async function render(element: ReactElement): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(element);
  });
}

async function unmount(): Promise<void> {
  if (!reactRoot) return;
  const root = reactRoot;
  reactRoot = null;
  await act(async () => {
    root.unmount();
  });
}

beforeEach(() => {
  dom = installTestDom();
});

afterEach(async () => {
  await unmount();
  dom.uninstall();
});

test('getFocusableElements: document order, skips disabled, hidden, negative tabindex', () => {
  const doc = dom.document;
  const root = doc.createElement('div');
  const make = (tag: string, attrs: Record<string, string> = {}) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    root.appendChild(el);
    return el;
  };
  const a = make('button');
  make('button', { disabled: '' });
  make('input', { type: 'hidden' });
  const input = make('input');
  make('div', { tabindex: '-1' });
  const div = make('div', { tabindex: '0' });
  make('a');
  const link = make('a', { href: '/x' });
  const hiddenWrap = make('div', { hidden: '' });
  hiddenWrap.appendChild(doc.createElement('button'));
  const styled = make('input', { type: 'file' });
  styled.style.setProperty('display', 'none');

  expect(getFocusableElements(root as unknown as Element)).toEqual([a, input, div, link]);
});

test('nextTrapFocus wraps at both ends and pulls focus back in', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(() => ({}) as HTMLElement);
  const list = [a, b, c];
  expect(nextTrapFocus(list, c, true, false)).toBe(a);
  expect(nextTrapFocus(list, a, true, true)).toBe(c);
  expect(nextTrapFocus(list, b, true, false)).toBeNull();
  expect(nextTrapFocus(list, null, false, false)).toBe(a);
  expect(nextTrapFocus(list, null, false, true)).toBe(c);
  expect(nextTrapFocus([], null, false, false)).toBeNull();
});

test('isNativeEnterTarget: buttons and links yes; text fields and checkboxes no', () => {
  const el = (tag: string, type?: string) => {
    const node = dom.document.createElement(tag);
    if (type) node.setAttribute('type', type);
    return node as unknown as EventTarget;
  };
  expect(isNativeEnterTarget(el('button'))).toBe(true);
  expect(isNativeEnterTarget(el('a'))).toBe(true);
  expect(isNativeEnterTarget(el('input', 'checkbox'))).toBe(false);
  expect(isNativeEnterTarget(el('input', 'submit'))).toBe(true);
  expect(isNativeEnterTarget(el('input'))).toBe(false);
  expect(isNativeEnterTarget(el('input', 'url'))).toBe(false);
  expect(isNativeEnterTarget(null)).toBe(false);
});

function Trap({ onEscape, label, scope }: { onEscape?: () => void; label: string; scope?: FocusTrapOptions['scope'] }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape, scope });
  // createElement is not JSX, so the refs rule can't tell `ref` is a prop.
  // eslint-disable-next-line react-hooks/refs
  return createElement('div', { ref, role: 'dialog', 'aria-modal': 'true', 'data-label': label },
    createElement('button', { type: 'button' }, `${label} one`),
    createElement('button', { type: 'button' }, `${label} two`));
}

test('focus moves in on open, Tab wraps, focus returns to the opener on close', async () => {
  const opener = dom.document.createElement('button');
  dom.document.body.appendChild(opener);
  opener.focus();

  await render(createElement(Trap, { label: 'x' }));
  const [one, two] = buttons();
  expect(focused()).toBe(one);
  expect(press('Tab', { shiftKey: true })).toBe(true);
  expect(focused()).toBe(two);
  expect(press('Tab')).toBe(true);
  expect(focused()).toBe(one);

  // Focus that escaped is pulled back in.
  opener.focus();
  press('Tab');
  expect(focused()).toBe(one);

  await unmount();
  expect(focused()).toBe(opener);
  expect(openTrapCount()).toBe(0);
});

test('stacked traps: only the topmost handles Escape', async () => {
  const lower = vi.fn();
  const upper = vi.fn();
  await render(createElement('div', null,
    createElement(Trap, { label: 'lower', onEscape: lower }),
    createElement(Trap, { label: 'upper', onEscape: upper })));
  press('Escape');
  expect(upper).toHaveBeenCalledTimes(1);
  expect(lower).not.toHaveBeenCalled();
});

test('owningTrap: the newest trap holding focus, else the newest', () => {
  const doc = dom.document;
  const a = doc.createElement('div');
  const b = doc.createElement('div');
  const inA = doc.createElement('button');
  a.appendChild(inA);
  const traps = [
    { name: 'a', containerRef: { current: a as unknown as HTMLElement } },
    { name: 'b', containerRef: { current: b as unknown as HTMLElement } },
  ];
  expect(owningTrap(traps, inA as unknown as Node)?.name).toBe('a');
  expect(owningTrap(traps, null)?.name).toBe('b');
  expect(owningTrap([], null)).toBeUndefined();
});

test('stacked traps: Escape goes to the trap holding focus', async () => {
  const lower = vi.fn();
  const upper = vi.fn();
  await render(createElement('div', null,
    createElement(Trap, { label: 'lower', onEscape: lower }),
    createElement(Trap, { label: 'upper', onEscape: upper })));
  buttons()[0].focus(); // "lower one"
  press('Escape');
  expect(lower).toHaveBeenCalledTimes(1);
  expect(upper).not.toHaveBeenCalled();
});

test('window scope: ignores keys from outside and keeps focus in another window', async () => {
  const appWindow = dom.document.createElement('div');
  appWindow.setAttribute('class', 'window');
  const field = dom.document.createElement('input');
  appWindow.appendChild(field);
  dom.document.body.appendChild(appWindow);
  field.focus();

  const onEscape = vi.fn();
  await render(createElement(Trap, { label: 'w', onEscape, scope: 'window' }));
  expect(focused()).toBe(field);
  expect(openTrapCount()).toBe(0);
  press('Escape');
  press('Tab');
  expect(onEscape).not.toHaveBeenCalled();
  expect(focused()).toBe(field);

  buttons()[1].focus();
  expect(press('Tab')).toBe(true);
  expect(focused()).toBe(buttons()[0]);
  press('Escape');
  expect(onEscape).toHaveBeenCalledTimes(1);
});

test('RecoveryCodesDialog: modal, focus inside, Escape does not dismiss', async () => {
  const onContinue = vi.fn();
  await render(createElement(RecoveryCodesDialog, { codes: ['AAAA-1111', 'BBBB-2222'], username: 'u', onContinue }));
  const [dialog] = byRole('dialog');
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.contains(focused())).toBe(true);
  press('Escape');
  expect(onContinue).not.toHaveBeenCalled();
  expect(byRole('dialog')).toHaveLength(1);
  // No inline styles left.
  expect(all(dom.root, (el) => el.hasAttribute('style'))).toHaveLength(0);
});

test('LinkDialog: URL field focused, Escape cancels, Enter on Cancel does not submit', async () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  await render(createElement(LinkDialog, { onSubmit, onCancel }));
  expect(focused().getAttribute('id')).toBe('link-url');

  const cancel = buttons().find((b) => b.childNodes.some((n) => (n as { data?: string }).data === 'Cancel'));
  if (!cancel) throw new Error('no Cancel button');
  cancel.focus();
  press('Enter');
  expect(onSubmit).not.toHaveBeenCalled();

  press('Escape');
  expect(onCancel).toHaveBeenCalledTimes(1);
});
