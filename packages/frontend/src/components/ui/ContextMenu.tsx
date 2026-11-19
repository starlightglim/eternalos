import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import { useRovingMenuFocus } from './menuKeyboard';
import styles from './ContextMenu.module.css';

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  divider?: boolean;
  action?: () => void;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  onClose: () => void;
}

/**
 * ContextMenu - Classic Mac OS style right-click context menu
 *
 * Features:
 * - Positioned at click location, adjusted to stay within viewport
 * - Hover highlight with inverted colors
 * - Keyboard shortcut display
 * - Dividers between groups
 * - Dismisses on click outside, Escape (restoring the pre-menu focus), Tab,
 *   or item selection
 */
export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [adjustedPos] = useState(position);

  // The element that held focus before the menu opened; Escape restores focus
  // to it. Captured during the mount render — before the roving-focus effect
  // below moves focus into the menu.
  const openerRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  // Roving focus over the enabled items (shared with the menu bar dropdowns).
  const { activeIndex, setActiveIndex, handleMenuKeyDown } = useRovingMenuFocus({
    items,
    itemRefs,
    containerRef: menuRef,
  });

  // Adjust position to keep menu within viewport - runs synchronously before paint
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let x = position.x;
    let y = position.y;

    // Keep menu within horizontal bounds
    if (x + rect.width > viewportWidth) {
      x = viewportWidth - rect.width - 8;
    }
    if (x < 8) x = 8;

    // Keep menu within vertical bounds
    if (y + rect.height > viewportHeight) {
      y = viewportHeight - rect.height - 8;
    }
    if (y < 8) y = 8;

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  }, [position]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    // Escape closes the menu and returns focus to the element that had focus
    // before the menu opened. Tab closes it too, without preventing default,
    // so the browser's normal Tab sequence moves focus out of the menu.
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const opener = openerRef.current;
        if (opener && document.contains(opener)) {
          opener.focus();
        }
        onClose();
      } else if (e.key === 'Tab') {
        onClose();
      }
    }

    // Use capture phase to catch click before other handlers
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const handleItemClick = (item: ContextMenuItem) => {
    if (item.disabled || item.divider) return;

    if (item.action) {
      item.action();
    }
    onClose();
  };

  // Arrow/Home/End move the roving focus between enabled items; Enter/Space
  // activate the focused item. Escape and Tab are handled by the document
  // listener above.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    handleMenuKeyDown(e, handleItemClick);
  };

  return (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
      role="menu"
      aria-orientation="vertical"
      tabIndex={-1}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        if (item.divider) {
          return <div key={`divider-${index}`} className={styles.divider} role="separator" />;
        }

        return (
          <div
            key={item.id}
            ref={(el) => { itemRefs.current[index] = el; }}
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            tabIndex={index === activeIndex ? 0 : -1}
            aria-disabled={item.disabled || undefined}
            aria-checked={item.checked !== undefined ? item.checked : undefined}
            className={`${styles.item} ${item.disabled ? styles.itemDisabled : ''}`}
            onClick={() => handleItemClick(item)}
            onMouseEnter={() => { if (!item.disabled) setActiveIndex(index); }}
          >
            {item.checked !== undefined && (
              <span className={styles.checkmark}>{item.checked ? '✓' : ''}</span>
            )}
            {item.label}
            {item.shortcut && <span className={styles.shortcut}>{item.shortcut}</span>}
          </div>
        );
      })}
    </div>
  );
}
