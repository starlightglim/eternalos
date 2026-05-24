import { useState, useEffect, useCallback, useRef } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { isApiConfigured, getFileUrl } from '../../services/api';
import { useFileTokenVersion } from '../../hooks/useFileToken';
import { ContextMenu, type ContextMenuItem } from '../ui';
import styles from './ImageViewer.module.css';

interface ImageViewerProps {
  itemId: string;
  windowId: string;
  name: string;
  r2Key?: string;
  mimeType?: string;
  isOwner?: boolean;
}

/**
 * ImageViewer - Classic Mac OS style image viewer
 * Features:
 * - Pixel-art border frame
 * - Centered image, fit-to-window
 * - Loading state with dithered placeholder
 * - Error state for failed loads
 */
export function ImageViewer({
  itemId,
  windowId,
  name,
  r2Key,
  mimeType,
  isOwner = true,
}: ImageViewerProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { updateItem } = useDesktopStore();
  const { updateWindowTitle } = useWindowStore();
  // Re-run the loadImage effect when the file token rotates so the URL stays valid.
  const fileTokenVersion = useFileTokenVersion();

  // Update filename when prop changes
  useEffect(() => {
    setFileName(name);
  }, [name]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  // Handle filename rename
  const handleRename = useCallback(() => {
    if (!isOwner || !fileName.trim()) {
      setFileName(name);
      setIsEditingName(false);
      return;
    }

    const newName = fileName.trim();
    if (newName !== name) {
      updateItem(itemId, { name: newName });
      updateWindowTitle(windowId, newName);
    }
    setIsEditingName(false);
  }, [fileName, name, isOwner, itemId, windowId, updateItem, updateWindowTitle]);

  // Handle name input key events
  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setFileName(name);
        setIsEditingName(false);
      }
    },
    [handleRename, name]
  );

  // Download the image file
  const handleDownload = useCallback(async () => {
    if (!imageUrl) return;

    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
    } catch (err) {
      console.error('Failed to download image:', err);
    }
  }, [imageUrl, fileName]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    if (imageUrl) {
      items.push({
        id: 'download',
        label: 'Download',
        shortcut: '⌘S',
        action: handleDownload,
      });
    }

    return items;
  }, [imageUrl, handleDownload]);

  useEffect(() => {
    function loadImage() {
      setLoading(true);
      setError(null);

      // In demo mode (no API) or no r2Key, show demo placeholder
      if (!isApiConfigured || !r2Key) {
        setImageUrl(null);
        setLoading(false);
        // Don't show error for demo mode - we'll show a nice placeholder
        return;
      }

      try {
        // Build the file URL using the r2Key directly
        const url = getFileUrl(r2Key);
        setImageUrl(url);
        setLoading(false);
      } catch (err) {
        console.error('Error loading image:', err);
        setError('Failed to load image');
        setLoading(false);
      }
    }

    loadImage();
  }, [r2Key, fileTokenVersion]);

  return (
    <div className={styles.imageViewer} onContextMenu={handleContextMenu}>
      {/* Pixel-art frame border */}
      <div className={styles.frame}>
        <div className={styles.frameInner}>
          {loading && (
            <div className={styles.loading}>
              <div className={styles.loadingIcon}>
                {/* Dithered loading pattern */}
                <div className={styles.dither} />
              </div>
              <span className={styles.loadingText}>Loading...</span>
            </div>
          )}

          {error && !loading && (
            <div className={styles.error}>
              <div className={styles.errorIcon}>!</div>
              <span className={styles.errorText}>{error}</span>
            </div>
          )}

          {imageUrl && !loading && !error && (
            <img
              src={imageUrl}
              alt={name}
              className={styles.image}
              onError={() => setError('Failed to load image')}
            />
          )}

          {/* Demo mode or missing r2Key - show placeholder image */}
          {(!isApiConfigured || !r2Key) && !loading && !error && (
            <div className={styles.demoImage}>
              <div className={styles.demoPlaceholder}>
                <svg
                  width="64"
                  height="64"
                  viewBox="0 0 32 32"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  {/* Pixel art image icon */}
                  <rect x="2" y="4" width="28" height="24" fill="#FFFFFF" stroke="#000000" strokeWidth="2" />
                  <rect x="4" y="6" width="24" height="20" fill="#C0C0C0" />
                  {/* Mountains */}
                  <polygon points="4,22 12,14 20,22" fill="#808080" />
                  <polygon points="14,22 22,12 28,22" fill="#606060" />
                  {/* Sun */}
                  <circle cx="24" cy="10" r="3" fill="#FFCC00" />
                </svg>
                <span className={styles.demoText}>{name}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Image info bar */}
      <div className={styles.infoBar}>
        {isEditingName ? (
          <input
            ref={nameInputRef}
            type="text"
            className={styles.fileNameInput}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleNameKeyDown}
          />
        ) : (
          <span
            className={`${styles.fileName} ${isOwner ? styles.fileNameEditable : ''}`}
            onClick={isOwner ? () => setIsEditingName(true) : undefined}
            title={isOwner ? 'Click to rename' : undefined}
          >
            {fileName}
          </span>
        )}
        <div className={styles.infoBarRight}>
          {mimeType && <span className={styles.fileType}>{mimeType}</span>}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems()}
          position={contextMenu}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
