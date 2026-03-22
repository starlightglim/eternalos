/**
 * CornerDotResize — Single dot resize indicator.
 */

import type { ResizeHandleSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './CornerDotResize.module.css';

export function CornerDotResize({
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
