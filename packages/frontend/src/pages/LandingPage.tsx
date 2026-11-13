/**
 * LandingPage - EternalOS Welcome Page (Consumer Launch)
 *
 * Redesigned landing page with:
 * - Compelling headline and 3 value propositions
 * - Interactive demo desktop visitors can explore without signing up
 * - "Create Your Desktop" CTA
 * - Featured desktops gallery (opt-in showcase)
 * - Classic Mac OS aesthetic throughout
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { openExternalUrl } from '../utils/safeUrl';
import { Link } from 'react-router-dom';
import { useDocumentMeta } from '../hooks/useDocumentMeta';
import { useWindowStore } from '../stores/windowStore';
import { useIsMobile } from '../hooks/useIsMobile';
import { DesktopIcon } from '../components/icons';
import { WindowManager } from '../components/window';
import type { DesktopItem } from '../types';
import styles from './LandingPage.module.css';

// Featured desktop placeholders (will be curated later)
interface FeaturedDesktop {
  username: string;
  displayName: string;
  description: string;
  accentColor?: string;
}

// Manually curated featured desktops - to be populated with real users
const FEATURED_DESKTOPS: FeaturedDesktop[] = [
  // Placeholder entries - replace with real curated users
  // { username: 'alice', displayName: 'Alice', description: 'Pixel art & music' },
  // { username: 'bob', displayName: 'Bob', description: 'Photography portfolio' },
];

// Demo desktop items for the interactive preview
const DEMO_ITEMS: DesktopItem[] = [
  {
    id: 'demo-welcome',
    type: 'text',
    name: 'Welcome.txt',
    parentId: null,
    position: { x: 0, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    textContent: `Welcome to EternalOS!

This is your personal corner of the internet — a desktop that's truly yours.

• Arrange files, folders, images, and links however you like
• Share your unique /@username link with friends
• No algorithms, no feeds, no likes — just you

Double-click any icon to explore. When you're ready, create your own desktop!`,
  },
  {
    id: 'demo-folder',
    type: 'folder',
    name: 'My Stuff',
    parentId: null,
    position: { x: 0, y: 1 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'demo-subfolder-1',
    type: 'text',
    name: 'Notes.txt',
    parentId: 'demo-folder',
    position: { x: 0, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    textContent: `A place for thoughts, ideas, and memories.

Unlike social media, nothing here is designed to capture your attention or measure your worth in likes.

Just a quiet space to collect what matters to you.`,
  },
  {
    id: 'demo-subfolder-2',
    type: 'link',
    name: 'EternalOS on GitHub',
    parentId: 'demo-folder',
    position: { x: 1, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: 'https://github.com/anthropics/eternalos',
  },
  {
    id: 'demo-link',
    type: 'link',
    name: 'About EternalOS',
    parentId: null,
    position: { x: 0, y: 2 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: 'https://github.com/anthropics/eternalos#readme',
  },
  {
    id: 'demo-widget',
    type: 'widget',
    name: 'Note',
    parentId: null,
    position: { x: 1, y: 0 },
    isPublic: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    widgetType: 'sticky-note',
    widgetConfig: {
      color: '#ffffa0',
      text: 'Try me! Double-click to open.\n\nThis is a sticky note widget.',
    },
  },
];

const GRID_CELL_SIZE = 80;

export function LandingPage() {
  const [activeSection, setActiveSection] = useState<'hero' | 'demo' | 'featured'>('hero');
  const [demoSelectedIds, setDemoSelectedIds] = useState<Set<string>>(new Set());
  const { openWindow, closeWindow } = useWindowStore();
  const isMobile = useIsMobile();

  // SEO meta tags
  useDocumentMeta({
    title: 'EternalOS - Your corner of the internet',
    description: 'A personal desktop in the browser. No algorithms. No feeds. Just you. Create your digital sanctuary today.',
    ogTitle: 'EternalOS',
    ogDescription: 'A personal desktop in the browser. Place files, receive visitors, enjoy the quiet.',
    ogType: 'website',
    twitterCard: 'summary_large_image',
  });

  // Close demo windows when leaving demo section
  useEffect(() => {
    if (activeSection !== 'demo') {
      // Close all demo windows
      const windows = useWindowStore.getState().windows;
      windows.forEach((w) => {
        if (w.id.startsWith('demo-')) {
          closeWindow(w.id);
        }
      });
    }
  }, [activeSection, closeWindow]);

  // Demo desktop handlers
  const handleDemoIconSelect = useCallback((id: string) => {
    setDemoSelectedIds(new Set([id]));
  }, []);

  const handleDemoDesktopClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      setDemoSelectedIds(new Set());
    }
  }, []);

  const handleDemoIconDoubleClick = useCallback((item: DesktopItem) => {
    const existingWindows = useWindowStore.getState().windows.length;
    const offsetX = 30 * existingWindows;
    const offsetY = 30 * existingWindows;

    if (item.type === 'folder') {
      openWindow({
        id: `demo-folder-${item.id}`,
        title: item.name,
        position: { x: 100 + offsetX, y: 80 + offsetY },
        size: { width: 350, height: 250 },
        minimized: false,
        maximized: false,
        contentType: 'folder',
        contentId: item.id,
      });
    } else if (item.type === 'text') {
      openWindow({
        id: `demo-text-${item.id}`,
        title: item.name,
        position: { x: 120 + offsetX, y: 60 + offsetY },
        size: { width: 380, height: 280 },
        minimized: false,
        maximized: false,
        contentType: 'text',
        contentId: item.id,
      });
    } else if (item.type === 'link' && item.url) {
      openExternalUrl(item.url);
    } else if (item.type === 'widget' && item.widgetType) {
      const widgetSizes: Record<string, { width: number; height: number }> = {
        'sticky-note': { width: 200, height: 200 },
        'guestbook': { width: 280, height: 350 },
        'music-player': { width: 250, height: 300 },
        'pixel-canvas': { width: 280, height: 320 },
        'link-board': { width: 280, height: 250 },
      };
      const size = widgetSizes[item.widgetType] || { width: 250, height: 250 };
      openWindow({
        id: `demo-widget-${item.id}`,
        title: item.name,
        position: { x: 150 + offsetX, y: 100 + offsetY },
        size,
        minimized: false,
        maximized: false,
        contentType: 'widget',
        contentId: item.id,
      });
    }
  }, [openWindow]);

  // Root demo items
  const rootDemoItems = useMemo(
    () => DEMO_ITEMS.filter((item) => item.parentId === null),
    []
  );

  return (
    <div className={styles.container}>
      {/* Menu bar */}
      <div className={styles.menuBar}>
        <div className={styles.menuLeft}>
          <span className={styles.menuLogo}>
            <AppleLogo />
          </span>
          <span className={styles.menuTitle}>EternalOS</span>
        </div>
        <div className={styles.menuRight}>
          <span className={styles.menuClock}>
            {new Date().toLocaleTimeString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })}
          </span>
        </div>
      </div>

      {/* Navigation tabs (styled as desktop icons bar) */}
      <div className={styles.navTabs}>
        <button
          className={`${styles.navTab} ${activeSection === 'hero' ? styles.navTabActive : ''}`}
          onClick={() => setActiveSection('hero')}
        >
          About
        </button>
        <button
          className={`${styles.navTab} ${activeSection === 'demo' ? styles.navTabActive : ''}`}
          onClick={() => setActiveSection('demo')}
        >
          Try Demo
        </button>
        {FEATURED_DESKTOPS.length > 0 && (
          <button
            className={`${styles.navTab} ${activeSection === 'featured' ? styles.navTabActive : ''}`}
            onClick={() => setActiveSection('featured')}
          >
            Featured
          </button>
        )}
      </div>

      {/* Hero section */}
      {activeSection === 'hero' && (
        <div className={styles.heroSection}>
          <div className={styles.heroWindow}>
            <div className={styles.windowTitleBar}>
              <div className={styles.closeBox} />
              <span className={styles.windowTitle}>Welcome to EternalOS</span>
              <div className={styles.windowButtons}>
                <div className={styles.collapseBox} />
                <div className={styles.zoomBox} />
              </div>
            </div>
            <div className={styles.windowContent}>
              <div className={styles.heroContent}>
                <h1 className={styles.headline}>Your corner of the internet</h1>
                <p className={styles.subheadline}>
                  A personal desktop in the browser. No algorithms, no feeds, no metrics.
                  <br />
                  Just a quiet space that's truly yours.
                </p>

                <div className={styles.features}>
                  <div className={styles.feature}>
                    <div className={styles.featureIcon}>
                      <FolderIcon />
                    </div>
                    <div className={styles.featureText}>
                      <h3>Place, don't post</h3>
                      <p>Arrange files, images, and links on a desktop that feels like home. Drag, drop, organize your way.</p>
                    </div>
                  </div>

                  <div className={styles.feature}>
                    <div className={styles.featureIcon}>
                      <WindowIcon />
                    </div>
                    <div className={styles.featureText}>
                      <h3>Visitors, not followers</h3>
                      <p>Share your unique /@username link. People visit your space — no accounts, no engagement loops.</p>
                    </div>
                  </div>

                  <div className={styles.feature}>
                    <div className={styles.featureIcon}>
                      <LockIcon />
                    </div>
                    <div className={styles.featureText}>
                      <h3>Quiet by design</h3>
                      <p>No likes, no comments, no notifications. A digital sanctuary for thoughtful curation.</p>
                    </div>
                  </div>
                </div>

                <div className={styles.cta}>
                  <Link to="/signup" className={styles.primaryButton}>
                    Create Your Desktop
                  </Link>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setActiveSection('demo')}
                  >
                    Try the Demo
                  </button>
                </div>

                <div className={styles.loginLink}>
                  Already have an account? <Link to="/login">Log in</Link>
                </div>
              </div>
            </div>
          </div>

          <p className={styles.footer}>
            Built on Cloudflare. Inspired by classic Mac OS.
          </p>
        </div>
      )}

      {/* Interactive demo section */}
      {activeSection === 'demo' && (
        <div className={styles.demoSection}>
          {/* Demo info bar */}
          <div className={styles.demoInfoBar}>
            <span className={styles.demoInfoText}>
              {isMobile ? 'Tap icons to explore' : 'Double-click icons to explore'} — this is a fully interactive demo
            </span>
            <Link to="/signup" className={styles.demoSignupLink}>
              Create your own
            </Link>
          </div>

          {/* Demo desktop surface */}
          <div
            className={styles.demoDesktop}
            onClick={handleDemoDesktopClick}
          >
            {/* Demo icons */}
            {rootDemoItems.map((item) => (
              <DesktopIcon
                key={item.id}
                item={item}
                isSelected={demoSelectedIds.has(item.id)}
                gridCellSize={GRID_CELL_SIZE}
                onSelect={handleDemoIconSelect}
                onDoubleClick={handleDemoIconDoubleClick}
                onDragStart={undefined}
                onDragMove={undefined}
                onDragEnd={undefined}
                isDragging={false}
              />
            ))}

            {/* Demo windows */}
            <WindowManager
              isVisitorMode={true}
              visitorItems={DEMO_ITEMS}
              ownerUid="demo"
            />

            {/* Demo trash icon (decorative) */}
            <div className={styles.demoTrash}>
              <TrashIcon />
              <span>Trash</span>
            </div>
          </div>
        </div>
      )}

      {/* Featured desktops section */}
      {activeSection === 'featured' && FEATURED_DESKTOPS.length > 0 && (
        <div className={styles.featuredSection}>
          <div className={styles.featuredWindow}>
            <div className={styles.windowTitleBar}>
              <div className={styles.closeBox} />
              <span className={styles.windowTitle}>Featured Desktops</span>
              <div className={styles.windowButtons}>
                <div className={styles.collapseBox} />
                <div className={styles.zoomBox} />
              </div>
            </div>
            <div className={styles.windowContent}>
              <p className={styles.featuredIntro}>
                Explore desktops curated by the EternalOS community.
              </p>
              <div className={styles.featuredGrid}>
                {FEATURED_DESKTOPS.map((desktop) => (
                  <Link
                    key={desktop.username}
                    to={`/@${desktop.username}`}
                    className={styles.featuredCard}
                  >
                    <div
                      className={styles.featuredPreview}
                      style={{
                        borderColor: desktop.accentColor || '#000080',
                      }}
                    >
                      {/* Preview placeholder - could be og:image */}
                      <div className={styles.featuredPreviewInner}>
                        <FolderIcon />
                      </div>
                    </div>
                    <div className={styles.featuredInfo}>
                      <span className={styles.featuredName}>@{desktop.username}</span>
                      <span className={styles.featuredDesc}>{desktop.description}</span>
                    </div>
                  </Link>
                ))}
              </div>
              <div className={styles.featuredCta}>
                <Link to="/signup" className={styles.primaryButton}>
                  Create Your Own
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Pixel art icons
function AppleLogo() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" style={{ imageRendering: 'pixelated' }}>
      <rect x="5" y="0" width="2" height="2" />
      <rect x="3" y="2" width="6" height="2" />
      <rect x="1" y="4" width="10" height="2" />
      <rect x="0" y="6" width="12" height="4" />
      <rect x="1" y="10" width="4" height="2" />
      <rect x="7" y="10" width="4" height="2" />
      <rect x="2" y="12" width="2" height="2" />
      <rect x="8" y="12" width="2" height="2" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ imageRendering: 'pixelated' }}>
      <rect x="2" y="8" width="28" height="20" fill="#FFFFCC" stroke="black" strokeWidth="2" />
      <rect x="2" y="4" width="12" height="6" fill="#FFFFCC" stroke="black" strokeWidth="2" />
      <rect x="4" y="10" width="24" height="2" fill="black" />
    </svg>
  );
}

function WindowIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ imageRendering: 'pixelated' }}>
      <rect x="2" y="4" width="28" height="24" fill="white" stroke="black" strokeWidth="2" />
      <rect x="2" y="4" width="28" height="8" fill="#C0C0C0" stroke="black" strokeWidth="2" />
      <rect x="4" y="6" width="4" height="4" fill="white" stroke="black" strokeWidth="1" />
      <line x1="2" y1="12" x2="30" y2="12" stroke="black" strokeWidth="2" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ imageRendering: 'pixelated' }}>
      <rect x="6" y="14" width="20" height="14" fill="#C0C0C0" stroke="black" strokeWidth="2" />
      <path d="M10 14V10C10 6 12 4 16 4C20 4 22 6 22 10V14" stroke="black" strokeWidth="2" fill="none" />
      <circle cx="16" cy="21" r="2" fill="black" />
      <line x1="16" y1="23" x2="16" y2="26" stroke="black" strokeWidth="2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ imageRendering: 'pixelated' }}>
      <rect x="8" y="8" width="16" height="20" fill="white" stroke="black" strokeWidth="2" />
      <rect x="6" y="4" width="20" height="4" fill="#C0C0C0" stroke="black" strokeWidth="2" />
      <line x1="12" y1="12" x2="12" y2="24" stroke="black" strokeWidth="2" />
      <line x1="16" y1="12" x2="16" y2="24" stroke="black" strokeWidth="2" />
      <line x1="20" y1="12" x2="20" y2="24" stroke="black" strokeWidth="2" />
    </svg>
  );
}
