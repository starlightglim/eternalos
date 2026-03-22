/**
 * Font Catalog for EternalOS
 *
 * Single source of truth for all available fonts.
 * Font IDs are stored in the user profile; CSS font-family stacks are derived here.
 */

export interface FontEntry {
  label: string;
  family: string; // CSS font-family value
  category: 'system' | 'pixel' | 'modern' | 'mono';
}

export const FONT_CATALOG: Record<string, FontEntry> = {
  // System fonts (bundled via @font-face in global.css)
  chicago:      { label: 'Chicago',         family: "'ChiKareGo2', 'VT323', 'Chicago', 'Charcoal', monospace", category: 'system' },
  geneva:       { label: 'Geneva',          family: "'Geneva', 'VT323', 'Helvetica', sans-serif",              category: 'system' },
  monaco:       { label: 'Monaco',          family: "'Monaco', 'VT323', 'Courier New', monospace",             category: 'system' },

  // Pixel / retro (loaded via Google Fonts)
  vt323:        { label: 'VT323',           family: "'VT323', monospace",            category: 'pixel' },
  silkscreen:   { label: 'Silkscreen',      family: "'Silkscreen', monospace",       category: 'pixel' },
  pressStart:   { label: 'Press Start 2P',  family: "'Press Start 2P', monospace",   category: 'pixel' },

  // Modern sans (loaded via Google Fonts)
  inter:        { label: 'Inter',           family: "'Inter', sans-serif",           category: 'modern' },
  dmSans:       { label: 'DM Sans',         family: "'DM Sans', sans-serif",         category: 'modern' },

  // Monospace (loaded via Google Fonts)
  ibmPlexMono:  { label: 'IBM Plex Mono',   family: "'IBM Plex Mono', monospace",    category: 'mono' },
  spaceMono:    { label: 'Space Mono',       family: "'Space Mono', monospace",       category: 'mono' },
  courierPrime: { label: 'Courier Prime',   family: "'Courier Prime', monospace",    category: 'mono' },
  dmMono:       { label: 'DM Mono',         family: "'DM Mono', monospace",          category: 'mono' },
};

/**
 * Resolve a font ID to a CSS font-family value.
 * Returns the default stack for the slot if the ID is unknown.
 */
export function resolveFontFamily(fontId: string | undefined, fallbackId: string): string {
  if (fontId && FONT_CATALOG[fontId]) {
    return FONT_CATALOG[fontId].family;
  }
  return FONT_CATALOG[fallbackId]?.family ?? fontId ?? 'monospace';
}

/**
 * Group fonts by category for the picker UI.
 */
export function getFontsByCategory(): Record<string, Array<{ id: string } & FontEntry>> {
  const grouped: Record<string, Array<{ id: string } & FontEntry>> = {};
  for (const [id, entry] of Object.entries(FONT_CATALOG)) {
    if (!grouped[entry.category]) {
      grouped[entry.category] = [];
    }
    grouped[entry.category].push({ id, ...entry });
  }
  return grouped;
}

/**
 * Validate that a font ID exists in the catalog.
 */
export function isValidFontId(id: string): boolean {
  return id in FONT_CATALOG;
}
