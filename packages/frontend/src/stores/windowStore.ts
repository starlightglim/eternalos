import { create } from 'zustand';
import type { WindowState } from '../types';
import { useSoundStore } from './soundStore';
import { isApiConfigured, getAuthToken, saveWindowsToServer, type SavedWindowState } from '../services/api';
import { getMenuBarHeight } from '../utils/layout';
import { useDesktopStore } from './desktopStore';

/** Pre-per-user key: one shared cache for every account on the browser. */
const LEGACY_WINDOW_STATE_KEY = 'eternalos-window-state';
const MIN_WINDOW_WIDTH = 200;
const MIN_WINDOW_HEIGHT = 150;
/** The server keeps at most this many windows (UserDesktop.saveWindows). */
const SERVER_WINDOW_LIMIT = 20;

function currentUid(): string | null {
  try {
    return useDesktopStore.getState().uid;
  } catch {
    return null;
  }
}

/** localStorage key for the signed-in user's layout (shared key in demo mode). */
export function windowStateKey(uid: string | null | undefined = currentUid()): string {
  return uid ? `${LEGACY_WINDOW_STATE_KEY}:${uid}` : LEGACY_WINDOW_STATE_KEY;
}

// Types that require a valid desktop item to exist
const CONTENT_DEPENDENT_TYPES = ['folder', 'image', 'text', 'markdown', 'code', 'audio', 'video', 'pdf', 'get-info', 'widget'];

/**
 * MobileBrowser opens full-screen viewers with `mobile-` ids. They are sized
 * for the phone, so they never go into the saved desktop layout.
 */
export function isMobileWindow(w: Pick<WindowState, 'id'>): boolean {
  return w.id.startsWith('mobile-');
}

function migrateLegacyWindowLayout(windowState: WindowState): WindowState {
  if (windowState.contentType === 'appearance' && ((windowState.size.width === 400 && windowState.size.height === 480) || (windowState.size.width === 620 && windowState.size.height === 620))) {
    // Old defaults: the sectioned panel needs room for its sidebar.
    return { ...windowState, size: { width: 780, height: 640 } };
  }
  if (windowState.contentType === 'agent-chat' && windowState.size.width === 430 && windowState.size.height === 380) {
    return { ...windowState, size: { width: 920, height: 620 } };
  }
  if (windowState.contentType === 'preferences' && windowState.size.width === 380 && windowState.size.height === 360) {
    return { ...windowState, position: { x: 88, y: 34 }, size: { width: 520, height: 620 } };
  }
  return windowState;
}

export function clampWindowPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
): { x: number; y: number } {
  const menuBarHeight = getMenuBarHeight();
  const maxX = Math.max(0, viewportWidth - size.width);
  const maxY = Math.max(menuBarHeight, viewportHeight - size.height);

  return {
    x: Math.min(Math.max(0, position.x), maxX),
    y: Math.min(Math.max(menuBarHeight, position.y), maxY),
  };
}

/**
 * Fit a window into a (possibly smaller) viewport: shrink it to the space
 * below the menu bar (never under the minimum size) and pull it back on
 * screen. Maximized windows track the viewport. Returns the same object when
 * nothing changes.
 */
export function fitWindowToViewport(w: WindowState, viewportWidth: number, viewportHeight: number): WindowState {
  if (w.minimized) return w;
  const menuBarHeight = getMenuBarHeight();
  const availableHeight = Math.max(0, viewportHeight - menuBarHeight);
  if (w.maximized) {
    if (w.position.x === 0 && w.position.y === menuBarHeight && w.size.width === viewportWidth && w.size.height === availableHeight) return w;
    return { ...w, position: { x: 0, y: menuBarHeight }, size: { width: viewportWidth, height: availableHeight } };
  }
  const size = {
    width: Math.max(MIN_WINDOW_WIDTH, Math.min(w.size.width, viewportWidth)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.min(w.size.height, availableHeight)),
  };
  const position = clampWindowPosition(w.position, size, viewportWidth, viewportHeight);
  if (
    size.width === w.size.width && size.height === w.size.height &&
    position.x === w.position.x && position.y === w.position.y
  ) return w;
  return { ...w, position, size };
}

// Debounce helper for localStorage (fast, 300ms)
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingLocal: { key: string; windows: WindowState[]; nextZIndex: number } | null = null;
// Debounce helper for server sync (slower, 2s to avoid excessive API calls)
let serverSyncTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingServer: WindowState[] | null = null;
/**
 * Signature of the layout the server last confirmed (we saved it, or we
 * loaded it). Stored with the local cache so a reload can tell whether the
 * server changed elsewhere since this browser last synced.
 */
let lastServerSig: string | null = null;
/**
 * Nothing is persisted until the saved layout has been restored: otherwise
 * a window opened before restoration (or on the mobile view, which never
 * restores the desktop layout) would overwrite the saved layout.
 */
