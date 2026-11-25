/**
 * Per-window chrome from an app's skin (shaped, frameless windows). Set by
 * AppViewer when the active skin has a `window` section; read by Window.
 * Not persisted: it follows the skin every time the app loads.
 */

import { create } from 'zustand';

export interface WindowSkinChrome {
  frameless: boolean;
  /** CSS clip-path (rounded/ellipse/polygon): clicks outside fall through. */
  clipPath?: string;
  /** PNG data URL used as a CSS mask (painted shapes). */
  maskUrl?: string;
  /** The skin's window was drawn for this size: locked, not resizable. */
  size?: { w: number; h: number };
}

interface WindowSkinState {
  chrome: Record<string, WindowSkinChrome>;
  setChrome: (windowId: string, chrome: WindowSkinChrome | null) => void;
}

export const useWindowSkinStore = create<WindowSkinState>((set) => ({
  chrome: {},
  setChrome: (windowId, chrome) => set((state) => {
    const next = { ...state.chrome };
    if (chrome) next[windowId] = chrome;
    else delete next[windowId];
    return { chrome: next };
  }),
}));
