import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { useClipboardStore } from '../../stores/clipboardStore';
import { FolderIcon, ImageFileIcon, TextFileIcon, LinkIcon, AudioFileIcon, VideoFileIcon, PDFFileIcon } from '../icons/PixelIcons';
import { ThumbnailIcon } from '../icons/ThumbnailIcon';
import { renderCustomIcon, CUSTOM_ICON_LIBRARY, type CustomIconId } from '../icons/customIconUtils';
import { getCustomIconUrl } from '../../services/api';
import { slugify } from '../../utils/slugify';
import { getItemExtension } from '../../utils/itemSelectors';
import { getTextFileContentType, type DesktopItem } from '../../types';
import { ContextMenu, type ContextMenuItem } from '../ui';
import styles from './FolderView.module.css';

// Counter for staggering window positions
let windowOffsetCounter = 0;

// Custom events for cross-component drag communication
export const FOLDER_DRAG_START = 'folder-drag-start';
export const FOLDER_DRAG_MOVE = 'folder-drag-move';
export const FOLDER_DRAG_END = 'folder-drag-end';

export interface FolderDragEvent {
  itemId: string;
  sourceFolderId: string | null;
  clientX: number;
  clientY: number;
}

interface FolderViewProps {
  folderId: string | null;
  visitorItems?: DesktopItem[];
  isVisitorMode?: boolean;
  isDropTarget?: boolean; // True when a desktop item is being dragged over this folder window
}

/**
 * FolderView - Shows contents of a folder in a window
 * Classic Mac OS folder view with icon grid
 * Supports drag-and-drop for moving items between folders
 */
