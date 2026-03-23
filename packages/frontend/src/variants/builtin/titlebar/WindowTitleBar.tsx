/**
 * WindowTitleBar — Unified title bar that switches CSS based on variant.
 * Uses a single stable component type to avoid React remounting children.
 */

import type { TitleBarSlotProps } from '../../slots';
import { useAppearanceStore } from '../../../stores/appearanceStore';
import { variantRegistry } from '../../registry';
import styles from './WindowTitleBar.module.css';

const VARIANT_CLASS: Record<string, string> = {
  classic: styles.classic,
  flat: styles.flat,
  gradient: styles.gradient,
  sprite: styles.sprite,
};

export function WindowTitleBar({
  title,
  isActive,
  collapsed,
  onDragStart,
  onDragMove,
  onDragEnd,
  children,
}: TitleBarSlotProps) {
  const variantId = useAppearanceStore(
    (s) => s.appearance.variants?.['window.titleBar'] ?? variantRegistry.getDefault('window.titleBar')
  );

  const variantClass = VARIANT_CLASS[variantId] ?? VARIANT_CLASS.classic;

  const wrapperClass = [
    variantClass,
    !isActive && styles.inactive,
    collapsed && styles.collapsed,
  ].filter(Boolean).join(' ');

  const showStripes = variantId === 'classic' && isActive;

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

        {/* Stripes (only for classic variant, only when active) */}
        {showStripes && <div className={`${styles.titleBarStripes} titleBarStripes`} />}

        {/* Title Text */}
        <span className={`${styles.titleText} titleText`} eos-part="title">{title}</span>
      </div>
    </div>
  );
}
