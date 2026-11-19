// Pure interaction state for the desktop: the icon selection.
//
// CORE-ROADMAP Workstream 1, item 4 separates this from the server-synced
// data slice. The selection is interaction-only state, so sync/reconcile
// code (server snapshots via setItems/loadDesktop, optimistic writes, and
// their rollbacks) never writes it — a server reconcile always leaves the
// selection intact. All selection writes live in this slice: the selection
// actions below, plus `dropFromSelection`, which is the only way mutation
// actions shrink the selection (a deleted/trashed item cannot stay
// selected). The session reset clears it through `deselectAll`.

import type { StateCreator } from 'zustand';
import type { DesktopStore } from './desktopStore';

export interface DesktopSelectionSlice {
  /** Currently selected item ids. Interaction-only state, never synced. */
  selectedIds: Set<string>;
  selectItem: (id: string, addToSelection?: boolean) => void;
  selectAll: (parentId?: string | null) => void;
  deselectAll: () => void;
  isSelected: (id: string) => boolean;
  /** Drop ids from the selection (items were deleted or trashed). */
  dropFromSelection: (ids: Iterable<string>) => void;
}

export const createDesktopSelectionSlice: StateCreator<
  DesktopStore,
  [],
  [],
  DesktopSelectionSlice
> = (set, get) => ({
  selectedIds: new Set<string>(),

  selectItem: (id, addToSelection = false) => {
    set((state) => ({
      selectedIds: addToSelection
        ? new Set([...state.selectedIds, id])
        : new Set([id]),
    }));
  },

  selectAll: (parentId = null) => {
    // Select all items in the specified parent (null = desktop root)
    set((state) => {
      const itemsInParent = state.items.filter((item) => item.parentId === parentId);
      return { selectedIds: new Set(itemsInParent.map((item) => item.id)) };
    });
  },

  deselectAll: () => set({ selectedIds: new Set() }),

  isSelected: (id) => get().selectedIds.has(id),

  dropFromSelection: (ids) => {
    const dropped = ids instanceof Set ? ids : new Set(ids);
    const current = get().selectedIds;
    let touchesSelection = false;
    for (const id of dropped) {
      if (current.has(id)) {
        touchesSelection = true;
        break;
      }
    }
    if (!touchesSelection) return;
    set((state) => ({
      selectedIds: new Set([...state.selectedIds].filter((id) => !dropped.has(id))),
    }));
  },
});
