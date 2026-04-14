// Desktop state store for EternalOS
// Uses Cloudflare Workers API (or mock mode when API not configured)

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

interface DesktopStore {
  items: DesktopItem[];
  selectedIds: Set<string>;
  uid: string | null; // Current user's uid
  loading: boolean;
  uploads: UploadProgress[]; // Active upload progress
  serverWindows: SavedWindowState[]; // Window state from server (for restoration)

  // Actions
  setItems: (items: DesktopItem[]) => void;
  setUid: (uid: string | null) => void;
  addItem: (item: DesktopItem) => void;
  removeItem: (id: string) => void;
  updateItem: (id: string, updates: Partial<DesktopItem>) => void;
  moveItem: (id: string, position: { x: number; y: number }) => void;
  requestImageAnalysis: (id: string) => Promise<void>;

  // Selection
  selectItem: (id: string, addToSelection?: boolean) => void;
  selectAll: (parentId?: string | null) => void;
  deselectAll: () => void;
  isSelected: (id: string) => boolean;

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

export const useDesktopStore = create<DesktopStore>((set, get) => ({
  // Use cached items on initial load for instant display (if API mode)
  // Falls back to mock items in demo mode
  items: isApiConfigured ? (loadCachedItems() || []) : mockItems,
  selectedIds: new Set<string>(),
  uid: null,
  loading: false,
  uploads: [],
  serverWindows: [],

  setItems: (items) => {
    set({ items });
    if (isApiConfigured) {
      cacheItems(items);
    }
  },

  setUid: (uid) => set({ uid }),

  setLoading: (loading) => set({ loading }),

  reset: () => {
    // Cancel any pending position/cache writes so they can't resurrect
    // the previous user's data after we clear.
    positionUpdateTimers.forEach((t) => clearTimeout(t));
    positionUpdateTimers.clear();
    purgeDesktopCache();
    set({
      items: [],
      selectedIds: new Set<string>(),
      uid: null,
      loading: false,
      uploads: [],
      serverWindows: [],
    });
  },

  addItem: (item) => {
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
      apiCreateItem(item).catch((error) => {
        console.error('Failed to create item:', error);
        showError(
          `Could not create "${item.name}". ${error instanceof Error ? error.message : 'Please try again.'}`,
          'Create Failed'
        );
      });
    }
  },

  removeItem: (id) => {
    // Update local state
    set((state) => {
      const newItems = state.items.filter((item) => item.id !== id);
      if (isApiConfigured) {
        cacheItems(newItems);
      }
      return {
        items: newItems,
        selectedIds: new Set([...state.selectedIds].filter((sid) => sid !== id)),
      };
    });

    // Sync to API if configured
    if (isApiConfigured) {
      apiDeleteItem(id).catch((error) => {
        console.error('Failed to delete item:', error);
        showError(
          `Could not delete item. ${error instanceof Error ? error.message : 'Please try again.'}`,
          'Delete Failed'
        );
      });
    }
  },

  updateItem: (id, updates) => {
    // Update local state
    set((state) => {
      const newItems = state.items.map((item) =>
        item.id === id ? { ...item, ...updates, updatedAt: Date.now() } : item
      );
      if (isApiConfigured) {
        cacheItems(newItems);
      }
      return { items: newItems };
    });

    // Sync to API if configured
    if (isApiConfigured) {
      apiUpdateItems([{ id, updates }]).catch((error) => {
        console.error('Failed to update item:', error);
        showError(
          'Your changes may not have been saved. Please reload to check.',
          'Sync Failed'
        );
      });
    }
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
      // Clear any existing timer for this item
      const existingTimer = positionUpdateTimers.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set a new timer
      const timer = setTimeout(() => {
        apiUpdateItems([{ id, updates: { position } }]).catch((error) => {
          console.error('Failed to update position:', error);
        });
        // Cache after position sync completes
        cacheItems(get().items);
        positionUpdateTimers.delete(id);
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

  selectItem: (id, addToSelection = false) => {
    set((state) => {
      const newSelectedIds = addToSelection
        ? new Set([...state.selectedIds, id])
        : new Set([id]);
      return { selectedIds: newSelectedIds };
    });
  },

  selectAll: (parentId = null) => {
    set((state) => {
      // Select all items in the specified parent (null = desktop root)
      const itemsInParent = state.items.filter((item) => item.parentId === parentId);
      return { selectedIds: new Set(itemsInParent.map((item) => item.id)) };
    });
  },

  deselectAll: () => set({ selectedIds: new Set() }),

  isSelected: (id) => get().selectedIds.has(id),

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
    // Sort items by name and arrange in columns (exclude trashed items)
    const itemsInParent = get().items.filter((item) => item.parentId === parentId && !item.isTrashed);
    const otherItems = get().items.filter((item) => item.parentId !== parentId || item.isTrashed);

    // Sort alphabetically by name
    const sortedItems = [...itemsInParent].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    // Arrange in columns (max ~8 items per column on typical desktop)
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

    // Cache and sync to API
    if (isApiConfigured) {
      cacheItems(newItems);
      // Batch update all positions
      const updates = updatedItems.map((item) => ({
        id: item.id,
        updates: { position: item.position },
      }));
      apiUpdateItems(updates).catch((error) => {
        console.error('Failed to update positions during clean up:', error);
      });
    }
  },

  sortByName: (parentId = null) => {
    // Sort items by name and arrange in columns (exclude trashed items)
    const itemsInParent = get().items.filter((item) => item.parentId === parentId && !item.isTrashed);
    const otherItems = get().items.filter((item) => item.parentId !== parentId || item.isTrashed);

    const sortedItems = [...itemsInParent].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

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

    // Persist the sort preference
    setFolderSortOrder(parentId, 'name');

    if (isApiConfigured) {
      cacheItems(newItems);
      const updates = updatedItems.map((item) => ({
        id: item.id,
        updates: { position: item.position },
      }));
      apiUpdateItems(updates).catch((error) => {
        console.error('Failed to update positions during sort by name:', error);
      });
    }
  },

  sortByDate: (parentId = null) => {
    // Sort items by date (newest first) and arrange in columns (exclude trashed items)
    const itemsInParent = get().items.filter((item) => item.parentId === parentId && !item.isTrashed);
    const otherItems = get().items.filter((item) => item.parentId !== parentId || item.isTrashed);

    const sortedItems = [...itemsInParent].sort((a, b) => b.updatedAt - a.updatedAt);

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

    // Persist the sort preference
    setFolderSortOrder(parentId, 'date');

    if (isApiConfigured) {
      cacheItems(newItems);
      const updates = updatedItems.map((item) => ({
        id: item.id,
        updates: { position: item.position },
      }));
      apiUpdateItems(updates).catch((error) => {
        console.error('Failed to update positions during sort by date:', error);
      });
    }
  },

  sortByKind: (parentId = null) => {
    // Sort items by type (folders first, then by type, then by name) and arrange in columns (exclude trashed items)
    const itemsInParent = get().items.filter((item) => item.parentId === parentId && !item.isTrashed);
    const otherItems = get().items.filter((item) => item.parentId !== parentId || item.isTrashed);

    // Type order: all item types in logical grouping
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

    const sortedItems = [...itemsInParent].sort((a, b) => {
      const typeComparison = (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99);
      if (typeComparison !== 0) return typeComparison;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

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

    // Persist the sort preference
    setFolderSortOrder(parentId, 'kind');

    if (isApiConfigured) {
      cacheItems(newItems);
      const updates = updatedItems.map((item) => ({
        id: item.id,
        updates: { position: item.position },
      }));
      apiUpdateItems(updates).catch((error) => {
        console.error('Failed to update positions during sort by kind:', error);
      });
    }
  },

  duplicateItems: async (itemIds, targetParentId) => {
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

      duplicates.push(duplicate);

      // Create item via API
      if (isApiConfigured) {
        try {
          await apiCreateItem(duplicate);
        } catch (error) {
          console.error('Failed to create duplicate item:', error);
        }
      }
    }

    // Add all duplicates to state
    if (duplicates.length > 0) {
      const newItems = [...items, ...duplicates];
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
        cacheItems(movedItems);
        apiUpdateItems(updates).catch((error) => {
          console.error('Failed to move items:', error);
        });
      }
    } else {
      // Copy items (create duplicates)
      await duplicateItems(itemIds, targetParentId);
    }
  },

  uploadFile: async (file, parentId, position) => {
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

      // Auto-clear completed uploads after 3 seconds
      setTimeout(() => {
        get().clearUpload(uploadId);
      }, 3000);

      return result.item;
    } catch (error) {
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
      set({
        items: response.items,
        loading: false,
      });
      // Cache the fresh items
      cacheItems(response.items);
    } catch (error) {
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
      return {
        items: newItems,
        selectedIds: new Set([...state.selectedIds].filter((id) => !allIdsToTrash.has(id))),
      };
    });

    // Play trash sound
    playSound('trash');

    // Sync to API if configured
    if (isApiConfigured) {
      const updates = idsArray.map((id) => {
        const item = items.find((i) => i.id === id);
        return {
          id,
          updates: { isTrashed: true, trashedAt: now, originalParentId: item?.parentId ?? null },
        };
      });
      apiUpdateItems(updates).catch((error) => {
        console.error('Failed to move items to trash:', error);
        showError(
          'Failed to move items to trash. Your changes may not be saved.',
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
      apiUpdateItems(updates).catch((error) => {
        console.error('Failed to restore items from trash:', error);
        showError(
          'Failed to restore items. Please try again.',
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
      emptyTrashApi().catch((error) => {
        console.error('Failed to empty trash:', error);
        showError(
          'Failed to permanently delete some items. They may reappear on reload.',
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
}));
