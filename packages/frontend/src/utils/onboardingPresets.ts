import type { DesktopItem } from '../types';
import type { CustomAppearance } from '../stores/appearanceStore';
import { isDarkColor, getContrastingTextColor } from './colorUtils';

export const CUSTOM_CSS_FOLDER_NAME = 'Custom CSS';
export const ONBOARDING_THEME_FILENAME = 'Starter Theme.css';

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  wallpaper: string;
  highlights: [string, string, string];
  appearance: CustomAppearance;
  preview: {
    desktop: string;
    titleBar: string;
    window: string;
    accent: string;
    label: string;
  };
}

function getReadableText(hex: string, muted = false): string {
  if (muted) {
    return isDarkColor(hex) ? '#CFCFCF' : '#666666';
  }
  return getContrastingTextColor(hex);
}

function getWindowShadow(windowShadow: number): string {
  return `0 ${Math.max(2, windowShadow / 2)}px ${Math.max(4, windowShadow)}px rgba(0, 0, 0, ${Math.min(0.45, 0.16 + windowShadow / 64)})`;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Clean platinum desktop with sharp contrast.',
    wallpaper: 'default',
    highlights: ['Classic platinum chrome', 'Square, crisp windows', 'Easy to keep customizing'],
    appearance: {
      accentColor: '#000080',
      desktopColor: '#C0C0C0',
      windowBgColor: '#FFFFFF',
      titleBarBgColor: '#D9D9D9',
      titleBarTextColor: '#000000',
      windowBorderColor: '#000000',
      buttonBgColor: '#C0C0C0',
      buttonTextColor: '#000000',
      buttonBorderColor: '#000000',
      labelColor: '#000000',
      fontSmoothing: false,
      windowBorderRadius: 0,
      controlBorderRadius: 2,
      windowShadow: 2,
    },
    preview: {
      desktop: '#C0C0C0',
      titleBar: '#D9D9D9',
      window: '#FFFFFF',
      accent: '#000080',
      label: '#000000',
    },
  },
  {
    id: 'colorful',
    name: 'Colorful',
    description: 'Bright candy palette with softer corners.',
    wallpaper: 'dots',
    highlights: ['Pastel chrome and accents', 'Rounded controls and windows', 'Playful icon labels'],
    appearance: {
      accentColor: '#FF6B6B',
      desktopColor: '#87CEEB',
      windowBgColor: '#FFF8E7',
      titleBarBgColor: '#FFD1DC',
      titleBarTextColor: '#6A1E35',
      windowBorderColor: '#CC5875',
      buttonBgColor: '#FFE7AF',
      buttonTextColor: '#5A3410',
      buttonBorderColor: '#CC5875',
      labelColor: '#163B58',
      fontSmoothing: false,
      windowBorderRadius: 7,
      controlBorderRadius: 9,
      windowShadow: 10,
    },
    preview: {
      desktop: '#87CEEB',
      titleBar: '#FFD1DC',
      window: '#FFF8E7',
      accent: '#FF6B6B',
      label: '#163B58',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Moody workstation with softer text and depth.',
    wallpaper: 'default',
    highlights: ['Low-glare surfaces', 'Deeper shadows', 'Readable light labels'],
    appearance: {
      accentColor: '#4080C0',
      desktopColor: '#1A1A1A',
      windowBgColor: '#2A2A2A',
      titleBarBgColor: '#101820',
      titleBarTextColor: '#E6EEF7',
      windowBorderColor: '#607080',
      buttonBgColor: '#303945',
      buttonTextColor: '#F5F7FA',
      buttonBorderColor: '#607080',
      labelColor: '#F5F7FA',
      fontSmoothing: true,
      windowBorderRadius: 4,
      controlBorderRadius: 6,
      windowShadow: 16,
    },
    preview: {
      desktop: '#1A1A1A',
      titleBar: '#101820',
      window: '#2A2A2A',
      accent: '#4080C0',
      label: '#F5F7FA',
    },
  },
  {
    id: 'retro',
    name: 'Retro',
    description: 'Dusty teal desktop with warmer document tones.',
    wallpaper: 'diagonal',
    highlights: ['Vintage teal desktop', 'Warm paper-like windows', 'Softer utility chrome'],
    appearance: {
      accentColor: '#336699',
      desktopColor: '#668B8B',
      windowBgColor: '#FFFAF0',
      titleBarBgColor: '#C8C2B5',
      titleBarTextColor: '#1E2E39',
      windowBorderColor: '#2D4F4F',
      buttonBgColor: '#E8DDC5',
      buttonTextColor: '#2C2418',
      buttonBorderColor: '#2D4F4F',
      labelColor: '#102020',
      fontSmoothing: false,
      windowBorderRadius: 2,
      controlBorderRadius: 3,
      windowShadow: 6,
    },
    preview: {
      desktop: '#668B8B',
      titleBar: '#C8C2B5',
      window: '#FFFAF0',
      accent: '#336699',
      label: '#102020',
    },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    description: 'Green-on-black CRT terminal aesthetic.',
    wallpaper: 'default',
    highlights: ['Phosphor green text', 'Zero radius, hard edges', 'VT323 pixel font'],
    appearance: {
      accentColor: '#33FF33',
      desktopColor: '#0A0A0A',
      windowBgColor: '#0D0D0D',
      titleBarBgColor: '#1A1A1A',
      titleBarTextColor: '#33FF33',
      windowBorderColor: '#33FF33',
      buttonBgColor: '#1A1A1A',
      buttonTextColor: '#33FF33',
      buttonBorderColor: '#33FF33',
      labelColor: '#33FF33',
      systemFont: 'vt323',
      bodyFont: 'vt323',
      monoFont: 'vt323',
      fontSmoothing: false,
      windowBorderRadius: 0,
      controlBorderRadius: 0,
      windowShadow: 0,
    },
    preview: {
      desktop: '#0A0A0A',
      titleBar: '#1A1A1A',
      window: '#0D0D0D',
      accent: '#33FF33',
      label: '#33FF33',
    },
  },
  {
    id: 'vaporwave',
    name: 'Vaporwave',
    description: 'Pastel gradients and nostalgic soft corners.',
    wallpaper: 'grid',
    highlights: ['Pink and cyan palette', 'Rounded soft chrome', 'Silkscreen pixel font'],
    appearance: {
      accentColor: '#FF71CE',
      desktopColor: '#2D1B69',
      windowBgColor: '#1A0A3E',
      titleBarBgColor: '#FF71CE',
      titleBarTextColor: '#1A0A3E',
      windowBorderColor: '#01CDFE',
      buttonBgColor: '#3D2B7E',
      buttonTextColor: '#FF71CE',
      buttonBorderColor: '#01CDFE',
      labelColor: '#01CDFE',
      systemFont: 'silkscreen',
      bodyFont: 'dmSans',
      monoFont: 'spaceMono',
      fontSmoothing: true,
      windowBorderRadius: 12,
      controlBorderRadius: 8,
      windowShadow: 20,
    },
    preview: {
      desktop: '#2D1B69',
      titleBar: '#FF71CE',
      window: '#1A0A3E',
      accent: '#FF71CE',
      label: '#01CDFE',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    description: 'Warm off-white with minimal ink accents.',
    wallpaper: 'default',
    highlights: ['Cream paper surfaces', 'Serif-inspired warmth', 'Gentle shadow depth'],
    appearance: {
      accentColor: '#5B4A3F',
      desktopColor: '#E8E0D4',
      windowBgColor: '#FAF6F0',
      titleBarBgColor: '#E0D8CC',
      titleBarTextColor: '#3A2E24',
      windowBorderColor: '#B8A99A',
      buttonBgColor: '#E8E0D4',
      buttonTextColor: '#3A2E24',
      buttonBorderColor: '#B8A99A',
      labelColor: '#3A2E24',
      systemFont: 'inter',
      bodyFont: 'inter',
      monoFont: 'courierPrime',
      fontSmoothing: true,
      windowBorderRadius: 3,
      controlBorderRadius: 4,
      windowShadow: 4,
    },
    preview: {
      desktop: '#E8E0D4',
      titleBar: '#E0D8CC',
      window: '#FAF6F0',
      accent: '#5B4A3F',
      label: '#3A2E24',
    },
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    description: 'Hard black and white with zero decoration.',
    wallpaper: 'default',
    highlights: ['Maximum contrast', 'Zero radius, zero shadow', 'Press Start 2P headlines'],
    appearance: {
      accentColor: '#000000',
      desktopColor: '#FFFFFF',
      windowBgColor: '#FFFFFF',
      titleBarBgColor: '#000000',
      titleBarTextColor: '#FFFFFF',
      windowBorderColor: '#000000',
      buttonBgColor: '#FFFFFF',
      buttonTextColor: '#000000',
      buttonBorderColor: '#000000',
      labelColor: '#000000',
      systemFont: 'pressStart',
      bodyFont: 'dmMono',
      monoFont: 'dmMono',
      fontSmoothing: false,
      windowBorderRadius: 0,
      controlBorderRadius: 0,
      windowShadow: 0,
    },
    preview: {
      desktop: '#FFFFFF',
      titleBar: '#000000',
      window: '#FFFFFF',
      accent: '#000000',
      label: '#000000',
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm oranges and deep burgundy with soft glow.',
    wallpaper: 'default',
    highlights: ['Warm amber chrome', 'Deep burgundy desktop', 'Soft ambient shadows'],
    appearance: {
      accentColor: '#FF8C42',
      desktopColor: '#3D1C2E',
      windowBgColor: '#2A1520',
      titleBarBgColor: '#FF8C42',
      titleBarTextColor: '#2A1520',
      windowBorderColor: '#CC6B35',
      buttonBgColor: '#4A2535',
      buttonTextColor: '#FFD4B2',
      buttonBorderColor: '#CC6B35',
      labelColor: '#FFD4B2',
      fontSmoothing: true,
      windowBorderRadius: 6,
      controlBorderRadius: 4,
      windowShadow: 14,
    },
    preview: {
      desktop: '#3D1C2E',
      titleBar: '#FF8C42',
      window: '#2A1520',
      accent: '#FF8C42',
      label: '#FFD4B2',
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cool blues with aquatic depth and clarity.',
    wallpaper: 'default',
    highlights: ['Deep sea blues', 'Medium radius for flow', 'Clean modern fonts'],
    appearance: {
      accentColor: '#0EA5E9',
      desktopColor: '#0C1929',
      windowBgColor: '#0F2238',
      titleBarBgColor: '#1A3650',
      titleBarTextColor: '#B8E0F7',
      windowBorderColor: '#2A5070',
      buttonBgColor: '#1A3650',
      buttonTextColor: '#B8E0F7',
      buttonBorderColor: '#2A5070',
      labelColor: '#7CC4E8',
      systemFont: 'inter',
      bodyFont: 'inter',
      monoFont: 'ibmPlexMono',
      fontSmoothing: true,
      windowBorderRadius: 8,
      controlBorderRadius: 6,
      windowShadow: 12,
    },
    preview: {
      desktop: '#0C1929',
      titleBar: '#1A3650',
      window: '#0F2238',
      accent: '#0EA5E9',
      label: '#7CC4E8',
    },
  },
  {
    id: 'y2k',
    name: 'Y2K',
    description: 'Bubbly pink kawaii desktop with rounded everything.',
    wallpaper: 'dots',
    highlights: ['Candy pink everywhere', 'Maximum radius and glow', 'Silkscreen pixel font'],
    appearance: {
      accentColor: '#FF69B4',
      desktopColor: '#FFB6C1',
      windowBgColor: '#FFF0F5',
      titleBarBgColor: '#FF69B4',
      titleBarTextColor: '#FFFFFF',
      windowBorderColor: '#FF1493',
      buttonBgColor: '#FFD1DC',
      buttonTextColor: '#8B0040',
      buttonBorderColor: '#FF1493',
      labelColor: '#8B0040',
      systemFont: 'silkscreen',
      bodyFont: 'dmSans',
      monoFont: 'dmMono',
      fontSmoothing: true,
      windowBorderRadius: 16,
      controlBorderRadius: 12,
      windowShadow: 18,
    },
    preview: {
      desktop: '#FFB6C1',
      titleBar: '#FF69B4',
      window: '#FFF0F5',
      accent: '#FF69B4',
      label: '#8B0040',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic blue-gray palette inspired by the Nord theme.',
    wallpaper: 'default',
    highlights: ['Frost-blue accents', 'Calm muted surfaces', 'IBM Plex Mono type'],
    appearance: {
      accentColor: '#88C0D0',
      desktopColor: '#2E3440',
      windowBgColor: '#3B4252',
      titleBarBgColor: '#434C5E',
      titleBarTextColor: '#ECEFF4',
      windowBorderColor: '#4C566A',
      buttonBgColor: '#434C5E',
      buttonTextColor: '#ECEFF4',
      buttonBorderColor: '#4C566A',
      labelColor: '#D8DEE9',
      systemFont: 'inter',
      bodyFont: 'inter',
      monoFont: 'ibmPlexMono',
      fontSmoothing: true,
      windowBorderRadius: 4,
      controlBorderRadius: 4,
      windowShadow: 8,
    },
    preview: {
      desktop: '#2E3440',
      titleBar: '#434C5E',
      window: '#3B4252',
      accent: '#88C0D0',
      label: '#D8DEE9',
    },
  },
  {
    id: 'xp',
    name: 'XP Classic',
    description: 'Luna-inspired blue chrome with gradient title bars.',
    wallpaper: 'default',
    highlights: ['#0054E3', '#ECE9D8', '#3A6EA5'],
    appearance: {
      accentColor: '#316AC5',
      desktopColor: '#3A6EA5',
      windowBgColor: '#ECE9D8',
      // Actual XP Luna gradient on the title bar
      titleBarBgColor: 'linear-gradient(180deg, #0A246A 0%, #3A6EA5 45%, #0A246A 100%)',
      titleBarTextColor: '#FFFFFF',
      windowBorderColor: '#0054E3',
      // XP-style buttons with subtle gradient
      buttonBgColor: 'linear-gradient(180deg, #FFFFFF 0%, #ECE9D8 50%, #D6D2C2 100%)',
      buttonTextColor: '#000000',
      buttonBorderColor: '#ACA899',
      labelColor: '#FFFFFF',
      systemFont: 'inter',
      bodyFont: 'inter',
      monoFont: 'monaco',
      fontSmoothing: true,
      windowBorderRadius: 8,
      controlBorderRadius: 3,
      windowShadow: 12,
      designTokens: {
        'window.titleBar.height': 28,
        'window.titleBar.stripes': false,
        'window.titleBar.textShadow': '0 1px 2px rgba(0,0,0,0.4)',
        'window.innerBevel': false,
        'window.border.width': 3,
        'window.border.topRadius': 8,
        'window.border.bottomRadius': 0,
        'window.closeButton.shape': 'circle',
        'window.closeButton.size': 16,
        'menuBar.background': 'linear-gradient(180deg, #2F72CF 0%, #1D5FB5 100%)',
        'menuBar.textColor': '#FFFFFF',
        'menuBar.height': 26,
        'scrollbar.track': '#F1EFE2',
        'scrollbar.thumb': '#C1D2EE',
        'icon.size': 48,
        'icon.labelSize': 11,
        'icon.labelShadow': '1px 1px 2px rgba(0,0,0,0.7)',
        'icon.selectedStyle': 'highlight',
      },
    },
    preview: {
      desktop: '#3A6EA5',
      titleBar: '#0054E3',
      window: '#ECE9D8',
      accent: '#316AC5',
      label: '#FFFFFF',
    },
  },
];

export function buildPresetCSSSnapshot(preset: ThemePreset): string {
  const appearance = preset.appearance;
  const desktopColor = appearance.desktopColor ?? '#C0C0C0';
  const windowBgColor = appearance.windowBgColor ?? '#FFFFFF';
  const titleBarBgColor = appearance.titleBarBgColor ?? '#C0C0C0';
  const titleBarTextColor = appearance.titleBarTextColor ?? getReadableText(titleBarBgColor);
  const windowBorderColor = appearance.windowBorderColor ?? '#000000';
  const buttonBgColor = appearance.buttonBgColor ?? '#C0C0C0';
  const buttonTextColor = appearance.buttonTextColor ?? getReadableText(buttonBgColor);
  const buttonBorderColor = appearance.buttonBorderColor ?? windowBorderColor;
  const labelColor = appearance.labelColor ?? getReadableText(desktopColor);
  const accentColor = appearance.accentColor ?? '#000080';
  const selectionText = getReadableText(accentColor);
  const windowTextColor = getReadableText(windowBgColor);
  const windowTextSecondary = getReadableText(windowBgColor, true);
  const desktopTextColor = getReadableText(desktopColor);
  const windowBorderRadius = appearance.windowBorderRadius ?? 0;
  const controlBorderRadius = appearance.controlBorderRadius ?? 3;
  const windowShadow = appearance.windowShadow ?? 2;
  const smoothingRule = appearance.fontSmoothing
    ? '-webkit-font-smoothing: antialiased;\n  -moz-osx-font-smoothing: grayscale;'
    : '-webkit-font-smoothing: none;\n  -moz-osx-font-smoothing: unset;';

  return `/* Starter Theme Snapshot
   Preset: ${preset.name}
   Wallpaper: ${preset.wallpaper}
   Generated from the onboarding picker.
   Use Special -> Custom CSS for live edits.
*/

.user-desktop {
  --custom-desktop-color: ${desktopColor};
  --desktop-text-color: ${desktopTextColor};
  --window-bg: ${windowBgColor};
  --window-text-color: ${windowTextColor};
  --window-text-secondary: ${windowTextSecondary};
  --selection: ${accentColor};
  --selection-text: ${selectionText};
  --accent: ${accentColor};
  --appearance-title-text: ${titleBarTextColor};
  --appearance-button-bg: ${buttonBgColor};
  --appearance-button-text: ${buttonTextColor};
  --appearance-button-border: ${buttonBorderColor};
  --appearance-label-color: ${labelColor};
  ${smoothingRule}
}

.user-desktop [eos-part="titlebar"] {
  background: ${titleBarBgColor};
  color: ${titleBarTextColor};
}

.user-desktop [eos-part="title"] {
  color: ${titleBarTextColor};
}

.user-desktop .titleBarStripes {
  opacity: 0.35;
}

.user-desktop .window {
  border-color: ${windowBorderColor};
  border-radius: ${windowBorderRadius}px;
  box-shadow: ${getWindowShadow(windowShadow)};
}

.user-desktop .windowInner {
  border-radius: ${Math.max(0, windowBorderRadius - 1)}px;
  overflow: hidden;
}

.user-desktop .titleBar {
  border-top-left-radius: ${Math.max(0, windowBorderRadius - 1)}px;
  border-top-right-radius: ${Math.max(0, windowBorderRadius - 1)}px;
}

.user-desktop button,
.user-desktop input,
.user-desktop select,
.user-desktop textarea {
  background: ${buttonBgColor};
  color: ${buttonTextColor};
  border-color: ${buttonBorderColor};
  border-radius: ${controlBorderRadius}px;
}

.user-desktop [eos-part="label"] {
  color: ${labelColor};
}`;
}

export function findNextGridPosition(items: DesktopItem[], parentId: string | null): { x: number; y: number } {
  const occupied = new Set(
    items
      .filter((item) => item.parentId === parentId && !item.isTrashed)
      .map((item) => `${item.position.x},${item.position.y}`)
  );

  let x = 0;
  let y = 0;
  while (occupied.has(`${x},${y}`)) {
    x++;
    if (x >= 8) {
      x = 0;
      y++;
    }
  }

  return { x, y };
}
