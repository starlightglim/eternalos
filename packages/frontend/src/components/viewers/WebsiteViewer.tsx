import { useState, useCallback, useRef } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import styles from './WebsiteViewer.module.css';

interface WebsiteViewerProps {
  itemId: string;
  url?: string;
  name?: string;
}

/**
 * WebsiteViewer - Classic Mac OS-style website browser/embed
 * Features:
 * - Embeds websites via iframe with sandbox security
 * - Navigation bar with URL display
 * - Back, forward, refresh buttons
 * - Open in new tab button
 * - Handles sites that block iframe embedding
 */
export function WebsiteViewer({ itemId, url: propUrl, name: propName }: WebsiteViewerProps) {
  // Get item from store as fallback
  const item = useDesktopStore((state) => state.getItem(itemId));
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Prefer prop url, fall back to store item
  const url = propUrl || item?.url;
  const siteName = propName || item?.name || 'Website';

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const displayUrl = url || '';

  const handleLoad = useCallback(() => {
    setIsLoading(false);
    setError(null);
  }, []);

  const handleError = useCallback(() => {
    setError('This website cannot be displayed in a frame. Click "Open in Browser" to view it.');
    setIsLoading(false);
  }, []);

  // Refresh the iframe
  const handleRefresh = useCallback(() => {
    if (iframeRef.current && url) {
      setIsLoading(true);
      setError(null);
      // Force reload by setting src to empty and back
      iframeRef.current.src = '';
      setTimeout(() => {
        if (iframeRef.current) {
          iframeRef.current.src = url;
        }
      }, 50);
    }
  }, [url]);

  // Open in new browser tab
  const handleOpenExternal = useCallback(() => {
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, [url]);

  // Show error if no URL available
  if (!url && !item) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Link not found</div>
      </div>
    );
  }

  if (!url) {
    return (
      <div className={styles.container}>
        <div className={styles.demoMode}>
          <div className={styles.demoIcon}>
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
              {/* Globe icon */}
              <circle cx="32" cy="32" r="24" fill="#fff" stroke="#000" strokeWidth="2"/>
              <ellipse cx="32" cy="32" rx="10" ry="24" fill="none" stroke="#000" strokeWidth="1.5"/>
              <line x1="8" y1="32" x2="56" y2="32" stroke="#000" strokeWidth="1.5"/>
              <ellipse cx="32" cy="20" rx="18" ry="6" fill="none" stroke="#000" strokeWidth="1"/>
              <ellipse cx="32" cy="44" rx="18" ry="6" fill="none" stroke="#000" strokeWidth="1"/>
            </svg>
          </div>
          <p className={styles.demoText}>{siteName}</p>
          <p className={styles.demoSubtext}>No URL specified</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Navigation Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.navButtons}>
          {/* Refresh button */}
          <button
            className={styles.navButton}
            onClick={handleRefresh}
            title="Refresh"
            disabled={!url}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 8C2 4.69 4.69 2 8 2C10.22 2 12.16 3.21 13.2 5H11V6.5H15.5V2H14V4.1C12.68 2.22 10.48 1 8 1C4.13 1 1 4.13 1 8H2Z"/>
              <path d="M14 8C14 11.31 11.31 14 8 14C5.78 14 3.84 12.79 2.8 11H5V9.5H0.5V14H2V11.9C3.32 13.78 5.52 15 8 15C11.87 15 15 11.87 15 8H14Z"/>
            </svg>
          </button>
        </div>

        {/* URL display bar */}
        <div className={styles.urlBar}>
          <div className={styles.urlIcon}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5"/>
              <ellipse cx="8" cy="8" rx="2.5" ry="6" fill="none" stroke="currentColor" strokeWidth="1"/>
              <line x1="2" y1="8" x2="14" y2="8" stroke="currentColor" strokeWidth="1"/>
            </svg>
          </div>
          <span className={styles.urlText} title={displayUrl}>
            {displayUrl}
          </span>
        </div>

        {/* Open external button */}
        <button
          className={styles.externalButton}
          onClick={handleOpenExternal}
          title="Open in Browser"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M10 1H15V6M15 1L8 8M6 3H2V14H13V10" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          </svg>
        </button>
      </div>

      {/* Website Content */}
      <div className={styles.contentWrapper}>
        {isLoading && !error && (
          <div className={styles.loadingOverlay}>
            <div className={styles.loadingSpinner} />
            <span>Loading {siteName}...</span>
          </div>
        )}

        {error && (
          <div className={styles.errorOverlay}>
            <div className={styles.errorIcon}>
              <svg width="48" height="48" viewBox="0 0 64 64" fill="none">
                {/* Blocked globe */}
                <circle cx="32" cy="32" r="24" fill="#fff" stroke="#000" strokeWidth="2"/>
                <ellipse cx="32" cy="32" rx="10" ry="24" fill="none" stroke="#808080" strokeWidth="1"/>
                <line x1="8" y1="32" x2="56" y2="32" stroke="#808080" strokeWidth="1"/>
                {/* X mark */}
                <line x1="20" y1="20" x2="44" y2="44" stroke="#c00" strokeWidth="3"/>
                <line x1="44" y1="20" x2="20" y2="44" stroke="#c00" strokeWidth="3"/>
              </svg>
            </div>
            <p className={styles.errorText}>{error}</p>
            <button className={styles.openButton} onClick={handleOpenExternal}>
              Open in Browser
            </button>
          </div>
        )}

        <iframe
          ref={iframeRef}
          src={url}
          className={styles.iframe}
          title={siteName}
          sandbox="allow-scripts allow-forms allow-popups"
          onLoad={handleLoad}
          onError={handleError}
          style={{ display: error ? 'none' : 'block' }}
        />
      </div>
    </div>
  );
}
