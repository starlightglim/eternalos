import { useCallback, useRef, useEffect, memo } from 'react';
import type { DesktopItem } from '../../types';
import { FolderIcon, TextFileIcon, ImageFileIcon, LinkIcon, AudioFileIcon, VideoFileIcon, PDFFileIcon, WidgetIcon } from './PixelIcons';
import { ThumbnailIcon } from './ThumbnailIcon';
import { renderCustomIcon, CUSTOM_ICON_LIBRARY, type CustomIconId } from './customIconUtils';
import { getCustomIconUrl } from '../../services/api';
import { slugify } from '../../utils/slugify';
import styles from './DesktopIcon.module.css';

interface DesktopIconProps {
  item: DesktopItem;
  isSelected: boolean;
  gridCellSize: number;
  onSelect: (id: string, addToSelection: boolean) => void;
  onDoubleClick: (item: DesktopItem) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onDragStart?: (id: string, e: React.PointerEvent) => void;
  onDragMove?: (e: React.PointerEvent) => void;
  onDragEnd?: (e: React.PointerEvent) => void;
  isDragging: boolean;
  isDropTarget?: boolean;
  isCut?: boolean; // Item is cut and pending paste (shows faded)
}

/**
 * Desktop Icon Component
 * Displays a 32x32 pixel art icon with label
 * Supports click to select, double-click to open, and drag to reposition
 *
 * Performance: Wrapped with React.memo to prevent unnecessary re-renders
 * when parent Desktop component updates but this icon's props haven't changed.
 */
