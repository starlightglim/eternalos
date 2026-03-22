/**
 * VariantPicker — Visual grid of variant cards with inline mini-previews.
 * Users click to swap variants for a given slot.
 */

import { useAppearanceStore } from '../../stores/appearanceStore';
import { variantRegistry } from '../../variants/registry';
import type { SlotId } from '../../variants/types';
import styles from './VariantPicker.module.css';

interface VariantPickerProps {
  slotId: SlotId;
  label: string;
}

/** Inline SVG mini-previews for each variant, keyed by slotId.variantId */
function VariantPreview({ slotId, variantId }: { slotId: SlotId; variantId: string }) {
  const key = `${slotId}:${variantId}`;

  switch (key) {
    // -- Window Chrome --
    case 'window.chrome:beveled':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="4" y="4" width="48" height="24" fill="#fff" stroke="#000" strokeWidth="1.5" />
          <rect x="5.5" y="5.5" width="45" height="21" fill="none" stroke="#ddd" strokeWidth="1" />
          <rect x="4" y="4" width="48" height="8" fill="#C0C0C0" stroke="#000" strokeWidth="1.5" />
          <line x1="4" y1="12" x2="52" y2="12" stroke="#000" strokeWidth="1" />
        </svg>
      );
    case 'window.chrome:flat':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="4" y="4" width="48" height="24" fill="#fff" stroke="#000" strokeWidth="1" />
          <rect x="4" y="4" width="48" height="8" fill="#E0E0E0" stroke="#000" strokeWidth="1" />
          <line x1="4" y1="12" x2="52" y2="12" stroke="#000" strokeWidth="0.5" />
        </svg>
      );
    case 'window.chrome:floating':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <defs>
            <filter id="fs" x="-2" y="-1" width="60" height="36">
              <feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity="0.18" />
            </filter>
          </defs>
          <rect x="6" y="4" width="44" height="22" rx="4" fill="#fff" filter="url(#fs)" />
          <rect x="6" y="4" width="44" height="8" rx="4" fill="#E8E8E8" />
          <rect x="6" y="8" width="44" height="4" fill="#E8E8E8" />
        </svg>
      );

    // -- Title Bar --
    case 'window.titleBar:classic':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="2" y="8" width="52" height="16" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
          {/* Stripes */}
          {[10, 12, 14, 16, 18, 20].map((y) => (
            <line key={y} x1="4" y1={y} x2="52" y2={y} stroke="#000" strokeWidth="0.5" opacity="0.4" />
          ))}
          <rect x="16" y="12" width="24" height="8" fill="#C0C0C0" />
          <text x="28" y="18.5" textAnchor="middle" fontSize="6" fontFamily="Chicago, sans-serif" fill="#000">Title</text>
        </svg>
      );
    case 'window.titleBar:flat':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="2" y="8" width="52" height="16" fill="#D8D8D8" stroke="#000" strokeWidth="1" />
          <text x="28" y="18.5" textAnchor="middle" fontSize="6" fontFamily="Geneva, sans-serif" fill="#000">Title</text>
        </svg>
      );
    case 'window.titleBar:gradient':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <defs>
            <linearGradient id="tg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4080C0" />
              <stop offset="100%" stopColor="#1A3050" />
            </linearGradient>
          </defs>
          <rect x="2" y="8" width="52" height="16" fill="url(#tg)" stroke="#000" strokeWidth="1" />
          <text x="28" y="18.5" textAnchor="middle" fontSize="6" fontFamily="Geneva, sans-serif" fill="#fff">Title</text>
        </svg>
      );

    // -- Window Buttons --
    case 'window.buttons:square':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="4" y="10" width="11" height="11" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
          <rect x="20" y="10" width="11" height="11" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
          <rect x="36" y="10" width="11" height="11" fill="#C0C0C0" stroke="#000" strokeWidth="1" />
        </svg>
      );
    case 'window.buttons:circle':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <circle cx="12" cy="16" r="5" fill="#FF5F57" stroke="#E0443E" strokeWidth="0.8" />
          <circle cx="26" cy="16" r="5" fill="#FFBD2E" stroke="#DEA123" strokeWidth="0.8" />
          <circle cx="40" cy="16" r="5" fill="#28C840" stroke="#1AAB29" strokeWidth="0.8" />
        </svg>
      );
    case 'window.buttons:text':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <text x="10" y="19" fontSize="9" fontFamily="monospace" fill="#000">&times;</text>
          <text x="24" y="19" fontSize="9" fontFamily="monospace" fill="#000">+</text>
          <text x="38" y="19" fontSize="9" fontFamily="monospace" fill="#000">&ndash;</text>
        </svg>
      );
    case 'window.buttons:hidden':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="4" y="10" width="48" height="12" rx="2" fill="#F5F5F5" stroke="#DDD" strokeWidth="0.5" strokeDasharray="2 2" />
          <text x="28" y="18.5" textAnchor="middle" fontSize="6" fill="#AAA" fontFamily="Geneva, sans-serif">hover</text>
        </svg>
      );

    // -- Resize Handle --
    case 'window.resizeHandle:lines':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="2" y="2" width="52" height="28" fill="#fff" stroke="#ccc" strokeWidth="0.5" />
          {/* Diagonal grip lines */}
          <line x1="38" y1="28" x2="50" y2="16" stroke="#888" strokeWidth="1" />
          <line x1="42" y1="28" x2="50" y2="20" stroke="#888" strokeWidth="1" />
          <line x1="46" y1="28" x2="50" y2="24" stroke="#888" strokeWidth="1" />
        </svg>
      );
    case 'window.resizeHandle:dot':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="2" y="2" width="52" height="28" fill="#fff" stroke="#ccc" strokeWidth="0.5" />
          <circle cx="48" cy="26" r="2.5" fill="#888" />
        </svg>
      );
    case 'window.resizeHandle:hidden':
      return (
        <svg viewBox="0 0 56 32" fill="none">
          <rect x="2" y="2" width="52" height="28" fill="#fff" stroke="#ccc" strokeWidth="0.5" />
          <text x="28" y="18" textAnchor="middle" fontSize="6" fill="#BBB" fontFamily="Geneva, sans-serif">none</text>
        </svg>
      );

    default:
      return null;
  }
}

