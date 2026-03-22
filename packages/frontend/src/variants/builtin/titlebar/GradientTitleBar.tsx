/**
 * GradientTitleBar — Two-color gradient title bar.
 * Exposes conditional tokens for gradient start/end colors.
 */

import type { TitleBarSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './GradientTitleBar.module.css';

export function GradientTitleBar({
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
