import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type RefObject } from 'react';

/**
 * Shared roving-focus keyboard contract for every ARIA menu surface
 * (`ContextMenu`, the menu bar's dropdowns). One implementation of the
 * WAI-ARIA menu keys: ArrowUp/Down move between enabled items (wrapping,
 * skipping dividers and disabled entries), Home/End jump to the first/last
 * enabled item, Enter/Space activate the focused item. Surfaces layer their
 * own keys on top (Escape, menu switching) and keep their own markup.
 */

/** The menu-item state every roving surface reads. */
export interface RovingMenuItem {
  disabled?: boolean;
  divider?: boolean;
}

/** Indices of the keyboard-navigable (non-divider, non-disabled) items. */
export function enabledItemIndices<T extends RovingMenuItem>(items: T[]): number[] {
  return items.reduce<number[]>((acc, item, i) => {
    if (!item.divider && !item.disabled) acc.push(i);
    return acc;
  }, []);
}

/** The next enabled index from `current` stepping in `direction`, wrapping. */
export function stepEnabledIndex(enabledIndices: number[], current: number, direction: 1 | -1): number {
  if (enabledIndices.length === 0) return -1;
  const pos = enabledIndices.indexOf(current);
  const nextPos =
    pos === -1
      ? (direction === 1 ? 0 : enabledIndices.length - 1)
      : (pos + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPos];
}

export interface RovingMenuFocusOptions<T extends RovingMenuItem> {
  items: T[];
  /** Ref array filled with the item elements, indexed like `items`. */
  itemRefs: RefObject<(HTMLElement | null)[]>;
  /** Focused when no item is active (e.g. every item disabled). Optional. */
  containerRef?: RefObject<HTMLElement | null>;
}

export interface RovingMenuFocus<T extends RovingMenuItem> {
  /** Index of the item holding the roving focus (-1 when none). */
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  moveActive: (direction: 1 | -1) => void;
  /**
   * Handle the shared menu keys (ArrowUp/Down, Home/End, Enter/Space): move
   * the roving focus / activate through `onActivate`. Returns whether the key
   * was handled, so callers can stop propagation and add their own keys
   * (Escape, menu switching) around it.
   */
  handleMenuKeyDown: (event: KeyboardEvent, onActivate: (item: T) => void) => boolean;
}

export function useRovingMenuFocus<T extends RovingMenuItem>({
  items,
  itemRefs,
  containerRef,
}: RovingMenuFocusOptions<T>): RovingMenuFocus<T> {
  // Indices of the keyboard-navigable (non-divider, non-disabled) items.
  const enabledIndices = useMemo(() => enabledItemIndices(items), [items]);

  const [activeIndex, setActiveIndex] = useState<number>(() => enabledIndices[0] ?? -1);

  // Roving focus: move DOM focus to the active item whenever it changes (incl.
  // on open, where activeIndex starts at the first enabled item).
  useEffect(() => {
    if (activeIndex >= 0) {
      itemRefs.current[activeIndex]?.focus();
    } else {
      containerRef?.current?.focus();
    }
  }, [activeIndex, itemRefs, containerRef]);

  const moveActive = useCallback(
    (direction: 1 | -1) => {
      if (enabledIndices.length === 0) return;
      setActiveIndex((current) => stepEnabledIndex(enabledIndices, current, direction));
    },
    [enabledIndices]
  );

  // The shared keys. Enter/Space activate via `onActivate`; the caller's
  // onActivate is expected to guard disabled/divider items (it is shared
  // with the mouse click path, exactly like ContextMenu's handleItemClick).
  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent, onActivate: (item: T) => void): boolean => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveActive(1);
          return true;
        case 'ArrowUp':
          event.preventDefault();
          moveActive(-1);
          return true;
        case 'Home':
          event.preventDefault();
          if (enabledIndices.length) setActiveIndex(enabledIndices[0]);
          return true;
        case 'End':
          event.preventDefault();
          if (enabledIndices.length) setActiveIndex(enabledIndices[enabledIndices.length - 1]);
          return true;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const item = items[activeIndex];
          if (item) onActivate(item);
          return true;
        }
        default:
          return false;
      }
    },
    [enabledIndices, items, activeIndex, moveActive]
  );

  return { activeIndex, setActiveIndex, moveActive, handleMenuKeyDown };
}
