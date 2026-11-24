import type { DesktopItem } from '../types';

/**
 * Desktop icon positions are GRID CELLS (80px each in the frontend), not
 * pixels. Agent-created notes and folders used { x: 60, y: 60 } — 4,800px off-screen,
 * so new notes and folders were invisible; new apps went one row below the
 * lowest icon (soon off the bottom of the screen) or to a random middle cell. Pick the first free cell,
 * column by column from the top-left, like the desktop's own layout.
 */
const GRID_ROWS = 7;
const GRID_COLUMNS = 14;
export function nextFreeDesktopCell(items: Pick<DesktopItem, 'isTrashed' | 'parentId' | 'position'>[], parentId: string | null = null): { x: number; y: number } {
  const taken = new Set(
    items
      .filter((item) => !item.isTrashed && (item.parentId ?? null) === parentId && item.position)
      .map((item) => `${Math.round(item.position.x)},${Math.round(item.position.y)}`),
  );
  for (let x = 0; x < GRID_COLUMNS; x++) {
    for (let y = 0; y < GRID_ROWS; y++) {
      if (!taken.has(`${x},${y}`)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}
