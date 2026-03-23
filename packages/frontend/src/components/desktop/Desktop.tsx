import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { WindowManager } from '../window';
import { DesktopIcon, Trash } from '../icons';
import { Sticker } from './Sticker';
import { EffectsOverlay } from '../../effects/EffectsOverlay';
import { MenuBar } from '../menubar';
import { UploadProgress } from './UploadProgress';
import { CSSElementPicker } from '../viewers/CSSElementPicker';
import { LoadingOverlay, ContextMenu, LinkDialog, IconPicker, WidgetPicker, QuickStartWizard, getWidgetDefaultSize, type ContextMenuItem } from '../ui';
import { useWindowStore } from '../../stores/windowStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useAuthStore } from '../../stores/authStore';
import { useClipboardStore } from '../../stores/clipboardStore';
import { useCSSPickerStore } from '../../stores/cssPickerStore';
import { useDesktopSync } from '../../hooks/useDesktopSync';
import { isApiConfigured, getWallpaperUrl, uploadFile as apiUploadFile } from '../../services/api';
import { getTextFileContentType, type DesktopItem, type WidgetType, type WidgetConfig } from '../../types';
import {
  FOLDER_DRAG_START,
  FOLDER_DRAG_MOVE,
  FOLDER_DRAG_END,
  type FolderDragEvent,
} from '../window/FolderView';
import styles from './Desktop.module.css';

// Available wallpaper patterns
export const WALLPAPER_OPTIONS = [
  { id: 'default', name: 'Default (Platinum)' },
  { id: 'diagonal', name: 'Diagonal Lines' },
  { id: 'checkerboard', name: 'Checkerboard' },
  { id: 'denim', name: 'Denim' },
  { id: 'crosshatch', name: 'Crosshatch' },
  { id: 'dots', name: 'Polka Dots' },
  { id: 'lines', name: 'Horizontal Lines' },
  { id: 'brick', name: 'Brick' },
  { id: 'weave', name: 'Weave' },
  { id: 'navy', name: 'Navy Blue' },
  { id: 'teal', name: 'Teal' },
  { id: 'purple', name: 'Purple' },
  { id: 'forest', name: 'Forest Green' },
] as const;

export type WallpaperId = typeof WALLPAPER_OPTIONS[number]['id'];

const GRID_CELL_SIZE = 80; // 80x80 pixel grid cells

interface DesktopProps {
  isVisitorMode?: boolean;
}

/**
 * Desktop component - the main surface of EternalOS
 * Full viewport #C0C0C0 background that holds all windows and icons
 */
