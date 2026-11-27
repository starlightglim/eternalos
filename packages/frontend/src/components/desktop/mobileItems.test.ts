import { expect, test } from 'vitest';
import type { DesktopItem } from '../../types';
import { mobileTapAction, visibleMobileItems } from './mobileItems';

const item = (overrides: Partial<DesktopItem>): DesktopItem => ({
  id: 'i1',
  type: 'text',
  name: 'Note.txt',
  parentId: null,
  position: { x: 0, y: 0 },
  isPublic: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
} as DesktopItem);

test('the list hides trashed items and stickers, folders first', () => {
  const items = [
    item({ id: 'b', name: 'b.txt' }),
    item({ id: 'trash', name: 'gone.txt', isTrashed: true }),
    item({ id: 'sticker', type: 'sticker', name: 'Star' }),
    item({ id: 'f', type: 'folder', name: 'z folder' }),
    item({ id: 'a', name: 'a.txt' }),
    item({ id: 'child', name: 'child.txt', parentId: 'f' }),
  ];
  expect(visibleMobileItems(items, null).map((i) => i.id)).toEqual(['f', 'a', 'b']);
  expect(visibleMobileItems(items, 'f').map((i) => i.id)).toEqual(['child']);
});

test('apps open full screen as app windows', () => {
  const action = mobileTapAction(
    item({ id: 'app1', type: 'app', name: 'Todo', appManifest: { appId: 'A1', name: 'Todo App' } as DesktopItem['appManifest'] }),
    390, 800,
  );
  expect(action).toMatchObject({
    kind: 'window',
    window: { id: 'mobile-app-app1', contentType: 'app', contentId: 'app1', title: 'Todo App', maximized: true },
  });
  expect(mobileTapAction(item({ type: 'app', name: 'Broken' }), 390, 800).kind).toBe('unsupported');
});

test('cartridges open the console player with their game id', () => {
  const pack = mobileTapAction(item({ id: 'c1', type: 'cartridge', cartridgeRef: { packId: 'pk' } as DesktopItem['cartridgeRef'] }), 390, 800);
  expect(pack).toMatchObject({ kind: 'window', window: { contentType: 'console-player', contentId: 'pk' } });
  const draft = mobileTapAction(item({ id: 'c2', type: 'cartridge', cartridgeRef: { draftId: 'd1' } as DesktopItem['cartridgeRef'] }), 390, 800);
  expect(draft).toMatchObject({ kind: 'window', window: { contentId: 'draft:d1' } });
  expect(mobileTapAction(item({ type: 'cartridge' }), 390, 800).kind).toBe('unsupported');
});

test('stickers and incomplete items say they cannot be opened', () => {
  const sticker = mobileTapAction(item({ type: 'sticker', name: 'Star' }), 390, 800);
  expect(sticker).toEqual({ kind: 'unsupported', message: expect.stringContaining('mobile') });
  expect(mobileTapAction(item({ type: 'link', name: 'Empty link' }), 390, 800).kind).toBe('unsupported');
  expect(mobileTapAction(item({ type: 'widget', name: 'W' }), 390, 800).kind).toBe('unsupported');
});

test('files, links, folders and widgets keep their tap behavior', () => {
  expect(mobileTapAction(item({ type: 'folder' }), 390, 800)).toEqual({ kind: 'folder' });
  expect(mobileTapAction(item({ type: 'link', url: 'https://example.org' }), 390, 800)).toEqual({ kind: 'link', url: 'https://example.org' });
  expect(mobileTapAction(item({ id: 'm', type: 'text', name: 'Read.md' }), 390, 800)).toMatchObject({
    kind: 'window', window: { contentType: 'markdown', size: { width: 390, height: 700 }, maximized: true },
  });
  expect(mobileTapAction(item({ type: 'audio' }), 390, 800)).toMatchObject({ window: { size: { height: 200 }, maximized: false } });
  expect(mobileTapAction(item({ type: 'widget', widgetType: 'guestbook' }), 390, 800)).toMatchObject({ window: { size: { height: 400 } } });
});
