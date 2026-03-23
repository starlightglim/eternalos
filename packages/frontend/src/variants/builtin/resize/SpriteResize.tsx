/**
 * SpriteResize — Custom image-based resize handle (Skin system).
 *
 * Uses a CSS variable for the sprite image.
 */

import type { ResizeHandleSlotProps } from '../../slots';
import type { VariantContext } from '../../types';
import styles from './SpriteResize.module.css';

export function SpriteResize({
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
