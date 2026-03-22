import { useRef, useCallback, useEffect } from 'react';
import { useWindowStore } from '../../stores/windowStore';
import { useSlot } from '../../variants/useSlot';
import type { WindowButtonsSlotProps, ResizeHandleSlotProps } from '../../variants/slots';
import { WindowChrome } from '../../variants/builtin/chrome/WindowChrome';
import { WindowTitleBar } from '../../variants/builtin/titlebar/WindowTitleBar';
import styles from './Window.module.css';

// Tags considered interactive — clicks on these shouldn't trigger body-drag
const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'textarea', 'select',
  'video', 'audio', 'canvas', 'label',
]);

// Containers that handle their own pointer interactions (e.g. folder selection rect)
const INTERACTIVE_CONTAINERS = new Set(['folder-view']);

/** Walk up from target to boundary, checking for interactive elements */
function isInteractiveTarget(target: EventTarget | null, boundary: HTMLElement | null): boolean {
  let el = target as HTMLElement | null;
  while (el && el !== boundary) {
    const tag = el.tagName?.toLowerCase();
    if (tag && INTERACTIVE_TAGS.has(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.draggable) return true;
    const role = el.getAttribute?.('role');
    if (role === 'button' || role === 'link' || role === 'slider' || role === 'textbox') return true;
    if (el.dataset?.noDrag !== undefined) return true;
    for (const cls of el.classList || []) {
      if (INTERACTIVE_CONTAINERS.has(cls)) return true;
    }
    el = el.parentElement as HTMLElement | null;
  }
  return false;
}

interface WindowProps {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  minimized: boolean;
  collapsed?: boolean;
  isActive: boolean;
  contentType?: string;
  contentId?: string;
  eosName?: string;
  eosType?: string;
  eosExtension?: string;
  eosFolder?: string;
  children?: React.ReactNode;
}

/**
 * Window component — renders via the variant slot system.
 * Chrome, title bar, buttons, and resize handle are all swappable variants.
 */
export function Window({
  id,
  title,
  position,
  size,
  zIndex,
  minimized,
  collapsed,
  isActive,
  contentType,
  contentId,
  eosName,
  eosType,
  eosExtension,
  eosFolder,
  children,
}: WindowProps) {
  const { closeWindow, focusWindow, moveWindow, resizeWindow, toggleCollapse, toggleMaximize } = useWindowStore();

  // Resolve active variant components for leaf slots (safe to swap)
  // Chrome and TitleBar use stable unified components (CSS-driven variants)
  // to avoid remounting children when variant changes
  const Buttons = useSlot<WindowButtonsSlotProps>('window.buttons');
  const Resize = useSlot<ResizeHandleSlotProps>('window.resizeHandle');

  const windowRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const lastClickTime = useRef(0);

  // Focus window on any click
  const handleWindowClick = useCallback((_e: React.PointerEvent) => {
    focusWindow(id);
  }, [focusWindow, id]);

  // Close button handler
  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      closeWindow(id);
    },
    [closeWindow, id]
  );

  // Collapse button handler (window shade)
  const handleCollapse = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleCollapse(id);
    },
    [toggleCollapse, id]
  );

  // Zoom button handler (maximize/restore)
  const handleZoom = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleMaximize(id);
    },
    [toggleMaximize, id]
  );

  // ============================================
  // DRAG HANDLING (Title Bar)
  // ============================================

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      const now = Date.now();
      if (now - lastClickTime.current < 300) {
        toggleCollapse(id);
        lastClickTime.current = 0;
        return;
      }
      lastClickTime.current = now;

      isDragging.current = true;
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };

      focusWindow(id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [position, focusWindow, id, toggleCollapse]
  );

  const handleDragMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragging.current) return;

      e.preventDefault();

      let newX = e.clientX - dragOffset.current.x;
      let newY = e.clientY - dragOffset.current.y;

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const menuBarHeight = 20;

      newX = Math.max(-size.width + 50, Math.min(newX, viewportWidth - 50));
      newY = Math.max(0, Math.min(newY, viewportHeight - 30));

      const snapThreshold = 10;

      if (newX >= 0 && newX <= snapThreshold) newX = 0;
      if (newX + size.width >= viewportWidth - snapThreshold && newX + size.width <= viewportWidth) {
        newX = viewportWidth - size.width;
      }
      if (newY >= menuBarHeight && newY <= menuBarHeight + snapThreshold) newY = menuBarHeight;
      if (newY + size.height >= viewportHeight - snapThreshold && newY + size.height <= viewportHeight) {
        newY = viewportHeight - size.height;
      }

      moveWindow(id, { x: newX, y: newY });
    },
    [moveWindow, id, size.width, size.height]
  );

  const handleDragEnd = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  // ============================================
  // BODY DRAG HANDLING (Content Area)
  // ============================================

  const handleBodyDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target, windowRef.current)) return;

      const el = e.currentTarget as HTMLElement;
      const rect = el.getBoundingClientRect();
      if (e.clientX > rect.left + el.clientWidth) return;
      if (e.clientY > rect.top + el.clientHeight) return;

      e.preventDefault();
      e.stopPropagation();

      isDragging.current = true;
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };

      focusWindow(id);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [position, focusWindow, id]
  );

  // ============================================
  // RESIZE HANDLING (Bottom-Right Corner)
  // ============================================

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;

      e.preventDefault();
      e.stopPropagation();

      isResizing.current = true;
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        width: size.width,
        height: size.height,
      };

      focusWindow(id);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [size, focusWindow, id]
  );

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing.current) return;

      e.preventDefault();

      const deltaX = e.clientX - resizeStart.current.x;
      const deltaY = e.clientY - resizeStart.current.y;

      resizeWindow(id, {
        width: resizeStart.current.width + deltaX,
        height: resizeStart.current.height + deltaY,
      });
    },
    [resizeWindow, id]
  );

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!isResizing.current) return;
    isResizing.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    return () => {
      isDragging.current = false;
      isResizing.current = false;
    };
  }, []);

  return (
    <WindowChrome
      windowRef={windowRef}
      windowId={id}
      isActive={isActive}
      collapsed={!!collapsed}
      minimized={minimized}
      position={position}
      size={size}
      zIndex={zIndex}
      contentType={contentType}
      contentId={contentId}
      eosName={eosName}
      eosType={eosType}
      eosExtension={eosExtension}
      eosFolder={eosFolder}
      onPointerDown={handleWindowClick}
    >
      <WindowTitleBar
        title={title}
        isActive={isActive}
        collapsed={!!collapsed}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
      >
        <Buttons
          isActive={isActive}
          onClose={handleClose}
          onZoom={handleZoom}
          onCollapse={handleCollapse}
        />
      </WindowTitleBar>

      {/* Content Area (hidden when collapsed) */}
      {!collapsed && (
        <div
          className={`${styles.content} windowContent`}
          eos-part="content"
          onPointerDown={handleBodyDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
        >
          {children}
        </div>
      )}

      {/* Resize Handle (hidden when collapsed) */}
      {!collapsed && (
        <Resize
          isActive={isActive}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
        />
      )}
    </WindowChrome>
  );
}
