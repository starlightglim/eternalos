/**
 * Theme Store for EternalOS
 *
 * Provides switchable themes inspired by classic Mac OS versions:
 * - Mac OS 8 (default): The classic platinum look
 * - System 7: Lighter, more colorful classic Mac
 * - Mac OS 9: Refined platinum with subtle enhancements
 * - NeXT: Dark, sophisticated NeXTSTEP aesthetic
 *
 * Themes are applied by setting CSS custom properties on :root
 * Text colors are auto-calculated for optimal contrast when not specified.
 */

import { create } from 'zustand';

export type ThemeId = 'macos8' | 'system7' | 'macos9' | 'next';

/**
 * Calculate relative luminance of a hex color (WCAG formula)
 */
function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;

  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Convert hex color to RGB
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Determine if background is dark (luminance < 0.5)
 */
function isDarkColor(hex: string): boolean {
  return getLuminance(hex) < 0.4;
}

/**
 * Get optimal text color for a given background
 */
function getContrastingTextColor(bgColor: string): string {
  return isDarkColor(bgColor) ? '#FFFFFF' : '#000000';
}

/**
 * Get secondary text color (slightly muted)
 */
function getSecondaryTextColor(bgColor: string): string {
  return isDarkColor(bgColor) ? '#CCCCCC' : '#666666';
}

export interface ThemeColors {
  platinum: string;
  white: string;
  black: string;
  shadow: string;
  highlight: string;
  selection: string;
  selectionText: string;
  windowBg: string;
  titleBarActive: string;
  titleBarInactive: string;
  border: string;
  // Text colors - auto-calculated if not specified
  textColor?: string;
  textColorSecondary?: string;
  // Additional theme-specific colors
  accent?: string;
  menuBarBg?: string;
  menuBarText?: string;
}

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  colors: ThemeColors;
  // Additional theme properties
  fontSmoothing: boolean;
  windowBorderRadius: number;
}

// Theme definitions
export const THEMES: Record<ThemeId, Theme> = {
  macos8: {
    id: 'macos8',
    name: 'Mac OS 8',
    description: 'The classic Platinum appearance',
    colors: {
      platinum: '#C0C0C0',
      white: '#FFFFFF',
      black: '#000000',
      shadow: '#808080',
      highlight: '#DFDFDF',
      selection: '#000080',
      selectionText: '#FFFFFF',
      windowBg: '#FFFFFF',
      titleBarActive: '#000000',
      titleBarInactive: '#888888',
      border: '#000000',
    },
    fontSmoothing: false,
    windowBorderRadius: 0,
  },
  system7: {
    id: 'system7',
    name: 'System 7',
    description: 'Classic Mac with colorful accents',
    colors: {
      platinum: '#DDDDDD',
      white: '#FFFFFF',
      black: '#000000',
      shadow: '#666666',
      highlight: '#EEEEEE',
      selection: '#000000',
      selectionText: '#FFFFFF',
      windowBg: '#FFFFFF',
      titleBarActive: '#000000',
      titleBarInactive: '#999999',
      border: '#000000',
      accent: '#0066CC',
    },
    fontSmoothing: false,
    windowBorderRadius: 0,
  },
  macos9: {
    id: 'macos9',
    name: 'Mac OS 9',
    description: 'Refined Platinum with subtle gradients',
    colors: {
      platinum: '#CCCCCC',
      white: '#FFFFFF',
      black: '#000000',
      shadow: '#888888',
      highlight: '#E8E8E8',
      selection: '#336699',
      selectionText: '#FFFFFF',
      windowBg: '#FFFFFF',
      titleBarActive: '#000000',
      titleBarInactive: '#888888',
      border: '#000000',
      accent: '#336699',
    },
    fontSmoothing: false,
    windowBorderRadius: 0,
  },
  next: {
    id: 'next',
    name: 'NeXT',
    description: 'Dark NeXTSTEP-inspired theme',
    colors: {
      platinum: '#2A2A2A',
      white: '#333333',
      black: '#000000',
      shadow: '#1A1A1A',
      highlight: '#444444',
      selection: '#4080C0',
      selectionText: '#FFFFFF',
      windowBg: '#2A2A2A',
      titleBarActive: '#CCCCCC',
      titleBarInactive: '#666666',
      border: '#555555',
      // Explicit text colors for dark theme
      textColor: '#EEEEEE',
      textColorSecondary: '#AAAAAA',
      accent: '#4080C0',
      menuBarBg: '#1A1A1A',
      menuBarText: '#CCCCCC',
    },
    fontSmoothing: true,
    windowBorderRadius: 0,
  },
};

