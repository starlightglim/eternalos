/**
 * TextButtons — Unicode text character buttons (× − □).
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import { activateButton } from './buttonKeyboard';
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
        role="button"
        tabIndex={0}
        aria-label="Collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
        onKeyDown={(e) => activateButton(e, onCollapse)}
      >
        −
      </div>
      <div
        className={styles.btn}
        eos-part="zoom"
        role="button"
        tabIndex={0}
        aria-label="Zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
        onKeyDown={(e) => activateButton(e, onZoom)}
      >
        □
      </div>
      <div
        className={styles.btn}
        eos-part="close"
        role="button"
        tabIndex={0}
        aria-label="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        onKeyDown={(e) => activateButton(e, onClose)}
      >
        ×
      </div>
    </div>
  );
}
