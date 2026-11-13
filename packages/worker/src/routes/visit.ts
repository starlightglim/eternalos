/**
 * Visitor Mode Route
 *
 * GET /api/visit/:username - Get public desktop snapshot
 *
 * Returns public items for a user's desktop.
 * Uses KV cache for fast reads, falls back to Durable Object.
 */

import type { Env } from '../index';
import type { DesktopItem, UserProfile, SoundPack } from '../types';

interface SavedWindowState {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  collapsed?: boolean;
  contentType: string;
  contentId?: string;
}

interface VisitorResponse {
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
  // Variant selections (window chrome style, etc.)
  variants?: Record<string, string>;
  // Sound customization
  soundPack?: SoundPack;
  // Profile fields
  bio?: string;
  profileLinks?: { title: string; url: string }[];
  shareDescription?: string;
  items: DesktopItem[];
  windows?: SavedWindowState[];
}

/**
 * Handle visitor requests
 * GET /api/visit/:username
 *
 * Flow:
 * 1. Look up username in AUTH_KV to get uid
 * 2. Try DESKTOP_KV public:{uid} for cached snapshot
 * 3. Fall back to Durable Object getPublicSnapshot()
 * 4. Cache result in KV for next visitor
 */
/** The raw public snapshot shape written to KV by UserDesktop.syncPublicSnapshot. */
interface PublicSnapshot {
  items: DesktopItem[];
  profile?: UserProfile | null;
  windows?: SavedWindowState[];
}

/**
 * Flatten the stored `{ items, profile, windows }` snapshot into the flat
 * VisitorResponse the client consumes (appearance fields hoisted to the top
 * level). Both the KV-cache path and the DO fallback go through this, so the
 * two can never disagree — previously the cache held the nested shape while the
 * fallback built the flat shape, so a cached visit (populated on every profile
 * mutation) lost all custom appearance.
 */
function buildVisitorResponse(
  normalizedUsername: string,
  data: PublicSnapshot
): VisitorResponse {
  return {
    username: normalizedUsername,
    displayName: data.profile?.displayName || normalizedUsername,
    wallpaper: data.profile?.wallpaper,
    wallpaperMode: data.profile?.wallpaperMode,
    accentColor: data.profile?.accentColor,
    desktopColor: data.profile?.desktopColor,
    windowBgColor: data.profile?.windowBgColor,
    fontSmoothing: data.profile?.fontSmoothing,
    customCSS: data.profile?.customCSS,
    hideWatermark: data.profile?.hideWatermark,
    designTokens: data.profile?.designTokens,
    variants: data.profile?.variants,
    soundPack: data.profile?.soundPack,
    bio: data.profile?.bio,
    profileLinks: data.profile?.profileLinks,
    shareDescription: data.profile?.shareDescription,
    items: data.items ?? [],
    windows: data.windows,
  };
}

export async function handleVisit(
  request: Request,
  env: Env,
  username: string
): Promise<Response> {
  try {
    // Normalize username (lowercase)
    const normalizedUsername = username.toLowerCase();

    // Look up username → uid in AUTH_KV
    const usernameData = await env.AUTH_KV.get<{ uid: string }>(
      `username:${normalizedUsername}`,
      'json'
    );

    if (!usernameData) {
      return Response.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const { uid } = usernameData;

    // Try KV cache first for fast visitor reads. The cache holds the raw
    // snapshot shape (written by UserDesktop.syncPublicSnapshot); flatten it the
    // same way as the fallback below.
    const cachedSnapshot = await env.DESKTOP_KV.get<PublicSnapshot>(
      `public:${uid}`,
      'json'
    );

    if (cachedSnapshot) {
      return Response.json(buildVisitorResponse(normalizedUsername, cachedSnapshot), {
        headers: {
          'Cache-Control': 'public, max-age=60', // Cache for 1 minute
        },
      });
    }

    // Fall back to Durable Object. getPublicSnapshot() populates the KV cache
    // (raw shape) as a side effect, so we don't re-write it here.
    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);

    const doResponse = await stub.fetch(
      new Request('http://internal/public-snapshot')
    );

    if (!doResponse.ok) {
      // Durable Object may not exist yet (new user with no items)
      // Return empty response
      const emptyResponse: VisitorResponse = {
        username: normalizedUsername,
        displayName: normalizedUsername,
        items: [],
      };
      return Response.json(emptyResponse);
    }

    const data = await doResponse.json() as PublicSnapshot;

    return Response.json(buildVisitorResponse(normalizedUsername, data), {
      headers: {
        'Cache-Control': 'public, max-age=60',
      },
    });

  } catch (error) {
    console.error('Visit error:', error);
    return Response.json(
      { error: 'Failed to load desktop' },
      { status: 500 }
    );
  }
}
