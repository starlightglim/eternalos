import { create } from 'zustand';
import type { WindowState } from '../types';
import { useSoundStore } from './soundStore';
import { isApiConfigured, getAuthToken, saveWindowsToServer, type SavedWindowState } from '../services/api';

const WINDOW_STATE_KEY = 'eternalos-window-state';

// Types that require a valid desktop item to exist
const CONTENT_DEPENDENT_TYPES = ['folder', 'image', 'text', 'markdown', 'code', 'audio', 'video', 'pdf', 'get-info', 'widget'];

// Debounce helper for localStorage (fast, 300ms)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
// Debounce helper for server sync (slower, 2s to avoid excessive API calls)
let serverSyncTimeout: ReturnType<typeof setTimeout> | null = null;

// Track whether we're in visitor mode to avoid persisting visitor window changes
let isVisitorMode = false;
export function setVisitorWindowMode(visitor: boolean) {
  isVisitorMode = visitor;
}

function debouncedSave(windows: WindowState[], nextZIndex: number, immediateSync = false) {
  // Don't persist visitor window changes to localStorage or server
  if (isVisitorMode) return;

  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    try {
      const state = { windows, nextZIndex };
      localStorage.setItem(WINDOW_STATE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Failed to save window state:', e);
    }
  }, 300); // 300ms debounce

  // Sync to server — immediate for open/close, debounced for move/resize
  if (immediateSync) {
    immediateServerSync(windows);
  } else {
    debouncedServerSync(windows);
  }
}

function toSavedWindows(windows: WindowState[]): SavedWindowState[] {
  return windows.map((w) => ({
    id: w.id,
    title: w.title,
    position: w.position,
    size: w.size,
    zIndex: w.zIndex,
    minimized: w.minimized,
    maximized: w.maximized,
    collapsed: w.collapsed,
    contentType: w.contentType,
    contentId: w.contentId,
  }));
}

function immediateServerSync(windows: WindowState[]) {
  if (!isApiConfigured) return;
  if (!getAuthToken()) return;

  // Cancel any pending debounced sync to avoid double-send
  if (serverSyncTimeout) {
    clearTimeout(serverSyncTimeout);
    serverSyncTimeout = null;
  }

  saveWindowsToServer(toSavedWindows(windows)).catch((e) => {
    console.warn('Failed to sync window state to server:', e);
  });
}

function debouncedServerSync(windows: WindowState[]) {
  if (!isApiConfigured) return;
  // Don't sync visitor windows to the server — only the owner's
  if (!getAuthToken()) return;

  if (serverSyncTimeout) {
    clearTimeout(serverSyncTimeout);
  }
  serverSyncTimeout = setTimeout(() => {
    saveWindowsToServer(toSavedWindows(windows)).catch((e) => {
      console.warn('Failed to sync window state to server:', e);
    });
  }, 2000); // 2s debounce
}

interface WindowStore {
  windows: WindowState[];
  nextZIndex: number;

  // Actions
  openWindow: (window: Omit<WindowState, 'zIndex'>) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  moveWindow: (id: string, position: { x: number; y: number }) => void;
  resizeWindow: (id: string, size: { width: number; height: number }) => void;
  minimizeWindow: (id: string) => void;
  restoreWindow: (id: string) => void;
  toggleCollapse: (id: string) => void;
  toggleMaximize: (id: string) => void;
  updateWindowTitle: (id: string, title: string) => void;
  getTopWindow: () => WindowState | undefined;

  // Persistence
  loadWindowState: (validItemIds?: Set<string>, serverWindows?: SavedWindowState[]) => void;
  loadVisitorWindows: (windows: SavedWindowState[], validItemIds: Set<string>) => void;
  clearWindowState: () => void;
}

