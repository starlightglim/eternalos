/**
 * MobileHomeGrid — iOS-style paginated grid of desktop items.
 *
 * Replaces the flat list for the phone viewport (< 640px). Items laid out
 * 4 columns wide, paginated at 16 items per page. Horizontal swipe changes
 * pages. Tap opens the item. Long-press (future) reveals context actions.
 *
 * This is a presentation primitive — it receives items + callbacks and does
 * not couple to the Zustand store. The parent (MobileShell) composes it.
 */

import { useMemo, useRef, useState, type PointerEvent } from 'react';
import type { DesktopItem } from '../../types';
import {
  FolderIcon,
  TextFileIcon,
  ImageFileIcon,
  LinkIcon,
  AudioFileIcon,
  VideoFileIcon,
  PDFFileIcon,
  WidgetIcon,
} from '../icons/PixelIcons';
import { renderCustomIcon, CUSTOM_ICON_LIBRARY, type CustomIconId } from '../icons/customIconUtils';
import { getCustomIconUrl } from '../../services/api';

export interface MobileHomeGridProps {
  items: DesktopItem[];
  onItemTap: (item: DesktopItem) => void;
  onItemLongPress?: (item: DesktopItem, rect: DOMRect) => void;
  /** Items per page; defaults to 16 (4x4). */
  pageSize?: number;
  /** Number of columns; defaults to 4. */
  columns?: number;
  /** Called when the user swipes to a different page. */
  onPageChange?: (pageIndex: number) => void;
}

const LONG_PRESS_MS = 450;
const SWIPE_THRESHOLD_RATIO = 0.18; // 18% of viewport width triggers page change
const MAX_SWIPE_VELOCITY_PX_PER_MS = 0.8;

