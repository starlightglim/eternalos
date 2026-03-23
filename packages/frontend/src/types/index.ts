// EternalOS Type Definitions

/**
 * Desktop item types
 */
export type DesktopItemType = 'folder' | 'image' | 'text' | 'link' | 'audio' | 'video' | 'pdf' | 'widget' | 'sticker';

/**
 * Widget types for Layer 3 customization
 */
export type WidgetType = 'sticky-note' | 'guestbook' | 'music-player' | 'pixel-canvas' | 'link-board';

/**
 * Widget configuration types
 */
export interface StickyNoteConfig {
  color: string; // Hex color for background
  text: string;
}

export interface GuestbookEntry {
  name: string;
  message: string;
  timestamp: number;
}

export interface GuestbookConfig {
  entries: GuestbookEntry[];
}

export interface MusicTrack {
  title: string;
  url: string;
}

export interface MusicPlayerConfig {
  tracks: MusicTrack[];
}

export interface PixelCanvasConfig {
  grid: number[][]; // 16x16 grid of color indices
  palette: string[]; // 8 hex colors
}

export interface LinkBoardLink {
  title: string;
  url: string;
  icon?: string;
}

export interface LinkBoardConfig {
  links: LinkBoardLink[];
}

export type WidgetConfig = StickyNoteConfig | GuestbookConfig | MusicPlayerConfig | PixelCanvasConfig | LinkBoardConfig;

/**
 * Sticker configuration (freely placed decoration images)
 */
export interface StickerConfig {
  width: number;
  height: number;
  rotation: number;   // degrees
  opacity: number;    // 0-1
}

export interface ImageAnalysisMetadata {
  status: 'pending' | 'complete' | 'failed' | 'skipped';
  analyzedAt?: number;
  caption?: string;
  tags?: string[];
  detectedText?: string[];
  dominantColors?: string[];
  model?: string;
  error?: string;
}

/**
 * Profile link for the profile window
 */
export interface ProfileLink {
  title: string;
  url: string;
}

/**
 * Represents a single item on the desktop (file, folder, widget, etc.)
 */
export interface DesktopItem {
  id: string;
  type: DesktopItemType;
  name: string;
  parentId: string | null; // null = root desktop
  position: { x: number; y: number };
  isPublic: boolean;
  createdAt: number; // unix timestamp (ms)
  updatedAt: number; // unix timestamp (ms)
  // Trash state
  isTrashed?: boolean; // true if item is in trash
  trashedAt?: number; // unix timestamp when moved to trash
  originalParentId?: string | null; // parentId before trashing, for restore
  // Optional fields based on type
  r2Key?: string; // R2 object key for uploaded files
  thumbnailKey?: string; // R2 key for thumbnail image (generated on upload)
  mimeType?: string;
  fileSize?: number;
  textContent?: string; // for text files
  url?: string; // for link files
  // Custom icon (Layer 2 customization)
  customIcon?: string; // ID of custom icon from library, or R2 key for uploaded icon
  // Widget fields (Layer 3 customization)
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
  // Sticker fields (Layer 3 decoration)
  stickerConfig?: StickerConfig;
  // User-curated tags for search and organization
  userTags?: string[];
  // AI / metadata enrichment for uploaded images
  imageAnalysis?: ImageAnalysisMetadata;
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
  contentType: 'folder' | 'image' | 'text' | 'markdown' | 'code' | 'get-info' | 'about' | 'wallpaper' | 'welcome' | 'search' | 'preferences' | 'trash' | 'audio' | 'video' | 'pdf' | 'calculator' | 'clock' | 'link' | 'appearance' | 'widget' | 'css-editor' | 'share-dialog' | 'profile' | 'agent-chat' | 'bazaar' | 'cursor-creator';
  contentId?: string; // Reference to DesktopItem id if applicable
}

/**
 * User profile
 */
export interface UserProfile {
  uid: string;
  username: string;
  displayName?: string;
  wallpaper?: string;
  createdAt: number; // unix timestamp (ms)
  // Onboarding flag (set to true on signup, cleared after first visit)
  isNewUser?: boolean;
  // Custom appearance settings (Layer 1 customization)
  accentColor?: string;     // Hex color for selection, highlights
  desktopColor?: string;    // Hex color for desktop background
  windowBgColor?: string;   // Hex color for window content area
  titleBarBgColor?: string; // Hex color for title bars and chrome bands
  titleBarTextColor?: string; // Hex color for window title text
  windowBorderColor?: string; // Hex color for window borders
  buttonBgColor?: string;   // Hex color for buttons and controls
  buttonTextColor?: string; // Hex color for button labels
  buttonBorderColor?: string; // Hex color for control borders
  labelColor?: string;      // Hex color for desktop/file labels
  // Typography
  systemFont?: string;      // Font catalog ID for UI text (titles, menus)
  bodyFont?: string;        // Font catalog ID for body text (labels, content)
  monoFont?: string;        // Font catalog ID for monospace (code, hex values)
  fontSmoothing?: boolean;  // Override theme's font smoothing
  windowBorderRadius?: number; // Rounded corners for windows
  windowOpacity?: number;     // Window content opacity (30-100 percent)
  controlBorderRadius?: number; // Rounded corners for buttons and inputs
  windowShadow?: number;    // Shadow intensity (0-32)
  // Extended design tokens (JSON blob for new properties beyond legacy flat fields)
  designTokens?: Record<string, string | number | boolean>;
  // Custom CSS (Layer 4 customization)
  customCSS?: string;       // User-defined CSS, max 50KB, scoped to .user-desktop
  // Wallpaper display mode
  wallpaperMode?: 'cover' | 'tile' | 'center'; // How custom wallpaper images are displayed
  // Watermark setting
  hideWatermark?: boolean;  // Hide "Made with EternalOS" watermark in visitor mode
  // Profile fields
  bio?: string;                    // User bio, max 500 chars
  profileLinks?: ProfileLink[];    // User links, max 5
  shareDescription?: string;       // Custom OG description, max 200 chars
  // Analytics
  analyticsEnabled?: boolean;      // Opt-in view counter
  // Sound customization (Skin system)
  soundPack?: { name: string; sounds: Partial<Record<string, string>> };
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
