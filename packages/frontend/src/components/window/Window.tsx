import { openAppSkins } from '../../utils/appWindowBus';
import { useWindowSkinStore } from '../../stores/windowSkinStore';
import { useTilingStore } from '../../stores/tilingStore';
import { tileAt } from '../../utils/tiling';
import { memo, useRef, useCallback, useEffect, useId, useMemo } from 'react';
import { useWindowStore, clampWindowPosition } from '../../stores/windowStore';
import { useSlot } from '../../variants/useSlot';
import type { WindowButtonsSlotProps, ResizeHandleSlotProps } from '../../variants/slots';
import { WindowChrome } from '../../variants/builtin/chrome/WindowChrome';
import { WindowTitleBar } from '../../variants/builtin/titlebar/WindowTitleBar';
import { getMenuBarHeight } from '../../utils/layout';
import { createFrameCoalescer } from './frameCoalescer';
import styles from './Window.module.css';

// Tags considered interactive — clicks on these shouldn't trigger body-drag
const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'textarea', 'select',
  'video', 'audio', 'canvas', 'label', 'iframe',
]);

// Containers that handle their own pointer interactions (e.g. folder selection rect)
const INTERACTIVE_CONTAINERS = new Set(['folder-view']);

// Keyboard steps for move/resize from the focused title bar:
// 10px per press, Shift = 50px (the pointer drag's coarse counterpart).
const KEYBOARD_STEP = 10;
const KEYBOARD_STEP_LARGE = 50;

const ARROW_DELTAS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

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
 * Memoized (cheap when only children change); WindowManager's memoized
 * ManagedWindow is what keeps other windows from re-rendering during a drag.
 */