const THEME_STORAGE_KEY = 'eternalos-theme';

// Load theme from localStorage
function loadSavedTheme(): ThemeId {
  try {
    if (localStorage.getItem(THEME_STORAGE_KEY)) {
      localStorage.removeItem(THEME_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage errors
  }
  return 'macos8';
}

// Apply theme to document
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  const colors = theme.colors;

  // Set CSS custom properties
  root.style.setProperty('--platinum', colors.platinum);
  root.style.setProperty('--white', colors.white);
  root.style.setProperty('--black', colors.black);
  root.style.setProperty('--shadow', colors.shadow);
  root.style.setProperty('--highlight', colors.highlight);
  root.style.setProperty('--selection', colors.selection);
  root.style.setProperty('--selection-text', colors.selectionText);
  root.style.setProperty('--window-bg', colors.windowBg);
  root.style.setProperty('--title-bar-active', colors.titleBarActive);
  root.style.setProperty('--title-bar-inactive', colors.titleBarInactive);
  root.style.setProperty('--border', colors.border);

  // Text colors - use specified or auto-calculate based on background
  const textColor = colors.textColor || getContrastingTextColor(colors.platinum);
  const textColorSecondary = colors.textColorSecondary || getSecondaryTextColor(colors.platinum);
  root.style.setProperty('--text-color', textColor);
  root.style.setProperty('--text-color-secondary', textColorSecondary);

  // Window content text colors - based on window background
  const windowTextColor = colors.textColor || getContrastingTextColor(colors.windowBg);
  const windowTextSecondary = colors.textColorSecondary || getSecondaryTextColor(colors.windowBg);
  root.style.setProperty('--window-text-color', windowTextColor);
  root.style.setProperty('--window-text-secondary', windowTextSecondary);

  // Optional colors
  if (colors.accent) {
    root.style.setProperty('--accent', colors.accent);
  }
  if (colors.menuBarBg) {
    root.style.setProperty('--menu-bar-bg', colors.menuBarBg);
  }
  if (colors.menuBarText) {
    root.style.setProperty('--menu-bar-text', colors.menuBarText);
  }

  // Font smoothing
  if (theme.fontSmoothing) {
    document.body.style.setProperty('-webkit-font-smoothing', 'antialiased');
    document.body.style.setProperty('-moz-osx-font-smoothing', 'grayscale');
  } else {
    document.body.style.setProperty('-webkit-font-smoothing', 'none');
    document.body.style.setProperty('-moz-osx-font-smoothing', 'unset');
  }

  // Add theme class to body for theme-specific CSS
  document.body.classList.remove('theme-macos8', 'theme-system7', 'theme-macos9', 'theme-next');
  document.body.classList.add(`theme-${theme.id}`);
}

interface ThemeStore {
  currentTheme: ThemeId;
  setTheme: (themeId: ThemeId) => void;
  getTheme: () => Theme;
  getThemeList: () => Theme[];
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  // Apply initial theme on store creation
  const initialTheme = loadSavedTheme();

  // Apply theme after a microtask to ensure DOM is ready
  queueMicrotask(() => {
    applyTheme(THEMES[initialTheme]);
  });

  return {
    currentTheme: initialTheme,

    setTheme: (themeId: ThemeId) => {
      const theme = THEMES[themeId];
      if (!theme) return;

      // Apply theme to document
      applyTheme(theme);

      // Save to localStorage
      try {
        localStorage.setItem(THEME_STORAGE_KEY, themeId);
      } catch {
        // Ignore localStorage errors
      }

      set({ currentTheme: themeId });
    },

    getTheme: () => {
      return THEMES[get().currentTheme];
    },

    getThemeList: () => {
      return Object.values(THEMES);
    },
  };
});
