/**
 * SpriteButtons — Custom image-based window buttons (Skin system).
 *
 * Each button (close, zoom, collapse) uses a CSS variable for its sprite image.
 * Supports 3 states per button: normal, hover, active — via CSS fallback chain.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import { activateButton } from './buttonKeyboard';
import styles from './SpriteButtons.module.css';

export function SpriteButtons({
  isActive,
  onClose,
  onZoom,
  onCollapse,
}: WindowButtonsSlotProps & VariantContext) {
  return (
    <div className={`${styles.buttonGroup} ${!isActive ? styles.inactive : ''}`}>
      <div
        className={`${styles.btn} ${styles.close}`}
        eos-part="close"
        role="button"
        tabIndex={0}
        aria-label="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        onKeyDown={(e) => activateButton(e, onClose)}
      />
      <div
        className={`${styles.btn} ${styles.zoom}`}
        eos-part="zoom"
        role="button"
        tabIndex={0}
        aria-label="Zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
        onKeyDown={(e) => activateButton(e, onZoom)}
      />
      <div
        className={`${styles.btn} ${styles.collapse}`}
        eos-part="collapse"
        role="button"
        tabIndex={0}
        aria-label="Collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
        onKeyDown={(e) => activateButton(e, onCollapse)}
      />
    </div>
  );
}
