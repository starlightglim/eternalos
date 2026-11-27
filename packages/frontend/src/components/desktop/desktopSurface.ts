/**
 * Pure helpers for the desktop surface (Desktop.tsx): coordinate mapping,
 * trash counting and icon DOM ids. Kept free of React/DOM globals so they
 * are unit-tested in the node vitest env.
 */
import type { DesktopItem } from '../../types';

export interface Point {
  x: number;
  y: number;
}

/** The bits of a DOMRect the mapping needs. */
export interface SurfaceRect {
  left: number;
  top: number;
}

/** Fallback for a missing pointer: a little in from the desktop's corner. */
export const DEFAULT_SURFACE_POINT: Point = { x: 100, y: 100 };

/**
 * Maps a viewport (clientX/clientY) point to desktop-relative pixels.
 * The desktop starts below the menu bar, so raw client coordinates land
 * one menu-bar height too low. A missing point falls back to
 * DEFAULT_SURFACE_POINT (desktop-relative already); a real 0 coordinate is
 * kept (`??`, not `||`). The result never goes negative.
 */
export function clientToDesktopPoint(
  client: Point | null | undefined,
  rect: SurfaceRect | null | undefined,
): Point {
  const p = desktopOffset(client, rect);
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/** Viewport point → desktop grid cell (the cell under the pointer). */
export function clientToGridCell(
  client: Point | null | undefined,
  rect: SurfaceRect | null | undefined,
  cellSize: number,
): Point {
  // Floor the raw offset: rounding first would push a pointer at 79.6px
  // into the next cell.
  const p = desktopOffset(client, rect);
  return { x: Math.floor(p.x / cellSize), y: Math.floor(p.y / cellSize) };
}

function desktopOffset(client: Point | null | undefined, rect: SurfaceRect | null | undefined): Point {
  if (!client) return { ...DEFAULT_SURFACE_POINT };
  return {
    x: Math.max(0, client.x - (rect?.left ?? 0)),
    y: Math.max(0, client.y - (rect?.top ?? 0)),
  };
}

export function countTrashed(items: readonly DesktopItem[]): number {
  let n = 0;
  for (const item of items) if (item.isTrashed) n++;
  return n;
}

/**
 * DOM id of a desktop icon (the listbox's aria-activedescendant target).
 * Injective: every character outside [A-Za-z0-9-] (including `_`) becomes
 * `_<hex>_`, so distinct item ids never share a DOM id.
 */
export function desktopIconDomId(itemId: string): string {
  return `desktop-icon-${itemId.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`)}`;
}

/**
 * The option the desktop listbox reports as active: the most recently
 * selected root icon (the one arrow keys move from), else none.
 */
export function activeDescendantId(
  selectedIds: ReadonlySet<string>,
  rootItems: readonly Pick<DesktopItem, 'id'>[],
): string | undefined {
  const selected = Array.from(selectedIds);
  for (let i = selected.length - 1; i >= 0; i--) {
    if (rootItems.some((item) => item.id === selected[i])) return desktopIconDomId(selected[i]);
  }
  return undefined;
}