export const Window = memo(function Window({
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
  // One selector per action: a bare useWindowStore() would re-render every
  // window on every store change (each pointermove of any drag).
  const closeWindow = useWindowStore((state) => state.closeWindow);
  const focusWindow = useWindowStore((state) => state.focusWindow);
  const moveWindow = useWindowStore((state) => state.moveWindow);
  const resizeWindow = useWindowStore((state) => state.resizeWindow);
  const toggleCollapse = useWindowStore((state) => state.toggleCollapse);
  const toggleMaximize = useWindowStore((state) => state.toggleMaximize);
  const titleId = useId();

  // Resolve active variant components for leaf slots (safe to swap)
  // Chrome and TitleBar use stable unified components (CSS-driven variants)
  // to avoid remounting children when variant changes
  const Buttons = useSlot<WindowButtonsSlotProps>('window.buttons');
  const Resize = useSlot<ResizeHandleSlotProps>('window.resizeHandle');

  // Shaped, frameless window from the app's skin (see windowSkinStore).
  const skinChrome = useWindowSkinStore((state) => state.chrome[id]);
  const tiled = useTilingStore((state) => Boolean(state.active && state.tiles[id]));
  const frameless = Boolean(skinChrome?.frameless) && contentType === 'app';
  const shapeStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!skinChrome || contentType !== 'app') return undefined;
    const style: React.CSSProperties = {};
    if (skinChrome.clipPath) {
      style.clipPath = skinChrome.clipPath;
      style.WebkitClipPath = skinChrome.clipPath;
    }
    if (skinChrome.maskUrl && /^data:image\/(png|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(skinChrome.maskUrl)) {
      const mask = `url("${skinChrome.maskUrl}")`;
      Object.assign(style, { maskImage: mask, WebkitMaskImage: mask, maskSize: '100% 100%', WebkitMaskSize: '100% 100%', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat' });
    }
    if (skinChrome.frameless) {
      style.background = 'transparent';
      style.pointerEvents = 'auto';
    }
    return style;
  }, [skinChrome, contentType]);

  const windowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const isResizing = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const lastClickTime = useRef(0);
  // Pending body-drag: press started on non-interactive content, but the drag
  // only begins once the pointer moves past a threshold (keeps clicks working).
  const bodyDragPending = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  // Pointer driving the current drag/resize (cancellation must match it).
  const activePointerId = useRef<number | null>(null);
  // Element holding our pointer capture: only its lostpointercapture counts
  // (moving capture off a child that touch captured implicitly fires one on
  // the child, which must not abort the drag that just started).
  const captureTarget = useRef<EventTarget | null>(null);

  // pointermove fires faster than frames paint: write at most one geometry
  // update per animation frame. pointerup/cancel flush the final value.
  const moveFrames = useMemo(
    () => createFrameCoalescer<{ x: number; y: number }>((next) => moveWindow(id, next)),
    [moveWindow, id]
  );
  const resizeFrames = useMemo(
    () => createFrameCoalescer<{ width: number; height: number }>((next) => resizeWindow(id, next)),
    [resizeWindow, id]
  );
  useEffect(() => () => {
    moveFrames.cancel();
    resizeFrames.cancel();
  }, [moveFrames, resizeFrames]);

  // Focus window on any click
  const handleWindowClick = useCallback(() => {
    focusWindow(id);
  }, [focusWindow, id]);

  // Close button handler
  const handleClose = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();
      closeWindow(id);
    },
    [closeWindow, id]
  );

  // Collapse button handler (window shade)
  const handleCollapse = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();
      toggleCollapse(id);
    },
    [toggleCollapse, id]
  );

  // Zoom button handler (maximize/restore)
  const handleZoom = useCallback(
    (e: React.SyntheticEvent) => {
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
      activePointerId.current = e.pointerId;
      dragOffset.current = {
        x: e.clientX - position.x,
        y: e.clientY - position.y,
      };

      focusWindow(id);
      // Tiled windows: pause tiling while dragging; the drop swaps tiles.
      if (useTilingStore.getState().tiles[id]) useTilingStore.getState().setDragging(id);
      captureTarget.current = e.target;
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
      const menuBarHeight = getMenuBarHeight();

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

      moveFrames.push({ x: newX, y: newY });
    },
    [moveFrames, size.width, size.height]
  );

  const handleDragEnd = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    isDragging.current = false;
    activePointerId.current = null;
    captureTarget.current = null;
    moveFrames.flush();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone (released implicitly on pointerup).
    }
    const tiling = useTilingStore.getState();
    if (tiling.dragging === id) {
      // Tiles are in desktop coordinates (the desktop starts below the menu bar).
      const desktop = windowRef.current?.offsetParent?.getBoundingClientRect();
      const target = tileAt(tiling.tiles, e.clientX - (desktop?.left ?? 0), e.clientY - (desktop?.top ?? 0), id);
      if (target) tiling.swap(id, target);
      tiling.setDragging(null);
    }
  }, [id, moveFrames]);

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

      // Don't hijack the press here: elements like list rows and tabs are
      // plain divs with onClick handlers, and capturing the pointer on
      // pointerdown would swallow their click. Record the press and only
      // start dragging once the pointer actually moves (see handleBodyDragMove).
      bodyDragPending.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
      focusWindow(id);
    },
    [focusWindow, id]
  );

  const handleBodyDragMove = useCallback(
    (e: React.PointerEvent) => {
      const pending = bodyDragPending.current;
      if (!isDragging.current && pending && e.pointerId === pending.pointerId) {
        // Primary button released outside the window — abandon the pending drag
        if ((e.buttons & 1) === 0) {
          bodyDragPending.current = null;
          return;
        }
        const distance = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
        if (distance < 5) return;

        isDragging.current = true;
        activePointerId.current = e.pointerId;
        dragOffset.current = {
          x: pending.x - position.x,
          y: pending.y - position.y,
        };
        bodyDragPending.current = null;
        if (useTilingStore.getState().tiles[id]) useTilingStore.getState().setDragging(id);
        try {
          captureTarget.current = e.currentTarget;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // Pointer may already be released (e.g. touch cancel race)
        }
      }

      handleDragMove(e);
    },
    [handleDragMove, position, id]
  );

  const handleBodyDragEnd = useCallback(
    (e: React.PointerEvent) => {
      bodyDragPending.current = null;
      handleDragEnd(e);
    },
    [handleDragEnd]
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
      activePointerId.current = e.pointerId;
      resizeStart.current = {
        x: e.clientX,
        y: e.clientY,
        width: size.width,
        height: size.height,
      };

      focusWindow(id);
      captureTarget.current = e.target;
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

      resizeFrames.push({
        width: resizeStart.current.width + deltaX,
        height: resizeStart.current.height + deltaY,
      });
    },
    [resizeFrames]
  );

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    if (!isResizing.current) return;
    isResizing.current = false;
    activePointerId.current = null;
    captureTarget.current = null;
    resizeFrames.flush();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Capture may already be gone (released implicitly on pointerup).
    }
  }, [resizeFrames]);

  // ============================================
  // CANCELLATION (pointercancel / lostpointercapture)
  // ============================================
  //
  // A cancelled touch (scroll takeover, OS gesture, palm rejection) or a
  // capture stolen mid-drag never sends pointerup. Without this the window
  // stays glued to the pointer and tiling stays paused. Both events bubble
  // to the window root from the title bar, body, resize handle or skin
  // handle. The window keeps the last position it reached; a tiled drag is
  // abandoned without a swap (the layout re-tiles it).

  const abortInteraction = useCallback(() => {
    if (isDragging.current) moveFrames.flush();
    if (isResizing.current) resizeFrames.flush();
    isDragging.current = false;
    isResizing.current = false;
    activePointerId.current = null;
    captureTarget.current = null;
    bodyDragPending.current = null;
    const tiling = useTilingStore.getState();
    if (tiling.dragging === id) tiling.setDragging(null);
  }, [id, moveFrames, resizeFrames]);

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (bodyDragPending.current?.pointerId === e.pointerId) bodyDragPending.current = null;
      if ((isDragging.current || isResizing.current) && activePointerId.current === e.pointerId) {
        abortInteraction();
      }
    },
    [abortInteraction]
  );

  const handleLostPointerCapture = useCallback(
    (e: React.PointerEvent) => {
      // Normal ends reset state in pointerup before capture is released, so
      // this only fires for a drag/resize whose capture vanished mid-way.
      if (
        (isDragging.current || isResizing.current) &&
        activePointerId.current === e.pointerId &&
        e.target === captureTarget.current
      ) {
        abortInteraction();
      }
    },
    [abortInteraction]
  );

  // ============================================
  // KEYBOARD HANDLING (title bar is the focus surface)
  // ============================================
  //
  // With the title bar focused (it is the window's first tab stop once
  // focus enters the window — by pointer click, or by Tabbing from any
  // focusable the window hosts):
  //   - arrows move the window (10px; Shift = 50px)
  //   - Alt/Option+arrows resize it (same steps, bottom-right-corner
  //     semantics: the store's resizeWindow enforces the 200x150 minimum,
  //     growing stops at the viewport edge)
  //   - Escape returns focus to the window content
  //   - Alt/Option+W closes (documented: the MenuBar's global Ctrl/Cmd+W
  //     shortcut is reserved by browsers — the tab closes before the page
  //     sees the keydown — so the title-bar surface uses Alt+W, which no
  //     browser or existing app shortcut claims)
  // Every handled key is stopped at the title bar so the document-level
  // shortcuts (Desktop icon navigation, MenuBar ⌘-keys) never double-fire.

  const handleTitleBarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Tab keeps the browser's native focus order (title bar → close →
      // zoom → collapse → content), but must not reach Desktop's
      // document-level icon-cycling handler, which hijacks every Tab that
      // doesn't start inside a text input.
      if (e.key === 'Tab') {
        e.stopPropagation();
        return;
      }

      const hasOsModifier = e.metaKey || e.ctrlKey;

      // Close shortcut — Alt/Option+W. Matched on `code` as well as `key`
      // because macOS Option+W reports key = "Ω".
      if (e.altKey && !hasOsModifier && (e.code === 'KeyW' || e.key === 'w' || e.key === 'W')) {
        e.preventDefault();
        e.stopPropagation();
        closeWindow(id);
        return;
      }

      // Escape returns focus to the window content. (When collapsed the
      // content isn't rendered; the focus simply stays.)
      if (e.key === 'Escape' && !e.altKey && !hasOsModifier) {
        e.preventDefault();
        e.stopPropagation();
        contentRef.current?.focus();
        return;
      }

      // The title bar is a toolbar, not a button: Enter/Space on it do
      // nothing, and must not leak to the document shortcuts (Enter there
      // opens the selected desktop icon). The close/zoom/collapse buttons
      // inside stop their own Enter/Space before they bubble this far.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      const delta = ARROW_DELTAS[e.key];
      // Leave OS/browser arrow combos (Cmd+Arrow, Ctrl+Arrow…) alone.
      if (!delta || hasOsModifier) return;

      e.preventDefault();
      e.stopPropagation();

      // Read the window's current geometry from the store rather than the
      // props: repeated keydowns can arrive between re-renders, and each
      // step must accumulate from the freshest committed position/size.
      const current = useWindowStore.getState().windows.find((w) => w.id === id);
      if (!current) return;

      const step = e.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;

      if (e.altKey) {
        // Resize with the bottom-right corner's semantics.
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;
        const next = { width: current.size.width, height: current.size.height };

        if (delta.x !== 0) {
          const desired = current.size.width + delta.x * step;
          if (delta.x > 0) {
            // Don't grow past the viewport's right edge — unless the window
            // already extends past it, in which case growing from there is
            // still refused (it can only stay or shrink back).
            const maxWidth = Math.max(viewportWidth - current.position.x, current.size.width);
            next.width = Math.min(desired, maxWidth);
          } else {
            // Shrinking flows through resizeWindow, which floors the
            // 200px minimum.
            next.width = desired;
          }
        }
        if (delta.y !== 0) {
          const desired = current.size.height + delta.y * step;
          if (delta.y > 0) {
            const maxHeight = Math.max(viewportHeight - current.position.y, current.size.height);
            next.height = Math.min(desired, maxHeight);
          } else {
            next.height = desired;
          }
        }

        resizeWindow(id, next);
      } else {
        // Move, clamped by the same rule the store applies on open and on
        // viewport resize (clampWindowPosition), so a keyboard move can
        // never push a window off-screen.
        moveWindow(
          id,
          clampWindowPosition(
            {
              x: current.position.x + delta.x * step,
              y: current.position.y + delta.y * step,
            },
            current.size
          )
        );
      }
    },
    [closeWindow, moveWindow, resizeWindow, id]
  );

  // Focusing the title bar (or a control inside it) raises the window,
  // mirroring what the pointer path does on every press.
  const handleTitleBarFocus = useCallback(() => {
    focusWindow(id);
  }, [focusWindow, id]);

  // Same Tab contract for the content area: Tab stays native inside the
  // window (it already did inside inputs; now it does from any focusable
  // the content hosts) instead of cycling desktop icons underneath.
  const handleContentKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Tab') e.stopPropagation();
  }, []);

  useEffect(() => {
    return () => {
      isDragging.current = false;
      isResizing.current = false;
      // Closed mid-drag: don't leave tiling paused on a window that's gone.
      const tiling = useTilingStore.getState();
      if (tiling.dragging === id) tiling.setDragging(null);
    };
  }, [id]);

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
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handleLostPointerCapture}
      titleId={titleId}
      frameless={frameless}
    >
      {frameless ? (
        // Frameless skin: no title bar, but the window can always be moved,
        // identified and closed from this handle (it can't hide what it is).
        <div
          className={styles.skinHandle}
          eos-part="skin-handle"
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          onContextMenu={(event) => { if (openAppSkins(id)) event.preventDefault(); }}
          title={`${title} — drag to move, right-click for skins`}
        >
          <span id={titleId} className={styles.skinHandleTitle}>{title}</span>
          <button type="button" className={styles.skinHandleClose} onPointerDown={(event) => event.stopPropagation()} onClick={handleClose} aria-label={`Close ${title}`}>×</button>
        </div>
      ) : (
      <WindowTitleBar
        title={title}
        titleId={titleId}
        isActive={isActive}
        collapsed={!!collapsed}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onKeyDown={handleTitleBarKeyDown}
        onFocus={handleTitleBarFocus}
        onContextMenu={contentType === 'app' ? (event) => {
          if (openAppSkins(id)) event.preventDefault();
        } : undefined}
      >
        <Buttons
          isActive={isActive}
          onClose={handleClose}
          onZoom={handleZoom}
          onCollapse={handleCollapse}
        />
      </WindowTitleBar>
      )}

      {/* Content Area (hidden when collapsed) */}
      {!collapsed && (
        <div
          ref={contentRef}
          className={`${styles.content} windowContent`}
          eos-part="content"
          // Programmatically focusable so Escape from the title bar can
          // hand focus back to the content; not a Tab stop itself.
          tabIndex={-1}
          onPointerDown={handleBodyDragStart}
          onPointerMove={handleBodyDragMove}
          onPointerUp={handleBodyDragEnd}
          onKeyDown={handleContentKeyDown}
          style={shapeStyle}
        >
          {children}
        </div>
      )}

      {/* Resize Handle (hidden when collapsed, or a skin fixed the size) */}
      {!collapsed && !tiled && !(skinChrome?.size && contentType === 'app') && (
        <Resize
          isActive={isActive}
          onResizeStart={handleResizeStart}
          onResizeMove={handleResizeMove}
          onResizeEnd={handleResizeEnd}
        />
      )}
    </WindowChrome>
  );
});
