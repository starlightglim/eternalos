/**
 * MobileBrowser - Simplified list-based UI for mobile devices (<768px)
 *
 * Replaces the desktop grid with a folder-browser list view.
 * Same data, different presentation.
 */

import { useState, useCallback } from 'react';
import { openExternalUrl } from '../../utils/safeUrl';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { useAuthStore } from '../../stores/authStore';
import { WindowManager } from '../window';
import { FolderIcon, TextFileIcon, ImageFileIcon, LinkIcon, AudioFileIcon, VideoFileIcon, PDFFileIcon, WidgetIcon } from '../icons/PixelIcons';
import { renderCustomIcon, CUSTOM_ICON_LIBRARY, type CustomIconId } from '../icons/customIconUtils';
import { getCustomIconUrl } from '../../services/api';
import type { DesktopItem } from '../../types';
import { mobileTapAction, visibleMobileItems } from './mobileItems';
import styles from './MobileBrowser.module.css';

interface MobileBrowserProps {
  isVisitorMode?: boolean;
  visitorItems?: DesktopItem[];
  username?: string;
  ownerUid?: string;
  /** Overrides the desktop store's loading flag (e.g. a page that fetches its own items). */
  loading?: boolean;
  /** Message shown instead of the list when the items couldn't be loaded. */
  error?: string | null;
  onRetry?: () => void;
}

export function MobileBrowser({ isVisitorMode = false, visitorItems, username, ownerUid, loading: loadingProp, error, onRetry }: MobileBrowserProps) {
  const storeItems = useDesktopStore((s) => s.items);
  const storeLoading = useDesktopStore((s) => s.loading);
  const openWindow = useWindowStore((s) => s.openWindow);
  const profile = useAuthStore((s) => s.profile);
  const logout = useAuthStore((s) => s.logout);

  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<{ id: string | null; name: string }[]>([
    { id: null, name: 'Desktop' },
  ]);
  const [notice, setNotice] = useState<string | null>(null);

  // Use visitor items if in visitor mode, otherwise store items
  const items = isVisitorMode && visitorItems ? visitorItems : storeItems;
  const loading = loadingProp ?? (!isVisitorMode && storeLoading);

  // Items in the current folder (no trash, no stickers), folders first
  const sortedItems = visibleMobileItems(items, currentFolderId);
  const currentFolderName = breadcrumbs[breadcrumbs.length - 1]?.name || 'this folder';

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
      setNotice(null);
      const action = mobileTapAction(item, window.innerWidth, window.innerHeight);
      switch (action.kind) {
        case 'folder':
          navigateToFolder(item);
          break;
        case 'link':
          openExternalUrl(action.url);
          break;
        case 'window':
          openWindow(action.window);
          break;
        case 'unsupported':
          setNotice(action.message);
          break;
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

      {notice && (
        <div className={styles.notice} role="status" aria-live="polite">
          <span>{notice}</span>
          <button type="button" className={styles.noticeDismiss} onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {/* Item list */}
      <div className={styles.itemList}>
        {error ? (
          <div className={styles.emptyState} role="alert">
            <strong>Couldn't load this desktop</strong>
            <p>{error}</p>
            {onRetry && (
              <button type="button" className={styles.retryButton} onClick={onRetry}>
                Try Again
              </button>
            )}
          </div>
        ) : loading && sortedItems.length === 0 ? (
          <div className={styles.emptyState} role="status" aria-live="polite" aria-busy="true">
            <strong>Loading…</strong>
          </div>
        ) : sortedItems.length === 0 ? (
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
