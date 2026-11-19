/**
 * SquareButtons — Classic Mac OS square close/zoom/collapse buttons.
 * This is the default window.buttons variant.
 */

import type { WindowButtonsSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import { activateButton } from './buttonKeyboard';
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
        title="Close"
        role="button"
        tabIndex={0}
        aria-label="Close"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onClose}
        onKeyDown={(e) => activateButton(e, onClose)}
      />
      <div
        className={`${styles.zoomBox} zoomBox`}
        eos-part="zoom"
        title="Zoom"
        role="button"
        tabIndex={0}
        aria-label="Zoom"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onZoom}
        onKeyDown={(e) => activateButton(e, onZoom)}
      />
      <div
        className={`${styles.collapseBox} collapseBox`}
        eos-part="collapse"
        title="Collapse"
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
