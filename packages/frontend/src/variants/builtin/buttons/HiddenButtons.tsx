/**
 * HiddenButtons — Invisible until the title bar is hovered.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './HiddenButtons.module.css';

export function HiddenButtons({
  onClose,
  onZoom,
  onCollapse,
}: WindowButtonsSlotProps & VariantContext) {
  return (
    <div className={styles.buttonGroup}>
      <div
        className={styles.btn}
        eos-part="close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      />
      <div
        className={styles.btn}
        eos-part="collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      />
      <div
        className={styles.btn}
        eos-part="zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
      />
    </div>
  );
}
