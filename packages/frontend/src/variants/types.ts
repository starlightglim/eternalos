/**
 * Variant System Types for EternalOS
 *
 * Every customizable visual element is a "slot".
 * Each slot has multiple "variants" — named implementations that can be swapped.
 */

import type { TokenDefinition } from '../tokens/tokenSchema';

// ---------------------------------------------------------------------------
// Slot IDs — every customizable visual element
// ---------------------------------------------------------------------------

export type SlotId =
  | 'window.chrome'
  | 'window.titleBar'
  | 'window.buttons'
  | 'window.resizeHandle'
  | 'menuBar'
  | 'desktop.icons'
  | 'scrollbar'
  | 'contextMenu';

/** Human-readable labels for slots */
export const SLOT_LABELS: Record<SlotId, string> = {
  'window.chrome': 'Window Frame',
  'window.titleBar': 'Title Bar',
  'window.buttons': 'Window Buttons',
  'window.resizeHandle': 'Resize Handle',
  'menuBar': 'Menu Bar',
  'desktop.icons': 'Desktop Icons',
  'scrollbar': 'Scrollbar',
  'contextMenu': 'Context Menu',
};

// ---------------------------------------------------------------------------
// Variant Definition
// ---------------------------------------------------------------------------

/**
 * Context injected into every variant component.
 */
export interface VariantContext {
  /** Whether the parent element (window, menu, etc.) is currently active/focused */
  isActive: boolean;
}

/**
 * A variant is a named implementation of a slot.
 * Some variants only differ in CSS, others have entirely different DOM structures.
 */
export interface VariantDefinition<P = Record<string, unknown>> {
  /** Unique id within the slot: e.g. 'classic', 'flat', 'gradient' */
  id: string;
  /** Which slot this variant applies to */
  slotId: SlotId;
  /** Human-readable name for the UI picker */
  label: string;
  /** Short description shown in the picker */
  description: string;
  /**
   * The React component that renders this variant.
   * Receives slot-specific props (P) plus VariantContext.
   */
  component: React.ComponentType<P & VariantContext>;
  /**
   * CSS-only variant: instead of a React component, just a CSS class or stylesheet.
   * Used for scrollbar variants where no structural DOM change is needed.
   */
  cssClass?: string;
  /**
   * Additional tokens this variant exposes.
   * These appear in the Appearance Panel ONLY when this variant is active.
   */
  tokens?: ConditionalTokenDefinition[];
  /**
   * Default token values applied when this variant is first selected.
   */
  defaults?: Record<string, string | number | boolean>;
}

/**
 * A token that only appears when a specific variant is selected.
 * Extends TokenDefinition with a condition field.
 */
export interface ConditionalTokenDefinition extends Omit<TokenDefinition, 'profileKey'> {
  profileKey: null;
  condition: { slotId: SlotId; variantId: string };
}

// ---------------------------------------------------------------------------
// Variant selections (persisted in appearance)
// ---------------------------------------------------------------------------

/** Map of slot → active variant ID */
export type VariantSelections = Partial<Record<SlotId, string>>;
