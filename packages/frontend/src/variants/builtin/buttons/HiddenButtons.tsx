/**
 * HiddenButtons — Invisible until the title bar is hovered.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import { activateButton } from './buttonKeyboard';
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
        role="button"
        tabIndex={0}
        aria-label="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        onKeyDown={(e) => activateButton(e, onClose)}
      />
      <div
        className={styles.btn}
        eos-part="collapse"
        role="button"
        tabIndex={0}
        aria-label="Collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
        onKeyDown={(e) => activateButton(e, onCollapse)}
      />
      <div
        className={styles.btn}
        eos-part="zoom"
        role="button"
        tabIndex={0}
        aria-label="Zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
        onKeyDown={(e) => activateButton(e, onZoom)}
      />
    </div>
  );
}
