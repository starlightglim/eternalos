/**
 * Tiling window layouts (i3 / dwm style) with gaps. Pure geometry: the
 * desktop hook (useTiling) decides which windows tile and applies the rects.
 *
 * Settings live in the appearance's design tokens, so a layout travels
 * with the rest of the look (.estheme exports, Bazaar):
 *   layout.mode         floating | master | columns | grid
 *   layout.gap          px between windows (0-48)
 *   layout.outerGap     px around the edges (0-80)
 *   layout.masterRatio  share of the width for the master window (0.3-0.75)
 *   layout.reserveIcons keep the desktop icon column visible (default true)
 */

export type TilingMode = 'floating' | 'master' | 'columns' | 'grid';

export interface TilingSettings {
  mode: TilingMode;
  gap: number;
  outerGap: number;
  masterRatio: number;
  reserveIcons: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_TILING: TilingSettings = { mode: 'floating', gap: 10, outerGap: 14, masterRatio: 0.55, reserveIcons: true };

const MIN_W = 200;
const MIN_H = 150;

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Read (and sanitize) tiling settings from design tokens. */
export function tilingFromTokens(tokens: Record<string, unknown> | undefined): TilingSettings {
  const mode = tokens?.['layout.mode'];
  return {
    mode: mode === 'master' || mode === 'columns' || mode === 'grid' ? mode : 'floating',
    gap: Math.round(clamp(tokens?.['layout.gap'], 0, 48, DEFAULT_TILING.gap)),
    outerGap: Math.round(clamp(tokens?.['layout.outerGap'], 0, 80, DEFAULT_TILING.outerGap)),
    masterRatio: clamp(tokens?.['layout.masterRatio'], 0.3, 0.75, DEFAULT_TILING.masterRatio),
    reserveIcons: tokens?.['layout.reserveIcons'] !== false,
  };
}

/** Split `length` into `count` parts separated by `gap`, rounding so parts tile exactly. */
function split(start: number, length: number, count: number, gap: number): Array<[number, number]> {
  const usable = length - gap * (count - 1);
  const parts: Array<[number, number]> = [];
  let pos = start;
  for (let i = 0; i < count; i++) {
    const end = start + Math.round((usable * (i + 1)) / count) + gap * i;
    parts.push([pos, end - pos]);
    pos = end + gap;
  }
  return parts;
}

/**
 * Rects for `ids` (in tiling order) inside `area`. Windows never go below
 * the minimum window size: when the area is too small for a column, the
 * extra windows share the last cell (they stack, like a tabbed container).
 */
export function computeTiles(ids: string[], area: Rect, settings: TilingSettings): Record<string, Rect> {
  const out: Record<string, Rect> = {};
  if (ids.length === 0 || settings.mode === 'floating') return out;
  const gap = settings.gap;
  const inner: Rect = {
    x: area.x + settings.outerGap,
    y: area.y + settings.outerGap,
    width: Math.max(MIN_W, area.width - settings.outerGap * 2),
    height: Math.max(MIN_H, area.height - settings.outerGap * 2),
  };
  const place = (id: string, rect: Rect) => {
    out[id] = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(MIN_W, Math.round(rect.width)), height: Math.max(MIN_H, Math.round(rect.height)) };
  };

  if (ids.length === 1) {
    place(ids[0], inner);
    return out;
  }

  if (settings.mode === 'columns') {
    const fit = Math.max(1, Math.min(ids.length, Math.floor((inner.width + gap) / (MIN_W + gap))));
    const cols = split(inner.x, inner.width, fit, gap);
    ids.forEach((id, i) => {
      const [x, width] = cols[Math.min(i, fit - 1)];
      place(id, { x, y: inner.y, width, height: inner.height });
    });
    return out;
  }

  if (settings.mode === 'grid') {
    const cols = Math.ceil(Math.sqrt(ids.length));
    const rows = Math.ceil(ids.length / cols);
    const rowParts = split(inner.y, inner.height, rows, gap);
    ids.forEach((id, i) => {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? ids.length - cols * (rows - 1) : cols;
      const colParts = split(inner.x, inner.width, inRow, gap);
      const [x, width] = colParts[i % cols];
      const [y, height] = rowParts[row];
      place(id, { x, y, width, height });
    });
    return out;
  }

  // master: one big window on the left, the rest stacked on the right.
  const masterWidth = Math.round((inner.width - gap) * settings.masterRatio);
  place(ids[0], { x: inner.x, y: inner.y, width: masterWidth, height: inner.height });
  const stackX = inner.x + masterWidth + gap;
  const stackWidth = inner.x + inner.width - stackX;
  const stack = ids.slice(1);
  const fit = Math.max(1, Math.min(stack.length, Math.floor((inner.height + gap) / (MIN_H + gap))));
  const rows = split(inner.y, inner.height, fit, gap);
  stack.forEach((id, i) => {
    const [y, height] = rows[Math.min(i, fit - 1)];
    place(id, { x: stackX, y, width: stackWidth, height });
  });
  return out;
}

/** The window (by id) whose rect contains the point, ignoring `exceptId`. */
export function tileAt(tiles: Record<string, Rect>, x: number, y: number, exceptId?: string): string | null {
  for (const [id, rect] of Object.entries(tiles)) {
    if (id === exceptId) continue;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) return id;
  }
  return null;
}
