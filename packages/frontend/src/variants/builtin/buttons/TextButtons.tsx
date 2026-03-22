/**
 * TextButtons — Unicode text character buttons (× − □).
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './TextButtons.module.css';

export function TextButtons({
  isActive,
  onClose,
  onZoom,
  onCollapse,
}: WindowButtonsSlotProps & VariantContext) {
  const wrapperClass = !isActive ? styles.inactive : undefined;

  return (
    <div className={`${styles.buttonGroup} ${wrapperClass ?? ''}`}>
      <div
        className={styles.btn}
        eos-part="collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      >
        −
      </div>
      <div
        className={styles.btn}
        eos-part="zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
      >
        □
      </div>
      <div
        className={styles.btn}
        eos-part="close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      >
        ×
      </div>
    </div>
  );
}
