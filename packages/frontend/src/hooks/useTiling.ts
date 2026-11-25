/**
 * Applies the tiling layout from the appearance tokens (utils/tiling.ts) to
 * the owner's open windows. Re-tiles when windows open, close, minimize or
 * collapse, when the viewport changes, and when the settings change. Leaving
 * tiling restores where windows were before it started.
 *
 * Floating exceptions (like i3's): minimized, collapsed and maximized
 * windows, and apps whose skin fixed the window size (shaped windows).
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppearanceStore } from '../stores/appearanceStore';
import { useWindowStore } from '../stores/windowStore';
import { useWindowSkinStore } from '../stores/windowSkinStore';
import { useTilingStore } from '../stores/tilingStore';
import { computeTiles, tilingFromTokens, type Rect } from '../utils/tiling';
import { getMenuBarHeight } from '../utils/layout';

const FLOATING_SNAPSHOT_KEY = 'eternalos-floating-geometry';
/** Room for the desktop icon column when layout.reserveIcons is on. */
export const ICON_COLUMN_WIDTH = 96;

type Geometry = Record<string, { position: { x: number; y: number }; size: { width: number; height: number } }>;

function readSnapshot(): Geometry {
  try {
    return JSON.parse(localStorage.getItem(FLOATING_SNAPSHOT_KEY) ?? '{}') as Geometry;
  } catch {
    return {};
  }
}

function writeSnapshot(geometry: Geometry | null): void {
  try {
    if (geometry) localStorage.setItem(FLOATING_SNAPSHOT_KEY, JSON.stringify(geometry));
    else localStorage.removeItem(FLOATING_SNAPSHOT_KEY);
  } catch {
    // Private mode: windows just stay where tiling left them.
  }
}

export function useTiling(enabled: boolean): void {
  const tokens = useAppearanceStore((state) => state.appearance.designTokens);
  const settings = useMemo(() => tilingFromTokens(tokens), [tokens]);
  const windows = useWindowStore((state) => state.windows);
  const chrome = useWindowSkinStore((state) => state.chrome);
  const dragging = useTilingStore((state) => state.dragging);
  const order = useTilingStore((state) => state.order);
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const tiling = enabled && settings.mode !== 'floating';

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Entering tiling: remember the floating layout. Leaving: put it back.
  useEffect(() => {
    if (!enabled) return;
    if (tiling) {
      if (Object.keys(readSnapshot()).length === 0) {
        const snapshot: Geometry = {};
        for (const w of useWindowStore.getState().windows) snapshot[w.id] = { position: w.position, size: w.size };
        writeSnapshot(snapshot);
      }
      return;
    }
    const snapshot = readSnapshot();
    if (Object.keys(snapshot).length > 0) {
      const store = useWindowStore.getState();
      const updates: Geometry = {};
      for (const w of store.windows) if (snapshot[w.id]) updates[w.id] = snapshot[w.id];
      store.setWindowGeometries(updates);
      writeSnapshot(null);
    }
    useTilingStore.getState().setLayout(false, [], {});
  }, [enabled, tiling]);

  useEffect(() => {
    if (!tiling || dragging) return;
    const tileable = windows.filter((w) => !w.minimized && !w.collapsed && !w.maximized && !chrome[w.id]?.size);
    const ids = tileable.map((w) => w.id);
    // Keep the existing order; new windows join at the end of the stack.
    const nextOrder = [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];

    // Window positions are relative to the desktop element (which already
    // starts below the menu bar), so tile inside its box.
    const desktop = document.querySelector('.user-desktop');
    const box = desktop?.getBoundingClientRect();
    const width = box?.width || viewport.width;
    const height = box?.height || viewport.height - getMenuBarHeight();
    const left = settings.reserveIcons ? ICON_COLUMN_WIDTH : 0;
    const area: Rect = { x: left, y: 0, width: Math.max(220, width - left), height: Math.max(170, height) };
    const tiles = computeTiles(nextOrder, area, settings);

    const updates: Geometry = {};
    for (const w of tileable) {
      const t = tiles[w.id];
      if (!t) continue;
      if (w.position.x !== t.x || w.position.y !== t.y || w.size.width !== t.width || w.size.height !== t.height) {
        updates[w.id] = { position: { x: t.x, y: t.y }, size: { width: t.width, height: t.height } };
      }
    }
    if (Object.keys(updates).length > 0) useWindowStore.getState().setWindowGeometries(updates);
    const current = useTilingStore.getState();
    if (!current.active || current.order.join('|') !== nextOrder.join('|') || JSON.stringify(current.tiles) !== JSON.stringify(tiles)) {
      current.setLayout(true, nextOrder, tiles);
    }
  }, [tiling, dragging, windows, chrome, order, settings, viewport]);
}
