import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import { AlertDialog } from './AlertDialog';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;

interface DialogProps {
  type: 'error' | 'warning' | 'info' | 'confirm';
  title?: string;
  message: string;
  buttons?: { label: string; onClick: () => void; primary?: boolean }[];
  onClose?: () => void;
}

/** Confirm-shaped buttons: Cancel first, OK (primary) second. */
function confirmButtons(cancel: () => void, ok: () => void) {
  return [
    { label: 'Cancel', onClick: cancel },
    { label: 'OK', onClick: ok, primary: true },
  ];
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

/** Depth-first (document order) list of <button> descendants. */
function buttonsIn(from: TestNode): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if (child.nodeName === 'BUTTON') found.push(child);
        visit(child);
      }
    }
  };
  visit(from);
  return found;
}

/** The rendered alert dialog. */
function dialogEl(): TestElement {
  const dialog = elementsWith(dom.root, 'role', 'alertdialog')[0];
  if (!dialog) throw new Error('no alertdialog rendered');
  return dialog;
}

function focused(): TestElement {
  const el = dom.document.activeElement;
  if (!el) throw new Error('no focused element');
  return el;
}

function pressKey(key: string, init?: { shiftKey?: boolean }): void {
  act(() => {
    dom.key(focused(), 'keydown', { key, shiftKey: init?.shiftKey });
  });
}

/**
 * Browsers activate a focused <button> on Enter as the keydown's default
 * action. The test DOM has no native activation, so simulate it: the
 * keydown bubbles to document (a document-wide Enter handler — the bug
 * this contract guards against — would fire there), and, unless someone
 * canceled the event, a click lands on the focused button.
 */
function enterKeydown(target: TestElement): void {
  act(() => {
    const event = dom.key(target, 'keydown', { key: 'Enter' });
    if (!event.defaultPrevented) {
      dom.pointer(target, 'pointerdown', { clientX: 0, clientY: 0 });
      dom.pointer(target, 'pointerup', { clientX: 0, clientY: 0 });
      dom.click();
    }
  });
}

/** An element outside the dialog, standing in for "the rest of the page". */
function outsideElement(): TestElement {
  const outside = dom.document.createElement('button');
  dom.document.body.appendChild(outside);
  return outside;
}

async function renderDialog(props: DialogProps): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(createElement(AlertDialog, props));
  });
}

beforeEach(() => {
  dom = installTestDom();
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

test('aria: alertdialog role, modal, and stable id linkage to title + message', async () => {
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(vi.fn<() => void>(), vi.fn<() => void>()),
    onClose: vi.fn<() => void>(),
  });

  const dialog = dialogEl();
  expect(dialog.getAttribute('aria-modal')).toBe('true');

  const labelledby = dialog.getAttribute('aria-labelledby');
  expect(labelledby).toBeTruthy();
  const title = labelledby ? dom.document.getElementById(labelledby) : null;
  expect(title?.textContent).toBe('Delete this thread?');

  const describedby = dialog.getAttribute('aria-describedby');
  expect(describedby).toBeTruthy();
  const message = describedby ? dom.document.getElementById(describedby) : null;
  expect(message?.textContent).toBe('This cannot be undone.');
});

test('aria: without a title, the message doubles as the accessible name', async () => {
  await renderDialog({ type: 'error', message: 'Disk full.', onClose: vi.fn<() => void>() });

  const dialog = dialogEl();
  const labelledby = dialog.getAttribute('aria-labelledby');
  expect(labelledby).toBeTruthy();
  const nameEl = labelledby ? dom.document.getElementById(labelledby) : null;
  expect(nameEl?.textContent).toBe('Disk full.');
  expect(labelledby).toBe(dialog.getAttribute('aria-describedby'));
});

test('initial focus lands on the primary action (the established pattern)', async () => {
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(vi.fn<() => void>(), vi.fn<() => void>()),
    onClose: vi.fn<() => void>(),
  });

  const [cancel, ok] = buttonsIn(dialogEl());
  expect(dom.document.activeElement).toBe(ok);
  expect(dom.document.activeElement).not.toBe(cancel);
});

