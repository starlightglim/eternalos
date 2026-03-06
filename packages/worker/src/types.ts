/**
 * Shared TypeScript types for EternalOS Worker
 */

/**
 * Widget types for Layer 3 customization
 */
export type WidgetType = 'sticky-note' | 'guestbook' | 'music-player' | 'pixel-canvas' | 'link-board';

/**
 * Sticker configuration (freely placed decoration images)
 */
export interface StickerConfig {
  width: number;
  height: number;
  rotation: number;   // degrees
  opacity: number;    // 0-1
}

/**
 * Profile link for the profile window
 */
export interface ProfileLink {
  title: string;
  url: string;
}

/**
 * Widget configuration types
 */
export interface StickyNoteConfig {
  color: string;
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
  grid: number[][];
  palette: string[];
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

export interface DesktopItem {
  id: string;
  type: 'folder' | 'image' | 'text' | 'link' | 'audio' | 'video' | 'pdf' | 'widget' | 'sticker';
  name: string;
  parentId: string | null; // null = root desktop
  position: { x: number; y: number };
  isPublic: boolean;
  createdAt: number; // unix timestamp
  updatedAt: number;
  // Trash state
  isTrashed?: boolean; // true if item is in trash
  trashedAt?: number; // unix timestamp when moved to trash
  originalParentId?: string | null; // parentId before trashing, for restore
  // Optional fields based on type
  r2Key?: string; // R2 object key for uploaded files
  mimeType?: string;
  fileSize?: number;
  textContent?: string; // for text files (small files stored inline)
  url?: string; // for link items
  // Custom icon (Layer 2 customization)
  customIcon?: string; // ID of custom icon from library, or R2 key for uploaded icon
  // Widget fields (Layer 3 customization)
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
  // Sticker fields (Layer 3 decoration)
  stickerConfig?: StickerConfig;
}

export interface UserProfile {
  uid: string;
  username: string;
  displayName: string;
  wallpaper: string; // pattern name or R2 key
  createdAt: number;
  // Onboarding flag (set to true on signup, cleared after first visit)
  isNewUser?: boolean;
  // Custom appearance settings (Layer 1 customization)
  accentColor?: string;     // Hex color for selection, highlights
  desktopColor?: string;    // Hex color for desktop background
  windowBgColor?: string;   // Hex color for window content area
  fontSmoothing?: boolean;  // Override theme's font smoothing
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
}

export interface UserRecord {
  uid: string;
  email: string;
  passwordHash: string;
  username: string;
  createdAt: number;
  // Session invalidation: tokens issued before this time are invalid
  // Incremented when password changes or user explicitly logs out all sessions
  passwordChangedAt?: number;
}

export interface SessionRecord {
  uid: string;
  expiresAt: number;
  // Track when the session was created for password change validation
  issuedAt: number;
  // Refresh token for token rotation
  refreshToken?: string;
  refreshExpiresAt?: number;
}

export interface JWTPayload {
  uid: string;
  username: string;
  iat: number;
  exp: number;
  jti?: string;
}

export interface PasswordResetRecord {
  uid: string;
  email: string;
  createdAt: number;
  expiresAt: number;
}