let hydrated = false;
/** The user changed the layout since it was restored (see the server reconcile below). */
let editedSinceHydrate = false;

// Track whether we're in visitor mode to avoid persisting visitor window changes
let isVisitorMode = false;
export function setVisitorWindowMode(visitor: boolean) {
  isVisitorMode = visitor;
}

export interface StoredWindowState {
  windows: WindowState[];
  nextZIndex: number;
  savedAt?: number;
  /** Signature of the server layout at the time of this write (null = never synced). */
  serverSig?: string | null;
}

function writeLocal(key: string, windows: WindowState[], nextZIndex: number) {
  try {
    const state: StoredWindowState = { windows, nextZIndex, savedAt: Date.now(), serverSig: lastServerSig };
    localStorage.setItem(key, JSON.stringify(state));
  } catch (e) {
    console.warn('Failed to save window state:', e);
  }
}

/** Record a server-confirmed layout in the cached entry too. */
function markServerSynced(sig: string, key: string) {
  // A save from a previous session (logout / user switch) must not count.
  if (key !== windowStateKey()) return;
  lastServerSig = sig;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const parsed = JSON.parse(raw) as StoredWindowState;
    if (parsed && Array.isArray(parsed.windows)) {
      localStorage.setItem(key, JSON.stringify({ ...parsed, serverSig: sig }));
    }
  } catch {
    // Cache only; the next write carries the signature anyway.
  }
}

function debouncedSave(allWindows: WindowState[], nextZIndex: number, immediateSync = false) {
  // Don't persist visitor window changes, or anything before the saved
  // layout has been restored.
  if (isVisitorMode || !hydrated) return;
  editedSinceHydrate = true;
  const windows = allWindows.filter((w) => !isMobileWindow(w));

  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  pendingLocal = { key: windowStateKey(), windows, nextZIndex };
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    const pending = pendingLocal;
    pendingLocal = null;
    if (pending) writeLocal(pending.key, pending.windows, pending.nextZIndex);
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

/**
 * Stable signature of a layout as the server stores it (same field
 * normalization and cap as UserDesktop.saveWindows), so a layout we saved
 * and the copy the server hands back compare equal.
 */
export function windowLayoutSignature(windows: Array<SavedWindowState | WindowState>): string {
  return JSON.stringify(
    windows.filter((w) => !isMobileWindow(w)).slice(0, SERVER_WINDOW_LIMIT).map((w) => [
      w.id,
      String(w.title || '').slice(0, 200),
      Number(w.position?.x) || 0,
      Number(w.position?.y) || 0,
      Number(w.size?.width) || 300,
      Number(w.size?.height) || 200,
      Number(w.zIndex) || 1,
      Boolean(w.minimized),
      Boolean(w.maximized),
      Boolean(w.collapsed),
      String(w.contentType || 'folder'),
      w.contentId ? String(w.contentId) : null,
    ]),
  );
}

let sendSeq = 0;
let ackedSeq = 0;

function sendToServer(windows: WindowState[], keepalive = false) {
  const key = windowStateKey();
  const sig = windowLayoutSignature(windows);
  const seq = ++sendSeq;
  saveWindowsToServer(toSavedWindows(windows), keepalive ? { keepalive: true } : undefined)
    .then(() => {
      // Replies can arrive out of order: an older save must not overwrite
      // the record of a newer one.
      if (seq < ackedSeq) return;
      ackedSeq = seq;
      markServerSynced(sig, key);
    })
    .catch((e) => {
      console.warn('Failed to sync window state to server:', e);
    });
}

function canSyncToServer() {
  // Only the signed-in owner syncs to the server
  return isApiConfigured && !!getAuthToken();
}

function immediateServerSync(windows: WindowState[]) {
  if (!canSyncToServer()) return;

  // Cancel any pending debounced sync to avoid double-send
  if (serverSyncTimeout) {
    clearTimeout(serverSyncTimeout);
    serverSyncTimeout = null;
  }
  pendingServer = null;

  sendToServer(windows);
}

function debouncedServerSync(windows: WindowState[]) {
  if (!canSyncToServer()) return;

  if (serverSyncTimeout) {
    clearTimeout(serverSyncTimeout);
  }
  pendingServer = windows;
  serverSyncTimeout = setTimeout(() => {
    serverSyncTimeout = null;
    const pending = pendingServer;
    pendingServer = null;
    if (pending) sendToServer(pending);
  }, 2000); // 2s debounce
}

/**
 * Write any debounced save right away (the page is being hidden or
 * unloaded). The server request uses `keepalive` so it outlives the page.
 */
export function flushPendingWindowSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  if (pendingLocal) {
    writeLocal(pendingLocal.key, pendingLocal.windows, pendingLocal.nextZIndex);
    pendingLocal = null;
  }
  if (serverSyncTimeout) {
    clearTimeout(serverSyncTimeout);
    serverSyncTimeout = null;
  }
  if (pendingServer) {
    const windows = pendingServer;
    pendingServer = null;
    if (canSyncToServer()) sendToServer(windows, true);
  }
}

