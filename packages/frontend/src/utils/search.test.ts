import { expect, test } from 'vitest';
import type { DesktopItem } from '../types';
import { searchItems } from './search';

function item(overrides: Partial<DesktopItem>): DesktopItem {
  return {
    id: 'x',
    name: 'Item',
    type: 'text',
    isPublic: true,
    parentId: null,
    position: { x: 0, y: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('orders equal-score, equal-timestamp results deterministically by id', () => {
  const items = [
    item({ id: 'b', name: 'report', updatedAt: 5 }),
    item({ id: 'a', name: 'report', updatedAt: 5 }),
    item({ id: 'c', name: 'report', updatedAt: 5 }),
  ];
  const forward = searchItems(items, 'report').map((r) => r.item.id);
  const reversed = searchItems([...items].reverse(), 'report').map((r) => r.item.id);
  expect(forward).toEqual(['a', 'b', 'c']);
  // Order must not depend on the input order — the id tiebreak makes it total.
  expect(reversed).toEqual(['a', 'b', 'c']);
});

test('ranks more recent items first when scores tie', () => {
  const items = [
    item({ id: 'old', name: 'report', updatedAt: 1 }),
    item({ id: 'new', name: 'report', updatedAt: 9 }),
  ];
  expect(searchItems(items, 'report').map((r) => r.item.id)).toEqual(['new', 'old']);
});

test('requires every query term to match (AND semantics)', () => {
  const items = [
    item({ id: 'both', name: 'red car' }),
    item({ id: 'one', name: 'red bike' }),
  ];
  expect(searchItems(items, 'red car').map((r) => r.item.id)).toEqual(['both']);
});

test('ranks a name match above a weaker field match', () => {
  const items = [
    item({ id: 'byName', name: 'folder notes' }),
    item({ id: 'byType', name: 'misc', type: 'folder' }),
  ];
  expect(searchItems(items, 'folder').map((r) => r.item.id)[0]).toBe('byName');
});

test('matches synonyms but ranks exact matches higher', () => {
  const items = [
    item({ id: 'exact', name: 'car' }),
    item({ id: 'synonym', name: 'vehicle' }),
  ];
  expect(searchItems(items, 'car').map((r) => r.item.id)).toEqual(['exact', 'synonym']);
});

test('excludes trashed items', () => {
  const items = [
    item({ id: 'live', name: 'report' }),
    item({ id: 'trashed', name: 'report', isTrashed: true }),
  ];
  expect(searchItems(items, 'report').map((r) => r.item.id)).toEqual(['live']);
});

test('returns nothing for an empty or whitespace query', () => {
  expect(searchItems([item({ name: 'anything' })], '   ')).toEqual([]);
});

test('respects the result limit', () => {
  const items = Array.from({ length: 30 }, (_, i) => item({ id: `i${i}`, name: 'report', updatedAt: i }));
  expect(searchItems(items, 'report', 5)).toHaveLength(5);
});