export function VariantPicker({ slotId, label }: VariantPickerProps) {
  const variants = variantRegistry.getAll(slotId);
  const activeId = useAppearanceStore(
    (s) => s.appearance.variants?.[slotId] ?? variantRegistry.getDefault(slotId)
  );
  const updateAppearance = useAppearanceStore((s) => s.updateAppearance);

  if (variants.length <= 1) return null;

  const handleSelect = (variantId: string) => {
    const def = variantRegistry.get(slotId, variantId);
    const currentAppearance = useAppearanceStore.getState().appearance;

    const newVariants = {
      ...(currentAppearance.variants || {}),
      [slotId]: variantId,
    };

    // Apply variant's default token values if switching to a new variant
    if (def?.defaults) {
      const newDesignTokens = { ...(currentAppearance.designTokens || {}), ...def.defaults };
      updateAppearance({ variants: newVariants, designTokens: newDesignTokens });
    } else {
      updateAppearance({ variants: newVariants });
    }
  };

  const activeLabel = variants.find((v) => v.id === activeId)?.label;

  return (
    <div className={styles.variantPicker}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionTitle}>{label}</div>
        {activeLabel && <div className={styles.activeLabel}>{activeLabel}</div>}
      </div>
      <div className={styles.variantGrid}>
        {variants.map((v) => (
          <button
            key={v.id}
            className={`${styles.variantCard} ${activeId === v.id ? styles.variantCardActive : ''}`}
            onClick={() => handleSelect(v.id)}
            type="button"
            title={v.description}
          >
            <div className={styles.preview}>
              <VariantPreview slotId={slotId} variantId={v.id} />
            </div>
            <div className={styles.variantLabel}>{v.label}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