function cancelPendingSaves() {
  if (saveTimeout) clearTimeout(saveTimeout);
  if (serverSyncTimeout) clearTimeout(serverSyncTimeout);
  saveTimeout = null;
  serverSyncTimeout = null;
  pendingLocal = null;
  pendingServer = null;
}

function readStoredWindowState(key: string): StoredWindowState | null {
  const saved = localStorage.getItem(key);
  if (!saved) return null;
  const parsed = JSON.parse(saved);
  // Validate shape: must have windows array and numeric nextZIndex
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray(parsed.windows) &&
    typeof parsed.nextZIndex === 'number'
  ) {
    return parsed as StoredWindowState;
  }
  // Corrupted shape — discard
  console.warn('Invalid window state shape in localStorage, discarding');
  localStorage.removeItem(key);
  return null;
}

/**
 * Pick the newest layout between this browser's cache and the server.
 *
 * The server keeps no timestamps, so "newer" is judged by what this browser
 * last saw the server hold (`serverSig`):
 *   - no cache → server;
 *   - server unchanged since our last sync → cache (it has our later edits);
 *   - server changed since then (another device saved) → server.
 * An empty server list never overrides the cache: it can't be told apart
 * from "not fetched".
 */
export function chooseWindowSource(
  local: StoredWindowState | null,
  serverWindows: SavedWindowState[] | undefined,
): 'local' | 'server' | 'none' {
  const hasServer = !!serverWindows && serverWindows.length > 0;
  const hasLocal = !!local && local.windows.length > 0;
  if (!hasServer) return hasLocal ? 'local' : 'none';
  if (!local) return 'server';
  const serverSig = windowLayoutSignature(serverWindows!);
  if (serverSig === windowLayoutSignature(local.windows)) return 'local';
  // Entries written before signatures existed: keep the old local-first rule.
  if (local.serverSig === undefined) return hasLocal ? 'local' : 'server';
  return local.serverSig === serverSig ? 'local' : 'server';
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
  /** Move/resize several windows in one update (tiling layouts). */
  setWindowGeometries: (updates: Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>) => void;
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
  // Wipe in-memory state AND the localStorage cache (logout / user switch).
  resetOnLogout: () => void;
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
      position: clampWindowPosition(windowData.position, windowData.size),
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

  setWindowGeometries: (updates) => {
    const newWindows = get().windows.map((w) => {
      const next = updates[w.id];
      return next ? { ...w, position: next.position, size: { width: Math.max(next.size.width, 200), height: Math.max(next.size.height, 150) } } : w;
    });
    set({ windows: newWindows });
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
        const menuBarHeight = getMenuBarHeight();
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
      // Land any debounced write first so the cache read below is current.
      if (hydrated) flushPendingWindowSave();
      const wasHydrated = hydrated;
      hydrated = true;
      editedSinceHydrate = false;
      const key = windowStateKey();
      let local: StoredWindowState | null = null;
      try {
        local = readStoredWindowState(key);
      } catch (e) {
        console.warn('Discarding unreadable window state:', e);
        localStorage.removeItem(key);
      }
      if (key !== LEGACY_WINDOW_STATE_KEY) {
        // The shared pre-per-user cache may belong to another account: adopt
        // it only when it matches what this account's server holds.
        try {
          const legacy = local ? null : readStoredWindowState(LEGACY_WINDOW_STATE_KEY);
          if (
            legacy && serverWindows && serverWindows.length > 0 &&
            windowLayoutSignature(legacy.windows) === windowLayoutSignature(serverWindows)
          ) {
            local = legacy;
          }
        } catch {
          // Unreadable legacy cache: just drop it.
        }
        localStorage.removeItem(LEGACY_WINDOW_STATE_KEY);
      }

      let windows: WindowState[] | null = null;
      let nextZIndex = 1;
      const source = chooseWindowSource(local, serverWindows);
      const hasServer = !!serverWindows && serverWindows.length > 0;

      if (source === 'local' && local) {
        windows = local.windows;
        nextZIndex = local.nextZIndex;
        // Signature-less entry: we now know what the server holds.
        lastServerSig = local.serverSig ?? (hasServer ? windowLayoutSignature(serverWindows!) : null);
      } else if (source === 'server' && serverWindows) {
        // Server wins: empty localStorage (new device, cleared cache) or a
        // newer layout saved from another device.
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
        nextZIndex = Math.max(0, ...windows.map((w) => w.zIndex)) + 1;
        lastServerSig = windowLayoutSignature(serverWindows);
        writeLocal(key, windows, nextZIndex);
      } else {
        lastServerSig = local?.serverSig ?? null;
      }

      if (windows) windows = windows.filter((w) => !isMobileWindow(w));

      if (!windows || windows.length === 0) {
        // Nothing saved: keep (and persist) windows opened before restore.
        const current = get().windows;
        if (!wasHydrated && current.some((w) => !isMobileWindow(w))) debouncedSave(current, get().nextZIndex);
        return;
      }

      // Filter out windows that depend on items that no longer exist
      const validWindows = windows.filter((w) => {
        // Content-dependent windows need their item to still exist
        if (CONTENT_DEPENDENT_TYPES.includes(w.contentType)) {
          if (!w.contentId) return false;
          if (validItemIds && !validItemIds.has(w.contentId)) return false;
        }
        return true;
      });

      // Fit into the current viewport (it may be smaller than when saved);
      // maximized windows take the current viewport size.
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const adjustedWindows = validWindows.map((windowState) =>
        fitWindowToViewport(migrateLegacyWindowLayout(windowState), viewportWidth, viewportHeight),
      );

      set({
        windows: adjustedWindows,
        nextZIndex: Math.max(nextZIndex, adjustedWindows.length + 1, ...adjustedWindows.map((w) => w.zIndex + 1)),
      });
    } catch (e) {
      console.warn('Failed to load window state:', e);
      // Clear corrupted state
      try {
        localStorage.removeItem(windowStateKey());
      } catch {
        // Ignore
      }
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
      const menuBarHeight = getMenuBarHeight();

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
    // Keep localStorage intact — it serves as a fast cache for next login;
    // loadWindowState() reconciles it with the server on the next restore.
    cancelPendingSaves();
    hydrated = false;
    set({ windows: [], nextZIndex: 1 });
  },

  resetOnLogout: () => {
    // Cancel any pending debounced writes so they can't re-populate
    // localStorage after we clear.
    cancelPendingSaves();
    hydrated = false;
    lastServerSig = null;
    try {
      localStorage.removeItem(windowStateKey());
      localStorage.removeItem(LEGACY_WINDOW_STATE_KEY);
    } catch {
      // Ignore
    }
    set({ windows: [], nextZIndex: 1 });
  },
}));

