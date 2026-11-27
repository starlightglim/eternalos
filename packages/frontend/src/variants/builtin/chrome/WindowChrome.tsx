/**
 * WindowChrome — Unified chrome component that switches CSS based on variant.
 * Uses a single stable component type to avoid React remounting children.
 */

import type { WindowChromeSlotProps } from '../../slots';
import { useAppearanceStore } from '../../../stores/appearanceStore';
import { variantRegistry } from '../../registry';
import styles from './WindowChrome.module.css';

const VARIANT_CLASS: Record<string, string> = {
  beveled: styles.beveled,
  flat: styles.flat,
  floating: styles.floating,
  sprite: styles.sprite,
};

export function WindowChrome({
  windowRef,
  windowId,
  collapsed,
  minimized,
  position,
  size,
  zIndex,
  contentType,
  contentId,
  eosName,
  eosType,
  eosExtension,
  eosFolder,
  onPointerDown,
  onPointerCancel,
  onLostPointerCapture,
  titleId,
  frameless,
  children,
}: WindowChromeSlotProps) {
  const variantId = useAppearanceStore(
    (s) => s.appearance.variants?.['window.chrome'] ?? variantRegistry.getDefault('window.chrome')
  );

  const variantClass = VARIANT_CLASS[variantId] ?? VARIANT_CLASS.beveled;

  const windowClasses = [
    styles.window,
    'window',
    variantClass,
    minimized && styles.minimized,
    collapsed && styles.collapsed,
    frameless && styles.frameless,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={windowRef}
      className={windowClasses}
      // Windows are non-modal dialogs named by their title.
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-window-id={windowId}
      data-content-id={contentId}
      data-content-type={contentType}
      {...(frameless ? { 'data-frameless': '' } : {})}
      eos-name={eosName}
      eos-type={eosType}
      {...(eosExtension ? { 'eos-extension': eosExtension } : {})}
      {...(eosFolder ? { 'eos-folder': eosFolder } : {})}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex,
      }}
      onPointerDown={onPointerDown}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <div className={styles.windowInner}>
        {children}
      </div>
    </div>
  );
}
