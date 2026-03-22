/**
 * CornerLinesResize — Classic Mac OS diagonal lines resize handle.
 * This is the default window.resizeHandle variant.
 */

import type { ResizeHandleSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './CornerLinesResize.module.css';

export function CornerLinesResize({
  onResizeStart,
  onResizeMove,
  onResizeEnd,
}: ResizeHandleSlotProps & VariantContext) {
  return (
    <div
      className={`${styles.resizeHandle} resizeHandle`}
      onPointerDown={onResizeStart}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
    />
  );
}
