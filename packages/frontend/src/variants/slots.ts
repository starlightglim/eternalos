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
  children: React.ReactNode;
}

/** Props for window button variants (close/zoom/collapse) */
export interface WindowButtonsSlotProps {
  isActive: boolean;
  onClose: (e: React.MouseEvent) => void;
  onZoom: (e: React.MouseEvent) => void;
  onCollapse: (e: React.MouseEvent) => void;
}

/** Props for resize handle variants */
export interface ResizeHandleSlotProps {
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
}
