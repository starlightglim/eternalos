/**
 * IconPicker - Classic Mac OS style icon selection dialog
 *
 * Displays a grid of available icons organized by category.
 * Users can select a built-in icon, upload a custom PNG, or reset to the default.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { getIconsByCategory } from '../icons/customIconUtils';
import { uploadCustomIcon, getCustomIconUrl } from '../../services/api';
import styles from './IconPicker.module.css';

interface IconPickerProps {
  currentIcon?: string | null;
  itemId: string; // Required for custom icon upload
  onSelect: (iconId: string | null) => void;
  onClose: () => void;
}

type CategoryId = 'folders' | 'symbols' | 'objects' | 'nature' | 'media' | 'tech' | 'upload';

const CATEGORY_LABELS: Record<CategoryId, string> = {
  folders: 'Colored Folders',
  symbols: 'Symbols',
  objects: 'Objects',
  nature: 'Nature',
  media: 'Media',
  tech: 'Technology',
  upload: 'Custom',
};

const CATEGORY_ORDER: CategoryId[] = ['folders', 'symbols', 'objects', 'nature', 'media', 'tech', 'upload'];

/**
 * IconPicker - Modal dialog for selecting custom icons
 */
export function IconPicker({ currentIcon, itemId, onSelect, onClose }: IconPickerProps) {
  const [selectedIcon, setSelectedIcon] = useState<string | null>(currentIcon || null);
  const [activeCategory, setActiveCategory] = useState<CategoryId>('folders');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedIconPreview, setUploadedIconPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const iconsByCategory = getIconsByCategory();

  // Check if current icon is an uploaded one
  const isUploadedIcon = currentIcon?.startsWith('upload:');

  // Initialize uploaded icon preview if current icon is uploaded
  useEffect(() => {
    if (isUploadedIcon && currentIcon) {
      setUploadedIconPreview(getCustomIconUrl(currentIcon));
    }
  }, [currentIcon, isUploadedIcon]);

  // Handle keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && !isUploading) {
        onSelect(selectedIcon);
        onClose();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onSelect, selectedIcon, isUploading]);

  // Handle overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleIconClick = useCallback((iconId: string) => {
    setSelectedIcon(iconId);
    setUploadError(null);
  }, []);

  const handleApply = useCallback(() => {
    onSelect(selectedIcon);
    onClose();
  }, [onSelect, selectedIcon, onClose]);

  const handleReset = useCallback(() => {
    onSelect(null);
    onClose();
  }, [onSelect, onClose]);

  // Handle file upload
  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (file.type !== 'image/png') {
      setUploadError('Only PNG files are allowed');
      return;
    }

    // Validate file size (50KB max)
    if (file.size > 50 * 1024) {
      setUploadError('File must be under 50KB');
      return;
    }

    setIsUploading(true);
    setUploadError(null);

    try {
      const result = await uploadCustomIcon(file, itemId);
      setSelectedIcon(result.customIcon);
      setUploadedIconPreview(getCustomIconUrl(result.customIcon));
      // Automatically apply after successful upload
      onSelect(result.customIcon);
      onClose();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setIsUploading(false);
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [itemId, onSelect, onClose]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.dialog}>
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.title}>Choose an Icon</span>
        </div>

        {/* Category Tabs */}
        <div className={styles.tabs} role="tablist" aria-label="Icon categories">
          {CATEGORY_ORDER.map((catId) => (
            <button
              key={catId}
              type="button"
              className={`${styles.tab} ${activeCategory === catId ? styles.tabActive : ''}`}
              onClick={() => setActiveCategory(catId)}
              aria-selected={activeCategory === catId}
              role="tab"
            >
              {CATEGORY_LABELS[catId]}
            </button>
          ))}
        </div>

        {/* Icon Grid */}
        <div className={styles.gridContainer}>
          {activeCategory === 'upload' ? (
            <div className={styles.uploadSection}>
              <p className={styles.uploadText}>
                Upload a custom PNG icon (32×32 or 64×64 pixels recommended, max 50KB)
              </p>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/png"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />

              <button
                type="button"
                className={styles.uploadButton}
                onClick={handleUploadClick}
                disabled={isUploading}
              >
                {isUploading ? 'Uploading...' : 'Choose PNG File...'}
              </button>

              {uploadError && (
                <p className={styles.errorText}>{uploadError}</p>
              )}

              {uploadedIconPreview && (
                <div className={styles.uploadedPreview}>
                  <p className={styles.uploadText}>Current custom icon:</p>
                  <img
                    src={uploadedIconPreview}
                    alt="Custom icon"
                    className={styles.uploadedImage}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className={styles.grid}>
              {(iconsByCategory[activeCategory] || []).map((icon) => {
                const IconComponent = icon.component;
                const isSelected = selectedIcon === icon.id;

                return (
                  <button
                    key={icon.id}
                    type="button"
                    className={`${styles.iconButton} ${isSelected ? styles.iconSelected : ''}`}
                    onClick={() => handleIconClick(icon.id)}
                    title={icon.label}
                    aria-pressed={isSelected}
                  >
                    <div className={styles.iconPreview}>
                      <IconComponent size={32} />
                    </div>
                    <span className={styles.iconLabel}>{icon.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer with buttons */}
        <div className={styles.footer}>
          <button type="button" className={styles.button} onClick={handleReset}>
            Reset to Default
          </button>
          <div className={styles.spacer} />
          <button type="button" className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.primaryButton}`}
            onClick={handleApply}
            disabled={isUploading}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
