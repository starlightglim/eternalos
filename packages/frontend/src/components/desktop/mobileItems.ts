/**
 * Pure helpers for MobileBrowser: which items the list shows, and what a tap
 * on each item does.
 */

import { getTextFileContentType, type DesktopItem, type WindowState } from '../../types';

/** Items of one folder the mobile list shows: no trash, no stickers; folders first, then by name. */
export function visibleMobileItems(items: DesktopItem[], parentId: string | null): DesktopItem[] {
  return items
    .filter((item) => item.parentId === parentId && !item.isTrashed && item.type !== 'sticker')
    .sort((a, b) => {
      if (a.type === 'folder' && b.type !== 'folder') return -1;
      if (a.type !== 'folder' && b.type === 'folder') return 1;
      return a.name.localeCompare(b.name);
    });
}

export type MobileTapAction =
  | { kind: 'folder' }
  | { kind: 'link'; url: string }
  | { kind: 'window'; window: Omit<WindowState, 'zIndex'> }
  | { kind: 'unsupported'; message: string };

const WIDGET_HEIGHTS: Record<string, number> = {
  'sticky-note': 250,
  guestbook: 400,
  'music-player': 350,
  'pixel-canvas': 380,
  'link-board': 300,
};

/** What tapping `item` does on a viewport of `width` x `height`. */
export function mobileTapAction(item: DesktopItem, width: number, height: number): MobileTapAction {
  // Leave room for the header and footer chrome.
  const fullHeight = Math.max(200, height - 100);
  const full = (contentType: WindowState['contentType'], contentId = item.id, title = item.name): MobileTapAction => ({
    kind: 'window',
    window: {
      id: `mobile-${contentType}-${item.id}`,
      title,
      position: { x: 0, y: 0 },
      size: { width, height: fullHeight },
      minimized: false,
      maximized: true,
      contentType,
      contentId,
    },
  });
  const partial = (contentType: WindowState['contentType'], h: number): MobileTapAction => ({
    kind: 'window',
    window: {
      id: `mobile-${contentType}-${item.id}`,
      title: item.name,
      position: { x: 0, y: 0 },
      size: { width, height: h },
      minimized: false,
      maximized: false,
      contentType,
      contentId: item.id,
    },
  });

  switch (item.type) {
    case 'folder':
      return { kind: 'folder' };
    case 'text':
      return full(getTextFileContentType(item.name));
    case 'image':
    case 'video':
    case 'pdf':
      return full(item.type);
    case 'audio':
      return partial('audio', 200); // Shorter for the audio player
    case 'link':
      return item.url
        ? { kind: 'link', url: item.url }
        : { kind: 'unsupported', message: `"${item.name}" has no address to open.` };
    case 'widget':
      return item.widgetType
        ? partial('widget', WIDGET_HEIGHTS[item.widgetType] ?? 300)
        : { kind: 'unsupported', message: `"${item.name}" can't be opened on mobile.` };
    case 'app':
      return item.appManifest?.appId
        ? full('app', item.id, item.appManifest.name || item.name)
        : { kind: 'unsupported', message: `"${item.name}" isn't a finished app yet.` };
    case 'cartridge': {
      const gameId = item.cartridgeRef?.packId
        ?? (item.cartridgeRef?.draftId ? `draft:${item.cartridgeRef.draftId}` : null);
      return gameId
        ? full('console-player', gameId)
        : { kind: 'unsupported', message: `"${item.name}" has no game to play.` };
    }
    default:
      return { kind: 'unsupported', message: `"${item.name}" can't be opened on mobile. Open it on a computer.` };
  }
}
