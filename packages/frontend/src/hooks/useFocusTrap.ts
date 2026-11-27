/**
 * useFocusTrap — the shared keyboard contract for modal dialogs.
 *
 * - Focus on open: if focus is not already inside the dialog (an autoFocus
 *   child counts), focus `initialFocus`, else the first focusable, else the
 *   dialog itself.
 * - Tab / Shift+Tab cycle inside the dialog.
 * - Escape calls `onEscape` — leave it out for dialogs that must be
 *   acknowledged (RecoveryCodesDialog).
 * - On close, focus returns to whatever had it when the dialog opened.
 *
 * Two scopes:
 * - `page` (default): the dialog covers the whole page. Keys are heard on
 *   `document` in the capture phase (Window's content div stops Tab from
 *   bubbling), and escaped focus is pulled back in. Page traps stack (a
 *   global alert over the icon picker): the trap holding focus handles the
 *   key, else the newest one, so one Escape closes one dialog.
 * - `window`: the dialog only covers one app window (AppPermissionDialog).
 *   Keys are heard on the dialog itself, so a prompt in a background or
 *   minimized window never takes Escape/Tab from the rest of the desktop,
 *   and it only takes focus on open when focus is in its own window.
 *
 * Focusables are found with a tree walk over attributes (no querySelector /
 * tabIndex property), so the hook also runs under the repo's node-env test
 * DOM (windowTestDom); in a real DOM, unrendered elements are skipped too.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

const ELEMENT_NODE = 1;
const ALWAYS_FOCUSABLE = new Set(['BUTTON', 'SELECT', 'TEXTAREA']);
// Input types whose Enter is not "submit the form" (checkbox/radio toggle
// on Space and do implicit submission on Enter, so they are not listed).
const ACTIVATING_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'file', 'image', 'color']);

interface NodeLike {
  nodeType: number;
  childNodes: ArrayLike<NodeLike>;
}

function isFocusable(el: Element): boolean {
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) < 0) return false;
  if (el.hasAttribute('disabled')) return false;
  const tag = el.nodeName;
  let focusable: boolean;
  if (ALWAYS_FOCUSABLE.has(tag)) focusable = true;
  else if (tag === 'INPUT') focusable = el.getAttribute('type') !== 'hidden';
  else if (tag === 'A') focusable = el.hasAttribute('href');
  else {
    const editable = el.getAttribute('contenteditable');
    focusable = (editable !== null && editable !== 'false') || tabindex !== null;
  }
  // Real DOM only: an element with no boxes (display:none via a class, a
  // minimized window) can't take focus.
  if (focusable && typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  return focusable;
}

/** Tabbable descendants of `root`, in document order (hidden subtrees skipped). */
export function getFocusableElements(root: Element): HTMLElement[] {
  const found: HTMLElement[] = [];
  const visit = (node: NodeLike): void => {
    const children = node.childNodes;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as unknown as Element;
      if (
        el.hasAttribute('hidden')
        || el.hasAttribute('inert')
        || el.getAttribute('aria-hidden') === 'true'
        || (el as HTMLElement).style?.display === 'none'
      ) continue;
      if (isFocusable(el)) found.push(el as HTMLElement);
      visit(child);
    }
  };
  visit(root as unknown as NodeLike);
  return found;
}

/**
 * Where Tab should move focus, or null to let the browser move it.
 * Wraps at both ends, and pulls focus back in when it is outside.
 */
export function nextTrapFocus(
  focusables: readonly HTMLElement[],
  active: Element | null,
  inside: boolean,
  shiftKey: boolean,
): HTMLElement | null {
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!inside) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

/**
 * True when Enter on `target` already does something natively (activates a
 * button or link, opens a select, newline in a textarea). Dialog-level
 * "Enter submits" handlers must skip these, or Enter on Cancel would submit.
 */
export function isNativeEnterTarget(target: EventTarget | null): boolean {
  if (!target || (target as Node).nodeType !== ELEMENT_NODE) return false;
  const el = target as Element;
  const tag = el.nodeName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return ACTIVATING_INPUT_TYPES.has((el.getAttribute('type') ?? 'text').toLowerCase());
  const role = el.getAttribute('role');
  return role === 'button' || role === 'tab' || role === 'link';
}

