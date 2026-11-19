// Desktop state store for EternalOS
// Uses Cloudflare Workers API (or mock mode when API not configured)
//
// State model (CORE-ROADMAP Workstream 1, item 4): the store separates
// server-synced state from interaction state.
//
//   * The data slice (items, uid, loading, uploads, serverWindows) mirrors —
//     or is en route to — server state. `items` holds the *displayed*
//     (optimistic) values, applied immediately so the UI stays responsive.
//     The last server-confirmed value per item lives in the acknowledged
//     snapshot (./desktopItemSync) together with all pending-mutation
//     bookkeeping; every failed write rolls the displayed item back to that
//     snapshot, so nothing ever looks saved when the server never recorded
//     it. `setItems`/`loadDesktop` are the reconcile paths and refresh the
//     displayed items and the snapshot together.
//   * The selection slice (./desktopSelectionSlice) is interaction-only
//     state. Sync/reconcile code never writes it: a server snapshot or a
//     rollback leaves the selection untouched, and only the slice's own
//     actions change it (plus `dropFromSelection` when items are
//     deleted/trashed).

import { create } from 'zustand';
import type { DesktopItem } from '../types';
import {
  isApiConfigured,
  createItem as apiCreateItem,
  updateItems as apiUpdateItems,
  deleteItem as apiDeleteItem,
  analyzeImageItem as apiAnalyzeImageItem,
  uploadFile as apiUploadFile,
  fetchDesktop as apiFetchDesktop,
  emptyTrashApi,
  type SavedWindowState,
} from '../services/api';
import { useAlertStore } from './alertStore';
import { useSoundStore, type SoundType } from './soundStore';
import {
  bumpDesktopSession,
  currentDesktopSession,
  forgetAcknowledgedItems,
  getAcknowledgedItem,
  noteAcknowledgedCreate,
  noteAcknowledgedWrite,
  noteServerItems,
  persistItemMutation,
  resetItemSync,
  rollbackAttemptedFields,
} from './desktopItemSync';
import { createDesktopSelectionSlice, type DesktopSelectionSlice } from './desktopSelectionSlice';

// Helper to show errors via alertStore
const showError = (message: string, title?: string) => {
  useAlertStore.getState().showError(message, title);
};

// Helper to play sounds
const playSound = (type: SoundType) => {
  useSoundStore.getState().playSound(type);
};

// Folder view preferences (persisted to localStorage)
export type SortOrder = 'name' | 'date' | 'kind' | 'none';

const FOLDER_PREFS_KEY = 'eternalos-folder-prefs';

interface FolderPrefs {
  [folderId: string]: {
    sortOrder: SortOrder;
  };
}

// Get preferences for a folder (returns 'none' if not set)
export function getFolderSortOrder(folderId: string | null): SortOrder {
  try {
    const prefs: FolderPrefs = JSON.parse(localStorage.getItem(FOLDER_PREFS_KEY) || '{}');
    const key = folderId ?? 'desktop';
    return prefs[key]?.sortOrder || 'none';
  } catch {
    return 'none';
  }
}

