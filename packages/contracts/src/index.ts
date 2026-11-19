/**
 * @eternalos/contracts — domain types shared by the frontend and the worker.
 *
 * Single source of truth for the common domain types that both deployables
 * exchange over the wire or persist in shared stores. `packages/frontend`
 * re-exports them from `src/types/index.ts` and `packages/worker` from
 * `src/types.ts` (plus `utils/jwt.ts` for `AppGrantedPermissions`), so
 * existing import sites keep working.
 *
 * Types only — no runtime code and no zod schemas (yet). Runtime validation
 * at network boundaries is planned follow-up work (design/RELEASE-READINESS.md,
 * "Structure" item 1).
 *
 * Reconciliation of the previously independent frontend/worker declarations
 * (2026-11) — every difference is listed here, none was changed silently:
 *
 * - `DesktopItem.thumbnailKey`: declared only by the frontend. The worker
 *   never writes it (absent from UserDesktop's create/update allowlists);
 *   kept optional so the frontend type is not narrowed.
 * - `DesktopItem.grantedPermissions`: both sides declared partial, different
 *   subsets of the wire shape (frontend: fs/profile/network/handlers/ipc;
 *   worker: read-only fs + profile). The value actually stored on items is
 *   the full `AppGrantedPermissions` (written by routes/apps.ts), so that
 *   type — previously declared in worker utils/jwt.ts — is the shared shape.
 * - `UserProfile.displayName`: worker required it, frontend made it optional.
 *   Kept required: every construction site on both sides sets it and the
 *   wire format always includes it (the visitor route falls back to the
 *   username).
 * - `UserProfile.wallpaper`: worker required it, frontend made it optional.
 *   Kept optional: the frontend legitimately builds interim profiles before
 *   fetching the real one (authStore login/signup) and the visitor response
 *   omits it when unset, so a required field would not typecheck.
 * - `UserProfile.soundPack`: worker used `SoundPack` (keys constrained to
 *   `SoundType`), frontend used a loose inline record. Kept loose: the
 *   server validates the URL prefix, not the slot names, so arbitrary keys
 *   round-trip through the profile store.
 */

// ---------------------------------------------------------------------------
// Desktop items
// ---------------------------------------------------------------------------

/** Item kinds that can live on the desktop. */
export type DesktopItemType =
  | 'folder'
  | 'image'
  | 'text'
  | 'link'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'widget'
  | 'sticker'
  | 'app'
  | 'cartridge';

/** Widget types for Layer 3 customization */
export type WidgetType = 'sticky-note' | 'guestbook' | 'music-player' | 'pixel-canvas' | 'link-board';

/** Widget configuration types */
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

/** Sticker configuration (freely placed decoration images) */
export interface StickerConfig {
  width: number;
  height: number;
  rotation: number; // degrees
  opacity: number; // 0-1
}

/** AI / metadata enrichment for uploaded images */
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

/** Profile link for the profile window */
export interface ProfileLink {
  title: string;
  url: string;
}

// ---------------------------------------------------------------------------
// User-created apps (Dynamic Workers)
// ---------------------------------------------------------------------------

/**
 * Permissions an app declares in its manifest. These are the *requested*
 * capabilities — the user grants a subset at install time (stored on the
 * DesktopItem as `grantedPermissions`).
 */
export interface AppPermissions {
  fs?: {
    read?: string[]; // path globs: ['**'], ['/Photos/**']
    write?: string[];
    delete?: string[];
    mimeTypes?: string[]; // ['image/*', 'audio/*', 'text/*']
  };
  profile?: {
    read?: Array<'username' | 'displayName' | 'bio' | 'avatar'>;
  };
  network?: {
    outbound?: string[];
  };
  ipc?: {
    listen?: string[];
    emit?: string[];
  };
  handlers?: {
    mimeTypes?: string[];
    extensions?: string[];
  };
}

export interface AppWindowConfig {
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  resizable?: boolean;
  frameless?: boolean;
}

export interface AppManifest {
  name: string;
  description?: string;
  version: string;
  windowConfig: AppWindowConfig;
  // Dynamic Worker app ID (registered in OrchestratorAgent)
  appId: string;
  // Permissions the app declares it needs. Users grant a subset at install.
  permissions?: AppPermissions;
  // Short natural-language reason shown in the install dialog. Keep under ~200 chars.
  rationale?: string;
}

/**
 * Permissions actually granted to an installed app — the subset of the
 * manifest's `AppPermissions` the user approved. Serialized JSON-safe and
 * stored in two places: on the app's `DesktopItem` (`grantedPermissions`)
 * and in the app registry KV (`app:{appId}.granted`), and embedded —
 * HMAC-signed — in the short-lived app capability tokens the sandboxed app
 * iframe uses for bridge calls back to the worker (see worker utils/jwt.ts
 * for the token format and threat model).
 *
 * Absent/empty = no permissions granted = hermetic app (default).
 */
