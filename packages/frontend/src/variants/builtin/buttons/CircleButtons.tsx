/**
 * CircleButtons — macOS-style traffic light circles.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import { activateButton } from './buttonKeyboard';
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
        title="Close"
        role="button"
        tabIndex={0}
        aria-label="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        onKeyDown={(e) => activateButton(e, onClose)}
      >
        ×
      </div>
      <div
        className={`${styles.btn} ${styles.collapse}`}
        eos-part="collapse"
        title="Collapse"
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
        className={`${styles.btn} ${styles.zoom}`}
        eos-part="zoom"
        title="Zoom"
        role="button"
        tabIndex={0}
        aria-label="Zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
        onKeyDown={(e) => activateButton(e, onZoom)}
      >
        +
      </div>
    </div>
  );
}