// Set sort preference for a folder
export function setFolderSortOrder(folderId: string | null, sortOrder: SortOrder): void {
  try {
    const prefs: FolderPrefs = JSON.parse(localStorage.getItem(FOLDER_PREFS_KEY) || '{}');
    const key = folderId ?? 'desktop';
    prefs[key] = { sortOrder };
    localStorage.setItem(FOLDER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Silently fail if localStorage isn't available
  }
}

interface UploadProgress {
  id: string;
  filename: string;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

// The server-synced data slice. Selection (interaction state) lives in
// DesktopSelectionSlice; DesktopStore extends both.
interface DesktopDataSlice {
  items: DesktopItem[];
  uid: string | null; // Current user's uid
  loading: boolean;
  uploads: UploadProgress[]; // Active upload progress
  serverWindows: SavedWindowState[]; // Window state from server (for restoration)

  // Actions
  setItems: (items: DesktopItem[]) => void;
  setUid: (uid: string | null) => void;
  addItem: (item: DesktopItem) => void;
  removeItem: (id: string) => void;
  updateItem: (id: string, updates: Partial<DesktopItem>) => Promise<boolean>;
  moveItem: (id: string, position: { x: number; y: number }) => void;
  requestImageAnalysis: (id: string) => Promise<void>;

  // Helpers
  getItemsByParent: (parentId: string | null) => DesktopItem[];
  getItem: (id: string) => DesktopItem | undefined;
  getNextAvailablePositionsInFolder: (
    folderId: string,
    count: number,
    excludeIds?: string[]
  ) => Array<{ x: number; y: number }>;
  cleanUp: (parentId?: string | null) => void;
  sortByName: (parentId?: string | null) => void;
  sortByDate: (parentId?: string | null) => void;
  sortByKind: (parentId?: string | null) => void;
  duplicateItems: (itemIds: string[], targetParentId: string | null) => Promise<DesktopItem[]>;
  pasteItems: (
    itemIds: string[],
    isCut: boolean,
    targetParentId: string | null
  ) => Promise<void>;

  // Loading
  setLoading: (loading: boolean) => void;

  // Reset all state + purge localStorage cache (called on logout / user switch)
  reset: () => void;

  // Upload
  uploadFile: (
    file: File,
    parentId: string | null,
    position: { x: number; y: number }
  ) => Promise<DesktopItem | null>;
  clearUpload: (id: string) => void;

  // Fetch from API
  loadDesktop: () => Promise<void>;

  // Trash operations
  moveToTrash: (ids: string[]) => void;
  restoreFromTrash: (ids: string[]) => void;
  emptyTrash: () => void;
  getTrashedItems: () => DesktopItem[];
  getTrashCount: () => number;
}

export interface DesktopStore extends DesktopDataSlice, DesktopSelectionSlice {}

// Mock data for demo mode (when API not configured)
const mockItems: DesktopItem[] = [
  {
    id: 'folder-documents',
    type: 'folder',
    name: 'Documents',
    parentId: null,
    position: { x: 0, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'folder-images',
    type: 'folder',
    name: 'Images',
    parentId: null,
    position: { x: 0, y: 1 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'text-readme',
    type: 'text',
    name: 'ReadMe.txt',
    parentId: null,
    position: { x: 0, y: 2 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    textContent: 'Welcome to EternalOS!\n\nYour corner of the internet.',
  },
  {
    id: 'image-sample',
    type: 'image',
    name: 'Sample.png',
    parentId: null,
    position: { x: 1, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mimeType: 'image/png',
  },
  {
    id: 'link-website',
    type: 'link',
    name: 'My Website',
    parentId: null,
    position: { x: 1, y: 1 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: 'https://example.com',
  },
  // Items inside Documents folder
  {
    id: 'text-notes',
    type: 'text',
    name: 'Notes.txt',
    parentId: 'folder-documents',
    position: { x: 0, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    textContent: 'My personal notes...',
  },
];

// Debounce timers for position updates
const positionUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Local cache key for instant load.
// Cache is namespaced by uid so one user's items can never surface under
// another user's session (see "image leak on user switch" bug).
const DESKTOP_CACHE_KEY = 'eternalos-desktop-cache';
const AUTH_PERSIST_KEY = 'eternalos-auth';

// Read the currently-persisted auth uid from localStorage. Returns null if
// no user is signed in. We read localStorage directly instead of importing
// authStore to avoid a circular import at module load.
function getPersistedUid(): string | null {
  try {
    const raw = localStorage.getItem(AUTH_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state?.user?.uid ?? null;
  } catch {
    return null;
  }
}

interface CachedDesktop {
  uid: string;
  items: DesktopItem[];
}

// Load cached items from localStorage — only if they belong to the
// currently-authenticated user.
function loadCachedItems(): DesktopItem[] | null {
  try {
    const cached = localStorage.getItem(DESKTOP_CACHE_KEY);
    if (!cached) return null;

    const parsed = JSON.parse(cached);
    const currentUid = getPersistedUid();

    // Legacy cache (bare array) — can't verify ownership, drop it.
    if (Array.isArray(parsed)) {
      localStorage.removeItem(DESKTOP_CACHE_KEY);
      return null;
    }

    // Namespaced cache — only return if uid matches current session.
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.uid === 'string' &&
      Array.isArray(parsed.items) &&
      parsed.uid === currentUid &&
      parsed.items.length > 0
    ) {
      return parsed.items as DesktopItem[];
    }

    // Mismatch (different user, or no user) — clear the stale cache.
    localStorage.removeItem(DESKTOP_CACHE_KEY);
    return null;
  } catch {
    return null;
  }
}

// Save items to localStorage cache (debounced). Cache is tagged with the
// current uid so a later session can detect and discard foreign data.
let cacheTimer: ReturnType<typeof setTimeout> | null = null;
function cacheItems(items: DesktopItem[]) {
  if (cacheTimer) {
    clearTimeout(cacheTimer);
  }
  cacheTimer = setTimeout(() => {
    try {
      const uid = getPersistedUid();
      // No authenticated user — don't write a cache entry that could
      // later be read by someone else.
      if (!uid) {
        localStorage.removeItem(DESKTOP_CACHE_KEY);
        return;
      }
      const payload: CachedDesktop = { uid, items };
      localStorage.setItem(DESKTOP_CACHE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore cache errors (e.g., quota exceeded)
    }
  }, 1000);
}

// Purge the desktop cache from localStorage immediately (cancel any pending
// debounced write first).
function purgeDesktopCache() {
  if (cacheTimer) {
    clearTimeout(cacheTimer);
    cacheTimer = null;
  }
  try {
    localStorage.removeItem(DESKTOP_CACHE_KEY);
  } catch {
    // Ignore
  }
}

// The localStorage cache holds the last server-known desktop from a previous
// session, so it seeds both the displayed items and the acknowledged
// snapshot until the next server reconcile replaces both.
const initialItems: DesktopItem[] = isApiConfigured
  ? (loadCachedItems() || [])
  : mockItems;
if (isApiConfigured) {
  noteServerItems(initialItems);
}

export const useDesktopStore = create<DesktopStore>()((set, get, api) => {
  // Update only the displayed (optimistic) items, and keep the local cache
  // in step. Rollback paths use this so reverting a failed write can never
  // launder an optimistic value into the server-acknowledged snapshot;
  // server snapshots go through `setItems`, which refreshes both.
  const setDisplayedItems = (next: DesktopItem[]) => {
    set({ items: next });
    if (isApiConfigured) {
      cacheItems(next);
    }
  };

  // Arrange the un-trashed items of one parent into grid columns (max ~8
  // per column) and persist the new positions. Shared by Clean Up and the
  // three sort orders. The arrangement is ONE batched `apiUpdateItems`
  // call (same request shape as the original fire-and-forget save — the
  // API's 300 req/min limit means a per-item fan-out would self-throttle a
  // large sort into 429s), but registered in EVERY affected item's write
  // queue: the request fires exactly once, when the last affected item's
  // queue turn comes — so it can never overtake an earlier in-flight save
  // for any of its items, and any write those items queue later (a drag)
  // lands behind it — and every queue entry awaits the same shared
  // outcome, so that per-item ordering is real.
  //
  // Refusal is all-or-nothing: the server's PATCH handler applies the
  // whole batch or (401/429/5xx/network) none of it, so a refused batch
  // reverts every item to its acknowledged position — except items a
  // newer interaction already re-touched — and surfaces one shared
  // "Sync Failed"; a success advances every item's acknowledged snapshot.
  const arrangeAndPersist = (
    parentId: string | null,
    compare: (a: DesktopItem, b: DesktopItem) => number,
    sortOrder: SortOrder | null,
    operation: string
  ) => {
    const itemsInParent = get().items.filter((item) => item.parentId === parentId && !item.isTrashed);
    const otherItems = get().items.filter((item) => item.parentId !== parentId || item.isTrashed);

    const sortedItems = [...itemsInParent].sort(compare);

    const maxItemsPerColumn = 8;
    const updatedItems = sortedItems.map((item, index) => ({
      ...item,
      position: {
        x: Math.floor(index / maxItemsPerColumn),
        y: index % maxItemsPerColumn,
      },
      updatedAt: Date.now(),
    }));

    const newItems = [...otherItems, ...updatedItems];
    set({ items: newItems });

    // Persist the sort preference (Clean Up does not set one).
    if (sortOrder) {
      setFolderSortOrder(parentId, sortOrder);
    }

    if (!isApiConfigured) return;
    cacheItems(newItems);

    const version = currentDesktopSession();
    // The single batched request. `fireBatch` is called exactly once — by
    // the queue entry whose turn comes last — and every entry (including
    // that one) awaits the shared `batchSettled` promise, holding its
    // item's queue slot open until the batch settles.
    const updates = updatedItems.map((item) => ({
      id: item.id,
      updates: { position: item.position },
    }));
    let turnsLeft = updatedItems.length;
    let fireBatch!: (request: Promise<unknown>) => void;
    const batchSettled = new Promise<unknown>((resolve) => {
      fireBatch = resolve;
    });
    let refused = false;

    const writes = updatedItems.map((item) =>
      persistItemMutation(item.id, () => {
        turnsLeft -= 1;
        if (turnsLeft === 0) {
          // Every affected item's queue reached the batch: send it once.
          fireBatch(apiUpdateItems(updates));
        }
        // Entries whose turn came earlier await the same request. If the
        // session dies before the last turn, `turnsLeft` never reaches 0
        // and this promise never settles — harmless: the dead session's
        // queues are dropped whole (resetItemSync), and no snapshot or
        // alert may advance for it anyway.
        return batchSettled;
      })
        .then((savedInSession) => {
          // The batch landed: the server now holds every arranged position.
          if (savedInSession) {
            noteAcknowledgedWrite(item.id, { position: item.position });
          }
          // `false` means the session changed under us (account switch);
          // rehydration reconciles, so that is not a user-facing failure.
          return false;
        })
        .catch((error) => {
          // The whole batch was refused (offline/401/429/500): nothing was
          // applied server-side. Revert this item to its acknowledged
          // position — unless a newer interaction (a drag) already moved
          // it after the sort — and remember the refusal so the batch
          // surfaces one shared error.
          refused = true;
          console.error(`Failed to update positions during ${operation}:`, error);
          if (version === currentDesktopSession()) {
            const displayed = get().getItem(item.id);
            const reverted = displayed
              ? rollbackAttemptedFields(displayed, { position: item.position })
              : null;
            if (reverted) {
              setDisplayedItems(
                get().items.map((current) => (current.id === item.id ? reverted : current))
              );
            }
          }
          return true;
        })
    );
    void Promise.all(writes).then(() => {
      if (version !== currentDesktopSession()) return;
      if (refused) {
        showError('Could not save the new arrangement. It has been reverted.', 'Sync Failed');
      }
    });
  };

  return {
    // ---- Interaction slice: selection (never touched by sync code) ----
    ...createDesktopSelectionSlice(set, get, api),

    // ---- Server-synced data slice ----
    // Use cached items on initial load for instant display (if API mode)
    // Falls back to mock items in demo mode
    items: initialItems,
    uid: null,
    loading: false,
    uploads: [],
    serverWindows: [],

    setItems: (items) => {
      // A server snapshot: the displayed items and the acknowledged state
      // move to it together. (useDesktopSync + tests use this as the
      // reconcile entry point.)
      noteServerItems(items);
      set({ items });
      if (isApiConfigured) {
        cacheItems(items);
      }
    },

    setUid: (uid) => {
      if (get().uid !== uid) bumpDesktopSession();
      set({ uid });
    },

    setLoading: (loading) => set({ loading }),

    reset: () => {
      bumpDesktopSession();
      // Cancel any pending position/cache writes so they can't resurrect
      // the previous user's data after we clear.
      positionUpdateTimers.forEach((t) => clearTimeout(t));
      positionUpdateTimers.clear();
      // Drop the acknowledged snapshot + queued writes of the old session.
      resetItemSync();
      purgeDesktopCache();
      // Selection is interaction state; clear it through its slice action.
      get().deselectAll();
      set({
        items: [],
        uid: null,
        loading: false,
        uploads: [],
        serverWindows: [],
      });
    },

    addItem: (item) => {
      const version = currentDesktopSession();
      // Update local state
      set((state) => {
        const newItems = [...state.items, item];
        if (isApiConfigured) {
          cacheItems(newItems);
        }
        return { items: newItems };
      });

      // Sync to API if configured
      if (isApiConfigured) {
        persistItemMutation(item.id, () => apiCreateItem(item))
          .then((savedInSession) => {
            // The server now knows the item exactly as created.
            if (savedInSession) noteAcknowledgedCreate(item);
          })
          .catch((error) => {
            if (version !== currentDesktopSession()) return;
            // The create failed: no phantom item, and nothing acknowledged.
            forgetAcknowledgedItems([item.id]);
            setDisplayedItems(get().items.filter((current) => current.id !== item.id));
            console.error('Failed to create item:', error);
            showError(
              `Could not create "${item.name}". ${error instanceof Error ? error.message : 'Please try again.'}`,
              'Create Failed'
            );
          });
      }
    },

    removeItem: (id) => {
      const version = currentDesktopSession();
      const original = get().getItem(id);
      // Update local state
      set((state) => {
        const newItems = state.items.filter((item) => item.id !== id);
        if (isApiConfigured) {
          cacheItems(newItems);
        }
        return { items: newItems };
      });
      // A deleted item cannot stay selected (interaction slice action).
      get().dropFromSelection([id]);

      // Sync to API if configured
      if (isApiConfigured) {
        persistItemMutation(id, () => apiDeleteItem(id))
          .then((deletedInSession) => {
            // The server forgot the item; so does the acknowledged snapshot.
            if (deletedInSession) forgetAcknowledgedItems([id]);
          })
          .catch((error) => {
            if (version !== currentDesktopSession()) return;
            // The delete never happened server-side: put the item back
            // exactly as it was. The failed write left the acknowledged
            // snapshot untouched, so re-adding the displayed original keeps
            // the two in sync.
            if (original && !get().getItem(id)) {
              setDisplayedItems([...get().items, original]);
            }
            console.error('Failed to delete item:', error);
            showError(
              `Could not delete item. ${error instanceof Error ? error.message : 'Please try again.'}`,
              'Delete Failed'
            );
          });
      }
    },

    updateItem: async (id, updates) => {
      const version = currentDesktopSession();
      if (!get().getItem(id)) return false;
      // Privacy and document content only become authoritative after a server
      // acknowledgement. Editors retain their own draft while the save is pending.
      const requiresAcknowledgement = 'isPublic' in updates || 'textContent' in updates;
      const apply = () => set((state) => {
        const newItems = state.items.map((item) =>
          item.id === id ? { ...item, ...updates, updatedAt: Date.now() } : item
        );
        if (isApiConfigured) {
          cacheItems(newItems);
        }
        return { items: newItems };
      });
      if (!isApiConfigured || !requiresAcknowledgement) apply();

      if (isApiConfigured) {
        try {
          const currentSession = await persistItemMutation(id, () => apiUpdateItems([{ id, updates }]));
          if (!currentSession) return false;
          if (requiresAcknowledgement) apply();
          // The server has now recorded exactly these fields.
          noteAcknowledgedWrite(id, updates);
        } catch (error) {
          if (version !== currentDesktopSession()) return false;
          // Roll the fields this write attempted back to the last
          // server-acknowledged snapshot — never to an intermediate
          // optimistic value (e.g. the first of two chained renames), and
          // never clobbering a newer interaction (a second rename, a drag)
          // that changed them in the meantime.
          const displayed = get().getItem(id);
          const reverted = displayed ? rollbackAttemptedFields(displayed, updates) : null;
          if (reverted) {
            setDisplayedItems(get().items.map((item) => (item.id === id ? reverted : item)));
          }
          console.error('Failed to update item:', error);
          showError(
            'Could not save your changes. Please try again.',
            'Sync Failed'
          );
          return false;
        }
      }
      return true;
    },

    moveItem: (id, position) => {
      // Play drop sound
      playSound('drop');

      // Update local state immediately for responsive UI
      set((state) => {
        const newItems = state.items.map((item) =>
          item.id === id ? { ...item, position, updatedAt: Date.now() } : item
        );
        // Note: caching is handled by the debounced API sync below
        return { items: newItems };
      });

      // Debounced sync to API (avoid excessive writes during drag)
      if (isApiConfigured) {
        const version = currentDesktopSession();
        // Clear any existing timer for this item
        const existingTimer = positionUpdateTimers.get(id);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // Set a new timer
        const timer = setTimeout(() => {
          positionUpdateTimers.delete(id);
          // Serialize through the per-item write queue (same as other
          // mutations) so a failed position save rolls back instead of
          // silently leaving an unsaved position that looks persisted. The
          // rollback target is the last server-acknowledged position, so a
          // whole chain of drags reverts to where the server actually is.
          persistItemMutation(id, () => apiUpdateItems([{ id, updates: { position } }]))
            .then((savedInSession) => {
              if (savedInSession) {
                noteAcknowledgedWrite(id, { position });
                cacheItems(get().items);
              }
              // savedInSession === false means the session changed under us
              // (account switch); rehydration reconciles, so leave state alone.
            })
            .catch(() => {
              // The session is unchanged but the save failed (offline/4xx/5xx).
              // Revert to the acknowledged position, but only if the user
              // hasn't moved this item again since this save was queued.
              if (version !== currentDesktopSession()) return;
              const displayed = get().getItem(id);
              const reverted = displayed ? rollbackAttemptedFields(displayed, { position }) : null;
              if (reverted) {
                setDisplayedItems(get().items.map((item) => (item.id === id ? reverted : item)));
                cacheItems(get().items);
              }
              showError(
                'Could not save the new position. It has been reverted.',
                'Sync Failed'
              );
            });
        }, 500);

        positionUpdateTimers.set(id, timer);
      }
    },

    requestImageAnalysis: async (id) => {
      const item = get().getItem(id);
      if (!item || item.type !== 'image' || !isApiConfigured) return;

      set((state) => {
        const newItems: DesktopItem[] = state.items.map((currentItem) =>
          currentItem.id === id
            ? {
                ...currentItem,
                imageAnalysis: {
                  ...(currentItem.imageAnalysis || {}),
                  status: 'pending' as const,
                  error: undefined,
                },
                updatedAt: Date.now(),
              }
            : currentItem
        );

        cacheItems(newItems);
        return { items: newItems };
      });

      try {
        await apiAnalyzeImageItem(id);
      } catch (error) {
        console.error('Failed to start image analysis:', error);
        set((state) => {
          const newItems: DesktopItem[] = state.items.map((currentItem) =>
            currentItem.id === id
              ? {
                  ...currentItem,
                  imageAnalysis: {
                    ...(currentItem.imageAnalysis || {}),
                    status: 'failed' as const,
                    error: error instanceof Error ? error.message : 'Failed to start image analysis',
                  },
                  updatedAt: Date.now(),
                }
              : currentItem
        );

          cacheItems(newItems);
          return { items: newItems };
        });
      }
    },

    getItemsByParent: (parentId) =>
      get().items.filter((item) => item.parentId === parentId),

    getItem: (id) => get().items.find((item) => item.id === id),

    getNextAvailablePositionsInFolder: (folderId, count, excludeIds = []) => {
      // Get items already in the target folder, excluding the ones being moved
      const existingItems = get().items.filter(
        (item) =>
          item.parentId === folderId &&
          !item.isTrashed &&
          !excludeIds.includes(item.id)
      );

      // Build a set of occupied positions
      const occupiedPositions = new Set(
        existingItems.map((item) => `${item.position.x},${item.position.y}`)
      );

      // Find available positions using an 8-column grid layout
      const positions: Array<{ x: number; y: number }> = [];
      let x = 0;
      let y = 0;

      while (positions.length < count) {
        const key = `${x},${y}`;
        if (!occupiedPositions.has(key)) {
          positions.push({ x, y });
          occupiedPositions.add(key); // Mark as occupied for subsequent items
        }
        // Move to next position in 8-column grid
        x++;
        if (x >= 8) {
          x = 0;
          y++;
        }
      }

      return positions;
    },

    cleanUp: (parentId = null) => {
      // Clean Up arranges alphabetically by name but sets no sort preference.
      arrangeAndPersist(
        parentId,
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        null,
        'clean up'
      );
    },

    sortByName: (parentId = null) => {
      arrangeAndPersist(
        parentId,
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        'name',
        'sort by name'
      );
    },

    sortByDate: (parentId = null) => {
      // Newest first.
      arrangeAndPersist(parentId, (a, b) => b.updatedAt - a.updatedAt, 'date', 'sort by date');
    },

    sortByKind: (parentId = null) => {
      // Folders first, then by type, then by name.
      const typeOrder: Record<string, number> = {
        folder: 0,
        text: 1,
        image: 2,
        video: 3,
        audio: 4,
        pdf: 5,
        link: 6,
        widget: 7,
      };
      arrangeAndPersist(
        parentId,
        (a, b) => {
          const typeComparison = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
          if (typeComparison !== 0) return typeComparison;
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        },
        'kind',
        'sort by kind'
      );
    },

    duplicateItems: async (itemIds, targetParentId) => {
      const version = currentDesktopSession();
      const { items, getItem } = get();
      const duplicates: DesktopItem[] = [];

      // Find positions in target folder
      const itemsInTarget = items.filter((item) => item.parentId === targetParentId);
      let nextY = itemsInTarget.length > 0
        ? Math.max(...itemsInTarget.map((i) => i.position.y)) + 1
        : 0;

      for (const id of itemIds) {
        const original = getItem(id);
        if (!original) continue;

        // Create duplicate with new id and position
        const duplicate: DesktopItem = {
          ...original,
          id: crypto.randomUUID(),
          name: `${original.name} copy`,
          parentId: targetParentId,
          position: { x: 0, y: nextY++ },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        // Create item via API
        if (isApiConfigured) {
          try {
            if (!await persistItemMutation(duplicate.id, () => apiCreateItem(duplicate))) return [];
            // The server knows the duplicate exactly as created.
            noteAcknowledgedCreate(duplicate);
          } catch (error) {
            if (version !== currentDesktopSession()) return [];
            console.error('Failed to create duplicate item:', error);
            showError(`Could not duplicate "${original.name}". Please try again.`, 'Duplicate Failed');
            continue;
          }
        }
        duplicates.push(duplicate);
      }

      // Add all duplicates to state
      if (duplicates.length > 0) {
        const newItems = [...get().items, ...duplicates];
        set({ items: newItems });
        if (isApiConfigured) {
          cacheItems(newItems);
        }
      }

      return duplicates;
    },

    pasteItems: async (itemIds, isCut, targetParentId) => {
      const { items, duplicateItems } = get();

      if (isCut) {
        // Roll back a failed move to the acknowledged snapshot (the last
        // server-confirmed parenting/position) instead of leaving items
        // looking moved when the server never recorded it.
        const originals = new Map(
          items.filter((item) => itemIds.includes(item.id)).map((item) => [item.id, { ...item }])
        );

        // Move items to target folder
        const updates: { id: string; updates: Partial<DesktopItem> }[] = [];
        const itemsInTarget = items.filter((item) => item.parentId === targetParentId);
        let nextY = itemsInTarget.length > 0
          ? Math.max(...itemsInTarget.map((i) => i.position.y)) + 1
          : 0;

        const movedItems = items.map((item) => {
          if (itemIds.includes(item.id)) {
            const newPos = { x: 0, y: nextY++ };
            updates.push({
              id: item.id,
              updates: { parentId: targetParentId, position: newPos },
            });
            return {
              ...item,
              parentId: targetParentId,
              position: newPos,
              updatedAt: Date.now(),
            };
          }
          return item;
        });

        set({ items: movedItems });

        // Sync to API
        if (isApiConfigured && updates.length > 0) {
          const version = currentDesktopSession();
          cacheItems(movedItems);
          apiUpdateItems(updates)
            .then(() => {
              if (version !== currentDesktopSession()) return;
              for (const { id, updates: attempted } of updates) {
                noteAcknowledgedWrite(id, attempted);
              }
            })
            .catch((error) => {
              console.error('Failed to move items:', error);
              // Roll back items still sitting in the move target (not
              // re-touched) within the same session, so nothing looks moved
              // when it wasn't. The paste reverts as one unit per item,
              // guarded on the parenting.
              if (version === currentDesktopSession()) {
                set((state) => ({
                  items: state.items.map((item) => {
                    if (!originals.has(item.id)) return item;
                    const attempted = updates.find((u) => u.id === item.id)?.updates;
                    const reverted = attempted
                      ? rollbackAttemptedFields(item, attempted, ['parentId'])
                      : null;
                    return reverted ?? item;
                  }),
                }));
                cacheItems(get().items);
              }
              showError(
                'Failed to move items. They have been returned to their original location.',
                'Move Failed'
              );
            });
        }
      } else {
        // Copy items (create duplicates)
        await duplicateItems(itemIds, targetParentId);
      }
    },

    uploadFile: async (file, parentId, position) => {
      const version = currentDesktopSession();
      if (!isApiConfigured) {
        console.warn('Upload not available in demo mode');
        return null;
      }

      // Create upload progress entry
      const uploadId = crypto.randomUUID();
      set((state) => ({
        uploads: [
          ...state.uploads,
          {
            id: uploadId,
            filename: file.name,
            progress: 0,
            status: 'uploading' as const,
          },
        ],
      }));

      try {
        // Upload file to API
        const result = await apiUploadFile(
          file,
          parentId,
          position,
          (progress) => {
            set((state) => ({
              uploads: state.uploads.map((u) =>
                u.id === uploadId ? { ...u, progress } : u
              ),
            }));
          }
        );
        if (version !== currentDesktopSession()) return null;

        // Mark upload complete
        set((state) => {
          const newItems = [...state.items, result.item];
          cacheItems(newItems);
          return {
            uploads: state.uploads.map((u) =>
              u.id === uploadId ? { ...u, progress: 100, status: 'complete' as const } : u
            ),
            // Add the uploaded item to local state
            items: newItems,
          };
        });
        // The item came from the server: it is the acknowledged value.
        noteAcknowledgedCreate(result.item);

        // Auto-clear completed uploads after 3 seconds
        setTimeout(() => {
          get().clearUpload(uploadId);
        }, 3000);

        return result.item;
      } catch (error) {
        if (version !== currentDesktopSession()) return null;
        const errorMessage = error instanceof Error ? error.message : 'Upload failed';
        // Mark upload as failed
        set((state) => ({
          uploads: state.uploads.map((u) =>
            u.id === uploadId
              ? {
                  ...u,
                  status: 'error' as const,
                  error: errorMessage,
                }
              : u
          ),
        }));
        showError(
          `Could not upload "${file.name}". ${errorMessage}`,
          'Upload Failed'
        );
        return null;
      }
    },

    clearUpload: (id) => {
      set((state) => ({
        uploads: state.uploads.filter((u) => u.id !== id),
      }));
    },

    loadDesktop: async () => {
      const version = currentDesktopSession();
      if (!isApiConfigured) {
        // In demo mode, items are already set from mockItems
        return;
      }

      // If we have cached items, show them immediately (already loaded in initial state)
      const cachedItems = get().items;
      const hasCache = cachedItems.length > 0;

      // Only show loading if no cache
      if (!hasCache) {
        set({ loading: true });
      }

      try {
        const response = await apiFetchDesktop();
        if (version !== currentDesktopSession()) return;
        // Server reconcile: the response is the source of truth for both
        // the displayed items and the acknowledged snapshot. An optimistic
        // item the server echoes back converges to the one server copy —
        // no duplicates.
        noteServerItems(response.items);
        set({
          items: response.items,
          loading: false,
        });
        // Cache the fresh items
        cacheItems(response.items);
      } catch (error) {
        if (version !== currentDesktopSession()) return;
        console.error('Failed to load desktop:', error);
        set({ loading: false });
        // Only show error if we don't have a cache to fall back on
        if (!hasCache) {
          showError(
            `Could not load your desktop. ${error instanceof Error ? error.message : 'Please try again.'}`,
            'Loading Failed'
          );
        }
      }
    },

    // ============================================
    // TRASH OPERATIONS
    // ============================================

    moveToTrash: (ids) => {
      const now = Date.now();

      // Cascade: collect all descendant items of any trashed folders
      const { items } = get();
      const allIdsToTrash = new Set(ids);
      const collectChildren = (parentId: string) => {
        for (const item of items) {
          if (item.parentId === parentId && !allIdsToTrash.has(item.id)) {
            allIdsToTrash.add(item.id);
            if (item.type === 'folder') {
              collectChildren(item.id);
            }
          }
        }
      };
      for (const id of ids) {
        const item = items.find((i) => i.id === id);
        if (item?.type === 'folder') {
          collectChildren(id);
        }
      }

      const idsArray = Array.from(allIdsToTrash);

      set((state) => {
        const newItems = state.items.map((item) =>
          allIdsToTrash.has(item.id)
            ? {
                ...item,
                isTrashed: true,
                trashedAt: now,
                updatedAt: now,
                // Save original parent so restore can put it back
                originalParentId: item.parentId,
              }
            : item
        );
        if (isApiConfigured) {
          cacheItems(newItems);
        }
        return { items: newItems };
      });
      // Trashed items cannot stay selected (interaction slice action).
      get().dropFromSelection(allIdsToTrash);

      // Play trash sound
      playSound('trash');

      // Sync to API if configured
      if (isApiConfigured) {
        const version = currentDesktopSession();
        const updates = idsArray.map((id) => {
          const item = items.find((i) => i.id === id);
          return {
            id,
            updates: { isTrashed: true, trashedAt: now, originalParentId: item?.parentId ?? null },
          };
        });
        apiUpdateItems(updates)
          .then(() => {
            if (version !== currentDesktopSession()) return;
            for (const { id, updates: attempted } of updates) {
              noteAcknowledgedWrite(id, attempted);
            }
          })
          .catch((error) => {
            console.error('Failed to move items to trash:', error);
            // Roll back the optimistic trash so items don't look trashed when
            // the server never recorded it. Only fields still showing this
            // write's attempted values are reverted (an item the user
            // re-touched keeps its newer state) and only within the same
            // session.
            if (version === currentDesktopSession()) {
              set((state) => ({
                items: state.items.map((item) => {
                  if (!allIdsToTrash.has(item.id)) return item;
                  const attempted = updates.find((u) => u.id === item.id)?.updates;
                  const reverted = attempted
                    ? rollbackAttemptedFields(item, attempted)
                    : null;
                  return reverted ?? item;
                }),
              }));
              cacheItems(get().items);
            }
            showError(
              'Failed to move items to trash. They have been restored.',
              'Trash Failed'
            );
          });
      }
    },

    restoreFromTrash: (ids) => {
      const { items } = get();

      set((state) => {
        const newItems = state.items.map((item) => {
          if (!ids.includes(item.id)) return item;

          // Restore to original parent if it still exists and isn't trashed
          let restoreParentId: string | null = null;
          if (item.originalParentId) {
            const parent = state.items.find(
              (p) => p.id === item.originalParentId && !p.isTrashed
            );
            if (parent) {
              restoreParentId = item.originalParentId;
            }
            // If parent is missing or also trashed, restore to desktop root (null)
          }

          return {
            ...item,
            isTrashed: false,
            trashedAt: undefined,
            originalParentId: undefined,
            parentId: restoreParentId,
            updatedAt: Date.now(),
          };
        });
        if (isApiConfigured) {
          cacheItems(newItems);
        }
        return { items: newItems };
      });

      // Sync to API if configured
      if (isApiConfigured) {
        const version = currentDesktopSession();
        const restoreIds = new Set(ids);
        const updates = ids.map((id) => {
          const item = items.find((i) => i.id === id);
          // Compute restore parentId same as above
          let restoreParentId: string | null = null;
          if (item?.originalParentId) {
            const parent = items.find(
              (p) => p.id === item.originalParentId && !p.isTrashed
            );
            if (parent) restoreParentId = item.originalParentId;
          }
          return {
            id,
            updates: {
              isTrashed: false,
              trashedAt: undefined,
              originalParentId: undefined,
              parentId: restoreParentId,
            },
          };
        });
        apiUpdateItems(updates)
          .then(() => {
            if (version !== currentDesktopSession()) return;
            for (const { id, updates: attempted } of updates) {
              noteAcknowledgedWrite(id, attempted);
            }
          })
          .catch((error) => {
            console.error('Failed to restore items from trash:', error);
            // Roll back the optimistic restore so an item doesn't look
            // restored when the server never recorded it — back to the
            // acknowledged (trashed) snapshot. Only items still showing as
            // restored (not re-touched) within the same session.
            if (version === currentDesktopSession()) {
              set((state) => ({
                items: state.items.map((item) => {
                  if (!restoreIds.has(item.id)) return item;
                  const attempted = updates.find((u) => u.id === item.id)?.updates;
                  const reverted = attempted
                    ? rollbackAttemptedFields(item, attempted)
                    : null;
                  return reverted ?? item;
                }),
              }));
              cacheItems(get().items);
            }
            showError(
              'Failed to restore items. They have been returned to the Trash.',
              'Restore Failed'
            );
          });
      }
    },

    emptyTrash: () => {
      const trashedItems = get().items.filter((item) => item.isTrashed);

      if (trashedItems.length === 0) return;

      // Play empty trash sound
      playSound('emptyTrash');

      // Remove from local state
      set((state) => {
        const newItems = state.items.filter((item) => !item.isTrashed);
        if (isApiConfigured) {
          cacheItems(newItems);
        }
        return { items: newItems };
      });

      // Use the server-side empty trash endpoint (atomic, handles R2 cleanup)
      if (isApiConfigured) {
        const version = currentDesktopSession();
        emptyTrashApi()
          .then(() => {
            // The server permanently deleted these; the acknowledged
            // snapshot forgets them too.
            if (version !== currentDesktopSession()) return;
            forgetAcknowledgedItems(trashedItems.map((item) => item.id));
          })
          .catch((error) => {
            console.error('Failed to empty trash:', error);
            if (version !== currentDesktopSession()) return;
            // The server refused the permanent delete, so it still holds
            // every trashed item. Put back the ones this call removed,
            // restored from the acknowledged snapshot (exactly what the
            // server still knows — falling back to the removed values for
            // items it never confirmed), so nothing looks destroyed when
            // it isn't.
            const present = new Set(get().items.map((item) => item.id));
            const restored = trashedItems
              .filter((item) => !present.has(item.id))
              .map((item) => getAcknowledgedItem(item.id) ?? item);
            if (restored.length > 0) {
              setDisplayedItems([...get().items, ...restored]);
            }
            showError(
              'Failed to permanently delete the trash. Your trashed items have been restored.',
              'Empty Trash Failed'
            );
          });
      }
    },

    getTrashedItems: () => {
      return get().items.filter((item) => item.isTrashed);
    },

    getTrashCount: () => {
      return get().items.filter((item) => item.isTrashed).length;
    },
  };
});
