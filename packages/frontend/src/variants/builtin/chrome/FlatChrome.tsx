/**
 * FlatChrome — Clean flat border window frame, no bevel effect.
 */

import type { WindowChromeSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './FlatChrome.module.css';

export function FlatChrome({
  windowRef,
  windowId,
  isActive: _isActive,
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
  children,
}: WindowChromeSlotProps & VariantContext) {
  const windowClasses = [
    styles.window,
    'window',
    minimized && styles.minimized,
    collapsed && styles.collapsed,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={windowRef}
      className={windowClasses}
      data-window-id={windowId}
      data-content-id={contentId}
      data-content-type={contentType}
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
    >
      <div className={styles.windowInner}>
        {children}
      </div>
    </div>
  );
}