export interface AppGrantedPermissions {
  fs?: {
    read?: string[]; // glob patterns: ['**'] | ['/Photos/**']
    write?: string[];
    delete?: string[];
    mimeTypes?: string[]; // legacy/read-only MIME patterns
    readMimeTypes?: string[];
    writeMimeTypes?: string[];
    deleteMimeTypes?: string[];
  };
  ipc?: {
    listen?: string[];
    emit?: string[];
  };
  network?: {
    outbound?: string[];
  };
  handlers?: {
    mimeTypes?: string[];
    extensions?: string[];
  };
  virtualFolders?: {
    mountAt?: string[];
  };
  profile?: {
    read?: Array<'username' | 'displayName' | 'bio' | 'avatar'>;
  };
  ai?: {
    modes?: Array<'ask' | 'search' | 'enrich'>;
  };
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
  thumbnailKey?: string; // R2 key for thumbnail image (frontend-declared; the worker never writes it today)
  mimeType?: string;
  fileSize?: number;
  textContent?: string; // for text files (small files stored inline)
  url?: string; // for link items (http(s) only — validated server-side on write)
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
  // User-created app (type='app')
  appManifest?: AppManifest;
  // For type='app': the subset of declared permissions the user approved
  // (see AppGrantedPermissions). Absent = no permissions granted = hermetic
  // app (default).
  grantedPermissions?: AppGrantedPermissions;
  permissionGrantedAt?: number;
  // Installed console game (type='cartridge') — references a bazaar pack or
  // the owner's own draft; the cartridge itself stays in R2/KV.
  cartridgeRef?: { packId?: string; draftId?: string; coverUrl?: string };
}

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

/**
 * User profile. `displayName` is always present (set at signup, and the
 * visitor route falls back to the username); `wallpaper` is optional because
 * clients construct interim profiles before the authoritative one is fetched
 * and the visitor response omits it when unset.
 */
export interface UserProfile {
  uid: string;
  username: string;
  displayName: string;
  wallpaper?: string; // pattern name or R2 key
  createdAt: number; // unix timestamp (ms)
  // Onboarding flag (set to true on signup, cleared after first visit)
  isNewUser?: boolean;
  // Custom appearance settings (Layer 1 customization)
  accentColor?: string; // Hex color for selection, highlights
  desktopColor?: string; // Hex color for desktop background
  windowBgColor?: string; // Hex color for window content area
  titleBarBgColor?: string; // Hex color for title bars and chrome bands
  titleBarTextColor?: string; // Hex color for window title text
  windowBorderColor?: string; // Hex color for window borders
  buttonBgColor?: string; // Hex color for buttons and controls
  buttonTextColor?: string; // Hex color for button labels
  buttonBorderColor?: string; // Hex color for control borders
  labelColor?: string; // Hex color for desktop/file labels
  // Typography
  systemFont?: string; // Font catalog ID for UI text (titles, menus)
  bodyFont?: string; // Font catalog ID for body text (labels, content)
  monoFont?: string; // Font catalog ID for monospace (code, hex values)
  fontSmoothing?: boolean; // Override theme's font smoothing
  windowBorderRadius?: number; // Rounded corners for windows
  windowOpacity?: number; // Window content opacity (30-100 percent)
  controlBorderRadius?: number; // Rounded corners for buttons and inputs
  windowShadow?: number; // Shadow intensity (0-32)
  // Extended design tokens (JSON blob for new properties beyond legacy flat fields)
  designTokens?: Record<string, string | number | boolean>;
  // Variant selections (e.g. window-chrome style). Keys/values select which
  // conditional tokens apply; compiled client-side. Stored as-is, bounded.
  variants?: Record<string, string>;
  // Custom CSS (Layer 4 customization)
  customCSS?: string; // User-defined CSS, max 50KB, scoped to .user-desktop
  // Wallpaper display mode
  wallpaperMode?: 'cover' | 'tile' | 'center'; // How custom wallpaper images are displayed
  // Watermark setting
  hideWatermark?: boolean; // Hide "Made with EternalOS" watermark in visitor mode
  // Profile fields
  bio?: string; // User bio, max 500 chars
  profileLinks?: ProfileLink[]; // User links, max 5
  shareDescription?: string; // Custom OG description, max 200 chars
  // Analytics
  analyticsEnabled?: boolean; // Opt-in view counter
  // Sound customization (Skin system). Keys are sound-slot names; the server
  // validates the URL prefix (/api/sounds/…), not the slot names, so keys are
  // deliberately not constrained to a fixed enum here.
  soundPack?: { name: string; sounds: Partial<Record<string, string>> };
}
