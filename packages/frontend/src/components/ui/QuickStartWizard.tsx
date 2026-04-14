/**
 * QuickStartWizard - First-time user onboarding wizard
 *
 * Shows after signup to let users choose an initial visual direction.
 * Applies a complete starter appearance and writes a CSS snapshot into the
 * user's Custom CSS folder so the preset is visible and reusable.
 */

import { useState, useCallback, useEffect, useMemo, useRef, useId } from 'react';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useAuthStore } from '../../stores/authStore';
import { updateProfile } from '../../services/api';
import {
  THEME_PRESETS,
  buildPresetCSSSnapshot,
  CUSTOM_CSS_FOLDER_NAME,
  ONBOARDING_THEME_FILENAME,
  findNextGridPosition,
  type ThemePreset,
} from '../../utils/onboardingPresets';
import styles from './QuickStartWizard.module.css';

interface QuickStartWizardProps {
  username: string;
  onComplete: () => void;
}

export function QuickStartWizard({ username, onComplete }: QuickStartWizardProps) {
  const [selectedId, setSelectedId] = useState<string>(THEME_PRESETS[0].id);
  const [isApplying, setIsApplying] = useState(false);
  const { loadAppearance, saveAppearance } = useAppearanceStore();
  const items = useDesktopStore((state) => state.items);
  const addItem = useDesktopStore((state) => state.addItem);
  const updateItem = useDesktopStore((state) => state.updateItem);
  const profile = useAuthStore((state) => state.profile);
  const wizardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  const selectedPreset = useMemo(
    () => THEME_PRESETS.find((preset) => preset.id === selectedId) ?? THEME_PRESETS[0],
    [selectedId]
  );

  const handleSelect = useCallback((preset: ThemePreset) => {
    setSelectedId(preset.id);
  }, []);

  const syncCustomCSSWorkspace = useCallback((preset: ThemePreset) => {
    const existingFolder = items.find(
      (item) =>
        item.type === 'folder' &&
        item.parentId === null &&
        !item.isTrashed &&
        item.name.toLowerCase() === CUSTOM_CSS_FOLDER_NAME.toLowerCase()
    );

    const now = Date.now();
    const folderId = existingFolder?.id ?? `folder-custom-css-${now}`;

    if (!existingFolder) {
      addItem({
        id: folderId,
        type: 'folder',
        name: CUSTOM_CSS_FOLDER_NAME,
        parentId: null,
        position: findNextGridPosition(items, null),
        isPublic: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    const cssSnapshot = buildPresetCSSSnapshot(preset);
    const existingThemeFile = items.find(
      (item) =>
        item.type === 'text' &&
        item.parentId === folderId &&
        !item.isTrashed &&
        item.name === ONBOARDING_THEME_FILENAME
    );

    if (existingThemeFile) {
      updateItem(existingThemeFile.id, {
        textContent: cssSnapshot,
      });
      return;
    }

    addItem({
      id: `text-onboarding-theme-${now}`,
      type: 'text',
      name: ONBOARDING_THEME_FILENAME,
      parentId: folderId,
      position: findNextGridPosition(items, folderId),
      isPublic: false,
      textContent: cssSnapshot,
      createdAt: now,
      updatedAt: now,
    });
  }, [addItem, items, updateItem]);

  const handleApply = useCallback(async () => {
    setIsApplying(true);

    try {
      loadAppearance({ ...selectedPreset.appearance });
      await saveAppearance();
      syncCustomCSSWorkspace(selectedPreset);

      if (profile) {
        useAuthStore.setState({
          profile: {
            ...profile,
            wallpaper: selectedPreset.wallpaper,
            isNewUser: false,
          },
        });
      }

      await updateProfile({
        wallpaper: selectedPreset.wallpaper,
        isNewUser: false,
      });
      onComplete();
    } catch (error) {
      console.error('Failed to apply starter preset:', error);
      onComplete();
    }
  }, [loadAppearance, onComplete, profile, saveAppearance, selectedPreset, syncCustomCSSWorkspace]);

  const handleSkip = useCallback(async () => {
    setIsApplying(true);
    try {
      await updateProfile({ isNewUser: false });
    } catch (error) {
      console.error('Failed to update profile:', error);
    }
    onComplete();
  }, [onComplete]);

  // Accessibility: move focus into the dialog on open, restore it on close,
  // and let Escape dismiss the wizard (same as clicking Skip).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    wizardRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isApplying) {
        e.preventDefault();
        handleSkip();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    // Prevent the page behind the modal from scrolling while it's open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [handleSkip, isApplying]);

  return (
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        // Clicking the dimmed backdrop acts as Skip (a11y-friendly dismiss)
        if (e.target === e.currentTarget && !isApplying) {
          handleSkip();
        }
      }}
    >
      <div
        className={styles.wizard}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        ref={wizardRef}
      >
        <div className={styles.scrollArea}>
        <div className={styles.header}>
          <h1 id={titleId} className={styles.title}>Welcome, {username}!</h1>
          <p id={descId} className={styles.subtitle}>Pick a starter direction. You can fine-tune every detail afterward.</p>
        </div>

        <div className={styles.presets} role="radiogroup" aria-labelledby={titleId}>
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selectedId === preset.id}
              aria-label={`${preset.name}: ${preset.description}`}
              className={`${styles.presetCard} ${selectedId === preset.id ? styles.selected : ''}`}
              onClick={() => handleSelect(preset)}
              disabled={isApplying}
            >
              <div
                className={styles.preview}
                style={{ backgroundColor: preset.preview.desktop }}
              >
                <div
                  className={styles.miniWindow}
                  style={{ backgroundColor: preset.preview.window }}
                >
                  <div
                    className={styles.miniTitleBar}
                    style={{ backgroundColor: preset.preview.titleBar }}
                  >
                    <div
                      className={styles.miniCloseBox}
                      style={{ borderColor: preset.preview.accent }}
                    />
                  </div>
                  <div className={styles.miniContent}>
                    <div
                      className={styles.miniSelection}
                      style={{ backgroundColor: preset.preview.accent }}
                    />
                  </div>
                </div>
                <div className={styles.miniIcon} style={{ color: preset.preview.label }} />
              </div>

              <div className={styles.presetInfo}>
                <span className={styles.presetName}>{preset.name}</span>
                <span className={styles.presetDesc}>{preset.description}</span>
              </div>
            </button>
          ))}
        </div>

        </div>

        <div className={styles.actions}>
          <button
            className={styles.skipButton}
            onClick={handleSkip}
            disabled={isApplying}
          >
            Skip
          </button>
          <button
            className={styles.applyButton}
            onClick={handleApply}
            disabled={isApplying}
          >
            {isApplying ? 'Applying...' : 'Apply & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
