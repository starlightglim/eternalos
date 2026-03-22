/**
 * Variant Registry for EternalOS
 *
 * Singleton registry that maps SlotId → variant implementations.
 * Plugins and built-in variants register themselves here.
 */

import type { SlotId, VariantDefinition, ConditionalTokenDefinition } from './types';

class VariantRegistry {
  private variants = new Map<SlotId, Map<string, VariantDefinition>>();
  private conditionalTokens: ConditionalTokenDefinition[] = [];

  /**
   * Register a variant for a slot.
   * The first variant registered for a slot becomes the default.
   */
  register<P>(definition: VariantDefinition<P>): void {
    if (!this.variants.has(definition.slotId)) {
      this.variants.set(definition.slotId, new Map());
    }
    this.variants.get(definition.slotId)!.set(
      definition.id,
      definition as VariantDefinition
    );

    // Register conditional tokens
    if (definition.tokens) {
      for (const token of definition.tokens) {
        // Avoid duplicates
        const exists = this.conditionalTokens.some(
          (t) => t.path === token.path
        );
        if (!exists) {
          this.conditionalTokens.push(token);
        }
      }
    }
  }

  /** Get a specific variant by slot and ID */
  get(slotId: SlotId, variantId: string): VariantDefinition | undefined {
    return this.variants.get(slotId)?.get(variantId);
  }

  /** Get all variants for a slot */
  getAll(slotId: SlotId): VariantDefinition[] {
    return [...(this.variants.get(slotId)?.values() ?? [])];
  }

  /** Get the default variant ID for a slot (first registered) */
  getDefault(slotId: SlotId): string {
    const first = this.variants.get(slotId)?.values().next().value;
    return first?.id ?? 'classic';
  }

  /** Get all conditional tokens registered by variants */
  getConditionalTokens(): ConditionalTokenDefinition[] {
    return this.conditionalTokens;
  }

  /** Get conditional tokens that are active given current variant selections */
  getActiveConditionalTokens(
    activeVariants: Partial<Record<SlotId, string>>
  ): ConditionalTokenDefinition[] {
    return this.conditionalTokens.filter((token) => {
      const activeForSlot = activeVariants[token.condition.slotId];
      return activeForSlot === token.condition.variantId;
    });
  }
}

export const variantRegistry = new VariantRegistry();