export function FolderView({ folderId, visitorItems, isVisitorMode = false, isDropTarget = false }: FolderViewProps) {
  // Subscribe to items directly so component re-renders when items change
  const storeItems = useDesktopStore((state) => state.items);
  const updateItem = useDesktopStore((state) => state.updateItem);
  const getNextAvailablePositionsInFolder = useDesktopStore((state) => state.getNextAvailablePositionsInFolder);
  const openWindow = useWindowStore((state) => state.openWindow);

  // Selection, drag, and context menu state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ position: { x: number; y: number }; targetItem: DesktopItem | null } | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const hasDragged = useRef(false);
  // Track the element and pointer ID that captured the pointer
  const capturedElementRef = useRef<HTMLElement | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);

  // Get clipboard state to show cut items as faded
  const clipboard = useClipboardStore((state) => state.clipboard);
  const cutItemIds = useMemo(() => {
    if (clipboard?.isCut) {
      return new Set(clipboard.itemIds);
    }
    return new Set<string>();
  }, [clipboard]);

  // If visitorItems is provided, filter from those; otherwise use the store
  // Always filter out trashed items
  const items = (visitorItems
    ? visitorItems.filter((item) => item.parentId === folderId)
    : storeItems.filter((item) => item.parentId === folderId)
  ).filter((item) => !item.isTrashed);

  // Resolve folder name for eos-folder attribute
  const allItems = visitorItems || storeItems;
  const folderItem = folderId ? allItems.find((i) => i.id === folderId) : undefined;
  const eosFolderName = folderItem ? slugify(folderItem.name) : undefined;

  // Build breadcrumb trail by walking up parentId chain
  const breadcrumbs = useMemo(() => {
    const trail: Array<{ id: string; name: string }> = [];
    let currentId = folderId;
    const visited = new Set<string>();
    while (currentId) {
      if (visited.has(currentId)) break; // safety against cycles
      visited.add(currentId);
      const item = allItems.find((i) => i.id === currentId);
      if (!item) break;
      trail.unshift({ id: item.id, name: item.name });
      currentId = item.parentId;
    }
    return trail;
  }, [folderId, allItems]);

  // Open a parent folder from breadcrumb click
  const handleBreadcrumbClick = useCallback(
    (targetFolderId: string) => {
      windowOffsetCounter = (windowOffsetCounter + 1) % 10;
      const offset = windowOffsetCounter * 20;
      const target = allItems.find((i) => i.id === targetFolderId);
      if (!target) return;
      openWindow({
        id: `folder-${targetFolderId}`,
        title: target.name,
        position: { x: 80 + offset, y: 40 + offset },
        size: { width: 400, height: 300 },
        minimized: false,
        maximized: false,
        contentType: 'folder',
        contentId: targetFolderId,
      });
    },
    [allItems, openWindow]
  );

  // Handle double-click to open any item — uses same window ID patterns as Desktop
  const handleItemOpen = useCallback(
    (item: DesktopItem) => {
      windowOffsetCounter = (windowOffsetCounter + 1) % 10;
      const offset = windowOffsetCounter * 20;

      // Determine content type and window ID prefix (match Desktop's patterns)
      let contentType: string = item.type;
      let idPrefix = item.type;
      let windowSize = { width: 400, height: 300 };

      switch (item.type) {
        case 'folder':
          idPrefix = 'folder';
          break;
        case 'text':
          contentType = getTextFileContentType(item.name);
          idPrefix = 'text';
          break;
        case 'image':
          idPrefix = 'image';
          windowSize = { width: 450, height: 350 };
          break;
        case 'audio':
          idPrefix = 'audio';
          windowSize = { width: 320, height: 240 };
          break;
        case 'video':
          idPrefix = 'video';
          windowSize = { width: 480, height: 360 };
          break;
        case 'pdf':
          idPrefix = 'pdf';
          windowSize = { width: 550, height: 700 };
          break;
        case 'link':
          idPrefix = 'link';
          windowSize = { width: 640, height: 480 };
          break;
        case 'widget':
          idPrefix = 'widget';
          windowSize = item.widgetType
            ? (() => { switch (item.widgetType) { case 'sticky-note': return { width: 250, height: 250 }; case 'guestbook': return { width: 350, height: 400 }; case 'pixel-canvas': return { width: 300, height: 340 }; case 'music-player': return { width: 300, height: 300 }; case 'link-board': return { width: 350, height: 300 }; default: return { width: 250, height: 250 }; } })()
            : { width: 250, height: 250 };
          break;
        case 'app':
          idPrefix = 'app';
          contentType = 'app';
          windowSize = {
            width: item.appManifest?.windowConfig?.defaultWidth || 600,
            height: item.appManifest?.windowConfig?.defaultHeight || 500,
          };
          break;
      }

      openWindow({
        id: `${idPrefix}-${item.id}`,
        title: item.name,
        position: { x: 100 + offset, y: 50 + offset },
        size: windowSize,
        minimized: false,
        maximized: false,
        contentType: contentType as 'folder' | 'image' | 'text' | 'markdown' | 'code' | 'get-info' | 'about' | 'audio' | 'video' | 'pdf' | 'link' | 'widget' | 'app',
        contentId: item.id,
      });
    },
    [openWindow]
  );

  // Handle pointer down on item (start potential drag)
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, itemId: string) => {
      if (isVisitorMode) return;

      e.stopPropagation();
      setSelectedId(itemId);
      setDraggingId(itemId);
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      hasDragged.current = false;

      // Don't dispatch FOLDER_DRAG_START here — wait until the drag threshold
      // is actually met (in handlePointerMove) to avoid accidental moves on click.

      // Capture on currentTarget (the item div) rather than target (could be child)
      const element = e.currentTarget as HTMLElement;
      element.setPointerCapture(e.pointerId);
      capturedElementRef.current = element;
      capturedPointerIdRef.current = e.pointerId;
    },
    [isVisitorMode]
  );

  // Handle pointer move during drag
  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingId || !dragStartPos.current) return;

      const dx = Math.abs(e.clientX - dragStartPos.current.x);
      const dy = Math.abs(e.clientY - dragStartPos.current.y);

      // Only consider it a drag if moved more than 5 pixels
      if (dx > 5 || dy > 5) {
        // Dispatch FOLDER_DRAG_START the first time the threshold is crossed
        if (!hasDragged.current) {
          hasDragged.current = true;
          window.dispatchEvent(
            new CustomEvent<FolderDragEvent>(FOLDER_DRAG_START, {
              detail: {
                itemId: draggingId,
                sourceFolderId: folderId,
                clientX: dragStartPos.current.x,
                clientY: dragStartPos.current.y,
              },
            })
          );
        }

        // Dispatch drag move event for Desktop to track (for cross-window drops)
        window.dispatchEvent(
          new CustomEvent<FolderDragEvent>(FOLDER_DRAG_MOVE, {
            detail: {
              itemId: draggingId,
              sourceFolderId: folderId,
              clientX: e.clientX,
              clientY: e.clientY,
            },
          })
        );
      }

      // Find if we're over a folder (drop target detection within this folder view)
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      let newDropTarget: string | null = null;

      for (const el of elements) {
        const folderEl = (el as HTMLElement).closest('[data-folder-id]');
        if (folderEl) {
          const targetFolderId = folderEl.getAttribute('data-folder-id');
          // Don't allow dropping on itself
          if (targetFolderId && targetFolderId !== draggingId) {
            newDropTarget = targetFolderId;
            break;
          }
        }
      }

      setFolderDropTargetId(newDropTarget);
    },
    [draggingId, folderId]
  );

  // Helper to release pointer capture safely
  const releasePointerCapture = useCallback(() => {
    if (capturedElementRef.current && capturedPointerIdRef.current !== null) {
      try {
        capturedElementRef.current.releasePointerCapture(capturedPointerIdRef.current);
      } catch {
        // Ignore - pointer may already be released
      }
      capturedElementRef.current = null;
      capturedPointerIdRef.current = null;
    }
  }, []);

  // Handle pointer up (end drag)
  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      // Only dispatch FOLDER_DRAG_END if an actual drag occurred (threshold met)
      // This prevents simple clicks from moving items to the desktop
      if (hasDragged.current && draggingId) {
        window.dispatchEvent(
          new CustomEvent<FolderDragEvent>(FOLDER_DRAG_END, {
            detail: {
              itemId: draggingId,
              sourceFolderId: folderId,
              clientX: e.clientX,
              clientY: e.clientY,
            },
          })
        );
      }

      // If we dropped on a folder within this folder view, handle it here
      if (draggingId && hasDragged.current && folderDropTargetId) {
        // Get the next available position in the target folder
        const positions = getNextAvailablePositionsInFolder(folderDropTargetId, 1, [draggingId]);
        // Move item to the target folder at the available position
        updateItem(draggingId, {
          parentId: folderDropTargetId,
          position: positions[0],
        });
      }

      releasePointerCapture();
      setDraggingId(null);
      setFolderDropTargetId(null);
      dragStartPos.current = null;
      hasDragged.current = false;
    },
    [draggingId, folderDropTargetId, updateItem, getNextAvailablePositionsInFolder, folderId, releasePointerCapture]
  );

  // Handle pointer cancel (when browser/OS interrupts the drag)
  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      // Only dispatch drag end if a drag was actually in progress
      if (hasDragged.current && draggingId) {
        window.dispatchEvent(
          new CustomEvent<FolderDragEvent>(FOLDER_DRAG_END, {
            detail: {
              itemId: draggingId,
              sourceFolderId: folderId,
              clientX: e.clientX,
              clientY: e.clientY,
            },
          })
        );
      }

      releasePointerCapture();
      setDraggingId(null);
      setFolderDropTargetId(null);
      dragStartPos.current = null;
      hasDragged.current = false;
    },
    [draggingId, folderId, releasePointerCapture]
  );

  const handleLostPointerCapture = useCallback(
    (e: React.PointerEvent) => {
      if (draggingId || hasDragged.current) {
        handlePointerCancel(e);
      }
    },
    [draggingId, handlePointerCancel]
  );

  // Clean up pointer capture on unmount
  useEffect(() => {
    return () => {
      releasePointerCapture();
    };
  }, [releasePointerCapture]);

  // Clear selection when clicking empty area
  const handleBackgroundClick = useCallback(() => {
    setSelectedId(null);
  }, []);

  // Right-click on empty area inside folder
  const handleFolderContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isVisitorMode) return;
      e.preventDefault();
      e.stopPropagation();
      // Only trigger when clicking the background, not an item
      if (e.target === e.currentTarget || (e.target as HTMLElement).closest(`.${styles.itemGrid}`) === e.target) {
        setContextMenu({
          position: { x: e.clientX, y: e.clientY },
          targetItem: null,
        });
      }
    },
    [isVisitorMode]
  );

  // Right-click on an item inside folder
  const handleItemContextMenu = useCallback(
    (item: DesktopItem, e: React.MouseEvent) => {
      if (isVisitorMode) return;
      e.preventDefault();
      e.stopPropagation();
      setSelectedId(item.id);
      setContextMenu({
        position: { x: e.clientX, y: e.clientY },
        targetItem: item,
      });
    },
    [isVisitorMode]
  );

  // Build context menu items
  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    const { addItem, moveToTrash, duplicateItems } = useDesktopStore.getState();

    if (contextMenu?.targetItem) {
      // Context menu for an item
      const item = contextMenu.targetItem;
      return [
        {
          id: 'open',
          label: 'Open',
          action: () => handleItemOpen(item),
        },
        {
          id: 'get-info',
          label: 'Get Info',
          shortcut: '⌘I',
          action: () => {
            openWindow({
              id: `info-${item.id}`,
              title: `${item.name} Info`,
              position: { x: 200, y: 150 },
              size: { width: 280, height: 320 },
              minimized: false,
              maximized: false,
              contentType: 'get-info',
              contentId: item.id,
            });
          },
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'rename',
          label: 'Rename...',
          action: () => {
            openWindow({
              id: `info-${item.id}`,
              title: `${item.name} Info`,
              position: { x: 200, y: 150 },
              size: { width: 280, height: 320 },
              minimized: false,
              maximized: false,
              contentType: 'get-info',
              contentId: item.id,
            });
          },
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          shortcut: '⌘D',
          action: () => {
            duplicateItems([item.id], folderId);
          },
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'toggle-public',
          label: item.isPublic ? 'Make Private' : 'Make Public',
          checked: item.isPublic,
          action: () => {
            updateItem(item.id, { isPublic: !item.isPublic });
          },
        },
        { id: 'divider-3', label: '', divider: true },
        {
          id: 'move-to-trash',
          label: 'Move to Trash',
          shortcut: '⌘⌫',
          action: () => {
            moveToTrash([item.id]);
            setSelectedId(null);
          },
        },
      ];
    } else {
      // Context menu for empty area inside folder
      const now = Date.now();
      return [
        {
          id: 'new-folder',
          label: 'New Folder',
          action: () => {
            const siblingItems = storeItems.filter((i) => i.parentId === folderId && !i.isTrashed);
            let maxY = -1;
            siblingItems.forEach((i) => {
              if (i.position.x === 0 && i.position.y > maxY) {
                maxY = i.position.y;
              }
            });
            addItem({
              id: `folder-${now}`,
              type: 'folder',
              name: 'Untitled Folder',
              parentId: folderId,
              position: { x: 0, y: maxY + 1 },
              isPublic: true,
              createdAt: now,
              updatedAt: now,
            });
          },
        },
        {
          id: 'new-text',
          label: 'New Text File',
          action: () => {
            const siblingItems = storeItems.filter((i) => i.parentId === folderId && !i.isTrashed);
            let maxY = -1;
            siblingItems.forEach((i) => {
              if (i.position.x === 0 && i.position.y > maxY) {
                maxY = i.position.y;
              }
            });
            addItem({
              id: `text-${now}`,
              type: 'text',
              name: 'Untitled.txt',
              parentId: folderId,
              position: { x: 0, y: maxY + 1 },
              isPublic: true,
              textContent: '',
              createdAt: now,
              updatedAt: now,
            });
          },
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'select-all',
          label: 'Select All',
          disabled: items.length === 0,
          action: () => {
            // Folder view currently supports single selection only
            if (items.length > 0) {
              setSelectedId(items[0].id);
            }
          },
        },
      ];
    }
  }, [contextMenu, handleItemOpen, openWindow, updateItem, folderId, storeItems, items]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Get icon for item - images with r2Key use ThumbnailIcon for preview
  const getIcon = (item: DesktopItem) => {
    // Custom icon takes precedence if set
    if (item.customIcon) {
      // Check if it's an uploaded icon (starts with "upload:") or a library icon
      if (item.customIcon.startsWith('upload:')) {
        return (
          <img
            src={getCustomIconUrl(item.customIcon)}
            alt={item.name}
            width={32}
            height={32}
            style={{ imageRendering: 'pixelated' }}
          />
        );
      } else if (CUSTOM_ICON_LIBRARY[item.customIcon as CustomIconId]) {
        return renderCustomIcon(item.customIcon, 32);
      }
    }

    switch (item.type) {
      case 'folder':
        return <FolderIcon size={32} />;
      case 'image':
        // Use thumbnail preview for images that have been uploaded
        if (item.r2Key) {
          return (
            <ThumbnailIcon
              r2Key={item.r2Key}
              thumbnailKey={item.thumbnailKey}
              alt={item.name}
              size={32}
              isSelected={selectedId === item.id}
            />
          );
        }
        return <ImageFileIcon size={32} />;
      case 'text':
        return <TextFileIcon size={32} />;
      case 'link':
        return <LinkIcon size={32} />;
      case 'audio':
        return <AudioFileIcon size={32} />;
      case 'video':
        return <VideoFileIcon size={32} />;
      case 'pdf':
        return <PDFFileIcon size={32} />;
      case 'app':
        return <TextFileIcon size={32} />;
      default:
        return <TextFileIcon size={32} />;
    }
  };

  // Breadcrumb bar (shared between empty and populated views)
  const breadcrumbBar = breadcrumbs.length > 0 ? (
    <div className={styles.breadcrumbs}>
      {breadcrumbs.map((crumb, i) => {
        const isLast = i === breadcrumbs.length - 1;
        return (
          <span key={crumb.id}>
            {i > 0 && <span className={styles.breadcrumbSep}>▸</span>}
            {isLast ? (
              <span className={styles.breadcrumbCurrent}>{crumb.name}</span>
            ) : (
              <button
                className={styles.breadcrumbLink}
                onClick={() => handleBreadcrumbClick(crumb.id)}
              >
                {crumb.name}
              </button>
            )}
          </span>
        );
      })}
    </div>
  ) : null;

  if (items.length === 0) {
    return (
      <div
        className={`${styles.emptyFolder} ${isDropTarget ? styles.windowDropTarget : ''}`}
        data-folder-window-id={folderId}
        onContextMenu={handleFolderContextMenu}
      >
        {breadcrumbBar}
        <p>This folder is empty</p>
        {contextMenu && (
          <ContextMenu
            items={getContextMenuItems()}
            position={contextMenu.position}
            onClose={closeContextMenu}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className={`${styles.folderView} folder-view ${isDropTarget ? styles.windowDropTarget : ''}`}
      data-folder-window-id={folderId}
      onClick={handleBackgroundClick}
      onContextMenu={handleFolderContextMenu}
      onPointerMove={draggingId ? handlePointerMove : undefined}
      onPointerUp={draggingId ? handlePointerUp : undefined}
      onPointerCancel={draggingId ? handlePointerCancel : undefined}
      onLostPointerCapture={draggingId ? handleLostPointerCapture : undefined}
    >
      {breadcrumbBar}
      <div className={styles.itemGrid}>
        {items.map((item) => {
          const itemExtension = getItemExtension(item);

          return (
          <div
            key={item.id}
            className={`${styles.item} ${selectedId === item.id ? styles.selected : ''} ${
              draggingId === item.id ? styles.dragging : ''
            } ${item.type === 'folder' && folderDropTargetId === item.id ? styles.dropTarget : ''} ${
              cutItemIds.has(item.id) ? styles.cut : ''
            }`}
            data-item-id={item.id}
            data-folder-id={item.type === 'folder' ? item.id : undefined}
            eos-name={slugify(item.name)}
            eos-type={item.type}
            {...(itemExtension ? { 'eos-extension': itemExtension } : {})}
            {...(eosFolderName ? { 'eos-folder': eosFolderName } : {})}
            onClick={(e) => {
              e.stopPropagation();
              setSelectedId(item.id);
            }}
            onDoubleClick={() => handleItemOpen(item)}
            onContextMenu={(e) => handleItemContextMenu(item, e)}
            onPointerDown={(e) => handlePointerDown(e, item.id)}
          >
            <div className={styles.itemIcon} eos-part="icon">{getIcon(item)}</div>
            <span className={styles.itemName} eos-part="label">{item.name}</span>
          </div>
          );
        })}
      </div>
      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems()}
          position={contextMenu.position}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
