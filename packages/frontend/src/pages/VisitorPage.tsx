// Visitor Page - Read-only view of a user's desktop
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { setPendingRice } from '../estheme/pendingRice';
import { openExternalUrl } from '../utils/safeUrl';
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
import { APPEARANCE_PROFILE_KEYS, applyAppearance, clearAppearance, profileToAppearance, profileHasAppearance, useAppearanceStore } from '../stores/appearanceStore';
import { useSoundStore, type SoundPack } from '../stores/soundStore';
import { mergeLiveProfile, visitorLookKey, visitorUsernameFrom } from '../utils/visitorView';
import { getTextFileContentType, type DesktopItem, type UserProfile } from '../types';
import styles from './VisitorPage.module.css';

const GRID_CELL_SIZE = 80;

// Profile fields a live push replaces outright (absent = cleared by the owner)
const LIVE_LOOK_KEYS: readonly string[] = [...APPEARANCE_PROFILE_KEYS, 'designTokens', 'variants', 'soundPack'];

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
  const username = visitorUsernameFrom(routeUsername, window.location.pathname);
  const { openWindow, loadVisitorWindows } = useWindowStore();
  const isMobile = useIsMobile();

  const [loadingState, setLoadingState] = useState<LoadingState>('loading');
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [items, setItems] = useState<DesktopItem[]>([]);
  const [savedWindows, setSavedWindows] = useState<SavedWindowState[] | undefined>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const hasRestoredWindows = useRef(false);

  // Build meta config based on current state
  const metaConfig = useMemo(() => {
    const displayName = profile?.displayName || username || 'Unknown';
    const itemCount = items.filter((i) => i.parentId === null).length;

    // Generate og:image URL pointing to our dynamic image endpoint on the API
    const apiBase = import.meta.env.VITE_API_URL || '';
    const ogImageUrl = `${apiBase}/api/og/${encodeURIComponent(username || "")}.png`;

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

  // The owner's look and sound pack, keyed by value: live profile updates
  // (and every snapshot on reconnect) arrive as new objects, and re-applying
  // an unchanged look flashes the default theme and reloads the sounds.
  const ownerProfile = profile as unknown as Record<string, unknown> | null;
  const appearanceKey = ownerProfile ? visitorLookKey(profileToAppearance(ownerProfile)) : null;
  const soundPackKey = ownerProfile?.soundPack ? visitorLookKey(ownerProfile.soundPack) : null;

  // Apply the owner's appearance (incl. custom CSS) only when it actually
  // changes. The cleanup puts the visitor's own look back — on leaving, and
  // when the profile goes away (another username, a failed retry) so an old
  // owner's theme never dresses the next page. A key change swaps looks in
  // one synchronous step, with no paint in between.
  useEffect(() => {
    if (appearanceKey === null) return;
    const savedAppearance = userAppearance.current;
    clearAppearance();
    applyAppearance(JSON.parse(appearanceKey));
    return () => {
      clearAppearance();
      if (savedAppearance && Object.keys(savedAppearance).length > 0) {
        applyAppearance(savedAppearance);
      }
    };
  }, [appearanceKey]);

  // Load the owner's sound pack when it actually changes
  useEffect(() => {
    if (soundPackKey === null) return;
    void useSoundStore.getState().loadVisitorSounds(JSON.parse(soundPackKey) as SoundPack);
    return () => {
      useSoundStore.getState().clearVisitorSounds();
    };
  }, [soundPackKey]);

  // Fetch the visited desktop; re-runs when the username changes or on Retry
  useEffect(() => {
    // A new desktop (or a retry) starts from a clean slate: nothing from the
    // previous owner may show on, or leak into, this one.
    setProfile(null);
    setItems([]);
    setSavedWindows(undefined);
    setSelectedIds(new Set());
    setErrorMessage(null);
    hasRestoredWindows.current = false;
    useWindowStore.setState({ windows: [], nextZIndex: 1 });

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

    // API mode - fetch real data. `cancelled` drops a response that lands
    // after the username changed (or the page unmounted), so a slow earlier
    // visit can't overwrite the desktop being shown now.
    let cancelled = false;
    setLoadingState('loading');
    const loadVisitorData = async () => {
      try {
        const data = await fetchVisitorDesktop(username);
        if (cancelled) return;

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
        if (cancelled) return;
        console.error('Error loading visitor data:', error);
        if (error instanceof Error && error.message === 'User not found') {
          setLoadingState('not_found');
        } else {
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load desktop');
          setLoadingState('error');
        }
      }
    };

    void loadVisitorData();
    return () => {
      cancelled = true;
    };
  }, [username, loadAttempt]);

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
    setProfile((prev) => mergeLiveProfile(prev, newProfile, LIVE_LOOK_KEYS));
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
      openExternalUrl(item.url);
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
          <div className={styles.errorIcon}><CautionIcon /></div>
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
          <div className={styles.errorIcon}><CautionIcon /></div>
          <div className={styles.errorTitle}>Error</div>
          <div className={styles.errorMessage} role="alert">
            {errorMessage || 'An unexpected error occurred.'}
          </div>
          <div className={styles.errorButtons}>
            <Link to="/" className={styles.errorButton}>OK</Link>
            <button
              type="button"
              className={`${styles.errorButton} ${styles.errorButtonDefault}`}
              onClick={() => setLoadAttempt((n) => n + 1)}
              autoFocus
            >
              Retry
            </button>
          </div>
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
 * "Try this rice": signed-in visitors preview the owner's whole look on their
 * own desktop (colors, tokens incl. layout/bar/conky, variants, custom CSS,
 * cursors, sounds, wallpaper) with Keep / Revert. Everyone can download it
 * as an .estheme.
 */
function StealThemeButton({ profile }: { profile: UserProfile }) {
  const navigate = useNavigate();
  const viewer = useAuthStore((state) => state.user?.username);
  const [busy, setBusy] = useState<'try' | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const riceName = typeof profile.designTokens?.['rice.name'] === 'string' && profile.designTokens['rice.name']
    ? String(profile.designTokens['rice.name'])
    : `${profile.username}'s rice`;

  const build = async (autoDownload: boolean) => {
    const { exportCurrentTheme } = await import('../utils/exportTheme');
    return exportCurrentTheme(profile, { name: riceName, autoDownload });
  };

  const tryIt = async () => {
    setBusy('try');
    setError(null);
    try {
      const { blob } = await build(false);
      setPendingRice(blob, profile.username);
      navigate('/desktop');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This rice could not be packed.');
      setBusy(null);
    }
  };

  const download = async () => {
    setBusy('download');
    setError(null);
    try {
      await build(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This rice could not be packed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <span className={styles.riceActions}>
      {viewer && viewer !== profile.username ? (
        <button className={styles.stealThemeButton} onClick={() => void tryIt()} disabled={Boolean(busy)} title="Preview this whole look on your own desktop — keep it or revert">
          {busy === 'try' ? 'Packing…' : 'Try this rice'}
        </button>
      ) : !viewer ? (
        <Link className={styles.stealThemeButton} to="/" title="Make an EternalOS desktop to try this look on">Sign up to try this rice</Link>
      ) : null}
      <button className={styles.stealThemeButton} onClick={() => void download()} disabled={Boolean(busy)} title="Download this look as an .estheme file">
        {busy === 'download' ? 'Packing…' : 'Download .estheme'}
      </button>
      {error && <span className={styles.riceError}>{error}</span>}
    </span>
  );
}

/**
 * Classic Mac "caution" alert icon, drawn on a 16px pixel grid.
 */
function CautionIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* Triangle: black outline, filled rows widening downward */}
      <path
        fill="var(--black, #000)"
        d="M7 1h2v2h1v2h1v2h1v2h1v2h1v2h1v3H1v-3h1v-2h1V9h1V7h1V5h1V3h1V1z"
      />
      <path
        fill="var(--caution-fill, #ffcc00)"
        d="M7 3h2v2h1v2h1v2h1v2h1v2h1v2H2v-2h1v-2h1V9h1V7h1V5h1V3z"
      />
      {/* Exclamation mark */}
      <path fill="var(--black, #000)" d="M7 5h2v5H7zM7 12h2v2H7z" />
    </svg>
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
