// Visitor Page - Read-only view of a user's desktop
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { WindowManager } from '../components/window';
import { DesktopIcon } from '../components/icons';
import { Sticker } from '../components/desktop/Sticker';
import { MobileBrowser } from '../components/desktop/MobileBrowser';
import { VisitorMenuBar } from '../components/menubar/VisitorMenuBar';
import { useWindowStore, setVisitorWindowMode } from '../stores/windowStore';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { useIsMobile } from '../hooks/useIsMobile';
import { isApiConfigured, fetchVisitorDesktop, getWallpaperUrl, type SavedWindowState } from '../services/api';
import { useVisitorSync } from '../hooks/useVisitorSync';
import { applyAppearance, clearAppearance, profileToAppearance, profileHasAppearance, useAppearanceStore, APPEARANCE_PROFILE_KEYS } from '../stores/appearanceStore';
import { useSoundStore } from '../stores/soundStore';
import { getTextFileContentType, type DesktopItem, type UserProfile } from '../types';
import styles from './VisitorPage.module.css';

const GRID_CELL_SIZE = 80;

type LoadingState = 'loading' | 'loaded' | 'not_found' | 'empty' | 'error';

// Mock data for demo mode visitor view
const mockVisitorItems: DesktopItem[] = [
  {
    id: 'visitor-folder',
    type: 'folder',
    name: 'Shared Folder',
    parentId: null,
    position: { x: 0, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'visitor-text',
    type: 'text',
    name: 'Welcome.txt',
    parentId: null,
    position: { x: 0, y: 1 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    textContent: 'Welcome to my desktop!\n\nFeel free to look around.',
  },
  {
    id: 'visitor-image',
    type: 'image',
    name: 'Photo.png',
    parentId: null,
    position: { x: 1, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mimeType: 'image/png',
  },
];

export function VisitorPage() {
  // Extract username from URL pathname manually since React Router v6
  // can't match /@:username (params must be full path segments).
  const { username: routeUsername } = useParams<{ username: string }>();
  const username = routeUsername || window.location.pathname.slice(2).split('?')[0] || undefined;
  const { openWindow, loadVisitorWindows } = useWindowStore();
  const isMobile = useIsMobile();

  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [items, setItems] = useState<DesktopItem[]>([]);
  const [savedWindows, setSavedWindows] = useState<SavedWindowState[] | undefined>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasRestoredWindows = useRef(false);

  // Build meta config based on current state
  const metaConfig = useMemo(() => {
    const displayName = profile?.displayName || username || 'Unknown';
    const itemCount = items.filter((i) => i.parentId === null).length;

    // Generate og:image URL pointing to our dynamic image endpoint on the API
    const apiBase = import.meta.env.VITE_API_URL || '';
    const ogImageUrl = `${apiBase}/api/og/${username}.png`;

    // Use custom shareDescription > bio > default
    const customDesc = profile?.shareDescription || profile?.bio || '';
    const defaultDesc = `Visit ${displayName}'s personal desktop on EternalOS. ${itemCount} item${itemCount !== 1 ? 's' : ''} on display.`;
    const ogDesc = customDesc || `A personal corner of the internet. ${itemCount} item${itemCount !== 1 ? 's' : ''} curated by ${displayName}.`;

    return {
      title: `@${username}'s Desktop | EternalOS`,
      description: customDesc || defaultDesc,
      ogTitle: `@${username}'s Desktop`,
      ogDescription: ogDesc,
      ogType: 'website',
      ogUrl: typeof window !== 'undefined' ? window.location.href : undefined,
      ogImage: ogImageUrl,
      twitterCard: 'summary_large_image' as const,
    };
  }, [username, profile, items]);

  // Apply meta tags
  useDocumentMeta(metaConfig);

  // Store reference to user's own appearance to restore when leaving
  const userAppearance = useRef(useAppearanceStore.getState().appearance);

  // Apply owner's custom appearance when profile is loaded
  useEffect(() => {
    if (!profile) return;
    const savedAppearance = userAppearance.current;

    // Build appearance object from owner's profile (including customCSS)
    const ownerAppearance = profileToAppearance(profile as unknown as Record<string, unknown>);

    // Apply owner's appearance settings (including custom CSS)
    applyAppearance(ownerAppearance);

    // Load owner's custom sounds if they have a sound pack
    const ownerProfile = profile as unknown as Record<string, unknown>;
    if (ownerProfile.soundPack) {
      useSoundStore.getState().loadVisitorSounds(ownerProfile.soundPack as import('../stores/soundStore').SoundPack);
    }

    // Cleanup: restore user's own appearance when leaving visitor mode
    return () => {
      // First clear the owner's appearance
      clearAppearance();
      // Clear visitor sounds
      useSoundStore.getState().clearVisitorSounds();
      // Then restore the user's own appearance if they had any
      if (savedAppearance && Object.keys(savedAppearance).length > 0) {
        applyAppearance(savedAppearance);
      }
    };
  }, [profile]);

  // Fetch user data on mount
  useEffect(() => {
    if (!username) {
      setLoadingState('not_found');
      return;
    }

    // Demo mode - use mock data
    if (!isApiConfigured) {
      setProfile({
        uid: 'demo-user',
        username: username,
        displayName: username,
        createdAt: Date.now(),
        wallpaper: undefined,
      });
      setItems(mockVisitorItems);
      setLoadingState('loaded');
      return;
    }

    // API mode - fetch real data
    const loadVisitorData = async () => {
      try {
        setLoadingState('loading');

        const data = await fetchVisitorDesktop(username);

        setProfile(data.profile);

        if (data.items.length === 0) {
          setItems([]);
          setLoadingState('empty');
        } else {
          setItems(data.items);
          setSavedWindows(data.windows);
          setLoadingState('loaded');
        }
      } catch (error) {
        console.error('Error loading visitor data:', error);
        if (error instanceof Error && error.message === 'User not found') {
          setLoadingState('not_found');
        } else {
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load desktop');
          setLoadingState('error');
        }
      }
    };

    loadVisitorData();
  }, [username]);

  // Restore owner's saved windows once items are loaded
  useEffect(() => {
    if (hasRestoredWindows.current) return;
    if (loadingState !== 'loaded') return;
    if (!savedWindows || savedWindows.length === 0) return;

    const validItemIds = new Set(items.map((i) => i.id));
    loadVisitorWindows(savedWindows, validItemIds);
    hasRestoredWindows.current = true;
  }, [loadingState, items, savedWindows, loadVisitorWindows]);

  // Set visitor mode to prevent window saves to localStorage/server
  useEffect(() => {
    setVisitorWindowMode(true);
    return () => {
      setVisitorWindowMode(false);
      // Clear visitor windows so they don't leak into the owner's desktop
      // Only clear in-memory state, don't touch localStorage (owner's windows)
      useWindowStore.setState({ windows: [], nextZIndex: 1 });
    };
  }, []);

  // --- Live sync via WebSocket ---
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const handleLiveItems = useCallback((newItems: DesktopItem[]) => {
    setItems(newItems);
    if (newItems.length === 0) {
      setLoadingState('empty');
    } else {
      setLoadingState('loaded');
    }
  }, []);

  const handleLiveWindows = useCallback((newWindows: SavedWindowState[]) => {
    setSavedWindows(newWindows);
    // Always apply live window updates to the window store
    const validItemIds = new Set(itemsRef.current.map((i) => i.id));
    loadVisitorWindows(newWindows, validItemIds);
    hasRestoredWindows.current = true;
  }, [loadVisitorWindows]);

  const handleLiveProfile = useCallback((newProfile: UserProfile) => {
    setProfile((prev) => prev ? { ...prev, ...newProfile } : newProfile);
  }, []);

  useVisitorSync({
    username,
    enabled: isApiConfigured && (loadingState === 'loaded' || loadingState === 'empty'),
    onItemsUpdate: handleLiveItems,
    onWindowsUpdate: handleLiveWindows,
    onProfileUpdate: handleLiveProfile,
  });

  // Get root-level items (parentId === null), split stickers from regular items
  const rootItems = items.filter((item) => item.parentId === null && item.type !== 'sticker');
  const stickerItems = items.filter((item) => item.parentId === null && item.type === 'sticker');

  // Handle icon selection (simple click, no shift-click in visitor mode)
  const handleIconSelect = useCallback((id: string) => {
    setSelectedIds(new Set([id]));
  }, []);

  // Handle desktop click to deselect
  const handleDesktopClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setSelectedIds(new Set());
    }
  }, []);

  // Handle double-click to open (read-only viewing)
  const handleIconDoubleClick = useCallback((item: DesktopItem) => {
    // Create a counter for window positioning (based on existing windows)
    const existingWindows = useWindowStore.getState().windows.length;
    const offsetX = 30 * existingWindows;
    const offsetY = 30 * existingWindows;

    if (item.type === 'folder') {
      openWindow({
        id: `visitor-folder-${item.id}`,
        title: item.name,
        position: { x: 100 + offsetX, y: 100 + offsetY },
        size: { width: 400, height: 300 },
        minimized: false,
        maximized: false,
        contentType: 'folder',
        contentId: item.id,
      });
    } else if (item.type === 'text') {
      const contentType = getTextFileContentType(item.name);
      openWindow({
        id: `visitor-text-${item.id}`,
        title: item.name,
        position: { x: 150 + offsetX, y: 120 + offsetY },
        size: { width: 400, height: 300 },
        minimized: false,
        maximized: false,
        contentType,
        contentId: item.id,
      });
    } else if (item.type === 'image') {
      openWindow({
        id: `visitor-image-${item.id}`,
        title: item.name,
        position: { x: 120 + offsetX, y: 80 + offsetY },
        size: { width: 450, height: 350 },
        minimized: false,
        maximized: false,
        contentType: 'image',
        contentId: item.id,
      });
    } else if (item.type === 'video') {
      openWindow({
        id: `visitor-video-${item.id}`,
        title: item.name,
        position: { x: 100 + offsetX, y: 60 + offsetY },
        size: { width: 640, height: 480 },
        minimized: false,
        maximized: false,
        contentType: 'video',
        contentId: item.id,
      });
    } else if (item.type === 'audio') {
      openWindow({
        id: `visitor-audio-${item.id}`,
        title: item.name,
        position: { x: 150 + offsetX, y: 150 + offsetY },
        size: { width: 300, height: 180 },
        minimized: false,
        maximized: false,
        contentType: 'audio',
        contentId: item.id,
      });
    } else if (item.type === 'pdf') {
      openWindow({
        id: `visitor-pdf-${item.id}`,
        title: item.name,
        position: { x: 80 + offsetX, y: 40 + offsetY },
        size: { width: 550, height: 700 },
        minimized: false,
        maximized: false,
        contentType: 'pdf',
        contentId: item.id,
      });
    } else if (item.type === 'link' && item.url) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
    } else if (item.type === 'widget' && item.widgetType) {
      // Get default size based on widget type
      const widgetSizes: Record<string, { width: number; height: number }> = {
        'sticky-note': { width: 200, height: 200 },
        'guestbook': { width: 280, height: 350 },
        'music-player': { width: 250, height: 300 },
        'pixel-canvas': { width: 280, height: 320 },
        'link-board': { width: 280, height: 250 },
      };
      const size = widgetSizes[item.widgetType] || { width: 250, height: 250 };
      openWindow({
        id: `visitor-widget-${item.id}`,
        title: item.name,
        position: { x: 100 + offsetX, y: 100 + offsetY },
        size,
        minimized: false,
        maximized: false,
        contentType: 'widget',
        contentId: item.id,
      });
    }
  }, [openWindow]);

  // Loading state
  if (loadingState === 'loading') {
    return (
      <div className={styles.container}>
        <div className={styles.loadingScreen}>
          <div className={styles.loadingText}>Loading desktop...</div>
        </div>
      </div>
    );
  }

  // User not found - classic Mac error dialog
  if (loadingState === 'not_found') {
    return (
      <div className={styles.container}>
        <div className={styles.errorDialog}>
          <div className={styles.errorIcon}>⚠️</div>
          <div className={styles.errorTitle}>User Not Found</div>
          <div className={styles.errorMessage}>
            The desktop for "@{username}" could not be found.
          </div>
          <Link to="/" className={styles.errorButton}>OK</Link>
        </div>
      </div>
    );
  }

  // Error state
  if (loadingState === 'error') {
    return (
      <div className={styles.container}>
        <div className={styles.errorDialog}>
          <div className={styles.errorIcon}>⚠️</div>
          <div className={styles.errorTitle}>Error</div>
          <div className={styles.errorMessage}>
            {errorMessage || 'An unexpected error occurred.'}
          </div>
          <Link to="/" className={styles.errorButton}>OK</Link>
        </div>
      </div>
    );
  }

  // Calculate wallpaper class and style
  const wallpaperValue = profile?.wallpaper;
  const isCustomWallpaper = wallpaperValue?.startsWith('custom:');
  const wallpaperClass = isCustomWallpaper ? '' : `wallpaper-${wallpaperValue || 'default'}`;
  const wallpaperStyle = isCustomWallpaper
    ? (() => {
        const mode = profile?.wallpaperMode || 'cover';
        const base = { backgroundImage: `url(${getWallpaperUrl(wallpaperValue!)})` };
        switch (mode) {
          case 'tile':
            return { ...base, backgroundSize: 'auto', backgroundRepeat: 'repeat', backgroundPosition: 'top left' };
          case 'center':
            return { ...base, backgroundSize: 'auto', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' };
          case 'cover':
          default:
            return { ...base, backgroundSize: 'cover', backgroundRepeat: 'no-repeat', backgroundPosition: 'center' };
        }
      })()
    : undefined;

  // Watermark visibility - only show if not hidden by profile setting
  const showWatermark = !profile?.hideWatermark;

  // Empty desktop state
  if (loadingState === 'empty') {
    return (
      <div className={styles.container}>
        <VisitorMenuBar username={username || ''} />
        <div
          className={`${styles.desktop} user-desktop ${wallpaperClass}`}
          eos-name="desktop"
          style={wallpaperStyle}
        >
          <div className={styles.emptyDesktopWindow}>
            <div className={styles.emptyWindowTitleBar}>
              <span className={styles.emptyWindowTitle}>@{username}'s Desktop</span>
            </div>
            <div className={styles.emptyWindowContent}>
              <p>This desktop is empty.</p>
              <p className={styles.emptySubtext}>No public items to display.</p>
            </div>
          </div>
        </div>
        <div className={styles.bottomBar}>
          {showWatermark && <Watermark />}
        </div>
      </div>
    );
  }

  // Loaded state - render the visitor desktop
  // On mobile, use MobileBrowser for better touch experience
  if (isMobile) {
    return (
      <MobileBrowser
        isVisitorMode={true}
        visitorItems={items}
        username={username}
        ownerUid={profile?.uid}
      />
    );
  }

  // Desktop view
  return (
    <div className={styles.container}>
      <VisitorMenuBar username={username || ''} />
      <div
        className={`${styles.desktop} user-desktop ${wallpaperClass}`}
        eos-name="desktop"
        style={wallpaperStyle}
        onClick={handleDesktopClick}
      >
        {/* Desktop Icons - Read-only, no dragging */}
        {rootItems.map((item) => (
          <DesktopIcon
            key={item.id}
            item={item}
            isSelected={selectedIds.has(item.id)}
            gridCellSize={GRID_CELL_SIZE}
            onSelect={handleIconSelect}
            onDoubleClick={handleIconDoubleClick}
            // No drag handlers - visitor mode is read-only
            onDragStart={undefined}
            onDragMove={undefined}
            onDragEnd={undefined}
            isDragging={false}
          />
        ))}

        {/* Sticker Layer - decorative images */}
        {stickerItems.map((item) => (
          <Sticker
            key={item.id}
            item={item}
            isOwner={false}
          />
        ))}

        {/* Window Manager - windows can still be moved/resized for browsing */}
        <WindowManager isVisitorMode={true} visitorItems={items} ownerUid={profile?.uid} />
      </div>
      <div className={styles.bottomBar}>
        {profile && profileHasAppearance(profile as unknown as Record<string, unknown>) && (
          <StealThemeButton profile={profile} />
        )}
        {showWatermark && <Watermark />}
      </div>
    </div>
  );
}

