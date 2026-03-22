/**
 * ClassicTitleBar — Mac OS 8 style with horizontal stripes.
 * This is the default window.titleBar variant.
 */

import type { TitleBarSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './ClassicTitleBar.module.css';

export function ClassicTitleBar({
  title,
  isActive,
  collapsed,
  onDragStart,
  onDragMove,
  onDragEnd,
  children,
}: TitleBarSlotProps & VariantContext) {
  // Wrap in a container that carries inactive/collapsed state for CSS
  const wrapperClass = [
    !isActive && styles.inactive,
    collapsed && styles.collapsed,
  ].filter(Boolean).join(' ');

  return (
    <div className={wrapperClass}>
      <div
        className={`${styles.titleBar} titleBar`}
        eos-part="titlebar"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        {/* Window buttons injected as children */}
        {children}

        {/* Stripes (only visible when active) */}
        {isActive && <div className={`${styles.titleBarStripes} titleBarStripes`} />}

        {/* Title Text */}
        <span className={`${styles.titleText} titleText`} eos-part="title">{title}</span>
      </div>
    </div>
  );
}