export function Desktop({ isVisitorMode = false }: DesktopProps) {
  // Sync desktop state with Firestore (if Firebase is enabled)
  useDesktopSync();

  const { openWindow, windows, focusWindow, loadWindowState } = useWindowStore();
  const { profile } = useAuthStore();
  const {
    items,
    selectedIds,
    selectItem,
    deselectAll,
    moveItem,
    removeItem,
    moveToTrash,
    getTrashCount,
    uploadFile,
    loading,
    cleanUp,
    selectAll,
  } = useDesktopStore();

  // Get clipboard state to show cut items as faded
  const clipboard = useClipboardStore((state) => state.clipboard);
  const cutItemIds = useMemo(() => {
    if (clipboard?.isCut) {
      return new Set(clipboard.itemIds);
    }
    return new Set<string>();
  }, [clipboard]);

  // CSS Element Picker state
  const pickerActive = useCSSPickerStore((state) => state.isActive);

  // Note: Desktop items are loaded by useDesktopSync hook (called above)
  // which fetches items + profile from the API when user is authenticated.

  // Restore window state after items are loaded
  // Tries localStorage first, falls back to server-saved windows
  const serverWindows = useDesktopStore((state) => state.serverWindows);
  const hasRestoredWindows = useRef(false);
  useEffect(() => {
    if (isVisitorMode || hasRestoredWindows.current) return;
    if (loading) return; // Wait for loading to finish

    // Build a set of valid item IDs for window restoration
    const validItemIds = new Set(items.map(item => item.id));
    loadWindowState(validItemIds, serverWindows);
    hasRestoredWindows.current = true;
  }, [loading, items, isVisitorMode, loadWindowState, serverWindows]);

  // New user onboarding
  const [quickStartDismissed, setQuickStartDismissed] = useState(false);
  const showQuickStart = !quickStartDismissed && !isVisitorMode && !loading && !!profile?.isNewUser;

  // Handle QuickStart wizard completion
  const handleQuickStartComplete = useCallback(() => {
    setQuickStartDismissed(true);

    // Update local profile state to mark as not new
    if (profile) {
      useAuthStore.setState({
        profile: { ...profile, isNewUser: false },
      });
    }

    // Open the Read Me.txt file after wizard closes
    const readMeItem = items.find(
      (item) => item.type === 'text' && item.name === 'Read Me.txt' && item.parentId === null
    );

    if (readMeItem) {
      openWindow({
        id: `text-${readMeItem.id}`,
        title: readMeItem.name,
        position: { x: 80, y: 60 },
        size: { width: 420, height: 480 },
        minimized: false,
        maximized: false,
        contentType: 'text',
        contentId: readMeItem.id,
      });
    }
  }, [items, profile, openWindow]);

  // Drag state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const dragItemStartGridPos = useRef<{ x: number; y: number } | null>(null);
  const dragPointerOffset = useRef<{ x: number; y: number } | null>(null);
  const latestDragPointer = useRef<{ x: number; y: number } | null>(null);
  const hasDragged = useRef(false);
  const rafId = useRef<number | null>(null); // For requestAnimationFrame throttling
  // Multi-select drag: store starting positions of all selected items
  const draggedItemsStartPos = useRef<Map<string, { x: number; y: number }> | null>(null);
  // Track if drag is still active (guards against stale RAF callbacks)
  const isDraggingRef = useRef(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const trashRef = useRef<HTMLDivElement>(null);
  const desktopRectRef = useRef<DOMRect | null>(null);
  const trashRectRef = useRef<DOMRect | null>(null);
  const folderHitTargetsRef = useRef<Array<{
    id: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
  }>>([]);
  const isDropTargetRef = useRef(false);
  const folderDropTargetIdRef = useRef<string | null>(null);
  const folderWindowDropTargetIdRef = useRef<string | null>(null);

  // Trash state
  const [trashSelected, setTrashSelected] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const trashedItemCount = getTrashCount();

  // File drag-drop state
  const [isFileDragOver, setIsFileDragOver] = useState(false);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    targetItem: DesktopItem | null;
  } | null>(null);

  // Link dialog state
  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [linkDialogPosition, setLinkDialogPosition] = useState<{ x: number; y: number } | null>(null);

  // Icon picker state
  const [iconPickerItem, setIconPickerItem] = useState<DesktopItem | null>(null);

  // Widget picker state
  const [showWidgetPicker, setShowWidgetPicker] = useState(false);
  const [widgetPickerPosition, setWidgetPickerPosition] = useState<{ x: number; y: number } | null>(null);

  // Folder drop target state (for drag-to-folder icons and folder windows)
  const [folderDropTargetId, setFolderDropTargetId] = useState<string | null>(null);
  const [folderWindowDropTargetId, setFolderWindowDropTargetId] = useState<string | null>(null);

  // Selection rectangle state (for marquee select)
  const [selectionRect, setSelectionRect] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const isSelectingRef = useRef(false);

  // Cross-component drag state (for items dragged from FolderView)
  const [folderDragItem, setFolderDragItem] = useState<{
    itemId: string;
    sourceFolderId: string | null;
  } | null>(null);
  const folderDragPos = useRef<{ x: number; y: number } | null>(null);
  // Track whether desktop surface is a valid drop target
  const [isDesktopDropTarget, setIsDesktopDropTarget] = useState(false);

  // Get root-level items (parentId === null), excluding trashed items
  // Performance: useMemo prevents recalculating on every render
  const rootItems = useMemo(
    () => items.filter((item) => item.parentId === null && !item.isTrashed && item.type !== 'sticker'),
    [items]
  );

  // Stickers are rendered in their own layer with pixel-based positioning
  const stickerItems = useMemo(
    () => items.filter((item) => item.parentId === null && !item.isTrashed && item.type === 'sticker'),
    [items]
  );

  // Selected sticker state
  const [selectedStickerId, setSelectedStickerId] = useState<string | null>(null);

  // Performance: Build a Set of occupied positions for O(1) lookup
  // Format: "x,y" string keys for fast membership testing
  const occupiedPositions = useMemo(() => {
    const positions = new Map<string, string>(); // "x,y" -> itemId
    for (const item of rootItems) {
      positions.set(`${item.position.x},${item.position.y}`, item.id);
    }
    return positions;
  }, [rootItems]);

  // Check if position is occupied by another item - O(1) with Set lookup
  const isPositionOccupied = useCallback(
    (x: number, y: number, excludeId?: string) => {
      const key = `${x},${y}`;
      const occupantId = occupiedPositions.get(key);
      return occupantId !== undefined && occupantId !== excludeId;
    },
    [occupiedPositions]
  );

  // Find nearest available grid position
  const findNearestAvailablePosition = useCallback(
    (targetX: number, targetY: number, excludeId?: string): { x: number; y: number } => {
      // First check if target position is available
      if (!isPositionOccupied(targetX, targetY, excludeId)) {
        return { x: targetX, y: targetY };
      }

      // Search in expanding rings for available position
      for (let ring = 1; ring < 20; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          for (let dy = -ring; dy <= ring; dy++) {
            if (Math.abs(dx) === ring || Math.abs(dy) === ring) {
              const newX = targetX + dx;
              const newY = targetY + dy;
              if (newX >= 0 && newY >= 0 && !isPositionOccupied(newX, newY, excludeId)) {
                return { x: newX, y: newY };
              }
            }
          }
        }
      }

      // Fallback to target position
      return { x: targetX, y: targetY };
    },
    [isPositionOccupied]
  );

  // Listen for drag events from FolderView (cross-component drag)
  useEffect(() => {
    if (isVisitorMode) return;

    const handleFolderDragStart = (e: Event) => {
      const event = e as CustomEvent<FolderDragEvent>;
      setFolderDragItem({
        itemId: event.detail.itemId,
        sourceFolderId: event.detail.sourceFolderId,
      });
      folderDragPos.current = { x: event.detail.clientX, y: event.detail.clientY };
    };

    const handleFolderDragMove = (e: Event) => {
      const event = e as CustomEvent<FolderDragEvent>;
      folderDragPos.current = { x: event.detail.clientX, y: event.detail.clientY };

      // Check if cursor is over the desktop surface (not over windows)
      const desktopEl = document.querySelector('[data-desktop]');
      if (desktopEl) {
        const desktopRect = desktopEl.getBoundingClientRect();
        const isOverDesktop =
          event.detail.clientX >= desktopRect.left &&
          event.detail.clientX <= desktopRect.right &&
          event.detail.clientY >= desktopRect.top &&
          event.detail.clientY <= desktopRect.bottom;

        // Check if we're over a window (which would block the desktop)
        const elements = document.elementsFromPoint(event.detail.clientX, event.detail.clientY);
        let isOverWindow = false;
        let overFolderWindowId: string | null = null;
        for (const el of elements) {
          const windowEl = (el as HTMLElement).closest('[data-window]');
          const folderWindowEl = (el as HTMLElement).closest('[data-folder-window-id]');
          if (folderWindowEl) {
            overFolderWindowId = folderWindowEl.getAttribute('data-folder-window-id');
            // Don't count being over the source folder as "over a window"
            if (overFolderWindowId !== event.detail.sourceFolderId) {
              isOverWindow = true;
            }
            break;
          } else if (windowEl) {
            isOverWindow = true;
            break;
          }
        }

        // Check if over trash
        const trashRect = document.querySelector('[data-trash]')?.getBoundingClientRect();
        let isOverTrash = false;
        if (trashRect) {
          isOverTrash =
            event.detail.clientX >= trashRect.left &&
            event.detail.clientX <= trashRect.right &&
            event.detail.clientY >= trashRect.top &&
            event.detail.clientY <= trashRect.bottom;
        }

        // Update drop target indicators
        setIsDesktopDropTarget(isOverDesktop && !isOverWindow && !isOverTrash);
        setIsDropTarget(isOverTrash);

        // Check for folder window drop targets (different from source folder)
        if (overFolderWindowId && overFolderWindowId !== event.detail.sourceFolderId) {
          setFolderWindowDropTargetId(overFolderWindowId);
        } else {
          setFolderWindowDropTargetId(null);
        }
      }
    };

    const handleFolderDragEnd = (e: Event) => {
      const event = e as CustomEvent<FolderDragEvent>;
      const { updateItem, moveToTrash: storeMovToTrash } = useDesktopStore.getState();
      const currentFolderDragItem = folderDragItem;
      const currentFolderWindowDropTargetId = folderWindowDropTargetId;

      if (currentFolderDragItem && currentFolderDragItem.itemId) {
        // Check if dropped on trash
        const trashRect = document.querySelector('[data-trash]')?.getBoundingClientRect();
        if (trashRect) {
          const isOverTrash =
            event.detail.clientX >= trashRect.left &&
            event.detail.clientX <= trashRect.right &&
            event.detail.clientY >= trashRect.top &&
            event.detail.clientY <= trashRect.bottom;
          if (isOverTrash) {
            storeMovToTrash([currentFolderDragItem.itemId]);
            setFolderDragItem(null);
            setIsDesktopDropTarget(false);
            setIsDropTarget(false);
            setFolderWindowDropTargetId(null);
            return;
          }
        }

        // Check if dropped on a different folder window
        if (currentFolderWindowDropTargetId && currentFolderWindowDropTargetId !== currentFolderDragItem.sourceFolderId) {
          const { getNextAvailablePositionsInFolder } = useDesktopStore.getState();
          const positions = getNextAvailablePositionsInFolder(
            currentFolderWindowDropTargetId,
            1,
            [currentFolderDragItem.itemId]
          );
          updateItem(currentFolderDragItem.itemId, {
            parentId: currentFolderWindowDropTargetId,
            position: positions[0],
          });
          setFolderDragItem(null);
          setIsDesktopDropTarget(false);
          setIsDropTarget(false);
          setFolderWindowDropTargetId(null);
          return;
        }

        // Check if dropped on desktop surface
        const desktopEl = document.querySelector('[data-desktop]');
        if (desktopEl) {
          const desktopRect = desktopEl.getBoundingClientRect();
          const isOverDesktop =
            event.detail.clientX >= desktopRect.left &&
            event.detail.clientX <= desktopRect.right &&
            event.detail.clientY >= desktopRect.top &&
            event.detail.clientY <= desktopRect.bottom;

          // Check if we're over a window
          const elements = document.elementsFromPoint(event.detail.clientX, event.detail.clientY);
          let isOverWindow = false;
          for (const el of elements) {
            const windowEl = (el as HTMLElement).closest('[data-window]');
            const folderWindowEl = (el as HTMLElement).closest('[data-folder-window-id]');
            // Being over the source folder counts as being over desktop for drop purposes
            if (folderWindowEl) {
              const folderId = folderWindowEl.getAttribute('data-folder-window-id');
              if (folderId !== currentFolderDragItem.sourceFolderId) {
                isOverWindow = true;
                break;
              }
            } else if (windowEl) {
              isOverWindow = true;
              break;
            }
          }

          if (isOverDesktop && !isOverWindow) {
            // Calculate grid position from drop location
            const dropX = event.detail.clientX - desktopRect.left;
            const dropY = event.detail.clientY - desktopRect.top;
            const gridX = Math.floor(dropX / GRID_CELL_SIZE);
            const gridY = Math.floor(dropY / GRID_CELL_SIZE);

            // Find nearest available position
            const finalPos = findNearestAvailablePosition(gridX, gridY);

            // Move item to desktop (parentId = null)
            updateItem(currentFolderDragItem.itemId, {
              parentId: null,
              position: finalPos,
            });
          }
        }
      }

      setFolderDragItem(null);
      setIsDesktopDropTarget(false);
      setIsDropTarget(false);
      setFolderWindowDropTargetId(null);
    };

    window.addEventListener(FOLDER_DRAG_START, handleFolderDragStart);
    window.addEventListener(FOLDER_DRAG_MOVE, handleFolderDragMove);
    window.addEventListener(FOLDER_DRAG_END, handleFolderDragEnd);

    return () => {
      window.removeEventListener(FOLDER_DRAG_START, handleFolderDragStart);
      window.removeEventListener(FOLDER_DRAG_MOVE, handleFolderDragMove);
      window.removeEventListener(FOLDER_DRAG_END, handleFolderDragEnd);
    };
  }, [isVisitorMode, folderDragItem, folderWindowDropTargetId, findNearestAvailablePosition]);

  // --- Sticker handlers ---
  const handleStickerSelect = useCallback((id: string) => {
    setSelectedStickerId(id);
    deselectAll();
    setTrashSelected(false);
  }, [deselectAll]);

  const handleStickerMove = useCallback((id: string, position: { x: number; y: number }) => {
    const { updateItem } = useDesktopStore.getState();
    updateItem(id, { position });
  }, []);

  const handleStickerResize = useCallback((id: string, size: { width: number; height: number }) => {
    const item = items.find(i => i.id === id);
    if (!item) return;
    const { updateItem } = useDesktopStore.getState();
    const currentConfig = item.stickerConfig || { width: 120, height: 120, rotation: 0, opacity: 1 };
    updateItem(id, { stickerConfig: { ...currentConfig, ...size } });
  }, [items]);

  const handleStickerContextMenu = useCallback((item: DesktopItem, e: React.MouseEvent) => {
    if (isVisitorMode) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedStickerId(item.id);
    setContextMenu({
      position: { x: e.clientX, y: e.clientY },
      targetItem: item,
    });
  }, [isVisitorMode]);

  // Click on empty desktop area - deselect all
  const handleDesktopClick = useCallback(
    (e: React.MouseEvent) => {
      // Only if clicking directly on desktop, not on an icon
      if (e.target === e.currentTarget) {
        deselectAll();
        setTrashSelected(false);
        setSelectedStickerId(null);
      }
    },
    [deselectAll]
  );

  // Icon selection
  const handleIconSelect = useCallback(
    (id: string, addToSelection: boolean) => {
      selectItem(id, addToSelection);
      setTrashSelected(false);
    },
    [selectItem]
  );

  // Icon double-click - open window
  const handleIconDoubleClick = useCallback(
    (item: DesktopItem) => {
      if (item.type === 'folder') {
        openWindow({
          id: `folder-${item.id}`,
          title: item.name,
          position: { x: 100 + Math.random() * 100, y: 100 + Math.random() * 100 },
          size: { width: 400, height: 300 },
          minimized: false,
          maximized: false,
          contentType: 'folder',
          contentId: item.id,
        });
      } else if (item.type === 'text') {
        // Determine viewer type based on file extension
        const contentType = getTextFileContentType(item.name);
        openWindow({
          id: `text-${item.id}`,
          title: item.name,
          position: { x: 150 + Math.random() * 100, y: 120 + Math.random() * 100 },
          size: { width: 400, height: 300 },
          minimized: false,
          maximized: false,
          contentType,
          contentId: item.id,
        });
      } else if (item.type === 'image') {
        openWindow({
          id: `image-${item.id}`,
          title: item.name,
          position: { x: 120 + Math.random() * 100, y: 80 + Math.random() * 100 },
          size: { width: 450, height: 350 },
          minimized: false,
          maximized: false,
          contentType: 'image',
          contentId: item.id,
        });
      } else if (item.type === 'audio') {
        openWindow({
          id: `audio-${item.id}`,
          title: item.name,
          position: { x: 140 + Math.random() * 100, y: 100 + Math.random() * 100 },
          size: { width: 320, height: 240 },
          minimized: false,
          maximized: false,
          contentType: 'audio',
          contentId: item.id,
        });
      } else if (item.type === 'video') {
        openWindow({
          id: `video-${item.id}`,
          title: item.name,
          position: { x: 100 + Math.random() * 100, y: 80 + Math.random() * 100 },
          size: { width: 480, height: 360 },
          minimized: false,
          maximized: false,
          contentType: 'video',
          contentId: item.id,
        });
      } else if (item.type === 'pdf') {
        openWindow({
          id: `pdf-${item.id}`,
          title: item.name,
          position: { x: 80 + Math.random() * 100, y: 40 + Math.random() * 80 },
          size: { width: 550, height: 700 },
          minimized: false,
          maximized: false,
          contentType: 'pdf',
          contentId: item.id,
        });
      } else if (item.type === 'link') {
        openWindow({
          id: `link-${item.id}`,
          title: item.name,
          position: { x: 80 + Math.random() * 100, y: 60 + Math.random() * 80 },
          size: { width: 640, height: 480 },
          minimized: false,
          maximized: false,
          contentType: 'link',
          contentId: item.id,
        });
      } else if (item.type === 'widget') {
        const defaultSize = item.widgetType ? getWidgetDefaultSize(item.widgetType) : { width: 250, height: 250 };
        openWindow({
          id: `widget-${item.id}`,
          title: item.name,
          position: { x: 100 + Math.random() * 100, y: 80 + Math.random() * 80 },
          size: defaultSize,
          minimized: false,
          maximized: false,
          contentType: 'widget',
          contentId: item.id,
        });
      }
    },
    [openWindow]
  );

  const updateTrashDropTarget = useCallback((nextValue: boolean) => {
    if (isDropTargetRef.current !== nextValue) {
      isDropTargetRef.current = nextValue;
      setIsDropTarget(nextValue);
    }
  }, []);

  const updateFolderDropTarget = useCallback((nextValue: string | null) => {
    if (folderDropTargetIdRef.current !== nextValue) {
      folderDropTargetIdRef.current = nextValue;
      setFolderDropTargetId(nextValue);
    }
  }, []);

  const updateFolderWindowDropTarget = useCallback((nextValue: string | null) => {
    if (folderWindowDropTargetIdRef.current !== nextValue) {
      folderWindowDropTargetIdRef.current = nextValue;
      setFolderWindowDropTargetId(nextValue);
    }
  }, []);

  // Drag start
  const handleDragStart = useCallback(
    (id: string, e: React.PointerEvent) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;

      setDraggingId(id);
      isDraggingRef.current = true;
      hasDragged.current = false;
      dragStartPos.current = { x: e.clientX, y: e.clientY };
      dragItemStartGridPos.current = { x: item.position.x, y: item.position.y };

      // Store starting positions of all selected items for multi-select drag
      const selectedArray = Array.from(selectedIds);
      if (selectedArray.length > 1 && selectedArray.includes(id)) {
        // Multi-select drag: store all selected items' positions
        const posMap = new Map<string, { x: number; y: number }>();
        selectedArray.forEach((itemId) => {
          const selectedItem = items.find((i) => i.id === itemId);
          if (selectedItem) {
            posMap.set(itemId, { x: selectedItem.position.x, y: selectedItem.position.y });
          }
        });
        draggedItemsStartPos.current = posMap;
      } else {
        draggedItemsStartPos.current = null;
      }

      desktopRectRef.current = desktopRef.current?.getBoundingClientRect() ?? null;
      trashRectRef.current = trashRef.current?.getBoundingClientRect() ?? null;
      latestDragPointer.current = { x: e.clientX, y: e.clientY };

      if (desktopRectRef.current) {
        dragPointerOffset.current = {
          x: e.clientX - (desktopRectRef.current.left + item.position.x * GRID_CELL_SIZE),
          y: e.clientY - (desktopRectRef.current.top + item.position.y * GRID_CELL_SIZE),
        };

        const draggedIds = draggedItemsStartPos.current
          ? new Set(draggedItemsStartPos.current.keys())
          : new Set([id]);

        folderHitTargetsRef.current = rootItems
          .filter((candidate) => candidate.type === 'folder' && !draggedIds.has(candidate.id))
          .map((candidate) => {
            const left = desktopRectRef.current!.left + candidate.position.x * GRID_CELL_SIZE;
            const top = desktopRectRef.current!.top + candidate.position.y * GRID_CELL_SIZE;
            return {
              id: candidate.id,
              left,
              top,
              right: left + GRID_CELL_SIZE,
              bottom: top + GRID_CELL_SIZE,
            };
          });
      } else {
        dragPointerOffset.current = null;
        folderHitTargetsRef.current = [];
      }
    },
    [items, rootItems, selectedIds]
  );

  // Drag move - throttled with requestAnimationFrame for smooth performance
  const handleDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingId || !dragStartPos.current || !dragItemStartGridPos.current) return;

      latestDragPointer.current = { x: e.clientX, y: e.clientY };

      if (rafId.current !== null) {
        return;
      }

      // Schedule state update for next frame
      rafId.current = requestAnimationFrame(() => {
        // Guard against stale callbacks - check if we're still dragging the same item
        if (!isDraggingRef.current || !dragStartPos.current || !dragItemStartGridPos.current) {
          rafId.current = null;
          return;
        }

        const pointer = latestDragPointer.current;
        if (!pointer) {
          rafId.current = null;
          return;
        }

        const { x: clientX, y: clientY } = pointer;

        const deltaX = clientX - dragStartPos.current!.x;
        const deltaY = clientY - dragStartPos.current!.y;

        // Check if we've actually dragged (threshold of 5px)
        if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
          hasDragged.current = true;
        }

        // Check if over trash
        const trashRect = trashRectRef.current;
        if (trashRect) {
          const isOverTrash =
            clientX >= trashRect.left &&
            clientX <= trashRect.right &&
            clientY >= trashRect.top &&
            clientY <= trashRect.bottom;
          updateTrashDropTarget(isOverTrash);
        } else {
          updateTrashDropTarget(false);
        }

        // Check if over a folder icon (for drag-to-folder)
        let foundFolderTarget: string | null = null;
        for (const target of folderHitTargetsRef.current) {
          if (
            clientX >= target.left &&
            clientX <= target.right &&
            clientY >= target.top &&
            clientY <= target.bottom
          ) {
            foundFolderTarget = target.id;
            break;
          }
        }
        updateFolderDropTarget(foundFolderTarget);

        // Check if over an open folder window (for drag-into-window)
        let foundFolderWindowTarget: string | null = null;
        const elements = document.elementsFromPoint(clientX, clientY);
        for (const el of elements) {
          const folderWindowEl = (el as HTMLElement).closest('[data-folder-window-id]');
          if (folderWindowEl) {
            const windowFolderId = folderWindowEl.getAttribute('data-folder-window-id');
            // Don't allow dropping an item into itself or items that are part of the multi-select
            if (windowFolderId && windowFolderId !== draggingId) {
              // Also verify this isn't a folder we're dragging (prevent dropping folder into itself)
              const draggedIds = draggedItemsStartPos.current
                ? Array.from(draggedItemsStartPos.current.keys())
                : [draggingId];
              if (!draggedIds.includes(windowFolderId)) {
                foundFolderWindowTarget = windowFolderId;
                break;
              }
            }
          }
        }
        updateFolderWindowDropTarget(foundFolderWindowTarget);

        rafId.current = null;
      });
    },
    [draggingId, updateFolderDropTarget, updateFolderWindowDropTarget, updateTrashDropTarget]
  );

  // Helper to reset all drag state
  const resetDragState = useCallback(() => {
    // Cancel any pending animation frame
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    isDraggingRef.current = false;
    setDraggingId(null);
    updateTrashDropTarget(false);
    updateFolderDropTarget(null);
    updateFolderWindowDropTarget(null);
    dragStartPos.current = null;
    dragItemStartGridPos.current = null;
    dragPointerOffset.current = null;
    latestDragPointer.current = null;
    draggedItemsStartPos.current = null;
    desktopRectRef.current = null;
    trashRectRef.current = null;
    folderHitTargetsRef.current = [];
    hasDragged.current = false;
  }, [updateFolderDropTarget, updateFolderWindowDropTarget, updateTrashDropTarget]);

  // Drag end
  const handleDragEnd = useCallback(
    (e: React.PointerEvent) => {
      // Cancel any pending animation frame
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }

      if (!draggingId || !dragItemStartGridPos.current) {
        resetDragState();
        return;
      }

      // Determine which items are being dragged (multi-select or single)
      const isDraggingMultiple = draggedItemsStartPos.current && draggedItemsStartPos.current.size > 1;
      const draggedItemIds = isDraggingMultiple
        ? Array.from(draggedItemsStartPos.current!.keys())
        : [draggingId];

      // Check if dropped on trash
      const trashRect = document.querySelector('[data-trash]')?.getBoundingClientRect();
      if (trashRect) {
        const isOverTrash =
          e.clientX >= trashRect.left &&
          e.clientX <= trashRect.right &&
          e.clientY >= trashRect.top &&
          e.clientY <= trashRect.bottom;

        if (isOverTrash && hasDragged.current) {
          // Move all dragged items to trash
          moveToTrash(draggedItemIds);
          resetDragState();
          return;
        }
      }

      const currentFolderDropTargetId = folderDropTargetIdRef.current;
      const currentFolderWindowDropTargetId = folderWindowDropTargetIdRef.current;

      // Check if dropped on a folder icon (move into folder)
      if (currentFolderDropTargetId && hasDragged.current) {
        const { updateItem, getNextAvailablePositionsInFolder } = useDesktopStore.getState();
        // Get available positions in the target folder, excluding the items being moved
        const positions = getNextAvailablePositionsInFolder(currentFolderDropTargetId, draggedItemIds.length, draggedItemIds);
        // Move all dragged items into the folder at available positions
        draggedItemIds.forEach((id, index) => {
          updateItem(id, { parentId: currentFolderDropTargetId, position: positions[index] });
        });
        resetDragState();
        return;
      }

      // Check if dropped on an open folder window (move into folder)
      if (currentFolderWindowDropTargetId && hasDragged.current) {
        const { updateItem, getNextAvailablePositionsInFolder } = useDesktopStore.getState();
        // Get available positions in the target folder, excluding the items being moved
        const positions = getNextAvailablePositionsInFolder(currentFolderWindowDropTargetId, draggedItemIds.length, draggedItemIds);
        // Move all dragged items into the folder at available positions
        draggedItemIds.forEach((id, index) => {
          updateItem(id, { parentId: currentFolderWindowDropTargetId, position: positions[index] });
        });
        resetDragState();
        return;
      }

      // Calculate new grid positions if we actually dragged
      if (hasDragged.current && dragStartPos.current && dragItemStartGridPos.current) {
        // Calculate delta in grid units
        const deltaGridX = Math.round((e.clientX - dragStartPos.current.x) / GRID_CELL_SIZE);
        const deltaGridY = Math.round((e.clientY - dragStartPos.current.y) / GRID_CELL_SIZE);

        if (isDraggingMultiple) {
          // Move all selected items by the same delta, checking for overlaps
          const draggedSet = new Set(draggedItemIds);
          const newlyAssigned = new Set<string>();

          // Helper: check if position is occupied by a non-dragged item OR already assigned
          const isOccupiedForBatch = (x: number, y: number) => {
            const key = `${x},${y}`;
            if (newlyAssigned.has(key)) return true;
            const occupantId = occupiedPositions.get(key);
            return occupantId !== undefined && !draggedSet.has(occupantId);
          };

          // Helper: find nearest available position for batch move
          const findAvailableForBatch = (targetX: number, targetY: number) => {
            if (!isOccupiedForBatch(targetX, targetY)) return { x: targetX, y: targetY };
            for (let ring = 1; ring < 20; ring++) {
              for (let dx = -ring; dx <= ring; dx++) {
                for (let dy = -ring; dy <= ring; dy++) {
                  if (Math.abs(dx) === ring || Math.abs(dy) === ring) {
                    const nx = targetX + dx;
                    const ny = targetY + dy;
                    if (nx >= 0 && ny >= 0 && !isOccupiedForBatch(nx, ny)) {
                      return { x: nx, y: ny };
                    }
                  }
                }
              }
            }
            return { x: targetX, y: targetY };
          };

          draggedItemIds.forEach((id) => {
            const startPos = draggedItemsStartPos.current!.get(id);
            if (startPos) {
              const targetX = Math.max(0, startPos.x + deltaGridX);
              const targetY = Math.max(0, startPos.y + deltaGridY);
              const finalPos = findAvailableForBatch(targetX, targetY);
              newlyAssigned.add(`${finalPos.x},${finalPos.y}`);
              moveItem(id, finalPos);
            }
          });
        } else {
          // Single item drag - use existing logic
          const desktopRect = desktopRectRef.current ?? desktopRef.current?.getBoundingClientRect();
          const pointerOffset = dragPointerOffset.current;
          if (!desktopRect || !pointerOffset) {
            resetDragState();
            return;
          }

          let newGridX = Math.round((e.clientX - desktopRect.left - pointerOffset.x) / GRID_CELL_SIZE);
          let newGridY = Math.round((e.clientY - desktopRect.top - pointerOffset.y) / GRID_CELL_SIZE);
          newGridX = Math.max(0, newGridX);
          newGridY = Math.max(0, newGridY);
          const finalPos = findNearestAvailablePosition(newGridX, newGridY, draggingId);
          moveItem(draggingId, finalPos);
        }
      }

      resetDragState();
    },
    [draggingId, moveItem, moveToTrash, findNearestAvailablePosition, occupiedPositions, resetDragState]
  );

  // Safety: Clean up stale drag state if component becomes unfocused during drag
  // This handles edge cases where pointerup is never received
  useEffect(() => {
    const handleWindowBlur = () => {
      if (isDraggingRef.current) {
        resetDragState();
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden && isDraggingRef.current) {
        resetDragState();
      }
    };

    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      // Clean up any pending RAF on unmount
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [resetDragState]);

  // Trash handlers
  const handleTrashSelect = useCallback(() => {
    deselectAll();
    setTrashSelected(true);
  }, [deselectAll]);

  const handleTrashDoubleClick = useCallback(() => {
    // Open trash window (shows trashed items with restore options)
    openWindow({
      id: 'trash-window',
      title: 'Trash',
      position: { x: 200, y: 150 },
      size: { width: 350, height: 300 },
      minimized: false,
      maximized: false,
      contentType: 'trash',
    });
  }, [openWindow]);

  const handleTrashDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDropTarget(true);
  }, []);

  const handleTrashDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDropTarget(false);
    // Handle HTML5 drag drop if needed
  }, []);

  // Track selection rectangle pointer capture
  const selectionPointerIdRef = useRef<number | null>(null);
  const selectionCaptureElementRef = useRef<HTMLElement | null>(null);

  // Selection rectangle handlers (marquee select)
  const handleSelectionStart = useCallback(
    (e: React.PointerEvent) => {
      // Only start selection if clicking directly on desktop (not on icons)
      if (e.target !== e.currentTarget) return;
      if (e.button !== 0) return; // Only left click
      if (isVisitorMode) return;

      const desktopRect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - desktopRect.left;
      const y = e.clientY - desktopRect.top;

      isSelectingRef.current = true;
      setSelectionRect({ startX: x, startY: y, currentX: x, currentY: y });

      // Deselect all unless shift is held
      if (!e.shiftKey) {
        deselectAll();
      }

      // Capture pointer for smooth selection outside bounds
      const element = e.currentTarget as HTMLElement;
      element.setPointerCapture(e.pointerId);
      selectionPointerIdRef.current = e.pointerId;
      selectionCaptureElementRef.current = element;
    },
    [isVisitorMode, deselectAll]
  );

  const handleSelectionMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isSelectingRef.current || !selectionRect) return;

      const desktopRect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - desktopRect.left;
      const y = e.clientY - desktopRect.top;

      setSelectionRect((prev) =>
        prev ? { ...prev, currentX: x, currentY: y } : null
      );
    },
    [selectionRect]
  );

  const handleSelectionEnd = useCallback(
    (e: React.PointerEvent) => {
      if (!isSelectingRef.current || !selectionRect) {
        isSelectingRef.current = false;
        setSelectionRect(null);
        return;
      }

      // Calculate selection bounds
      const left = Math.min(selectionRect.startX, selectionRect.currentX);
      const right = Math.max(selectionRect.startX, selectionRect.currentX);
      const top = Math.min(selectionRect.startY, selectionRect.currentY);
      const bottom = Math.max(selectionRect.startY, selectionRect.currentY);

      // Only select if we've dragged a meaningful distance
      if (right - left > 5 || bottom - top > 5) {
        // Find items within selection bounds
        const itemsToSelect: string[] = [];
        rootItems.forEach((item) => {
          const itemLeft = item.position.x * GRID_CELL_SIZE;
          const itemTop = item.position.y * GRID_CELL_SIZE;
          const itemRight = itemLeft + GRID_CELL_SIZE;
          const itemBottom = itemTop + GRID_CELL_SIZE;

          // Check if item overlaps with selection rectangle
          if (
            itemLeft < right &&
            itemRight > left &&
            itemTop < bottom &&
            itemBottom > top
          ) {
            itemsToSelect.push(item.id);
          }
        });

        // Select all items in the rectangle
        if (itemsToSelect.length > 0) {
          itemsToSelect.forEach((id, index) => {
            selectItem(id, index > 0 || e.shiftKey); // Add to existing selection
          });
        }
      }

      isSelectingRef.current = false;
      setSelectionRect(null);
      // Release pointer capture from the correct element
      if (selectionCaptureElementRef.current && selectionPointerIdRef.current !== null) {
        try {
          selectionCaptureElementRef.current.releasePointerCapture(selectionPointerIdRef.current);
        } catch {
          // Ignore - pointer may already be released
        }
        selectionPointerIdRef.current = null;
        selectionCaptureElementRef.current = null;
      }
    },
    [selectionRect, rootItems, selectItem]
  );

  // Handle selection cancel (when browser interrupts selection)
  const handleSelectionCancel = useCallback(() => {
    isSelectingRef.current = false;
    setSelectionRect(null);
    selectionPointerIdRef.current = null;
    selectionCaptureElementRef.current = null;
  }, []);

  // In visitor mode, disable drag and drop
  const dragStartHandler = isVisitorMode ? undefined : handleDragStart;
  const dragMoveHandler = isVisitorMode ? undefined : handleDragMove;
  const dragEndHandler = isVisitorMode ? undefined : handleDragEnd;

  // File drag-drop handlers (for uploading files from OS or URLs from browser)
  const handleFileDragOver = useCallback(
    (e: React.DragEvent) => {
      if (isVisitorMode) return;
      e.preventDefault();
      e.stopPropagation();

      // Check if we're dragging files or URLs
      const hasFiles = e.dataTransfer.types.includes('Files');
      const hasUrl = e.dataTransfer.types.includes('text/uri-list') ||
                     e.dataTransfer.types.includes('text/plain') ||
                     e.dataTransfer.types.includes('text/html');

      if (hasFiles || hasUrl) {
        setIsFileDragOver(true);
        e.dataTransfer.dropEffect = 'copy';
      }
    },
    [isVisitorMode]
  );

  const handleFileDragLeave = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Only set false if we're leaving the desktop entirely
      const rect = e.currentTarget.getBoundingClientRect();
      if (
        e.clientX <= rect.left ||
        e.clientX >= rect.right ||
        e.clientY <= rect.top ||
        e.clientY >= rect.bottom
      ) {
        setIsFileDragOver(false);
      }
    },
    []
  );

  const handleFileDrop = useCallback(
    async (e: React.DragEvent) => {
      if (isVisitorMode) return;
      e.preventDefault();
      e.stopPropagation();
      setIsFileDragOver(false);

      const { addItem } = useDesktopStore.getState();

      // Calculate grid position from drop location
      const rect = e.currentTarget.getBoundingClientRect();
      const dropX = e.clientX - rect.left;
      const dropY = e.clientY - rect.top;
      const gridX = Math.floor(dropX / GRID_CELL_SIZE);
      const gridY = Math.floor(dropY / GRID_CELL_SIZE);

      // Check for files first (OS file drop)
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0 && isApiConfigured) {
        // Upload each file
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const position = findNearestAvailablePosition(gridX, gridY + i);
          await uploadFile(file, null, position);
        }
        return;
      }

      // Check for URLs dragged from browser
      // Try text/uri-list first (standard for dragging links)
      let url = e.dataTransfer.getData('text/uri-list');

      // Fall back to text/plain if no uri-list
      if (!url) {
        url = e.dataTransfer.getData('text/plain');
      }

      // Try to extract URL from HTML (for images dragged from web pages)
      if (!url) {
        const html = e.dataTransfer.getData('text/html');
        if (html) {
          // Try to extract image src or link href from HTML
          const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
          const linkMatch = html.match(/<a[^>]+href=["']([^"']+)["']/i);
          url = imgMatch?.[1] || linkMatch?.[1] || '';
        }
      }

      // Clean up the URL (uri-list can have multiple URLs, take first)
      if (url) {
        url = url.split('\n')[0].trim();
        // Filter out comments in uri-list format
        if (url.startsWith('#')) url = '';
      }

      // Validate and handle URL
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        // Check if URL looks like an image — try to fetch and upload instead of creating link
        const imageExtPattern = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;
        if (imageExtPattern.test(url) && isApiConfigured) {
          try {
            const response = await fetch(url);
            if (response.ok) {
              const blob = await response.blob();
              if (blob.type.startsWith('image/')) {
                // Extract filename from URL
                const urlPath = new URL(url).pathname;
                const filename = urlPath.split('/').pop() || 'image.png';
                const file = new File([blob], filename, { type: blob.type });
                const position = findNearestAvailablePosition(gridX, gridY);
                await uploadFile(file, null, position);
                return; // Successfully uploaded as image
              }
            }
          } catch {
            // Fetch failed (likely CORS) — fall through to link creation
          }
        }

        // Fall through: create link item
        let name = 'Link';
        try {
          const urlObj = new URL(url);
          name = urlObj.hostname.replace(/^www\./, '');
        } catch {
          // Keep default name
        }

        const position = findNearestAvailablePosition(gridX, gridY);
        const now = Date.now();
        addItem({
          id: `link-${now}`,
          type: 'link',
          name,
          parentId: null,
          position,
          isPublic: true,
          url,
          createdAt: now,
          updatedAt: now,
        });
      }
    },
    [isVisitorMode, uploadFile, findNearestAvailablePosition]
  );

  // Close context menu
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  // Keyboard navigation for desktop icons
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if focus is in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // Handle Cmd+` (backtick) to cycle through open windows
      // Note: Cmd+Tab conflicts with OS/browser tab switching, so we use ` instead
      if ((e.metaKey || e.ctrlKey) && (e.key === '`' || e.key === '~')) {
        e.preventDefault();
        const visibleWindows = windows.filter((w) => !w.minimized);
        if (visibleWindows.length > 1) {
          // Sort by z-index to find current top window
          const sortedWindows = [...visibleWindows].sort((a, b) => b.zIndex - a.zIndex);
          // Focus the next window (wraps around)
          const currentTopIndex = 0; // Top window is first after sorting
          const nextIndex = e.shiftKey
            ? (currentTopIndex - 1 + sortedWindows.length) % sortedWindows.length
            : (currentTopIndex + 1) % sortedWindows.length;
          focusWindow(sortedWindows[nextIndex].id);
        }
        return;
      }

      // Handle Tab to cycle through desktop icons (no modifier keys)
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (rootItems.length === 0) return;

        const selectedArray = Array.from(selectedIds);
        if (selectedArray.length === 0) {
          // No selection, select first item
          selectItem(rootItems[0].id, false);
        } else {
          // Find current selection in sorted items list and move to next
          const sortedItems = [...rootItems].sort((a, b) => {
            // Sort by position: top-to-bottom, then left-to-right
            if (a.position.y !== b.position.y) return a.position.y - b.position.y;
            return a.position.x - b.position.x;
          });
          const currentIndex = sortedItems.findIndex((i) => selectedArray.includes(i.id));
          const nextIndex = e.shiftKey
            ? (currentIndex - 1 + sortedItems.length) % sortedItems.length
            : (currentIndex + 1) % sortedItems.length;
          selectItem(sortedItems[nextIndex].id, false);
        }
        return;
      }

      // Get currently selected items
      const selectedArray = Array.from(selectedIds);
      if (selectedArray.length === 0 && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        return;
      }

      // Handle Enter to open selected item
      if (e.key === 'Enter' && selectedArray.length === 1) {
        const item = rootItems.find((i) => i.id === selectedArray[0]);
        if (item) {
          e.preventDefault();
          handleIconDoubleClick(item);
        }
        return;
      }

      // Handle Escape to deselect
      if (e.key === 'Escape') {
        deselectAll();
        setContextMenu(null);
        return;
      }

      // Handle Cmd+Backspace / Cmd+Delete to trash selected items
      // Requires modifier to prevent accidental deletion (matches MenuBar shortcut ⌘⌫)
      if ((e.key === 'Delete' || e.key === 'Backspace') && (e.metaKey || e.ctrlKey) && selectedArray.length > 0) {
        e.preventDefault();
        moveToTrash(selectedArray);
        deselectAll();
        return;
      }

      // Handle arrow key navigation
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();

        // If nothing selected, select first item
        if (selectedArray.length === 0 && rootItems.length > 0) {
          selectItem(rootItems[0].id, false);
          return;
        }

        // Get the last selected item's position
        const lastSelected = rootItems.find((i) => i.id === selectedArray[selectedArray.length - 1]);
        if (!lastSelected) return;

        const { x, y } = lastSelected.position;
        let targetX = x;
        let targetY = y;

        switch (e.key) {
          case 'ArrowUp':
            targetY = y - 1;
            break;
          case 'ArrowDown':
            targetY = y + 1;
            break;
          case 'ArrowLeft':
            targetX = x - 1;
            break;
          case 'ArrowRight':
            targetX = x + 1;
            break;
        }

        // Find item at target position
        const targetItem = rootItems.find(
          (i) => i.position.x === targetX && i.position.y === targetY
        );

        if (targetItem) {
          selectItem(targetItem.id, e.shiftKey);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedIds, rootItems, selectItem, deselectAll, handleIconDoubleClick, moveToTrash, removeItem, windows, focusWindow]);

  // Right-click on desktop (empty area)
  const handleDesktopContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isVisitorMode) return;
      e.preventDefault();

      // Only if clicking directly on desktop, not on an icon
      if (e.target === e.currentTarget) {
        setContextMenu({
          position: { x: e.clientX, y: e.clientY },
          targetItem: null,
        });
      }
    },
    [isVisitorMode]
  );

  // Right-click on an icon
  const handleIconContextMenu = useCallback(
    (item: DesktopItem, e: React.MouseEvent) => {
      if (isVisitorMode) return;
      e.preventDefault();
      e.stopPropagation();

      // Select the item if not already selected
      if (!selectedIds.has(item.id)) {
        selectItem(item.id, false);
      }

      setContextMenu({
        position: { x: e.clientX, y: e.clientY },
        targetItem: item,
      });
    },
    [isVisitorMode, selectedIds, selectItem]
  );

  // Build context menu items based on target
  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    const { addItem, updateItem } = useDesktopStore.getState();

    if (contextMenu?.targetItem?.type === 'sticker') {
      // Menu for a sticker
      const item = contextMenu.targetItem;
      const { updateItem } = useDesktopStore.getState();
      const config = item.stickerConfig || { width: 120, height: 120, rotation: 0, opacity: 1 };
      return [
        {
          id: 'rotate-cw',
          label: 'Rotate Clockwise',
          action: () => {
            updateItem(item.id, { stickerConfig: { ...config, rotation: (config.rotation + 15) % 360 } });
          },
        },
        {
          id: 'rotate-ccw',
          label: 'Rotate Counter-CW',
          action: () => {
            updateItem(item.id, { stickerConfig: { ...config, rotation: (config.rotation - 15 + 360) % 360 } });
          },
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'opacity-100',
          label: 'Full Opacity',
          checked: config.opacity === 1,
          action: () => {
            updateItem(item.id, { stickerConfig: { ...config, opacity: 1 } });
          },
        },
        {
          id: 'opacity-50',
          label: 'Half Opacity',
          checked: config.opacity === 0.5,
          action: () => {
            updateItem(item.id, { stickerConfig: { ...config, opacity: 0.5 } });
          },
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'remove-sticker',
          label: 'Remove Sticker',
          action: () => {
            moveToTrash([item.id]);
            setSelectedStickerId(null);
          },
        },
      ];
    }

    if (contextMenu?.targetItem) {
      // Menu for a desktop item
      const item = contextMenu.targetItem;
      return [
        {
          id: 'open',
          label: 'Open',
          shortcut: '⌘O',
          action: () => handleIconDoubleClick(item),
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
            // Open Get Info which has rename functionality
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
            const { duplicateItems } = useDesktopStore.getState();
            const idsToDuplicate = selectedIds.size > 0 && selectedIds.has(item.id)
              ? Array.from(selectedIds)
              : [item.id];
            duplicateItems(idsToDuplicate, item.parentId);
          },
        },
        {
          id: 'change-icon',
          label: 'Change Icon...',
          action: () => {
            setIconPickerItem(item);
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
            // Move all selected items to trash, not just the right-clicked one
            const idsToTrash = selectedIds.size > 0 && selectedIds.has(item.id)
              ? Array.from(selectedIds)
              : [item.id];
            moveToTrash(idsToTrash);
            deselectAll();
          },
        },
      ];
    } else {
      // Menu for empty desktop area
      return [
        {
          id: 'new-folder',
          label: 'New Folder',
          shortcut: '⇧⌘N',
          action: () => {
            const position = {
              x: Math.floor((contextMenu?.position.x || 100) / GRID_CELL_SIZE),
              y: Math.floor((contextMenu?.position.y || 100) / GRID_CELL_SIZE),
            };
            const finalPos = findNearestAvailablePosition(position.x, position.y);
            const now = Date.now();
            addItem({
              id: `folder-${now}`,
              type: 'folder',
              name: 'Untitled Folder',
              parentId: null,
              position: finalPos,
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
            const position = {
              x: Math.floor((contextMenu?.position.x || 100) / GRID_CELL_SIZE),
              y: Math.floor((contextMenu?.position.y || 100) / GRID_CELL_SIZE),
            };
            const finalPos = findNearestAvailablePosition(position.x, position.y);
            const now = Date.now();
            addItem({
              id: `text-${now}`,
              type: 'text',
              name: 'Untitled.txt',
              parentId: null,
              position: finalPos,
              isPublic: true,
              textContent: '',
              createdAt: now,
              updatedAt: now,
            });
          },
        },
        {
          id: 'new-link',
          label: 'New Link...',
          action: () => {
            const position = {
              x: Math.floor((contextMenu?.position.x || 100) / GRID_CELL_SIZE),
              y: Math.floor((contextMenu?.position.y || 100) / GRID_CELL_SIZE),
            };
            setLinkDialogPosition(position);
            setShowLinkDialog(true);
          },
        },
        {
          id: 'new-widget',
          label: 'New Widget...',
          action: () => {
            const position = {
              x: Math.floor((contextMenu?.position.x || 100) / GRID_CELL_SIZE),
              y: Math.floor((contextMenu?.position.y || 100) / GRID_CELL_SIZE),
            };
            setWidgetPickerPosition(position);
            setShowWidgetPicker(true);
          },
        },
        {
          id: 'add-sticker',
          label: 'Add Sticker...',
          action: () => {
            // Check sticker limit
            if (stickerItems.length >= 20) {
              alert('Maximum 20 stickers allowed.');
              return;
            }
            // Open file picker for image
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/jpeg,image/png,image/gif,image/webp';
            input.onchange = async () => {
              const file = input.files?.[0];
              if (!file || !isApiConfigured) return;
              try {
                // Upload via API with sticker override
                const pixelX = contextMenu?.position.x || 100;
                const pixelY = contextMenu?.position.y || 100;
                const result = await apiUploadFile(file, null, { x: pixelX, y: pixelY });
                // After upload, patch item to be a sticker with config
                const { updateItem: patchItem } = useDesktopStore.getState();
                patchItem(result.item.id, {
                  type: 'sticker' as DesktopItem['type'],
                  stickerConfig: { width: 120, height: 120, rotation: 0, opacity: 1 },
                });
              } catch (error) {
                console.error('Failed to upload sticker:', error);
              }
            };
            input.click();
          },
        },
        { id: 'divider-1', label: '', divider: true },
        {
          id: 'change-wallpaper',
          label: 'Change Wallpaper...',
          action: () => {
            openWindow({
              id: 'wallpaper-picker',
              title: 'Desktop Patterns',
              position: { x: 150, y: 100 },
              size: { width: 320, height: 280 },
              minimized: false,
              maximized: false,
              contentType: 'wallpaper',
            });
          },
        },
        { id: 'divider-2', label: '', divider: true },
        {
          id: 'select-all',
          label: 'Select All',
          shortcut: '⌘A',
          action: () => {
            selectAll(null);
          },
        },
        {
          id: 'clean-up',
          label: 'Clean Up',
          action: () => {
            cleanUp(null);
          },
        },
      ];
    }
  }, [contextMenu, deselectAll, handleIconDoubleClick, openWindow, moveToTrash, selectedIds, findNearestAvailablePosition, cleanUp, selectAll, stickerItems]);

  // Handle link creation from dialog
  const handleLinkCreate = useCallback((url: string, name: string) => {
    const { addItem } = useDesktopStore.getState();
    const position = linkDialogPosition || { x: 1, y: 1 };
    const finalPos = findNearestAvailablePosition(position.x, position.y);
    const now = Date.now();
    addItem({
      id: `link-${now}`,
      type: 'link',
      name,
      parentId: null,
      position: finalPos,
      isPublic: true,
      url,
      createdAt: now,
      updatedAt: now,
    });
    setShowLinkDialog(false);
    setLinkDialogPosition(null);
  }, [linkDialogPosition, findNearestAvailablePosition]);

  const handleLinkCancel = useCallback(() => {
    setShowLinkDialog(false);
    setLinkDialogPosition(null);
  }, []);

  return (
    <>
      {/* Loading overlay while fetching desktop data */}
      {loading && <LoadingOverlay message="Loading your desktop..." />}

      {/* Menu Bar - fixed at top (hide in visitor mode, visitor has its own banner) */}
      {!isVisitorMode && <MenuBar />}

      <div
        ref={desktopRef}
        data-desktop
        eos-name="desktop"
        className={`${styles.desktop} user-desktop ${isFileDragOver ? styles.dragOver : ''} ${isDesktopDropTarget ? styles.desktopDropTarget : ''} ${profile?.wallpaper?.startsWith('custom:') ? '' : `wallpaper-${profile?.wallpaper || 'default'}`}`}
        style={profile?.wallpaper?.startsWith('custom:') ? (() => {
          const mode = profile?.wallpaperMode || 'cover';
          const base = { backgroundImage: `url(${getWallpaperUrl(profile.wallpaper)})` };
          switch (mode) {
            case 'tile':
              return { ...base, backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'top left' };
            case 'center':
              return { ...base, backgroundSize: 'auto', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' };
            case 'cover':
            default:
              return { ...base, backgroundSize: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' };
          }
        })() : undefined}
        onClick={handleDesktopClick}
        onContextMenu={handleDesktopContextMenu}
        onPointerDown={handleSelectionStart}
        onPointerMove={handleSelectionMove}
        onPointerUp={handleSelectionEnd}
        onPointerCancel={handleSelectionCancel}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
      >
        {/* Effects overlay (skin system) */}
        <EffectsOverlay />

        {/* Desktop Icons */}
      {rootItems.map((item) => (
        <DesktopIcon
          key={item.id}
          item={item}
          isSelected={selectedIds.has(item.id)}
          gridCellSize={GRID_CELL_SIZE}
          onSelect={handleIconSelect}
          onDoubleClick={handleIconDoubleClick}
          onContextMenu={(e) => handleIconContextMenu(item, e)}
          onDragStart={dragStartHandler}
          onDragMove={dragMoveHandler}
          onDragEnd={dragEndHandler}
          isDragging={draggingId === item.id}
          isDropTarget={item.type === 'folder' && folderDropTargetId === item.id}
          isCut={cutItemIds.has(item.id)}
        />
      ))}

      {/* Trash Icon - hidden in visitor mode */}
      {!isVisitorMode && (
        <div ref={trashRef} data-trash>
          <Trash
            isFull={trashedItemCount > 0}
            isSelected={trashSelected}
            isDropTarget={isDropTarget}
            onSelect={handleTrashSelect}
            onDoubleClick={handleTrashDoubleClick}
            onDragOver={handleTrashDragOver}
            onDrop={handleTrashDrop}
          />
        </div>
      )}

      {/* Sticker Layer - rendered between icons and windows */}
      {stickerItems.map((item) => (
        <Sticker
          key={item.id}
          item={item}
          isOwner={!isVisitorMode}
          isSelected={selectedStickerId === item.id}
          onSelect={handleStickerSelect}
          onContextMenu={handleStickerContextMenu}
          onMove={handleStickerMove}
          onResize={handleStickerResize}
        />
      ))}

        {/* Minimized windows dock - shows minimized windows as small title bars at bottom */}
        {windows.filter((w) => w.minimized).length > 0 && (
          <div className={styles.minimizedDock}>
            {windows
              .filter((w) => w.minimized)
              .map((win) => (
                <button
                  key={win.id}
                  className={styles.minimizedWindow}
                  onClick={() => {
                    const { restoreWindow, focusWindow } = useWindowStore.getState();
                    restoreWindow(win.id);
                    focusWindow(win.id);
                  }}
                  title={`Restore "${win.title}"`}
                >
                  <span className={styles.minimizedTitle}>{win.title}</span>
                </button>
              ))}
          </div>
        )}

        {/* Window Manager renders all open windows */}
        <WindowManager folderWindowDropTargetId={folderWindowDropTargetId} />

        {/* Upload Progress indicator */}
        {!isVisitorMode && <UploadProgress />}

        {/* Context Menu */}
        {contextMenu && (
          <ContextMenu
            items={getContextMenuItems()}
            position={contextMenu.position}
            onClose={closeContextMenu}
          />
        )}

        {/* Selection Rectangle (marquee select) */}
        {selectionRect && (
          <div
            className={`${styles.selectionRect} selectionRect`}
            style={{
              left: Math.min(selectionRect.startX, selectionRect.currentX),
              top: Math.min(selectionRect.startY, selectionRect.currentY),
              width: Math.abs(selectionRect.currentX - selectionRect.startX),
              height: Math.abs(selectionRect.currentY - selectionRect.startY),
            }}
          />
        )}

        {/* Link Dialog */}
        {showLinkDialog && (
          <LinkDialog
            onSubmit={handleLinkCreate}
            onCancel={handleLinkCancel}
          />
        )}

        {/* Icon Picker */}
        {iconPickerItem && (
          <IconPicker
            currentIcon={iconPickerItem.customIcon}
            itemId={iconPickerItem.id}
            onSelect={(iconId) => {
              const { updateItem } = useDesktopStore.getState();
              updateItem(iconPickerItem.id, { customIcon: iconId ?? undefined });
            }}
            onClose={() => setIconPickerItem(null)}
          />
        )}

        {/* Widget Picker */}
        {showWidgetPicker && (
          <WidgetPicker
            onSelect={(widgetType: WidgetType, config: WidgetConfig, name: string) => {
              const { addItem } = useDesktopStore.getState();
              const position = widgetPickerPosition || { x: 1, y: 1 };
              const finalPos = findNearestAvailablePosition(position.x, position.y);
              const now = Date.now();
              const newWidgetItem: DesktopItem = {
                id: `widget-${now}`,
                type: 'widget',
                name,
                parentId: null,
                position: finalPos,
                isPublic: true,
                createdAt: now,
                updatedAt: now,
                widgetType,
                widgetConfig: config,
              };
              addItem(newWidgetItem);

              // Open the widget window
              const defaultSize = getWidgetDefaultSize(widgetType);
              openWindow({
                id: `widget-${newWidgetItem.id}`,
                title: name,
                position: { x: 100 + finalPos.x * 20, y: 60 + finalPos.y * 20 },
                size: defaultSize,
                minimized: false,
                maximized: false,
                contentType: 'widget',
                contentId: newWidgetItem.id,
              });
            }}
            onClose={() => {
              setShowWidgetPicker(false);
              setWidgetPickerPosition(null);
            }}
          />
        )}

        {/* Quick Start Wizard for new users */}
        {showQuickStart && profile?.username && (
          <QuickStartWizard
            username={profile.username}
            onComplete={handleQuickStartComplete}
          />
        )}
      </div>

      {/* CSS Element Picker overlay — rendered via portal at document.body level */}
      {!isVisitorMode && pickerActive && createPortal(
        <CSSElementPicker />,
        document.body
      )}
    </>
  );
}
