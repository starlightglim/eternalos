/**
 * Shared TypeScript types for EternalOS Worker
 *
 * Domain types shared with the frontend live in @eternalos/contracts and are
 * re-exported here so existing `from '../types'` imports keep working.
 * Worker-only types (auth records, bazaar, sound/cursor asset metadata,
 * OAuth) stay local.
 */

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
  AppWindowConfig,
  AppPermissions,
  AppManifest,
  AppGrantedPermissions,
  AppGrantApproval,
  UserProfile,
} from '@eternalos/contracts';

// ---------------------------------------------------------------------------
// Sound & Cursor Skin System
// ---------------------------------------------------------------------------

/**
 * All sound types available in the OS.
 * Each can be mapped to a custom audio file via SoundPack.
 */
export type SoundType =
  | 'click'
  | 'windowOpen'
  | 'windowClose'
  | 'folderOpen'
  | 'drop'
  | 'trash'
  | 'emptyTrash'
  | 'alert'
  | 'error'
  | 'startup'
  | 'select';

/**
 * A sound pack maps sound types to custom audio file URLs.
 * Sounds not in the map fall back to built-in synthesized sounds.
 */
export interface SoundPack {
  name: string; // e.g. "Custom", "Sci-Fi", "Retro"
  sounds: Partial<Record<SoundType, string>>; // SoundType → URL path
}

/**
 * Metadata for an uploaded sound asset stored in R2.
 */
export interface SoundAssetMeta {
  soundId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  soundType?: SoundType; // Which sound slot this is assigned to
}

/**
 * Cursor states that can be customized with images.
 */
export type CursorState =
  | 'default'
  | 'pointer'
  | 'grab'
  | 'grabbing'
  | 'text'
  | 'wait'
  | 'move'
  | 'nwse-resize';

/**
 * Metadata for an uploaded cursor asset stored in R2.
 */
export interface CursorAssetMeta {
  cursorId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  cursorState?: CursorState; // Which cursor slot this is assigned to
  hotspotX?: number; // Cursor hotspot X coordinate
  hotspotY?: number; // Cursor hotspot Y coordinate
}

export interface CustomCSSVersion {
  id: string;
  css: string;
  createdAt: number;
  source: 'manual' | 'assistant' | 'revert';
  summary?: string;
}

export interface OAuthProvider {
  provider: 'google';
  providerId: string; // Google subject ID
  connectedAt: number;
  email?: string; // OAuth provider email (for display)
}

export interface UserRecord {
  uid: string;
  email: string;
  passwordHash?: string; // null for OAuth-only users
  username: string;
  createdAt: number;
  // Session invalidation: tokens issued before this time are invalid
  // Incremented when password changes or user explicitly logs out all sessions
  passwordChangedAt?: number;
  // Email verification
  emailVerified?: boolean;
  emailVerifiedAt?: number;
  // OAuth providers linked to this account
  oauthProviders?: OAuthProvider[];
  // Soft delete — set when user initiates account deletion.
  // While set, login is blocked and tokens are rejected. After a grace period
  // (14 days), a scheduled cleanup hard-deletes user data.
  // Users can cancel deletion during the grace period via /api/auth/cancel-deletion.
  deletedAt?: number;
  hardDeleteAt?: number;
  // Recovery codes: bcrypt-hashed one-time-use codes. Generated at signup and
  // shown to the user once; burned after successful use. Recover access when
  // email+password is unavailable. Regenerating invalidates the prior set.
  recoveryCodesHashed?: string[];
  recoveryCodesGeneratedAt?: number;
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

export interface EmailVerificationRecord {
  uid: string;
  email: string;
  createdAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Bazaar — Community asset marketplace
// ---------------------------------------------------------------------------

export type PackType = 'cursor' | 'icon' | 'sound' | 'effect' | 'skin' | 'game';

export interface BazaarPack {
  packId: string;
  type: PackType;
  name: string;
  description: string;
  authorUid: string;
  authorUsername: string;
  version: string;
  previewUrl: string;
  createdAt: number;
  updatedAt: number;
  installs: number;
  tags: string[];
  /** Maps asset keys to public R2 URLs (e.g. "default" → "/api/bazaar/assets/packId/default.png") */
  assets: Record<string, string>;
  /** Token paths → values to apply on install */
  config: Record<string, string | number | boolean>;
}
