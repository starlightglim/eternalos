import { useState, useCallback } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { getFileUrl, isApiConfigured } from '../../services/api';
import { useFileTokenVersion } from '../../hooks/useFileToken';
import styles from './PDFViewer.module.css';

interface PDFViewerProps {
  itemId: string;
  r2Key?: string;
  name?: string;
}

/**
 * PDFViewer - Classic Mac OS-style PDF document viewer
 * Uses native browser PDF rendering via iframe/object element
 */
export function PDFViewer({ itemId, r2Key: propR2Key, name: propName }: PDFViewerProps) {
  // Get item from store as fallback (for backwards compatibility)
  const item = useDesktopStore((state) => state.getItem(itemId));
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Prefer prop r2Key, fall back to store item
  const r2Key = propR2Key || item?.r2Key;
  const fileName = propName || item?.name || 'Document';

  // Re-render when the file token rotates so the PDF URL stays signed.
  useFileTokenVersion();
  const pdfUrl = r2Key && isApiConfigured
    ? getFileUrl(r2Key)
    : null;

  const handleLoad = useCallback(() => {
    setIsLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setError('Failed to load PDF document');
    setIsLoading(false);
  }, []);

  // Open in new tab for full browser PDF viewer
  const handleOpenExternal = useCallback(() => {
    if (pdfUrl) {
      window.open(pdfUrl, '_blank', 'noopener,noreferrer');
    }
  }, [pdfUrl]);

  // Show error if no r2Key available (item not found in store AND no prop passed)
  if (!r2Key && !item) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>PDF file not found</div>
      </div>
    );
  }

  if (!pdfUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.demoMode}>
          <div className={styles.demoIcon}>
            <svg width="64" height="80" viewBox="0 0 64 80" fill="none">
              {/* Document body */}
              <rect x="4" y="4" width="48" height="64" fill="#fff" stroke="#000" strokeWidth="2"/>
              {/* Folded corner */}
              <path d="M40 4 L52 16 L40 16 Z" fill="#c0c0c0" stroke="#000" strokeWidth="1"/>
              <path d="M40 4 L52 16" stroke="#000" strokeWidth="2"/>
              {/* PDF text */}
              <text x="20" y="44" fontFamily="Chicago, Geneva, sans-serif" fontSize="14" fill="#c00">PDF</text>
              {/* Lines representing text */}
              <rect x="12" y="52" width="32" height="2" fill="#808080"/>
              <rect x="12" y="58" width="24" height="2" fill="#808080"/>
            </svg>
          </div>
          <p className={styles.demoText}>{fileName}</p>
          <p className={styles.demoSubtext}>Demo mode: No PDF data</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>{error}</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.fileName}>{fileName}</span>
        </div>
        <div className={styles.toolbarRight}>
          <button
            className={styles.toolbarButton}
            onClick={handleOpenExternal}
            title="Open in New Tab"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M10 1H15V6M15 1L8 8M6 3H2V14H13V10" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            </svg>
            <span>Open in Browser</span>
          </button>
        </div>
      </div>

      {/* PDF Content */}
      <div className={styles.pdfWrapper}>
        {isLoading && (
          <div className={styles.loadingOverlay}>
            <span>Loading PDF...</span>
          </div>
        )}
        <object
          data={pdfUrl}
          type="application/pdf"
          className={styles.pdfObject}
          onLoad={handleLoad}
          onError={handleError}
        >
          {/* Fallback for browsers that don't support object tag for PDFs */}
          <iframe
            src={pdfUrl}
            className={styles.pdfFrame}
            title={fileName}
            onLoad={handleLoad}
            onError={handleError}
          />
        </object>
      </div>
    </div>
  );
}
