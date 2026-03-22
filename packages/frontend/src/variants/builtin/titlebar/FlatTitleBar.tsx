/**
 * FlatTitleBar — Solid color title bar with no stripes.
 */

import type { TitleBarSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './FlatTitleBar.module.css';

export function FlatTitleBar({
  title,
  isActive,
  collapsed,
  onDragStart,
  onDragMove,
  onDragEnd,
  children,
}: TitleBarSlotProps & VariantContext) {
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
        {children}
        <span className={`${styles.titleText} titleText`} eos-part="title">{title}</span>
      </div>
    </div>
  );
}
