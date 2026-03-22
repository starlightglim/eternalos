/**
 * HiddenResize — Invisible resize handle, cursor-only.
 */

import type { ResizeHandleSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './HiddenResize.module.css';

export function HiddenResize({
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
