import { describe, expect, it } from 'vitest';
import type { DesktopItem } from '../../types';
import {
  activeDescendantId,
  clientToDesktopPoint,
  clientToGridCell,
  countTrashed,
  desktopIconDomId,
} from './desktopSurface';

describe('clientToDesktopPoint', () => {
  it('subtracts the desktop origin (the desktop starts below the menu bar)', () => {
    expect(clientToDesktopPoint({ x: 300, y: 220 }, { left: 0, top: 20 })).toEqual({ x: 300, y: 200 });
  });

  it('keeps a real 0 coordinate instead of falling back', () => {
    expect(clientToDesktopPoint({ x: 0, y: 20 }, { left: 0, top: 20 })).toEqual({ x: 0, y: 0 });
  });

  it('falls back only when there is no point', () => {
    expect(clientToDesktopPoint(null, { left: 0, top: 20 })).toEqual({ x: 100, y: 100 });
  });

  it('never goes negative and tolerates a missing rect', () => {
    expect(clientToDesktopPoint({ x: 5, y: 10 }, { left: 0, top: 20 })).toEqual({ x: 5, y: 0 });
    expect(clientToDesktopPoint({ x: 5, y: 10 }, null)).toEqual({ x: 5, y: 10 });
  });
});

describe('clientToGridCell', () => {
  it('maps to the cell under the pointer on the desktop', () => {
    // 95px from the top of the viewport is 75px into the desktop: row 0.
    expect(clientToGridCell({ x: 170, y: 95 }, { left: 0, top: 20 }, 80)).toEqual({ x: 2, y: 0 });
    // 79.6px into the desktop is still row 0 (no rounding before the floor).
    expect(clientToGridCell({ x: 0, y: 100 }, { left: 0, top: 20.4 }, 80)).toEqual({ x: 0, y: 0 });
  });
});

describe('countTrashed', () => {
  it('counts trashed items', () => {
    const items = [{ isTrashed: true }, { isTrashed: false }, {}, { isTrashed: true }] as DesktopItem[];
    expect(countTrashed(items)).toBe(2);
  });
});

describe('desktop icon listbox ids', () => {
  it('builds a valid DOM id from any item id', () => {
    expect(desktopIconDomId('item-1')).toBe('desktop-icon-item-1');
    expect(desktopIconDomId('a b')).toBe('desktop-icon-a_20_b');
    expect(desktopIconDomId('a_b')).not.toBe(desktopIconDomId('a.b'));
  });

  it('reports the most recently selected root icon as active', () => {
    const root = [{ id: 'a' }, { id: 'b' }];
    expect(activeDescendantId(new Set(['a', 'b']), root)).toBe('desktop-icon-b');
    expect(activeDescendantId(new Set(['a', 'nested']), root)).toBe('desktop-icon-a');
    expect(activeDescendantId(new Set(), root)).toBeUndefined();
  });
});
