/**
 * Visitor domain client — the public (unauthenticated) view of a user's
 * desktop, including the flat appearance → profile transform.
 */

import type { DesktopItem, UserProfile } from '../types';
import { API_URL } from './transport';
import type { SavedWindowState } from './desktop';

// ============ Visitor API ============

interface VisitorApiResponse {
  username: string;
  displayName: string;
  wallpaper?: string;
  wallpaperMode?: 'cover' | 'tile' | 'center';
  // Custom appearance settings
  accentColor?: string;
  desktopColor?: string;
  windowBgColor?: string;
  fontSmoothing?: boolean;
  customCSS?: string;
  hideWatermark?: boolean;
  // Extended design tokens (cursor images, etc.)
  designTokens?: Record<string, string | number | boolean>;
  // Variant selections
  variants?: Record<string, string>;
  // Sound customization
  soundPack?: { name: string; sounds: Record<string, string> };
  // Profile fields
  bio?: string;
  profileLinks?: { title: string; url: string }[];
  shareDescription?: string;
  items: DesktopItem[];
  windows?: SavedWindowState[];
}

export interface VisitorResponse {
  items: DesktopItem[];
  profile: UserProfile;
  windows?: SavedWindowState[];
}

export async function fetchVisitorDesktop(username: string): Promise<VisitorResponse> {
  const response = await fetch(`${API_URL}/api/visit/${username}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('User not found');
    }
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data: VisitorApiResponse = await response.json();

  // Transform API response to match expected format
  return {
    items: data.items,
    profile: {
      uid: '', // Not exposed to visitors
      username: data.username,
      displayName: data.displayName,
      wallpaper: data.wallpaper,
      wallpaperMode: data.wallpaperMode,
      accentColor: data.accentColor,
      desktopColor: data.desktopColor,
      windowBgColor: data.windowBgColor,
      fontSmoothing: data.fontSmoothing,
      customCSS: data.customCSS,
      hideWatermark: data.hideWatermark,
      designTokens: data.designTokens,
      variants: data.variants,
      soundPack: data.soundPack,
      bio: data.bio,
      profileLinks: data.profileLinks,
      shareDescription: data.shareDescription,
      createdAt: 0, // Not exposed to visitors
    },
    windows: data.windows,
  };
}