export function MobileHomeGrid({
  items,
  onItemTap,
  onItemLongPress,
  pageSize = 16,
  columns = 4,
  onPageChange,
}: MobileHomeGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStateRef = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    active: boolean;
    width: number;
  } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  // Sort: folders first, then by name. Keep stable for same-input.
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        return a.name.localeCompare(b.name);
      }),
    [items],
  );

  const pages = useMemo(() => {
    const chunks: DesktopItem[][] = [];
    for (let i = 0; i < sortedItems.length; i += pageSize) {
      chunks.push(sortedItems.slice(i, i + pageSize));
    }
    return chunks.length === 0 ? [[]] : chunks;
  }, [sortedItems, pageSize]);

  const clampPage = (idx: number) => Math.max(0, Math.min(pages.length - 1, idx));

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const containerWidth = containerRef.current?.clientWidth ?? window.innerWidth;
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      startTime: performance.now(),
      active: true,
      width: containerWidth,
    };
    setDragOffset(0);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state?.active) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    // Cancel long-press the moment the user moves far enough for it to count as a gesture.
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cancelLongPress();
    // Only consider horizontal-dominant drags for paging.
    if (Math.abs(dx) > Math.abs(dy)) {
      setDragOffset(dx);
      // Prevent vertical scroll while actively paging.
      event.preventDefault();
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state?.active) return;
    const dx = event.clientX - state.startX;
    const dt = Math.max(1, performance.now() - state.startTime);
    const velocity = dx / dt;
    const width = state.width;

    let newPage = pageIndex;
    if (Math.abs(dx) > width * SWIPE_THRESHOLD_RATIO || Math.abs(velocity) > MAX_SWIPE_VELOCITY_PX_PER_MS) {
      newPage = clampPage(pageIndex + (dx < 0 ? 1 : -1));
    }

    setPageIndex(newPage);
    setDragOffset(0);
    dragStateRef.current = null;
    if (newPage !== pageIndex) onPageChange?.(newPage);
  };

  const handlePointerCancel = () => {
    setDragOffset(0);
    dragStateRef.current = null;
    cancelLongPress();
  };

  const handleItemPointerDown = (event: PointerEvent<HTMLButtonElement>, item: DesktopItem) => {
    if (!onItemLongPress) return;
    cancelLongPress();
    const target = event.currentTarget;
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      onItemLongPress(item, target.getBoundingClientRect());
      // Haptic feedback if the device supports it.
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.(8);
      }
    }, LONG_PRESS_MS);
  };

  const handleItemPointerEnd = () => {
    cancelLongPress();
  };

  const renderIcon = (item: DesktopItem) => {
    if (item.customIcon) {
      if (item.customIcon.startsWith('upload:')) {
        return (
          <img
            src={getCustomIconUrl(item.customIcon)}
            alt=""
            width={40}
            height={40}
            style={{ imageRendering: 'pixelated' }}
          />
        );
      }
      if (CUSTOM_ICON_LIBRARY[item.customIcon as CustomIconId]) {
        return renderCustomIcon(item.customIcon, 40);
      }
    }
    switch (item.type) {
      case 'folder':
        return <FolderIcon size={40} />;
      case 'image':
        return <ImageFileIcon size={40} />;
      case 'video':
        return <VideoFileIcon size={40} />;
      case 'audio':
        return <AudioFileIcon size={40} />;
      case 'pdf':
        return <PDFFileIcon size={40} />;
      case 'link':
        return <LinkIcon size={40} />;
      case 'widget':
        return <WidgetIcon size={40} />;
      case 'text':
      default:
        return <TextFileIcon size={40} />;
    }
  };

  const trackStyle: React.CSSProperties = {
    display: 'flex',
    transform: `translate3d(calc(${-pageIndex * 100}% + ${dragOffset}px), 0, 0)`,
    transition: dragStateRef.current?.active ? 'none' : 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
    width: '100%',
    willChange: 'transform',
  };

  return (
    <div
      ref={containerRef}
      style={rootStyle}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div style={trackStyle}>
        {pages.map((pageItems, pIdx) => (
          <div key={pIdx} style={pageStyle}>
            <div style={{ ...gridStyle, gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
              {pageItems.map((item) => (
                <button
                  key={item.id}
                  style={itemButtonStyle}
                  onClick={() => onItemTap(item)}
                  onPointerDown={(e) => handleItemPointerDown(e, item)}
                  onPointerUp={handleItemPointerEnd}
                  onPointerCancel={handleItemPointerEnd}
                  onPointerLeave={handleItemPointerEnd}
                  aria-label={item.name}
                >
                  <div style={itemIconStyle}>{renderIcon(item)}</div>
                  <div style={itemLabelStyle}>{item.name}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {pages.length > 1 && (
        <div style={dotsStyle} aria-hidden="true">
          {pages.map((_, i) => (
            <span
              key={i}
              style={{
                ...dotStyle,
                opacity: i === pageIndex ? 1 : 0.35,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Inline styles (mobile-first, parent handles theming tokens)
const rootStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  touchAction: 'pan-y',
  overflow: 'hidden',
  position: 'relative',
  userSelect: 'none',
};

const pageStyle: React.CSSProperties = {
  flex: '0 0 100%',
  padding: '16px 12px',
  boxSizing: 'border-box',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gap: 12,
  width: '100%',
};

const itemButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: '8px 4px',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 4,
  minHeight: 88,
  color: 'var(--label-color, #ffffff)',
  fontFamily: 'inherit',
  WebkitTapHighlightColor: 'transparent',
};

const itemIconStyle: React.CSSProperties = {
  width: 56,
  height: 56,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const itemLabelStyle: React.CSSProperties = {
  fontSize: 11,
  lineHeight: 1.2,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  wordBreak: 'break-word',
  textAlign: 'center',
};

const dotsStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  left: 0,
  right: 0,
  display: 'flex',
  gap: 6,
  justifyContent: 'center',
};

const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: 'var(--label-color, #ffffff)',
  transition: 'opacity 160ms ease',
};
