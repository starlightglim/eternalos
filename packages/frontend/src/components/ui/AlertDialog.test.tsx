// @vitest-environment jsdom
/**
 * AlertDialog accessibility contract (CORE-ROADMAP Workstream 1, item 2):
 * aria linkage, initial focus, Tab/Shift+Tab focus trap, scoped Enter,
 * Escape-to-cancel, and focus restoration to the opener on close.
 */

import { useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AlertDialog } from './AlertDialog';

// vitest globals are off in this repo, so @testing-library/react's
// automatic cleanup never registers — clean up manually between tests.
afterEach(() => {
  cleanup();
});

function mockFn() {
  return vi.fn(() => {});
}

type MockFn = ReturnType<typeof mockFn>;

type Handlers = {
  cancel: MockFn;
  ok: MockFn;
  onClose: MockFn;
};

function confirmHandlers(): Handlers {
  return { cancel: mockFn(), ok: mockFn(), onClose: mockFn() };
}

/** Confirm-shaped buttons: Cancel first, OK (primary) second. */
function confirmButtons({ cancel, ok }: { cancel: () => void; ok: () => void }) {
  return [
    { label: 'Cancel', onClick: cancel },
    { label: 'OK', onClick: ok, primary: true },
  ];
}

function keyDownOnActiveElement(key: string, init?: KeyboardEventInit) {
  const target = document.activeElement ?? document.body;
  fireEvent.keyDown(target, { key, ...init });
}

describe('AlertDialog a11y contract', () => {
  test('aria: alertdialog role, modal, and stable id linkage to title + message', () => {
    render(
      <AlertDialog
        type="confirm"
        title="Delete this thread?"
        message="This cannot be undone."
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const title = screen.getByText('Delete this thread?');
    const message = screen.getByText('This cannot be undone.');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(message.id);
    expect(title.id).toBeTruthy();
    expect(message.id).toBeTruthy();
  });

  test('aria: without a title, the message doubles as the accessible name', () => {
    render(<AlertDialog type="error" message="Disk full." onClose={vi.fn()} />);

    const dialog = screen.getByRole('alertdialog');
    const message = screen.getByText('Disk full.');
    expect(dialog.getAttribute('aria-labelledby')).toBe(message.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(message.id);
  });

  test('initial focus lands on the primary action (the established pattern)', () => {
    render(
      <AlertDialog
        type="confirm"
        title="Delete this thread?"
        message="This cannot be undone."
        buttons={confirmButtons(confirmHandlers())}
        onClose={vi.fn()}
      />
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
  });

  test('initial focus falls back to the first action when no button is primary', () => {
    render(
      <AlertDialog
        type="confirm"
        title="Delete this thread?"
        message="This cannot be undone."
        buttons={[
          { label: 'Keep', onClick: mockFn() },
          { label: 'Drop', onClick: mockFn() },
        ]}
        onClose={vi.fn()}
      />
    );

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep' }));
  });

  test('Tab wraps from the last action to the first; Shift+Tab wraps back', () => {
    render(
      <AlertDialog
        type="confirm"
        title="Delete this thread?"
        message="This cannot be undone."
        buttons={confirmButtons(confirmHandlers())}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const ok = within(dialog).getByRole('button', { name: 'OK' });

    // Focus starts on OK (the last focusable). Tab wraps to Cancel.
    expect(document.activeElement).toBe(ok);
    keyDownOnActiveElement('Tab');
    expect(document.activeElement).toBe(cancel);

    // Shift+Tab from the first action wraps back to the last.
    keyDownOnActiveElement('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(ok);
  });

  test('Tab never escapes the dialog, even when focus starts outside it', () => {
    render(
      <>
        <button>elsewhere on the page</button>
        <AlertDialog
          type="confirm"
          title="Delete this thread?"
          message="This cannot be undone."
          buttons={confirmButtons(confirmHandlers())}
          onClose={vi.fn()}
        />
      </>
    );

    const outside = screen.getByRole('button', { name: 'elsewhere on the page' });
    const dialog = screen.getByRole('alertdialog');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const ok = within(dialog).getByRole('button', { name: 'OK' });

    outside.focus();
    keyDownOnActiveElement('Tab');
    expect(document.activeElement).toBe(cancel);

    outside.focus();
    keyDownOnActiveElement('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(ok);
  });

  test('Enter activates only the focused action — Enter on Cancel cancels', async () => {
    const user = userEvent.setup();
    const handlers = confirmHandlers();

    render(
      <AlertDialog
        type="confirm"
        title="Delete this thread?"
        message="This cannot be undone."
        buttons={confirmButtons(handlers)}
        onClose={handlers.onClose}
      />
    );

    // Focus (not click) Cancel, then press Enter: the focused action runs.
    screen.getByRole('button', { name: 'Cancel' }).focus();
    await user.keyboard('{Enter}');

    expect(handlers.cancel).toHaveBeenCalledOnce();
    expect(handlers.ok).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  test('Enter with focus outside the dialog does not confirm it', async () => {
    const user = userEvent.setup();
    const outsideClick = vi.fn();
    const handlers = confirmHandlers();

    render(
      <>
        <button onClick={outsideClick}>elsewhere on the page</button>
        <AlertDialog
          type="confirm"
          title="Delete this thread?"
          message="This cannot be undone."
          buttons={confirmButtons(handlers)}
          onClose={handlers.onClose}
        />
      </>
    );

    // Focus (not click) the outside element, then press Enter: it reacts
    // to its own Enter, the dialog must not.
    screen.getByRole('button', { name: 'elsewhere on the page' }).focus();
    await user.keyboard('{Enter}');

    // The outside element still responds to its own Enter (native
    // activation) — but the dialog must not fire any action. The old
    // document-wide Enter handler would have clicked the primary here.
    expect(outsideClick).toHaveBeenCalledOnce();
    expect(handlers.ok).not.toHaveBeenCalled();
    expect(handlers.cancel).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  test('Escape cancels via onClose', async () => {
    const user = userEvent.setup();
    const handlers = confirmHandlers();

    render(
      <AlertDialog
        type="confirm"
        title="Delete this thread?"
        message="This cannot be undone."
        buttons={confirmButtons(handlers)}
        onClose={handlers.onClose}
      />
    );

    await user.keyboard('{Escape}');

    expect(handlers.onClose).toHaveBeenCalledOnce();
    expect(handlers.cancel).not.toHaveBeenCalled();
    expect(handlers.ok).not.toHaveBeenCalled();
  });

  test('focus is restored to the opener when the dialog closes', async () => {
    const user = userEvent.setup();

    function Host() {
      const [open, setOpen] = useState(false);
      const close = () => setOpen(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Delete thing</button>
          {open && (
            <AlertDialog
              type="confirm"
              title="Delete thing?"
              message="This cannot be undone."
              buttons={confirmButtons({ cancel: close, ok: close })}
              onClose={close}
            />
          )}
        </>
      );
    }

    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Delete thing' });

    await user.click(opener);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
