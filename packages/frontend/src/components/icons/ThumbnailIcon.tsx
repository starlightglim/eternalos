/**
 * ThumbnailIcon Component
 *
 * Displays a pixelated thumbnail preview of media files (images, videos).
 * Uses the actual file content scaled down with pixelated rendering
 * for that authentic retro Mac aesthetic.
 *
 * Implements Intersection Observer-based lazy loading to prevent fetching
 * full images for icons that are not visible in the viewport (e.g., icons
 * in closed folders or scrolled off-screen).
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { getFileUrl } from '../../services/api';
import { useFileTokenVersion } from '../../hooks/useFileToken';
import styles from './ThumbnailIcon.module.css';

interface ThumbnailIconProps {
  /** R2 key for the thumbnail (or full image if no separate thumbnail) */
  r2Key: string;
  /** Optional separate thumbnail key for faster loading */
  thumbnailKey?: string;
  /** Alt text for accessibility */
  alt: string;
  /** Icon size (width and height in px) */
  size?: number;
  /** Whether the icon is currently selected */
  isSelected?: boolean;
}

/**
 * ThumbnailIcon displays a pixelated preview of an image file.
 * Falls back to loading state or error state gracefully.
 *
 * Uses Intersection Observer to defer image loading until the icon
 * is visible in the viewport. This prevents unnecessary network requests
 * for thumbnails that aren't yet visible to the user.
 */
export function ThumbnailIcon({
  r2Key,
  thumbnailKey,
  alt,
  size = 32,
  isSelected = false,
}: ThumbnailIconProps) {
  const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined';
  // Track whether the icon is visible in the viewport
  const [isVisible, setIsVisible] = useState(!supportsIntersectionObserver);
  // Track image load state: 'idle' (waiting for visibility), 'loading', 'loaded', 'error'
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>(
    supportsIntersectionObserver ? 'idle' : 'loading'
  );
  const containerRef = useRef<HTMLDivElement>(null);

  // Use thumbnail key if available, otherwise use full image
  const imageKey = thumbnailKey || r2Key;
  // Subscribe to file-token version so URLs are recomputed after the token
  // first loads (page refresh) or rotates (every few minutes). Without this
  // the first render after a refresh produces a tokenless URL that 401s.
  const fileTokenVersion = useFileTokenVersion();
  const imageUrl = getFileUrl(imageKey);

  // If we previously errored (e.g. fetched without a token), retry once the
  // token version changes so the new signed URL gets a chance to load.
  useEffect(() => {
    setLoadState((prev) => (prev === 'error' && isVisible ? 'loading' : prev));
  }, [fileTokenVersion, imageUrl, isVisible]);

  // Set up Intersection Observer to detect when icon enters viewport
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    // If IntersectionObserver is not available (old browsers), load immediately
    if (!supportsIntersectionObserver) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry.isIntersecting) {
          // Icon is now visible - start loading the image
          setIsVisible(true);
          setLoadState('loading');
          // Once visible, we don't need to observe anymore
          observer.disconnect();
        }
      },
      {
        // Load when within 100px of viewport (slight preload for smoother UX)
        rootMargin: '100px',
        threshold: 0,
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [supportsIntersectionObserver]);

  const handleLoad = useCallback(() => {
    setLoadState('loaded');
  }, []);

  const handleError = useCallback(() => {
    setLoadState('error');
  }, []);

  // Show loading state when idle (not yet visible) or actively loading
  const showLoading = loadState === 'idle' || loadState === 'loading';

  return (
    <div
      ref={containerRef}
      className={`${styles.thumbnailContainer} ${isSelected ? styles.selected : ''}`}
      style={{ width: size, height: size }}
    >
      {/* Loading placeholder - shown until image loads or errors */}
      {showLoading && (
        <div className={styles.placeholder}>
          <div className={styles.loadingDots}>
            <span />
            <span />
            <span />
          </div>
        </div>
      )}

      {/* Error state - show generic image icon */}
      {loadState === 'error' && (
        <div className={styles.errorIcon}>
          <svg width={size * 0.75} height={size * 0.75} viewBox="0 0 32 32" fill="none">
            {/* Simple image icon fallback */}
            <rect x="2" y="4" width="28" height="24" fill="#FFFFFF" stroke="#000000" strokeWidth="2" />
            <circle cx="10" cy="12" r="3" fill="#FFCC00" />
            <path d="M4 24 L12 16 L18 22 L24 14 L28 20 L28 26 L4 26 Z" fill="#4CAF50" />
          </svg>
        </div>
      )}

      {/* Actual thumbnail image - only rendered when visible in viewport */}
      {isVisible && (
        <img
          src={imageUrl}
          alt={alt}
          className={`${styles.thumbnail} ${loadState === 'loaded' ? styles.visible : ''}`}
          onLoad={handleLoad}
          onError={handleError}
          loading="lazy"
          draggable={false}
        />
      )}

      {/* Pixelated border frame for that retro Mac look */}
      <div className={styles.frame} />
    </div>
  );
}