interface PageTrap {
  token: symbol;
  containerRef: RefObject<HTMLElement | null>;
}

// Open page traps, oldest first.
const pageTraps: PageTrap[] = [];

/**
 * The page trap that should handle a key: the newest one holding focus,
 * else the newest one.
 */
export function owningTrap<T extends { containerRef: RefObject<HTMLElement | null> }>(
  traps: readonly T[],
  active: Node | null,
): T | undefined {
  if (active) {
    for (let i = traps.length - 1; i >= 0; i -= 1) {
      if (traps[i].containerRef.current?.contains(active)) return traps[i];
    }
  }
  return traps[traps.length - 1];
}

/** Test hook: the number of page traps currently open. */
export function openTrapCount(): number {
  return pageTraps.length;
}

/** Nearest `.window` ancestor (inclusive), or null. */
function closestWindow(node: Node | null): Element | null {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== ELEMENT_NODE) continue;
    const classes = ((current as Element).getAttribute('class') ?? '').split(/\s+/);
    if (classes.includes('window')) {
      return current as Element;
    }
  }
  return null;
}

export interface FocusTrapOptions {
  /** Called on Escape. Omit to make Escape do nothing (must-acknowledge dialogs). */
  onEscape?: () => void;
  /** Element to focus on open when focus is not already inside. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Return focus to the opener on close (default true). */
  restoreFocus?: boolean;
  /** `page` (default) covers the page; `window` covers one app window. */
  scope?: 'page' | 'window';
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, options: FocusTrapOptions = {}): void {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const scope = options.scope ?? 'page';

  // Captured during the first render — before any child's autoFocus runs at
  // commit — so it points at the real opener.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
  );

  useEffect(() => {
    const container = containerRef.current;
    const trap: PageTrap = { token: Symbol('focus-trap'), containerRef };
    if (scope === 'page') pageTraps.push(trap);

    if (container) {
      const active = document.activeElement;
      const focusOutside = !active || !container.contains(active);
      const mayTakeFocus = scope === 'page'
        || !active
        || active === document.body
        || closestWindow(active) === closestWindow(container);
      if (focusOutside && mayTakeFocus) {
        const target = optionsRef.current.initialFocus?.current
          ?? getFocusableElements(container)[0]
          ?? null;
        if (target && !target.hasAttribute('disabled')) {
          target.focus();
        } else {
          if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
          container.focus();
        }
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (scope === 'page' && owningTrap(pageTraps, document.activeElement) !== trap) return;
      if (e.key === 'Escape') {
        if (e.isComposing) return;
        const onEscape = optionsRef.current.onEscape;
        if (onEscape) {
          e.preventDefault();
          e.stopPropagation();
          onEscape();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const root = containerRef.current;
      if (!root) return;
      const active = document.activeElement;
      const inside = active !== null && root.contains(active);
      const focusables = getFocusableElements(root);
      const next = nextTrapFocus(focusables, active, inside, e.shiftKey);
      if (next) {
        e.preventDefault();
        next.focus();
      } else if (focusables.length === 0) {
        // Nothing tabbable: keep focus on the dialog itself.
        e.preventDefault();
      }
    };

    // Window scope listens on the dialog (bubble phase: fires before React's
    // root listener, so Window's stopPropagation can't hide it).
    const target: EventTarget | null = scope === 'page' ? document : container;
    const capture = scope === 'page';
    target?.addEventListener('keydown', handleKeyDown as EventListener, capture);

    return () => {
      target?.removeEventListener('keydown', handleKeyDown as EventListener, capture);
      const index = pageTraps.indexOf(trap);
      if (index !== -1) pageTraps.splice(index, 1);
      if (optionsRef.current.restoreFocus !== false && opener && document.contains(opener)) {
        const active = document.activeElement;
        // Don't yank focus back if the user already moved on elsewhere.
        if (!active || active === document.body || container?.contains(active) || !document.contains(active)) {
          opener.focus?.();
        }
      }
    };
  }, [containerRef, opener, scope]);
}
