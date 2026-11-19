// EternalOS Type Definitions
//
// Domain types shared with the worker live in @eternalos/contracts and are
// re-exported here so existing `from '../types'` imports keep working.
// Frontend-only types (window state, cartridges, menu bar, auth session
// user) stay local.

export type {
  DesktopItemType,
  WidgetType,
  StickyNoteConfig,
  GuestbookEntry,
  GuestbookConfig,
  MusicTrack,
  MusicPlayerConfig,
  PixelCanvasConfig,
  LinkBoardLink,
  LinkBoardConfig,
  WidgetConfig,
  StickerConfig,
  ImageAnalysisMetadata,
  ProfileLink,
  DesktopItem,
  AppPermissions,
  AppWindowConfig,
  AppManifest,
  AppGrantedPermissions,
  AppGrantApproval,
  UserProfile,
} from '@eternalos/contracts';

/**
 * Cartridge format for the fantasy game console.
 * Mirrors packages/worker/src/utils/cartridge.ts.
 */
export interface CartridgeMeta {
  name: string;
  description?: string;
  author: string;
  version: string;
}

export interface Cartridge {
  formatVersion: 1;
  meta: CartridgeMeta;
  code: string;
  /** 128 rows x 128 hex nibbles (one palette index per pixel), '\n'-joined */
  spritesheet: string;
  /** Optional 16-entry hex color palette override */
  palette?: string[];
  /** Optional 512 hex chars of per-sprite flags */
  flags?: string;
}

export interface CartridgeDraftSummary {
  cartId: string;
  name: string;
  version: string;
  updatedAt: number;
}

/**
 * Window state for the window manager
 */
export interface WindowState {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  collapsed?: boolean; // Window shade - show only title bar
  // Pre-maximized state for restore
  preMaximizedPosition?: { x: number; y: number };
  preMaximizedSize?: { width: number; height: number };
  // Content information
  contentType: 'folder' | 'image' | 'text' | 'markdown' | 'code' | 'get-info' | 'about' | 'wallpaper' | 'welcome' | 'search' | 'preferences' | 'trash' | 'audio' | 'video' | 'pdf' | 'calculator' | 'clock' | 'link' | 'appearance' | 'widget' | 'css-editor' | 'share-dialog' | 'profile' | 'agent-chat' | 'bazaar' | 'cursor-creator' | 'developer-studio' | 'app' | 'app-preview' | 'console-player' | 'cartridge-editor';

  contentId?: string; // Reference to DesktopItem id if applicable
  launchFileId?: string; // Double-clicked file ID to pass to a custom handler app
}

/**
 * Auth user info (from JWT)
 */
export interface AuthUser {
  uid: string;
  username: string;
  email: string;
  emailVerified?: boolean;
}

/**
 * Menu item for the menu bar
 */
export interface MenuItem {
  label: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  divider?: boolean;
  /** Present on toggleable entries: renders as menuitemcheckbox. */
  checked?: boolean;
  submenu?: MenuItem[];
}

/**
 * Menu definition for the menu bar
 */
export interface Menu {
  label: string;
  items: MenuItem[];
}

/**
 * File extension patterns for different viewers
 */
const CODE_EXTENSIONS = /\.(js|jsx|ts|tsx|py|css|html|json|sh|bash|yml|yaml|go|rs|java|c|cpp|h|hpp)$/i;
const MARKDOWN_EXTENSIONS = /\.(md|markdown)$/i;

/**
 * Determines the content type for a text file based on its extension
 * @param filename - The name of the file
 * @returns 'markdown' | 'code' | 'text'
 */
export function getTextFileContentType(filename: string): 'markdown' | 'code' | 'text' {
  if (MARKDOWN_EXTENSIONS.test(filename)) return 'markdown';
  if (CODE_EXTENSIONS.test(filename)) return 'code';
  return 'text';
}
