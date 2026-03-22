/**
 * CircleButtons — macOS-style traffic light circles.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './CircleButtons.module.css';

export function CircleButtons({
  isActive,
  onClose,
  onZoom,
  onCollapse,
}: WindowButtonsSlotProps & VariantContext) {
  const wrapperClass = !isActive ? styles.inactive : undefined;

  return (
    <div className={`${styles.buttonGroup} ${wrapperClass ?? ''}`}>
      <div
        className={`${styles.btn} ${styles.close}`}
        eos-part="close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        ×
      </div>
      <div
        className={`${styles.btn} ${styles.collapse}`}
        eos-part="collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      >
        −
      </div>
      <div
        className={`${styles.btn} ${styles.zoom}`}
        eos-part="zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
      >
        +
      </div>
    </div>
  );
}
