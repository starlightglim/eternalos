/**
 * Slot-specific prop interfaces for EternalOS Variant System
 *
 * Each slot defines the props its variant components receive.
 * All variant components also receive VariantContext (isActive).
 */

import type React from 'react';

// ---------------------------------------------------------------------------
// Window Slots
// ---------------------------------------------------------------------------

/** Props for window chrome variants (the outer frame) */
export interface WindowChromeSlotProps {
  windowRef: React.RefObject<HTMLDivElement | null>;
  windowId: string;
  isActive: boolean;
  collapsed: boolean;
  minimized: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  contentType?: string;
  contentId?: string;
  eosName?: string;
  eosType?: string;
  eosExtension?: string;
  eosFolder?: string;
  onPointerDown: (e: React.PointerEvent) => void;
  /** A skin made this window frameless (no frame, no shadow, overflow visible). */
  frameless?: boolean;
  children: React.ReactNode;
}

/** Props for title bar variants */
export interface TitleBarSlotProps {
  title: string;
  isActive: boolean;
  collapsed: boolean;
  onDragStart: (e: React.PointerEvent) => void;
  onDragMove: (e: React.PointerEvent) => void;
  onDragEnd: (e: React.PointerEvent) => void;
  /**
   * Keyboard control of the window (arrow move/resize, Escape, close
   * shortcut). The title bar is the keyboard surface: it is focusable and
   * its keydown handler implements the window's keyboard contract.
   */
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** Raised when the title bar (or a control inside it) gains focus. */
  onFocus: () => void;
  /** Right-click on the title bar (app windows open their Skins panel). */
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}

/**
 * Props for window button variants (close/zoom/collapse).
 * The actions accept any SyntheticEvent because they fire from both click
 * (pointer) and Enter/Space keydown (keyboard activation).
 */
export interface WindowButtonsSlotProps {
  isActive: boolean;
  onClose: (e: React.SyntheticEvent) => void;
  onZoom: (e: React.SyntheticEvent) => void;
  onCollapse: (e: React.SyntheticEvent) => void;
}

/** Props for resize handle variants */
export interface ResizeHandleSlotProps {
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}
