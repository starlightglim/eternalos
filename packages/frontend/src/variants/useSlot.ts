/**
 * useSlot Hook for EternalOS Variant System
 *
 * Resolves the active variant component for a given slot
 * by reading the variant selection from the appearance store.
 */

import { useMemo } from 'react';
import { useAppearanceStore } from '../stores/appearanceStore';
import { variantRegistry } from './registry';
import type { SlotId, VariantContext } from './types';

// Ensure builtins are always registered (safe to call multiple times)
import { registerBuiltinVariants } from './registerBuiltins';
registerBuiltinVariants();

/**
 * Returns the React component for the active variant of a slot.
 *
 * Usage:
 *   const TitleBar = useSlot<TitleBarSlotProps>('window.titleBar');
 *   return <TitleBar title="Hello" isActive={true} ... />;
 */
export function useSlot<P = Record<string, unknown>>(
  slotId: SlotId
): React.ComponentType<P & VariantContext> {
  const activeVariantId = useAppearanceStore(
    (s) => s.appearance.variants?.[slotId]
  );

  return useMemo(() => {
    const id = activeVariantId ?? variantRegistry.getDefault(slotId);
    const definition = variantRegistry.get(slotId, id);

    if (definition) {
      return definition.component as React.ComponentType<P & VariantContext>;
    }

    // Fallback: try first registered variant for this slot
    const allVariants = variantRegistry.getAll(slotId);
    if (allVariants.length > 0) {
      return allVariants[0].component as React.ComponentType<P & VariantContext>;
    }

    // Should never reach here if registerBuiltins ran
    throw new Error(`No variants registered for slot "${slotId}"`);
  }, [slotId, activeVariantId]);
}
