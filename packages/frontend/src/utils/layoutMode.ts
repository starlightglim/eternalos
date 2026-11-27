/**
 * Mobile vs desktop layout choice for the owner's desktop.
 *
 * Swapping Desktop ↔ MobileBrowser unmounts the other tree and throws away
 * every open viewer's state, so the layout must not flip on a small resize
 * near the breakpoint:
 *  - the first decision uses the plain breakpoint;
 *  - after that, the layout only changes once the width moves clearly past
 *    it (HYSTERESIS px either side);
 *  - a touch device whose short side is phone-sized stays mobile in either
 *    orientation, so rotating a phone never flips it.
 */

export const MOBILE_BREAKPOINT = 768;
export const LAYOUT_HYSTERESIS = 64;

export interface LayoutInput {
  width: number;
  height: number;
  /** `(pointer: coarse)` — a touch-first device. */
  coarsePointer: boolean;
  /** The current layout, or undefined for the first decision. */
  previous?: boolean;
}

export function decideMobileLayout({ width, height, coarsePointer, previous }: LayoutInput): boolean {
  if (coarsePointer && Math.min(width, height) < MOBILE_BREAKPOINT) return true;
  if (previous === undefined) return width < MOBILE_BREAKPOINT;
  return previous
    ? width < MOBILE_BREAKPOINT + LAYOUT_HYSTERESIS
    : width < MOBILE_BREAKPOINT - LAYOUT_HYSTERESIS;
}