test('initial focus falls back to the first action when no button is primary', async () => {
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: [
      { label: 'Keep', onClick: vi.fn<() => void>() },
      { label: 'Drop', onClick: vi.fn<() => void>() },
    ],
    onClose: vi.fn<() => void>(),
  });

  const [keep, drop] = buttonsIn(dialogEl());
  expect(dom.document.activeElement).toBe(keep);
  expect(dom.document.activeElement).not.toBe(drop);
});

test('Tab wraps from the last action to the first; Shift+Tab wraps back', async () => {
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(vi.fn<() => void>(), vi.fn<() => void>()),
    onClose: vi.fn<() => void>(),
  });

  const [cancel, ok] = buttonsIn(dialogEl());

  // Focus starts on OK (the last focusable). Tab wraps to Cancel.
  expect(dom.document.activeElement).toBe(ok);
  pressKey('Tab');
  expect(dom.document.activeElement).toBe(cancel);

  // Shift+Tab from the first action wraps back to the last.
  pressKey('Tab', { shiftKey: true });
  expect(dom.document.activeElement).toBe(ok);
});

test('Tab never escapes the dialog, even when focus starts outside it', async () => {
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(vi.fn<() => void>(), vi.fn<() => void>()),
    onClose: vi.fn<() => void>(),
  });

  const [cancel, ok] = buttonsIn(dialogEl());
  const outside = outsideElement();

  outside.focus();
  pressKey('Tab');
  expect(dom.document.activeElement).toBe(cancel);

  outside.focus();
  pressKey('Tab', { shiftKey: true });
  expect(dom.document.activeElement).toBe(ok);
});

test('Enter activates only the focused action — Enter on Cancel cancels', async () => {
  const cancel = vi.fn<() => void>();
  const ok = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(cancel, ok),
    onClose,
  });

  const [cancelButton] = buttonsIn(dialogEl());
  cancelButton.focus();
  enterKeydown(cancelButton);

  expect(cancel).toHaveBeenCalledTimes(1);
  expect(ok).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('Enter with focus outside the dialog does not confirm it', async () => {
  const outsideClick = vi.fn();
  const cancel = vi.fn<() => void>();
  const ok = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(cancel, ok),
    onClose,
  });

  // A document-wide Enter handler — the removed bug — would have fired
  // the primary action while this keydown bubbles past the dialog.
  const outside = outsideElement();
  outside.addEventListener('click', outsideClick);
  outside.focus();
  enterKeydown(outside);

  expect(outsideClick).toHaveBeenCalledTimes(1);
  expect(ok).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test('Escape cancels via onClose', async () => {
  const cancel = vi.fn<() => void>();
  const ok = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  await renderDialog({
    type: 'confirm',
    title: 'Delete this thread?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(cancel, ok),
    onClose,
  });

  pressKey('Escape');

  expect(onClose).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(ok).not.toHaveBeenCalled();
});

test('focus is restored to the opener when the dialog closes', async () => {
  const opener = outsideElement();
  opener.focus();
  expect(dom.document.activeElement).toBe(opener);

  const onClose = vi.fn<() => void>();
  await renderDialog({
    type: 'confirm',
    title: 'Delete thing?',
    message: 'This cannot be undone.',
    buttons: confirmButtons(onClose, onClose),
    onClose,
  });
  expect(dom.document.activeElement).not.toBe(opener); // focus moved into the dialog

  pressKey('Escape');
  expect(onClose).toHaveBeenCalledTimes(1);

  // The host closes the dialog on cancel; focus must return to the opener.
  if (!reactRoot) throw new Error('no react root');
  const root = reactRoot;
  reactRoot = null;
  await act(async () => {
    root.unmount();
  });
  expect(dom.document.activeElement).toBe(opener);
});
