/**
 * SpriteEditor — Upload UI for window chrome sprites (Skin system).
 *
 * Shown in the Appearance Panel when any sprite variant is active.
 * Handles uploading sprites for:
 *   - Window frame (9-slice PNG)
 *   - Title bar texture
 *   - Window buttons (close/zoom/collapse × normal/hover/active)
 *   - Resize handle
 *
 * Uses the existing CSS asset upload API for storage.
 * Sprite URLs are stored in designTokens via buildTokenUpdate().
 */

import { useState, useRef, useCallback } from 'react';
import { uploadCSSAsset, getCSSAssetUrl } from '../../services/api';
import { useAppearanceStore, buildTokenUpdate, getTokenValue } from '../../stores/appearanceStore';
import styles from './SpriteEditor.module.css';

interface SpriteSlot {
  tokenPath: string;
  label: string;
  group: string;
}

// All uploadable sprite slots
const CHROME_SLOTS: SpriteSlot[] = [
  { tokenPath: 'chrome.sprite.url', label: 'Frame Image', group: 'Window Frame' },
];

const TITLEBAR_SLOTS: SpriteSlot[] = [
  { tokenPath: 'titlebar.sprite.url', label: 'Title Bar Texture', group: 'Title Bar' },
];

const BUTTON_SLOTS: SpriteSlot[] = [
  { tokenPath: 'buttons.sprite.close', label: 'Close', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.closeHover', label: 'Close (Hover)', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.closeActive', label: 'Close (Active)', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.zoom', label: 'Zoom', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.zoomHover', label: 'Zoom (Hover)', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.zoomActive', label: 'Zoom (Active)', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.collapse', label: 'Collapse', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.collapseHover', label: 'Collapse (Hover)', group: 'Buttons' },
  { tokenPath: 'buttons.sprite.collapseActive', label: 'Collapse (Active)', group: 'Buttons' },
];

const RESIZE_SLOTS: SpriteSlot[] = [
  { tokenPath: 'resize.sprite.url', label: 'Resize Handle', group: 'Resize' },
];

interface Props {
  /** Which sprite variant sections to show (based on active variants) */
  showChrome: boolean;
  showTitleBar: boolean;
  showButtons: boolean;
  showResize: boolean;
}

export default function SpriteEditor({ showChrome, showTitleBar, showButtons, showResize }: Props) {
  const { appearance, updateAppearance } = useAppearanceStore();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const getTokenUrl = useCallback(
    (tokenPath: string): string | undefined => {
      const val = getTokenValue(tokenPath, appearance);
      return typeof val === 'string' && val.trim() ? val : undefined;
    },
    [appearance]
  );

  const handleUpload = async (tokenPath: string, file: File) => {
    if (file.size > 500 * 1024) {
      setError(`File too large (${Math.round(file.size / 1024)}KB). Max 500KB.`);
      return;
    }

    setError(null);
    setUploading(tokenPath);

    try {
      const result = await uploadCSSAsset(file);
      // Store the URL in the design token
      const update = buildTokenUpdate(tokenPath, result.asset.url, appearance);
      updateAppearance(update);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const handleRemove = (tokenPath: string) => {
    const update = buildTokenUpdate(tokenPath, '', appearance);
    updateAppearance(update);
  };

  const handleSliceChange = (field: string, value: number) => {
    const update = buildTokenUpdate(field, value, appearance);
    updateAppearance(update);
  };

  const handleFileSelect = (tokenPath: string) => {
    fileInputRefs.current[tokenPath]?.click();
  };

  const handleFileChange = (tokenPath: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleUpload(tokenPath, file);
    e.target.value = '';
  };

  const renderSpriteRow = (slot: SpriteSlot) => {
    const url = getTokenUrl(slot.tokenPath);
    const hasSprite = !!url;
    const isUploading = uploading === slot.tokenPath;

    return (
      <div key={slot.tokenPath} className={styles.spriteRow}>
        <span className={styles.spriteLabel}>{slot.label}</span>

        <div className={styles.spritePreview}>
          {url ? (
            <img src={getCSSAssetUrl(url)} alt={slot.label} />
          ) : (
            <span style={{ fontSize: 10, color: '#999' }}>--</span>
          )}
        </div>

        <span className={`${styles.spriteStatus} ${hasSprite ? styles.active : ''}`}>
          {isUploading ? 'Uploading...' : hasSprite ? 'Custom' : 'None'}
        </span>

        <div className={styles.spriteActions}>
          <button
            className={styles.btn}
            onClick={() => handleFileSelect(slot.tokenPath)}
            disabled={isUploading}
          >
            Upload
          </button>

          <input
            ref={(el) => { fileInputRefs.current[slot.tokenPath] = el; }}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp"
            className={styles.hiddenInput}
            onChange={(e) => handleFileChange(slot.tokenPath, e)}
          />

          {hasSprite && (
            <button
              className={styles.btnRemove}
              onClick={() => handleRemove(slot.tokenPath)}
            >
              &#10005;
            </button>
          )}
        </div>
      </div>
    );
  };

  const hasAnySection = showChrome || showTitleBar || showButtons || showResize;
  if (!hasAnySection) return null;

  return (
    <div className={styles.container}>
      {showChrome && (
        <div className={styles.spriteGroup}>
          <div className={styles.sectionLabel}>Window Frame Sprite</div>
          <div className={styles.hint}>Upload a PNG. Corners stay fixed, edges stretch (9-slice).</div>
          {CHROME_SLOTS.map(renderSpriteRow)}

          {/* 9-Slice controls */}
          <div className={styles.sliceInputs}>
            <label>
              T:
              <input
                type="number"
                min={0}
                max={100}
                value={Number(getTokenValue('chrome.sprite.sliceTop', appearance) ?? 20)}
                onChange={(e) => handleSliceChange('chrome.sprite.sliceTop', Number(e.target.value))}
              />
            </label>
            <label>
              R:
              <input
                type="number"
                min={0}
                max={100}
                value={Number(getTokenValue('chrome.sprite.sliceRight', appearance) ?? 20)}
                onChange={(e) => handleSliceChange('chrome.sprite.sliceRight', Number(e.target.value))}
              />
            </label>
            <label>
              B:
              <input
                type="number"
                min={0}
                max={100}
                value={Number(getTokenValue('chrome.sprite.sliceBottom', appearance) ?? 20)}
                onChange={(e) => handleSliceChange('chrome.sprite.sliceBottom', Number(e.target.value))}
              />
            </label>
            <label>
              L:
              <input
                type="number"
                min={0}
                max={100}
                value={Number(getTokenValue('chrome.sprite.sliceLeft', appearance) ?? 20)}
                onChange={(e) => handleSliceChange('chrome.sprite.sliceLeft', Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      )}

      {showTitleBar && (
        <div className={styles.spriteGroup}>
          <div className={styles.sectionLabel}>Title Bar Sprite</div>
          <div className={styles.hint}>Upload a texture that stretches to fill the title bar.</div>
          {TITLEBAR_SLOTS.map(renderSpriteRow)}
        </div>
      )}

      {showButtons && (
        <div className={styles.spriteGroup}>
          <div className={styles.sectionLabel}>Button Sprites</div>
          <div className={styles.hint}>Upload images for each button state. Hover/Active are optional.</div>
          {BUTTON_SLOTS.map(renderSpriteRow)}
        </div>
      )}

      {showResize && (
        <div className={styles.spriteGroup}>
          <div className={styles.sectionLabel}>Resize Handle Sprite</div>
          {RESIZE_SLOTS.map(renderSpriteRow)}
        </div>
      )}

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