function DesktopIconInner({
  item,
  isSelected,
  gridCellSize,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
  isDragging,
  isDropTarget,
  isCut,
}: DesktopIconProps) {
  const clickTimeoutRef = useRef<number | null>(null);
  const clickCountRef = useRef(0);
  const iconRef = useRef<HTMLDivElement>(null);
  // Track the pointer ID we captured so we can release it reliably
  const capturedPointerIdRef = useRef<number | null>(null);
  const dragStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const dragActiveRef = useRef(false);

  // Calculate pixel position from grid position
  const pixelX = item.position.x * gridCellSize;
  const pixelY = item.position.y * gridCellSize;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return; // Only left click

      e.preventDefault();
      e.stopPropagation();

      // Handle selection (shift-click for multi-select)
      const addToSelection = e.shiftKey || e.metaKey || e.ctrlKey;
      onSelect(item.id, addToSelection);

      // Start drag (if handler provided)
      if (onDragStart && iconRef.current) {
        dragStartClientRef.current = { x: e.clientX, y: e.clientY };
        dragActiveRef.current = true;
        onDragStart(item.id, e);
        // Capture pointer on the icon element (not e.target which could be a child)
        iconRef.current.setPointerCapture(e.pointerId);
        capturedPointerIdRef.current = e.pointerId;
      }
    },
    [item.id, onSelect, onDragStart]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (isDragging && dragStartClientRef.current && iconRef.current) {
        const deltaX = e.clientX - dragStartClientRef.current.x;
        const deltaY = e.clientY - dragStartClientRef.current.y;
        iconRef.current.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
      }

      if (onDragMove) {
        onDragMove(e);
      }
    },
    [isDragging, onDragMove]
  );

  const finishDrag = useCallback((e: React.PointerEvent) => {
    if (!dragActiveRef.current) {
      return;
    }

    dragActiveRef.current = false;

    if (onDragEnd) {
      onDragEnd(e);
    }

    if (iconRef.current) {
      iconRef.current.style.transform = '';
    }
    dragStartClientRef.current = null;

    if (iconRef.current && capturedPointerIdRef.current !== null) {
      try {
        if (iconRef.current.hasPointerCapture(capturedPointerIdRef.current)) {
          iconRef.current.releasePointerCapture(capturedPointerIdRef.current);
        }
      } catch {
        // Ignore - pointer may already be released
      }
    }
    capturedPointerIdRef.current = null;
  }, [onDragEnd]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    finishDrag(e);
  }, [finishDrag]);

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    finishDrag(e);
  }, [finishDrag]);

  const handleLostPointerCapture = useCallback((e: React.PointerEvent) => {
    finishDrag(e);
  }, [finishDrag]);

  // Clean up pointer capture if component unmounts during drag
  useEffect(() => {
    const iconElement = iconRef.current;
    return () => {
      if (iconElement) {
        iconElement.style.transform = '';
      }
      dragActiveRef.current = false;
      if (iconElement && capturedPointerIdRef.current !== null) {
        try {
          if (iconElement.hasPointerCapture(capturedPointerIdRef.current)) {
            iconElement.releasePointerCapture(capturedPointerIdRef.current);
          }
        } catch {
          // Ignore - pointer may already be released
        }
        capturedPointerIdRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isDragging && iconRef.current) {
      iconRef.current.style.transform = '';
    }
  }, [isDragging]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      clickCountRef.current += 1;

      if (clickCountRef.current === 1) {
        // First click - wait for potential second click
        clickTimeoutRef.current = window.setTimeout(() => {
          clickCountRef.current = 0;
          // Single click - selection already handled in pointerdown
        }, 250);
      } else if (clickCountRef.current === 2) {
        // Double click
        if (clickTimeoutRef.current) {
          clearTimeout(clickTimeoutRef.current);
        }
        clickCountRef.current = 0;
        onDoubleClick(item);
      }
    },
    [item, onDoubleClick]
  );

  const iconClasses = [
    styles.desktopIcon,
    'desktopIcon', // Plain class for user custom CSS targeting
    isSelected && styles.selected,
    isDragging && styles.dragging,
    isDropTarget && styles.dropTarget,
    isCut && styles.cut,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      ref={iconRef}
      className={iconClasses}
      data-item-type={item.type}
      eos-name={slugify(item.name)}
      eos-type={item.type}
      style={{
        left: pixelX,
        top: pixelY,
        width: gridCellSize,
        height: gridCellSize,
        touchAction: 'none', // Prevent browser handling of touch gestures during drag
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onClick={handleClick}
      onContextMenu={onContextMenu}
    >
      <div className={styles.iconImage}>
        {/* Custom icon takes precedence if set */}
        {item.customIcon ? (
          // Check if it's an uploaded icon (starts with "upload:") or a library icon
          item.customIcon.startsWith('upload:') ? (
            <img
              src={getCustomIconUrl(item.customIcon)}
              alt={item.name}
              width={32}
              height={32}
              className={styles.uploadedIcon}
            />
          ) : CUSTOM_ICON_LIBRARY[item.customIcon as CustomIconId] ? (
            renderCustomIcon(item.customIcon, 32)
          ) : null
        ) : (
          <>
            {item.type === 'folder' && <FolderIcon size={32} />}
            {item.type === 'text' && <TextFileIcon size={32} />}
            {/* Images with r2Key show pixelated thumbnail preview */}
            {item.type === 'image' && item.r2Key ? (
              <ThumbnailIcon
                r2Key={item.r2Key}
                thumbnailKey={item.thumbnailKey}
                alt={item.name}
                size={32}
                isSelected={isSelected}
              />
            ) : item.type === 'image' ? (
              <ImageFileIcon size={32} />
            ) : null}
            {item.type === 'link' && <LinkIcon size={32} />}
            {item.type === 'audio' && <AudioFileIcon size={32} />}
            {item.type === 'video' && <VideoFileIcon size={32} />}
            {item.type === 'pdf' && <PDFFileIcon size={32} />}
            {item.type === 'widget' && <WidgetIcon size={32} />}
          </>
        )}
      </div>
      <div className={`${styles.iconLabel} iconLabel ${isSelected ? styles.labelSelected : ''}`}>
        <span>{item.name}</span>
      </div>
    </div>
  );
}

/**
 * Memoized DesktopIcon - only re-renders when its specific props change.
 * This is crucial for performance with 30+ items on the desktop.
 */
export const DesktopIcon = memo(DesktopIconInner, (prevProps, nextProps) => {
  // Custom comparison for performance - only re-render when relevant props change
  return (
    prevProps.item.id === nextProps.item.id &&
    prevProps.item.name === nextProps.item.name &&
    prevProps.item.type === nextProps.item.type &&
    prevProps.item.position.x === nextProps.item.position.x &&
    prevProps.item.position.y === nextProps.item.position.y &&
    prevProps.item.r2Key === nextProps.item.r2Key &&
    prevProps.item.thumbnailKey === nextProps.item.thumbnailKey &&
    prevProps.item.customIcon === nextProps.item.customIcon &&
    prevProps.isSelected === nextProps.isSelected &&
    prevProps.isDragging === nextProps.isDragging &&
    prevProps.isDropTarget === nextProps.isDropTarget &&
    prevProps.isCut === nextProps.isCut &&
    prevProps.gridCellSize === nextProps.gridCellSize
    // Note: callback props (onSelect, onDoubleClick, etc.) are not compared
    // because they should be stable useCallback refs from the parent
  );
});
