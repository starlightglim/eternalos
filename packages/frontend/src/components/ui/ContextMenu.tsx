import { useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
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
 * - Dismisses on click outside, Escape, or item selection
 */
export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [adjustedPos] = useState(position);

  // Indices of the keyboard-navigable (non-divider, non-disabled) items.
  const enabledIndices = useMemo(
    () =>
      items.reduce<number[]>((acc, item, i) => {
        if (!item.divider && !item.disabled) acc.push(i);
        return acc;
      }, []),
    [items]
  );

  const [activeIndex, setActiveIndex] = useState<number>(() => enabledIndices[0] ?? -1);

  // Roving focus: move DOM focus to the active item whenever it changes (incl.
  // on open, where activeIndex starts at the first enabled item).
  useEffect(() => {
    if (activeIndex >= 0) {
      itemRefs.current[activeIndex]?.focus();
    } else {
      menuRef.current?.focus();
    }
  }, [activeIndex]);

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

    // Close on Escape key
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
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
  // activate the focused item. Escape is handled by the document listener.
  const moveActive = (direction: 1 | -1) => {
    if (enabledIndices.length === 0) return;
    const pos = enabledIndices.indexOf(activeIndex);
    const nextPos =
      pos === -1
        ? (direction === 1 ? 0 : enabledIndices.length - 1)
        : (pos + direction + enabledIndices.length) % enabledIndices.length;
    setActiveIndex(enabledIndices[nextPos]);
  };

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        e.preventDefault();
        if (enabledIndices.length) setActiveIndex(enabledIndices[0]);
        break;
      case 'End':
        e.preventDefault();
        if (enabledIndices.length) setActiveIndex(enabledIndices[enabledIndices.length - 1]);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = items[activeIndex];
        if (item) handleItemClick(item);
        break;
      }
      default:
        break;
    }
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
      onKeyDown={handleMenuKeyDown}
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
