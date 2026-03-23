/**
 * SoundPackEditor - UI for managing custom sound files per sound type.
 *
 * Shows each sound type with play preview, upload, and remove buttons.
 * Custom sounds override the built-in synthesized sounds.
 */

import { useState, useRef, useCallback } from 'react';
import { useSoundStore, type SoundType } from '../../stores/soundStore';
import { uploadSound, deleteSound, type SoundAsset } from '../../services/api';
import { BUILTIN_PACK_LABELS, type BuiltInPackId } from '../../sounds/builtInPacks';
import { updateProfile } from '../../services/api';
import styles from './SoundPackEditor.module.css';

/** Human-readable labels and descriptions for each sound type */
const SOUND_TYPE_INFO: { type: SoundType; label: string }[] = [
  { type: 'click', label: 'Click' },
  { type: 'select', label: 'Select' },
  { type: 'windowOpen', label: 'Window Open' },
  { type: 'windowClose', label: 'Window Close' },
  { type: 'folderOpen', label: 'Folder Open' },
  { type: 'drop', label: 'Drop' },
  { type: 'trash', label: 'Trash' },
  { type: 'emptyTrash', label: 'Empty Trash' },
  { type: 'alert', label: 'Alert' },
  { type: 'error', label: 'Error' },
  { type: 'startup', label: 'Startup' },
];

interface Props {
  /** Currently uploaded sound assets (loaded from API) */
  soundAssets: SoundAsset[];
  /** Callback when assets change (to refresh parent) */
  onAssetsChange: () => void;
}

export default function SoundPackEditor({ soundAssets, onAssetsChange }: Props) {
  const { builtInPack, setBuiltInPack, customSoundPack, setCustomSoundUrl, playSound, preloadCustomSounds } = useSoundStore();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<SoundType | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Find custom sound asset for a given type
  const getCustomAsset = useCallback(
    (type: SoundType): SoundAsset | undefined => {
      return soundAssets.find(a => a.soundType === type);
    },
    [soundAssets]
  );

  const handlePackChange = (pack: BuiltInPackId) => {
    setBuiltInPack(pack);
  };

  const handleUpload = async (type: SoundType, file: File) => {
    if (file.size > 200 * 1024) {
      setError(`File too large (${Math.round(file.size / 1024)}KB). Max 200KB.`);
      return;
    }

    setError(null);
    setUploading(type);

    try {
      const result = await uploadSound(file, type);
      // Update sound pack in store and profile
      setCustomSoundUrl(type, result.asset.url);

      // Sync to profile
      const currentPack = useSoundStore.getState().customSoundPack;
      if (currentPack) {
        await updateProfile({ soundPack: currentPack });
      }

      // Preload the new sound
      await preloadCustomSounds();

      onAssetsChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const handleRemove = async (type: SoundType) => {
    const asset = getCustomAsset(type);
    if (!asset) return;

    setError(null);
    try {
      await deleteSound(asset.soundId);
      setCustomSoundUrl(type, null);

      // Sync to profile
      const currentPack = useSoundStore.getState().customSoundPack;
      await updateProfile({ soundPack: currentPack || { name: 'Custom', sounds: {} } });

      // Re-preload
      await preloadCustomSounds();

      onAssetsChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleFileSelect = (type: SoundType) => {
    fileInputRefs.current[type]?.click();
  };

  const handleFileChange = (type: SoundType, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleUpload(type, file);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  return (
    <div className={styles.container}>
      {/* Built-in pack selector */}
      <div className={styles.packSelector}>
        <label>Built-in Pack:</label>
        <select
          value={builtInPack}
          onChange={(e) => handlePackChange(e.target.value as BuiltInPackId)}
        >
          {Object.entries(BUILTIN_PACK_LABELS).map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </div>

      {/* Custom sounds section */}
      <div className={styles.sectionLabel}>Custom Sounds (override built-in)</div>

      <div className={styles.soundGrid}>
        {SOUND_TYPE_INFO.map(({ type, label }) => {
          const customAsset = getCustomAsset(type);
          const hasCustom = !!customAsset || !!customSoundPack?.sounds?.[type];
          const isUploading = uploading === type;

          return (
            <div key={type} className={styles.soundRow}>
              <span className={styles.soundLabel}>{label}</span>

              <span className={`${styles.soundStatus} ${hasCustom ? styles.custom : ''}`}>
                {isUploading ? 'Uploading...' : hasCustom ? (customAsset?.filename || 'Custom') : 'Built-in'}
              </span>

              <div className={styles.soundActions}>
                {/* Play preview */}
                <button
                  className={styles.btnPlay}
                  onClick={() => playSound(type)}
                  title="Preview sound"
                >
                  &#9654;
                </button>

                {/* Upload */}
                <button
                  className={styles.btn}
                  onClick={() => handleFileSelect(type)}
                  disabled={isUploading}
                  title="Upload custom sound"
                >
                  Upload
                </button>

                {/* Hidden file input */}
                <input
                  ref={(el) => { fileInputRefs.current[type] = el; }}
                  type="file"
                  accept="audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/webm,.mp3,.wav,.ogg,.webm"
                  className={styles.hiddenInput}
                  onChange={(e) => handleFileChange(type, e)}
                />

                {/* Remove */}
                {hasCustom && (
                  <button
                    className={styles.btnRemove}
                    onClick={() => handleRemove(type)}
                    title="Remove custom sound"
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