// ============================================
// Fit windows to the viewport on resize; flush saves on pagehide
// ============================================
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

/** Fit every window into the current viewport and persist the result. */
export function fitWindowsToViewport() {
  const { windows, nextZIndex } = useWindowStore.getState();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let changed = false;

  const adjusted = windows.map((w) => {
    // Mobile viewers are laid out by MobileBrowser around its own chrome.
    if (isMobileWindow(w)) return w;
    const next = fitWindowToViewport(w, vw, vh);
    if (next !== w) changed = true;
    return next;
  });

  if (changed) {
    useWindowStore.setState({ windows: adjusted });
    debouncedSave(adjusted, nextZIndex);
  }
}

function handleViewportResize() {
  // Debounce to avoid excessive updates during resize
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    fitWindowsToViewport();
  }, 200);
}

function handlePageHide() {
  flushPendingWindowSave();
}

/** Remove the store's global listeners (tests, HMR). */
export function removeWindowStoreListeners() {
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = null;
  unsubscribeServerWindows();
  if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
  window.removeEventListener('resize', handleViewportResize);
  window.removeEventListener('pagehide', handlePageHide);
}

// The desktop restores the layout as soon as it mounts, which can be before
// the server's copy has arrived. When it arrives, reconcile again (newest
// wins), unless the user has already moved things around.
export function reconcileWithServerWindows(serverWindows: SavedWindowState[]) {
  if (isVisitorMode || !hydrated || editedSinceHydrate || serverWindows.length === 0) return;
  const key = windowStateKey();
  let local: StoredWindowState | null = null;
  try {
    local = readStoredWindowState(key);
  } catch {
    local = null;
  }
  if (chooseWindowSource(local, serverWindows) !== 'server') {
    if (lastServerSig === null) lastServerSig = windowLayoutSignature(serverWindows);
    return;
  }
  const validItemIds = new Set(useDesktopStore.getState().items.map((item) => item.id));
  useWindowStore.getState().loadWindowState(validItemIds, serverWindows);
}

const unsubscribeServerWindows = typeof useDesktopStore.subscribe === 'function'
  ? useDesktopStore.subscribe((state, prev) => {
    if (state.serverWindows !== prev.serverWindows) reconcileWithServerWindows(state.serverWindows);
  })
  : () => {};

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('resize', handleViewportResize);
  window.addEventListener('pagehide', handlePageHide);
}

if (import.meta.hot) {
  import.meta.hot.dispose(removeWindowStoreListeners);
}
