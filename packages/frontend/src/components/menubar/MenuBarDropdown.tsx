import { useRef, type KeyboardEvent } from 'react';
import { useRovingMenuFocus } from '../ui/menuKeyboard';
import type { MenuItem } from '../../types';
import styles from './MenuBar.module.css';

interface MenuBarDropdownProps {
  /** The top-level menu this dropdown belongs to (for Escape/menu switching). */
  menuName: string;
  items: MenuItem[];
  /** Guards disabled/divider, runs the action and closes the menu. */
  onActivate: (item: MenuItem) => void;
  /** Escape: close the dropdown and refocus the top-level item. */
  onEscape: (menuName: string) => void;
  /** Left/Right: switch to the neighboring top-level menu, keeping it open. */
  onSwitchMenu: (menuName: string, direction: 1 | -1) => void;
}

/**
 * MenuBarDropdown - the open dropdown of one menu bar entry.
 *
 * A WAI-ARIA `menu`: ArrowUp/Down/Home/End/Enter/Space come from the shared
 * roving-focus helper (`menuKeyboard.ts`, also used by ContextMenu); Escape
 * and Left/Right are menubar-specific and handled here. On mount the roving
 * focus lands on the first enabled item, exactly like ContextMenu on open.
 *
 * Handled keys stop propagation so the parent top-level item's own keyboard
 * handler (open/switch/Escape-to-exit) doesn't also see them.
 */
export function MenuBarDropdown({ menuName, items, onActivate, onEscape, onSwitchMenu }: MenuBarDropdownProps) {
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const { activeIndex, handleMenuKeyDown } = useRovingMenuFocus({ items, itemRefs });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onEscape(menuName);
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      onSwitchMenu(menuName, e.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (handleMenuKeyDown(e, onActivate)) {
      e.stopPropagation();
    }
  };

  return (
    <div className={styles.dropdown} role="menu" aria-orientation="vertical" onKeyDown={handleKeyDown}>
      {items.map((item, index) =>
        item.divider ? (
          <div key={index} className={styles.divider} role="separator" />
        ) : (
          <div
            key={index}
            ref={(el) => { itemRefs.current[index] = el; }}
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked !== undefined ? item.checked : undefined}
            aria-disabled={item.disabled || undefined}
            tabIndex={index === activeIndex ? 0 : -1}
            className={`${styles.dropdownItem} ${item.disabled ? styles.disabled : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              onActivate(item);
            }}
          >
            <span>
              {item.checked !== undefined && (
                <span className={styles.checkmark}>{item.checked ? '✓' : ''}</span>
              )}
              {item.label}
            </span>
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </div>
        )
      )}
    </div>
  );
}
