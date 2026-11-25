/**
 * Open the Appearance hub, optionally at a section ("desktop" = Wallpaper,
 * "layout", "bar", ...). An already-open panel switches section too.
 */

import { useWindowStore } from '../stores/windowStore';

export const APPEARANCE_SECTION_KEY = 'eternalos-appearance-section';
export const APPEARANCE_SECTION_EVENT = 'eternalos:appearance-section';

export function openAppearance(section?: string): void {
  if (section) {
    try { localStorage.setItem(APPEARANCE_SECTION_KEY, section); } catch { /* per-viewer convenience */ }
    window.dispatchEvent(new CustomEvent(APPEARANCE_SECTION_EVENT, { detail: section }));
  }
  const store = useWindowStore.getState();
  if (store.windows.some((w) => w.id === 'appearance-panel')) {
    store.focusWindow('appearance-panel');
    return;
  }
  store.openWindow({
    id: 'appearance-panel',
    title: 'Appearance',
    position: { x: 72, y: 38 },
    size: { width: 780, height: 640 },
    minimized: false,
    maximized: false,
    contentType: 'appearance',
  });
}