export const useWindowStore = create<WindowStore>((set, get) => ({
  windows: [],
  nextZIndex: 1,

  openWindow: (windowData) => {
    const { nextZIndex, windows } = get();
    const existingWindow = windows.find((w) => w.id === windowData.id);

    if (existingWindow) {
      // If window already exists, just focus it and uncollapse it
      get().focusWindow(windowData.id);
      if (existingWindow.collapsed) {
        get().toggleCollapse(windowData.id);
      }
      return;
    }

    const newWindow: WindowState = {
      ...windowData,
      zIndex: nextZIndex,
      collapsed: false,
    };

    const newWindows = [...windows, newWindow];
    const newNextZIndex = nextZIndex + 1;

    set({
      windows: newWindows,
      nextZIndex: newNextZIndex,
    });

    // Play window open sound
    useSoundStore.getState().playSound('windowOpen');

    // Save to localStorage + immediate server sync for live visitor updates
    debouncedSave(newWindows, newNextZIndex, true);
  },

  closeWindow: (id) => {
    // Play window close sound
    useSoundStore.getState().playSound('windowClose');

    const newWindows = get().windows.filter((w) => w.id !== id);

    set({ windows: newWindows });

    // Save to localStorage + immediate server sync for live visitor updates
    debouncedSave(newWindows, get().nextZIndex, true);
  },

  focusWindow: (id) => {
    const { windows, nextZIndex } = get();
    const windowToFocus = windows.find((w) => w.id === id);

    if (!windowToFocus) return;

    // Check if already the top window
    const maxZ = Math.max(...windows.map((w) => w.zIndex));
    if (windowToFocus.zIndex === maxZ) return;

    const newWindows = windows.map((w) =>
      w.id === id ? { ...w, zIndex: nextZIndex } : w
    );
    const newNextZIndex = nextZIndex + 1;

    set({
      windows: newWindows,
      nextZIndex: newNextZIndex,
    });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, newNextZIndex);
  },

  moveWindow: (id, position) => {
    const newWindows = get().windows.map((w) =>
      w.id === id ? { ...w, position } : w
    );

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  resizeWindow: (id, size) => {
    // Enforce minimum size constraints
    const constrainedSize = {
      width: Math.max(size.width, 200),
      height: Math.max(size.height, 150),
    };

    const newWindows = get().windows.map((w) =>
      w.id === id ? { ...w, size: constrainedSize } : w
    );

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  minimizeWindow: (id) => {
    const newWindows = get().windows.map((w) =>
      w.id === id ? { ...w, minimized: true } : w
    );

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  restoreWindow: (id) => {
    const newWindows = get().windows.map((w) =>
      w.id === id ? { ...w, minimized: false } : w
    );

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  toggleCollapse: (id) => {
    const newWindows = get().windows.map((w) =>
      w.id === id ? { ...w, collapsed: !w.collapsed } : w
    );

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  toggleMaximize: (id) => {
    const newWindows = get().windows.map((w) => {
      if (w.id !== id) return w;

      if (w.maximized) {
        // Restore to pre-maximized state
        return {
          ...w,
          maximized: false,
          position: w.preMaximizedPosition || w.position,
          size: w.preMaximizedSize || w.size,
          preMaximizedPosition: undefined,
          preMaximizedSize: undefined,
        };
      } else {
        // Maximize - fill screen below menu bar (20px)
        const menuBarHeight = 20;
        return {
          ...w,
          maximized: true,
          preMaximizedPosition: w.position,
          preMaximizedSize: w.size,
          position: { x: 0, y: menuBarHeight },
          size: {
            width: window.innerWidth,
            height: window.innerHeight - menuBarHeight,
          },
        };
      }
    });

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  updateWindowTitle: (id, title) => {
    const newWindows = get().windows.map((w) =>
      w.id === id ? { ...w, title } : w
    );

    set({ windows: newWindows });

    // Save to localStorage (debounced)
    debouncedSave(newWindows, get().nextZIndex);
  },

  getTopWindow: () => {
    const { windows } = get();
    if (windows.length === 0) return undefined;

    const visibleWindows = windows.filter((w) => !w.minimized);
    if (visibleWindows.length === 0) return undefined;

    return visibleWindows.reduce((top, w) =>
      w.zIndex > top.zIndex ? w : top
    );
  },

  loadWindowState: (validItemIds?: Set<string>, serverWindows?: SavedWindowState[]) => {
    try {
      // Try localStorage first (fast, has full WindowState with collapsed etc.)
      let windows: WindowState[] | null = null;
      let nextZIndex = 1;

      const saved = localStorage.getItem(WINDOW_STATE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as {
          windows: WindowState[];
          nextZIndex: number;
        };
        windows = parsed.windows;
        nextZIndex = parsed.nextZIndex;
      }

      // Fall back to server windows if localStorage is empty
      // (happens after logout/login, new device, cleared cache, etc.)
      if ((!windows || windows.length === 0) && serverWindows && serverWindows.length > 0) {
        windows = serverWindows.map((w, i) => ({
          id: w.id,
          title: w.title,
          position: w.position,
          size: w.size,
          zIndex: w.zIndex || (i + 1),
          minimized: w.minimized,
          maximized: w.maximized,
          collapsed: w.collapsed,
          contentType: w.contentType as WindowState['contentType'],
          contentId: w.contentId,
        }));
        nextZIndex = windows.length + 1;
      }

      if (!windows || windows.length === 0) return;

      // Filter out windows that depend on items that no longer exist
      const validWindows = windows.filter((w) => {
        // Content-dependent windows need their item to still exist
        if (CONTENT_DEPENDENT_TYPES.includes(w.contentType)) {
          if (!w.contentId) return false;
          if (validItemIds && !validItemIds.has(w.contentId)) return false;
        }
        return true;
      });

      // Adjust positions if viewport has changed
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const menuBarHeight = 20;

      const adjustedWindows = validWindows.map((w) => {
        let { position } = w;
        const size = w.size;

        // Ensure window is not off-screen
        if (position.x < 0) position = { ...position, x: 0 };
        if (position.y < menuBarHeight) position = { ...position, y: menuBarHeight };
        if (position.x + size.width > viewportWidth) {
          position = { ...position, x: Math.max(0, viewportWidth - size.width) };
        }
        if (position.y + size.height > viewportHeight) {
          position = { ...position, y: Math.max(menuBarHeight, viewportHeight - size.height) };
        }

        // If maximized, recalculate to current viewport size
        if (w.maximized) {
          return {
            ...w,
            position: { x: 0, y: menuBarHeight },
            size: {
              width: viewportWidth,
              height: viewportHeight - menuBarHeight,
            },
          };
        }

        return { ...w, position };
      });

      set({
        windows: adjustedWindows,
        nextZIndex: Math.max(nextZIndex, adjustedWindows.length + 1),
      });
    } catch (e) {
      console.warn('Failed to load window state:', e);
      // Clear corrupted state
      localStorage.removeItem(WINDOW_STATE_KEY);
    }
  },

  loadVisitorWindows: (serverWindows: SavedWindowState[], validItemIds: Set<string>) => {
    try {
      if (!serverWindows || serverWindows.length === 0) return;

      // Filter windows that reference valid public items
      const validWindows = serverWindows.filter((w) => {
        if (CONTENT_DEPENDENT_TYPES.includes(w.contentType)) {
          if (!w.contentId) return false;
          if (!validItemIds.has(w.contentId)) return false;
        }
        return true;
      });

      if (validWindows.length === 0) return;

      // Map server windows to WindowState, adding visitor- prefix to IDs
      // so they match the visitor double-click behavior
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const menuBarHeight = 20;

      const windowStates: WindowState[] = validWindows.map((w, i) => {
        // Build the visitor-style ID based on contentType
        const visitorId = w.contentId
          ? `visitor-${w.contentType}-${w.contentId}`
          : w.id;

        let position = { ...w.position };
        const size = { ...w.size };

        // Ensure window is not off-screen
        if (position.x < 0) position = { ...position, x: 0 };
        if (position.y < menuBarHeight) position = { ...position, y: menuBarHeight };
        if (position.x + size.width > viewportWidth) {
          position = { ...position, x: Math.max(0, viewportWidth - size.width) };
        }
        if (position.y + size.height > viewportHeight) {
          position = { ...position, y: Math.max(menuBarHeight, viewportHeight - size.height) };
        }

        // If maximized, recalculate to visitor's viewport
        if (w.maximized) {
          position = { x: 0, y: menuBarHeight };
          size.width = viewportWidth;
          size.height = viewportHeight - menuBarHeight;
        }

        return {
          id: visitorId,
          title: w.title,
          position,
          size,
          zIndex: w.zIndex || (i + 1),
          minimized: w.minimized,
          maximized: w.maximized,
          collapsed: w.collapsed,
          contentType: w.contentType as WindowState['contentType'],
          contentId: w.contentId,
        };
      });

      set({
        windows: windowStates,
        nextZIndex: Math.max(1, ...windowStates.map((w) => w.zIndex)) + 1,
      });
    } catch (e) {
      console.warn('Failed to load visitor windows:', e);
    }
  },

  clearWindowState: () => {
    // Only clear in-memory state (for clean UI after logout).
    // Keep localStorage intact — it serves as a fast cache for next login.
    // The server is the source of truth; loadWindowState() falls back to
    // server windows when localStorage doesn't match.
    set({ windows: [], nextZIndex: 1 });
  },
}));

// ============================================
// Constrain windows to viewport on resize
// ============================================
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('resize', () => {
  // Debounce to avoid excessive updates during resize
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const { windows } = useWindowStore.getState();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuBarHeight = 20;
    let changed = false;

    const adjusted = windows.map((w) => {
      if (w.minimized) return w;
      let { x, y } = w.position;
      // Ensure at least 100px of window is visible horizontally
      if (x + 100 > vw) {
        x = Math.max(0, vw - 100);
        changed = true;
      }
      // Ensure title bar is reachable (below menu bar, above bottom)
      if (y + 30 > vh) {
        y = Math.max(menuBarHeight, vh - 30);
        changed = true;
      }
      if (x === w.position.x && y === w.position.y) return w;
      changed = true;
      return { ...w, position: { x, y } };
    });

    if (changed) {
      useWindowStore.setState({ windows: adjusted });
    }
  }, 200);
});
