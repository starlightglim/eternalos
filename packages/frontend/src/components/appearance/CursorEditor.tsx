/**
 * CursorEditor - UI for uploading and managing custom cursor images.
 *
 * Each cursor state (default, pointer, grab, etc.) can have a custom image.
 * Cursor URLs are stored in the designTokens blob and compiled to CSS
 * via the token compiler's cursor-specific handling.
 */

import { useState, useRef, useCallback } from 'react';
import { uploadCursor, deleteCursor, getCursorUrl, getApiUrl, type CursorAsset } from '../../services/api';
import { useAppearanceStore, buildTokenUpdate } from '../../stores/appearanceStore';
import styles from './CursorEditor.module.css';

type CursorState = 'default' | 'pointer' | 'grab' | 'grabbing' | 'text' | 'wait' | 'move' | 'nwse-resize';

/** Human-readable labels for cursor states */
const CURSOR_STATE_INFO: { state: CursorState; label: string; tokenPath: string }[] = [
  { state: 'default', label: 'Default', tokenPath: 'cursor.image.default' },
  { state: 'pointer', label: 'Pointer', tokenPath: 'cursor.image.pointer' },
  { state: 'grab', label: 'Grab', tokenPath: 'cursor.image.grab' },
  { state: 'grabbing', label: 'Grabbing', tokenPath: 'cursor.image.grabbing' },
  { state: 'text', label: 'Text', tokenPath: 'cursor.image.text' },
  { state: 'wait', label: 'Wait', tokenPath: 'cursor.image.wait' },
  { state: 'move', label: 'Move', tokenPath: 'cursor.image.move' },
  { state: 'nwse-resize', label: 'Resize', tokenPath: 'cursor.image.nwse-resize' },
];

interface Props {
  /** Currently uploaded cursor assets (loaded from API) */
  cursorAssets: CursorAsset[];
  /** Callback when assets change (to refresh parent) */
  onAssetsChange: () => void;
}

export default function CursorEditor({ cursorAssets, onAssetsChange }: Props) {
  const { appearance, updateAppearance } = useAppearanceStore();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<CursorState | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Get cursor asset for a state
  const getAssetForState = useCallback(
    (state: CursorState): CursorAsset | undefined => {
      return cursorAssets.find(a => a.cursorState === state);
    },
    [cursorAssets]
  );

  // Get current cursor URL from design tokens
  const getCursorTokenValue = useCallback(
    (tokenPath: string): string | undefined => {
      const val = appearance?.designTokens?.[tokenPath];
      return typeof val === 'string' && val.trim() ? val : undefined;
    },
    [appearance]
  );

  const handleUpload = async (state: CursorState, tokenPath: string, file: File) => {
    if (file.size > 50 * 1024) {
      setError(`File too large (${Math.round(file.size / 1024)}KB). Max 50KB.`);
      return;
    }

    setError(null);
    setUploading(state);

    try {
      const result = await uploadCursor(file, state, 0, 0);
      // Store the cursor URL in design tokens (format: url|hotspotX|hotspotY)
      const cursorValue = `${getCursorUrl(result.asset.url)}|${result.asset.hotspotX || 0}|${result.asset.hotspotY || 0}`;
      const tokenUpdate = buildTokenUpdate(tokenPath, cursorValue, appearance);
      updateAppearance(tokenUpdate);
      onAssetsChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const handleRemove = async (state: CursorState, tokenPath: string) => {
    const asset = getAssetForState(state);
    setError(null);

    try {
      if (asset) {
        await deleteCursor(asset.cursorId);
      }
      // Clear the token
      const tokenUpdate = buildTokenUpdate(tokenPath, '', appearance);
      updateAppearance(tokenUpdate);
      onAssetsChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleFileSelect = (state: CursorState) => {
    fileInputRefs.current[state]?.click();
  };

  const handleFileChange = (state: CursorState, tokenPath: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUpload(state, tokenPath, file);
    }
    e.target.value = '';
  };

  return (
    <div className={styles.container}>
      <div className={styles.sectionLabel}>Custom Cursors</div>

      <div className={styles.cursorGrid}>
        {CURSOR_STATE_INFO.map(({ state, label, tokenPath }) => {
          const asset = getAssetForState(state);
          const tokenValue = getCursorTokenValue(tokenPath);
          const hasCustom = !!tokenValue || !!asset;
          const isUploading = uploading === state;

          // Extract URL from token value (format: url|hotspotX|hotspotY)
          const rawUrl = tokenValue?.split('|')[0];
          const previewUrl = rawUrl?.startsWith('/api/') ? getApiUrl(rawUrl) : rawUrl;

          return (
            <div key={state} className={styles.cursorRow}>
              <span className={styles.cursorLabel}>{label}</span>

              {/* Preview */}
              <div
                className={styles.cursorPreview}
                style={previewUrl ? { cursor: `url('${previewUrl}') 0 0, ${state === 'default' ? 'default' : state}` } : undefined}
              >
                {previewUrl ? (
                  <img src={previewUrl} alt={`${label} cursor`} />
                ) : (
                  <span style={{ fontSize: 10, color: '#999' }}>--</span>
                )}
              </div>

              <span className={`${styles.cursorStatus} ${hasCustom ? styles.custom : ''}`}>
                {isUploading ? 'Uploading...' : hasCustom ? (asset?.filename || 'Custom') : 'Default'}
              </span>

              <div className={styles.cursorActions}>
                {/* Upload */}
                <button
                  className={styles.btn}
                  onClick={() => handleFileSelect(state)}
                  disabled={isUploading}
                  title="Upload cursor image"
                >
                  Upload
                </button>

                {/* Hidden file input */}
                <input
                  ref={(el) => { fileInputRefs.current[state] = el; }}
                  type="file"
                  accept="image/png,image/svg+xml,image/gif,image/webp,.png,.svg,.gif,.webp,.cur,.ani"
                  className={styles.hiddenInput}
                  onChange={(e) => handleFileChange(state, tokenPath, e)}
                />

                {/* Remove */}
                {hasCustom && (
                  <button
                    className={styles.btnRemove}
                    onClick={() => handleRemove(state, tokenPath)}
                    title="Remove custom cursor"
                  >
                    &#10005;
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  );
}
