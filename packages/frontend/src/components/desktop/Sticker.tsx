/**
 * Sticker - Freely placed decoration image on the desktop
 *
 * Stickers are a special item type that render as images with pixel-based positioning
 * (not grid-snapped like regular icons). They support rotation, opacity, and resizing.
 *
 * Owner mode: drag to move, corner handles to resize, right-click context menu
 * Visitor mode: read-only display
 */

import { useCallback, useRef, useState, memo } from 'react';
import type { DesktopItem } from '../../types';
import { getFileUrl } from '../../services/api';
import { slugify } from '../../utils/slugify';
import styles from './Sticker.module.css';

interface StickerProps {
  item: DesktopItem;
  isOwner: boolean;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
  onContextMenu?: (item: DesktopItem, e: React.MouseEvent) => void;
  onMove?: (id: string, position: { x: number; y: number }) => void;
  onResize?: (id: string, config: { width: number; height: number }) => void;
}

function StickerInner({
  item,
  isOwner,
  isSelected,
  onSelect,
  onContextMenu,
  onMove,
  onResize,
}: StickerProps) {
  const config = item.stickerConfig || { width: 120, height: 120, rotation: 0, opacity: 1 };

  // Drag state
  const [isDragging, setIsDragging] = useState(false);
  const dragStartMouse = useRef({ x: 0, y: 0 });
  const [dragStartPos, setDragStartPos] = useState({ x: item.position.x, y: item.position.y });
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const capturedElementRef = useRef<HTMLElement | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);
  const dragActiveRef = useRef(false);

  // Resize state
  const isResizing = useRef(false);
  const resizeStartMouse = useRef({ x: 0, y: 0 });
  const resizeStartSize = useRef({ width: 0, height: 0 });

  const imageUrl = item.r2Key ? getFileUrl(item.r2Key) : '';

  // --- Drag handlers (owner only) ---
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isOwner) return;
    if (e.button !== 0) return;

    e.stopPropagation();
    e.preventDefault();

    onSelect?.(item.id);

    setIsDragging(true);
    dragStartMouse.current = { x: e.clientX, y: e.clientY };
    setDragStartPos({ x: item.position.x, y: item.position.y });
    setDragOffset(null);

    const element = e.currentTarget as HTMLElement;
    element.setPointerCapture(e.pointerId);
    capturedElementRef.current = element;
    capturedPointerIdRef.current = e.pointerId;
    dragActiveRef.current = true;
  }, [isOwner, item.id, item.position, onSelect]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStartMouse.current.x;
      const dy = e.clientY - dragStartMouse.current.y;
      setDragOffset({ x: dx, y: dy });
    }
  }, [isDragging]);

  const finishDrag = useCallback(() => {
    if (!dragActiveRef.current && !isDragging) {
      return;
    }

    dragActiveRef.current = false;

    if (isDragging && dragOffset) {
      const newX = Math.max(0, dragStartPos.x + dragOffset.x);
      const newY = Math.max(0, dragStartPos.y + dragOffset.y);
      onMove?.(item.id, { x: newX, y: newY });
    }
    setIsDragging(false);
    setDragOffset(null);

    if (capturedElementRef.current && capturedPointerIdRef.current !== null) {
      try {
        if (capturedElementRef.current.hasPointerCapture(capturedPointerIdRef.current)) {
          capturedElementRef.current.releasePointerCapture(capturedPointerIdRef.current);
        }
      } catch {
        // Ignore
      }
    }
    capturedElementRef.current = null;
    capturedPointerIdRef.current = null;
  }, [item.id, dragOffset, dragStartPos, isDragging, onMove]);

  const handlePointerUp = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  const handlePointerCancel = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  const handleLostPointerCapture = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  // --- Resize handlers ---
  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    if (!isOwner) return;
    e.stopPropagation();
    e.preventDefault();

    isResizing.current = true;
    resizeStartMouse.current = { x: e.clientX, y: e.clientY };
    resizeStartSize.current = { width: config.width, height: config.height };

    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [isOwner, config.width, config.height]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!isResizing.current) return;

    const dx = e.clientX - resizeStartMouse.current.x;
    const dy = e.clientY - resizeStartMouse.current.y;
    // Maintain aspect ratio using the larger delta
    const delta = Math.max(dx, dy);
    const newWidth = Math.max(40, resizeStartSize.current.width + delta);
    const newHeight = Math.max(40, resizeStartSize.current.height + delta);

    onResize?.(item.id, { width: newWidth, height: newHeight });
  }, [item.id, onResize]);

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    isResizing.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
  }, []);

  // --- Context menu ---
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!isOwner) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu?.(item, e);
  }, [isOwner, item, onContextMenu]);

  // Compute position
  const x = dragOffset ? dragStartPos.x + dragOffset.x : item.position.x;
  const y = dragOffset ? dragStartPos.y + dragOffset.y : item.position.y;

  const className = [
    styles.sticker,
    'sticker', // Plain class for user custom CSS targeting
    isOwner && styles.stickerOwner,
    isDragging && dragOffset && styles.stickerDragging,
    isSelected && styles.stickerSelected,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      eos-name={slugify(item.name)}
      eos-type="sticker"
      style={{
        left: x,
        top: y,
        width: config.width,
        height: config.height,
        transform: config.rotation ? `rotate(${config.rotation}deg)` : undefined,
        opacity: config.opacity,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      onContextMenu={handleContextMenu}
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt={item.name}
          className={styles.stickerImage}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          draggable={false}
        />
      )}

      {/* Resize handles (owner only) */}
      {isOwner && (
        <div className={styles.handles}>
          <div
            className={`${styles.handle} ${styles.handleSE}`}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
          />
        </div>
      )}
    </div>
  );
}

export const Sticker = memo(StickerInner);
