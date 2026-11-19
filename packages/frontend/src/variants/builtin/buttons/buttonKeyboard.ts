/**
 * buttonKeyboard — shared keyboard activation for the div-based window
 * buttons (close/zoom/collapse) across all window.buttons variants.
 *
 * The buttons are styled divs, so they implement the ARIA button pattern
 * themselves: `role="button"`, `tabIndex={0}`, and Enter/Space on keydown
 * firing the same action a click does. Keydown activation (rather than
 * keyup for Space) matches the repo's established ContextMenu contract.
 *
 * stopPropagation keeps the keydown from reaching the title bar's window
 * handler and the document-level shortcuts (Desktop icon navigation,
 * MenuBar ⌘-shortcuts); preventDefault stops Space from scrolling the
 * page and Enter from activating anything else.
 */

import type React from 'react';

export function activateButton(
  e: React.KeyboardEvent,
  action: (e: React.SyntheticEvent) => void
): void {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  e.stopPropagation();
  action(e);
}
