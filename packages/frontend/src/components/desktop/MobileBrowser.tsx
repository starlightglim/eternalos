/**
 * MobileBrowser - Simplified list-based UI for mobile devices (<768px)
 *
 * Replaces the desktop grid with a folder-browser list view.
 * Same data, different presentation.
 */

import { useState, useCallback } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { useAuthStore } from '../../stores/authStore';
import { WindowManager } from '../window';
import { FolderIcon, TextFileIcon, ImageFileIcon, LinkIcon, AudioFileIcon, VideoFileIcon, PDFFileIcon, WidgetIcon } from '../icons/PixelIcons';
import { renderCustomIcon, CUSTOM_ICON_LIBRARY, type CustomIconId } from '../icons/customIconUtils';
import { getCustomIconUrl } from '../../services/api';
import { getTextFileContentType, type DesktopItem } from '../../types';
import styles from './MobileBrowser.module.css';

interface MobileBrowserProps {
  isVisitorMode?: boolean;
  visitorItems?: DesktopItem[];
  username?: string;
  ownerUid?: string;
}

export function MobileBrowser({ isVisitorMode = false, visitorItems, username, ownerUid }: MobileBrowserProps) {
  const { items: storeItems, getItemsByParent } = useDesktopStore();
  const { openWindow } = useWindowStore();
  const { profile, logout } = useAuthStore();

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: 'Desktop' },
  ]);

  // Use visitor items if in visitor mode, otherwise store items
  const items = isVisitorMode && visitorItems ? visitorItems : storeItems;

  // Get items in current folder
  const currentItems = isVisitorMode
    ? items.filter((item) => item.parentId === currentFolderId)
    : getItemsByParent(currentFolderId);
  const currentFolderName = breadcrumbs[breadcrumbs.length - 1]?.name || 'this folder';

  // Sort: folders first, then by name
  const sortedItems = [...currentItems].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.name.localeCompare(b.name);
  });

  // Navigate into a folder
  const navigateToFolder = useCallback((folder: DesktopItem) => {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }, []);

  // Navigate back using breadcrumbs
  const navigateToBreadcrumb = useCallback((index: number) => {
    const crumb = breadcrumbs[index];
    setCurrentFolderId(crumb.id);
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  }, [breadcrumbs]);

  // Handle item tap
  const handleItemTap = useCallback(
    (item: DesktopItem) => {
      // Calculate full-screen size for mobile viewers
      const fullWidth = window.innerWidth;
      const fullHeight = window.innerHeight - 100; // Leave room for chrome

      if (item.type === 'folder') {
        navigateToFolder(item);
      } else if (item.type === 'text') {
        // Open in appropriate viewer based on file extension
        const contentType = getTextFileContentType(item.name);
        openWindow({
          id: `mobile-text-${item.id}`,
          title: item.name,
          position: { x: 0, y: 0 },
          size: { width: fullWidth, height: fullHeight },
          minimized: false,
          maximized: true,
          contentType,
          contentId: item.id,
        });
      } else if (item.type === 'image') {
        openWindow({
          id: `mobile-image-${item.id}`,
          title: item.name,
          position: { x: 0, y: 0 },
          size: { width: fullWidth, height: fullHeight },
          minimized: false,
          maximized: true,
          contentType: 'image',
          contentId: item.id,
        });
      } else if (item.type === 'video') {
        openWindow({
          id: `mobile-video-${item.id}`,
          title: item.name,
          position: { x: 0, y: 0 },
          size: { width: fullWidth, height: fullHeight },
          minimized: false,
          maximized: true,
          contentType: 'video',
          contentId: item.id,
        });
      } else if (item.type === 'audio') {
        openWindow({
          id: `mobile-audio-${item.id}`,
          title: item.name,
          position: { x: 0, y: 0 },
          size: { width: fullWidth, height: 200 }, // Shorter for audio player
          minimized: false,
          maximized: false,
          contentType: 'audio',
          contentId: item.id,
        });
      } else if (item.type === 'pdf') {
        openWindow({
          id: `mobile-pdf-${item.id}`,
          title: item.name,
          position: { x: 0, y: 0 },
          size: { width: fullWidth, height: fullHeight },
          minimized: false,
          maximized: true,
          contentType: 'pdf',
          contentId: item.id,
        });
      } else if (item.type === 'link' && item.url) {
        window.open(item.url, '_blank', 'noopener,noreferrer');
      } else if (item.type === 'widget' && item.widgetType) {
        // Get default size based on widget type
        const widgetSizes: Record<string, { width: number; height: number }> = {
          'sticky-note': { width: fullWidth, height: 250 },
          'guestbook': { width: fullWidth, height: 400 },
          'music-player': { width: fullWidth, height: 350 },
          'pixel-canvas': { width: fullWidth, height: 380 },
          'link-board': { width: fullWidth, height: 300 },
        };
        const size = widgetSizes[item.widgetType] || { width: fullWidth, height: 300 };
        openWindow({
          id: `mobile-widget-${item.id}`,
          title: item.name,
          position: { x: 0, y: 0 },
          size,
          minimized: false,
          maximized: false,
          contentType: 'widget',
          contentId: item.id,
        });
      }
    },
    [navigateToFolder, openWindow]
  );

  // Get icon for item type
  const getItemIcon = (item: DesktopItem) => {
    // Custom icon takes precedence if set
    if (item.customIcon) {
      // Check if it's an uploaded icon (starts with "upload:") or a library icon
      if (item.customIcon.startsWith('upload:')) {
        return (
          <img
            src={getCustomIconUrl(item.customIcon)}
            alt={item.name}
            width={24}
            height={24}
            style={{ imageRendering: 'pixelated' }}
          />
        );
      } else if (CUSTOM_ICON_LIBRARY[item.customIcon as CustomIconId]) {
        return renderCustomIcon(item.customIcon, 24);
      }
    }

    switch (item.type) {
      case 'folder':
        return <FolderIcon size={24} />;
      case 'image':
        return <ImageFileIcon size={24} />;
      case 'video':
        return <VideoFileIcon size={24} />;
      case 'audio':
        return <AudioFileIcon size={24} />;
      case 'pdf':
        return <PDFFileIcon size={24} />;
      case 'link':
        return <LinkIcon size={24} />;
      case 'widget':
        return <WidgetIcon size={24} />;
      case 'text':
      default:
        return <TextFileIcon size={24} />;
    }
  };

  // Format file size
  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={`${styles.container} user-desktop`}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          {isVisitorMode ? (
            <span>@{username}'s Desktop</span>
          ) : (
            <span>EternalOS</span>
          )}
        </div>
        {!isVisitorMode && (
          <button type="button" className={styles.logoutButton} onClick={() => logout()}>
            Log Out
          </button>
        )}
      </header>

      {/* Breadcrumb navigation */}
      <nav className={styles.breadcrumbs}>
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.id ?? 'root'}>
            {index > 0 && <span className={styles.breadcrumbSep}>/</span>}
            <button
              type="button"
              className={styles.breadcrumbItem}
              onClick={() => navigateToBreadcrumb(index)}
              disabled={index === breadcrumbs.length - 1}
              aria-current={index === breadcrumbs.length - 1 ? 'page' : undefined}
              aria-label={`Open ${crumb.name}`}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {/* Item list */}
      <div className={styles.itemList}>
        {sortedItems.length === 0 ? (
          <div className={styles.emptyState} role="status" aria-live="polite">
            <strong>No items here yet</strong>
            <p>{currentFolderName} is empty</p>
          </div>
        ) : (
          sortedItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={styles.item}
              onClick={() => handleItemTap(item)}
              aria-label={`${item.type === 'folder' ? 'Open folder' : 'Open'} ${item.name}`}
            >
              <div className={styles.itemIcon}>{getItemIcon(item)}</div>
              <div className={styles.itemInfo}>
                <span className={styles.itemName}>{item.name}</span>
                {item.type !== 'folder' && (
                  <span className={styles.itemMeta}>
                    {item.type.toUpperCase()}
                    {item.fileSize && ` • ${formatSize(item.fileSize)}`}
                  </span>
                )}
              </div>
              {item.type === 'folder' && (
                <span className={styles.chevron}>›</span>
              )}
            </button>
          ))
        )}
      </div>

      {/* Footer info */}
      {!isVisitorMode && profile && (
        <footer className={styles.footer}>
          <span>@{profile.username}</span>
          <span>{sortedItems.length} items</span>
        </footer>
      )}

      {/* Window Manager for file viewers */}
      <WindowManager
        isVisitorMode={isVisitorMode}
        visitorItems={isVisitorMode ? visitorItems : undefined}
        ownerUid={isVisitorMode ? ownerUid : undefined}
      />
    </div>
  );
}