/**
 * "Steal this theme" button — lets visitors export the owner's appearance
 */
function StealThemeButton({ profile }: { profile: UserProfile }) {
  const [copied, setCopied] = useState(false);

  const handleSteal = () => {
    const appearance = profileToAppearance(profile as unknown as Record<string, unknown>);
    // Exclude customCSS from the exported theme
    const theme: Record<string, unknown> = { _format: 'eternalos-theme-v1' };
    for (const key of APPEARANCE_PROFILE_KEYS) {
      if (key === 'customCSS') continue;
      const value = (appearance as Record<string, unknown>)[key];
      if (value !== undefined) {
        theme[key] = value;
      }
    }

    const json = JSON.stringify(theme, null, 2);
    navigator.clipboard.writeText(json).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback: download as file
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${profile.username}-theme.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  return (
    <button
      className={styles.stealThemeButton}
      onClick={handleSteal}
      title="Copy this desktop's theme to your clipboard"
    >
      {copied ? 'Copied!' : 'Steal this theme'}
    </button>
  );
}

/**
 * Made with EternalOS watermark - unobtrusive link to landing page
 */
function Watermark() {
  return (
    <a
      href="/"
      className={styles.watermark}
      target="_blank"
      rel="noopener noreferrer"
      title="Create your own EternalOS desktop"
    >
      <span className={styles.watermarkIcon}>
        <svg viewBox="0 0 16 16" fill="currentColor">
          <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1" fill="none" />
          <rect x="3" y="3" width="4" height="3" fill="currentColor" />
          <rect x="9" y="3" width="4" height="3" fill="currentColor" />
          <rect x="3" y="8" width="10" height="5" fill="currentColor" />
        </svg>
      </span>
      <span>Made with EternalOS</span>
    </a>
  );
}
