/**
 * SpriteButtons — Custom image-based window buttons (Skin system).
 *
 * Each button (close, zoom, collapse) uses a CSS variable for its sprite image.
 * Supports 3 states per button: normal, hover, active — via CSS fallback chain.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
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
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
      />
      <div
        className={`${styles.btn} ${styles.zoom}`}
        eos-part="zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
      />
      <div
        className={`${styles.btn} ${styles.collapse}`}
        eos-part="collapse"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onCollapse}
      />
    </div>
  );
}
