/**
 * BeveledChrome — Classic Mac OS window frame with 3D bevel effect.
 * This is the default window.chrome variant.
 */

import type { WindowChromeSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './BeveledChrome.module.css';

export function BeveledChrome({
  windowRef,
  windowId,
  isActive,
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
    !isActive && styles.inactive,
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
