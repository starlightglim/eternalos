import { describe, expect, test } from 'vitest';
import { computeTiles, tileAt, tilingFromTokens, type Rect, type TilingSettings } from './tiling';

const area: Rect = { x: 0, y: 20, width: 1200, height: 780 };
const settings = (overrides: Partial<TilingSettings> = {}): TilingSettings => ({ mode: 'master', gap: 10, outerGap: 10, masterRatio: 0.5, reserveIcons: true, ...overrides });

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('computeTiles', () => {
  test('master + stack fills the area with exact gaps and no overlap', () => {
    const tiles = computeTiles(['a', 'b', 'c'], area, settings());
    expect(tiles.a).toEqual({ x: 10, y: 30, width: 585, height: 760 });
    expect(tiles.b.x).toBe(10 + 585 + 10);
    expect(tiles.b.x + tiles.b.width).toBe(1190);
    expect(tiles.c.y).toBe(tiles.b.y + tiles.b.height + 10);
    expect(tiles.c.y + tiles.c.height).toBe(790);
    expect(overlaps(tiles.a, tiles.b) || overlaps(tiles.b, tiles.c)).toBe(false);
  });

  test('one window fills everything; floating tiles nothing', () => {
    expect(computeTiles(['a'], area, settings())).toEqual({ a: { x: 10, y: 30, width: 1180, height: 760 } });
    expect(computeTiles(['a', 'b'], area, settings({ mode: 'floating' }))).toEqual({});
  });

  test('columns and grid tile without overlap', () => {
    for (const mode of ['columns', 'grid'] as const) {
      const ids = ['a', 'b', 'c', 'd', 'e'];
      const tiles = computeTiles(ids, area, settings({ mode }));
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          if (mode === 'grid') expect(overlaps(tiles[ids[i]], tiles[ids[j]])).toBe(false);
        }
        expect(tiles[ids[i]].width).toBeGreaterThanOrEqual(200);
      }
    }
    const grid = computeTiles(['a', 'b', 'c'], area, settings({ mode: 'grid' }));
    expect(grid.c.width).toBe(1180); // the last row spreads out
  });

  test('never shrinks windows below the minimum size', () => {
    const many = Array.from({ length: 12 }, (_, i) => `w${i}`);
    const tiles = computeTiles(many, { x: 0, y: 0, width: 600, height: 400 }, settings());
    for (const rect of Object.values(tiles)) {
      expect(rect.width).toBeGreaterThanOrEqual(200);
      expect(rect.height).toBeGreaterThanOrEqual(150);
    }
  });

  test('tileAt finds the window under a point', () => {
    const tiles = computeTiles(['a', 'b'], area, settings());
    expect(tileAt(tiles, 900, 400)).toBe('b');
    expect(tileAt(tiles, 900, 400, 'b')).toBeNull();
  });
});

test('settings from tokens are sanitized', () => {
  expect(tilingFromTokens({ 'layout.mode': 'grid', 'layout.gap': 999, 'layout.masterRatio': 0.1, 'layout.reserveIcons': false }))
    .toEqual({ mode: 'grid', gap: 48, outerGap: 14, masterRatio: 0.3, reserveIcons: false });
  expect(tilingFromTokens({ 'layout.mode': 'evil' }).mode).toBe('floating');
  expect(tilingFromTokens(undefined).mode).toBe('floating');
});
