/**
 * Client-side registry of open app windows (AppViewer instances). Backs the
 * parent-mediated IPC bus between apps and lets the chat keep open app
 * windows in sync with what the assistant changes. Kept out of AppViewer so
 * importers don't pull the lazily-loaded viewer chunk.
 */

import type { AppPermissions } from '../types';

export interface AppIpcMessage {
  type: 'eternal:ipc:message';
  topic: string;
  payload: unknown;
  sender: { appId?: string; previewId?: string };
}

export interface AppDataChangedMessage {
  type: 'eternal:data:changed';
  source: 'assistant';
}

export interface ActiveAppListener {
  appId?: string;
  previewId?: string;
  onMessage: (msg: AppIpcMessage | AppDataChangedMessage) => void;
  /** Remount the iframe (new app code was installed). */
  onReload?: () => void;
  /** The app's active skin changed: re-send it to the app. */
  onSkinChanged?: () => void;
  /** Open this window's Skins panel. */
  openSkins?: () => void;
  windowId?: string;
  granted: AppPermissions;
}

// In-memory list of active app viewers for the parent-mediated IPC event bus.
export const activeAppListeners = new Set<ActiveAppListener>();

/**
 * The assistant changed an installed app's backend data (callAppApi / Code
 * Mode). Open windows of that app get an 'eternal:data:changed' message; the
 * runtime runs the app's eternal.api.onChange handlers, or reloads the app
 * document when it registered none.
 */
export function notifyAppDataChanged(appId: string): void {
  for (const listener of activeAppListeners) {
    if (listener.appId === appId && !listener.previewId) {
      listener.onMessage({ type: 'eternal:data:changed', source: 'assistant' });
    }
  }
}

/** New code was installed for an app: remount its open windows. */
export function reloadAppWindows(appId: string): void {
  for (const listener of activeAppListeners) {
    if (listener.appId === appId && !listener.previewId) listener.onReload?.();
  }
}

/** App ids that currently have an open window (installed apps only). */
export function openAppIds(): string[] {
  return [...new Set([...activeAppListeners].filter((l) => l.appId && !l.previewId).map((l) => l.appId as string))];
}

/** An app's active skin changed (panel, drop, or the assistant): restyle its open windows. */
export function notifyAppSkinChanged(appId: string): void {
  for (const listener of activeAppListeners) {
    if (listener.appId === appId && !listener.previewId) listener.onSkinChanged?.();
  }
}

/** Open the Skins panel of an app window. False when that window can't be skinned. */
export function openAppSkins(windowId: string): boolean {
  for (const listener of activeAppListeners) {
    if (listener.windowId === windowId && listener.appId && !listener.previewId && listener.openSkins) {
      listener.openSkins();
      return true;
    }
  }
  return false;
}

/** Open the Skins panel in an open window of this app. False when none is open. */
export function openAppSkinsForApp(appId: string): boolean {
  for (const listener of activeAppListeners) {
    if (listener.appId === appId && !listener.previewId && listener.openSkins) {
      listener.openSkins();
      return true;
    }
  }
  return false;
}
