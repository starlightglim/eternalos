/**
 * Tiling state shared by the desktop hook (useTiling) and windows: the
 * tiling order (master first), the current tile rects, and which window is
 * being dragged (tiling pauses while it is, then the drop swaps tiles).
 */

import { create } from 'zustand';
import type { Rect } from '../utils/tiling';

interface TilingState {
  active: boolean;
  order: string[];
  tiles: Record<string, Rect>;
  dragging: string | null;
  setLayout: (active: boolean, order: string[], tiles: Record<string, Rect>) => void;
  setDragging: (id: string | null) => void;
  /** Swap two windows' places in the tiling order. */
  swap: (a: string, b: string) => void;
}

export const useTilingStore = create<TilingState>((set) => ({
  active: false,
  order: [],
  tiles: {},
  dragging: null,
  setLayout: (active, order, tiles) => set({ active, order, tiles }),
  setDragging: (dragging) => set({ dragging }),
  swap: (a, b) => set((state) => {
    const order = [...state.order];
    const i = order.indexOf(a);
    const j = order.indexOf(b);
    if (i < 0 || j < 0) return {};
    [order[i], order[j]] = [order[j], order[i]];
    return { order };
  }),
}));
