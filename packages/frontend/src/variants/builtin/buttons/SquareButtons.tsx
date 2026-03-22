/**
 * SquareButtons — Classic Mac OS square close/zoom/collapse buttons.
 * This is the default window.buttons variant.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './SquareButtons.module.css';

export function SquareButtons({
  isActive,
  onClose,
  onZoom,
  onCollapse,
}: WindowButtonsSlotProps & VariantContext) {
  const wrapperClass = !isActive ? styles.inactive : undefined;

  return (
    <div className={wrapperClass}>
      <div
        className={`${styles.closeBox} closeBox`}
        eos-part="close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      />
      <div
        className={`${styles.zoomBox} zoomBox`}
        eos-part="zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
      />
      <div
        className={`${styles.collapseBox} collapseBox`}
        eos-part="collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      />
    </div>
  );
}
