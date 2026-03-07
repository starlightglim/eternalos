/**
 * QuickStartWizard - First-time user onboarding wizard
 *
 * Shows after signup to let users choose an initial visual direction.
 * Applies appearance + wallpaper settings immediately and saves to profile.
 */

import { useState, useCallback } from 'react';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { updateProfile } from '../../services/api';
import styles from './QuickStartWizard.module.css';

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  accentColor: string;
  desktopColor: string;
  windowBgColor?: string;
  wallpaper: string;
  preview: {
    desktop: string;
    titleBar: string;
    window: string;
    accent: string;
  };
}

// Curated visual presets for onboarding
const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Clean & classic',
    accentColor: '#000080',
    desktopColor: '#C0C0C0',
    wallpaper: 'default',
    preview: {
      desktop: '#C0C0C0',
      titleBar: '#E0E0E0',
      window: '#FFFFFF',
      accent: '#000080',
    },
  },
  {
    id: 'colorful',
    name: 'Colorful',
    description: 'Bright & playful',
    accentColor: '#FF6B6B',
    desktopColor: '#87CEEB',
    windowBgColor: '#FFF8E7',
    wallpaper: 'dots',
    preview: {
      desktop: '#87CEEB',
      titleBar: '#FFB6C1',
      window: '#FFF8E7',
      accent: '#FF6B6B',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Easy on the eyes',
    accentColor: '#4080C0',
    desktopColor: '#1A1A1A',
    wallpaper: 'default',
    preview: {
      desktop: '#1A1A1A',
      titleBar: '#333333',
      window: '#2A2A2A',
      accent: '#4080C0',
    },
  },
  {
    id: 'retro',
    name: 'Retro',
    description: 'Vintage vibes',
    accentColor: '#336699',
    desktopColor: '#668B8B',
    windowBgColor: '#FFFAF0',
    wallpaper: 'diagonal',
    preview: {
      desktop: '#668B8B',
      titleBar: '#CCCCCC',
      window: '#FFFAF0',
      accent: '#336699',
    },
  },
];

interface QuickStartWizardProps {
  username: string;
  onComplete: () => void;
}

export function QuickStartWizard({ username, onComplete }: QuickStartWizardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const { setAccentColor, setDesktopColor, setWindowBgColor } = useAppearanceStore();

  const handleSelect = useCallback((preset: ThemePreset) => {
    setSelectedId(preset.id);
  }, []);

  const handleApply = useCallback(async () => {
    const preset = THEME_PRESETS.find((p) => p.id === selectedId);
    if (!preset) return;

    setIsApplying(true);

    try {
      // Apply appearance settings
      setAccentColor(preset.accentColor);
      setDesktopColor(preset.desktopColor);
      if (preset.windowBgColor) {
        setWindowBgColor(preset.windowBgColor);
      }

      // Save to profile
      await updateProfile({
        wallpaper: preset.wallpaper,
        accentColor: preset.accentColor,
        desktopColor: preset.desktopColor,
        windowBgColor: preset.windowBgColor,
        isNewUser: false,
      });

      onComplete();
    } catch (error) {
      console.error('Failed to apply starter preset:', error);
      // Still complete the wizard even if save fails
      onComplete();
    }
  }, [selectedId, setAccentColor, setDesktopColor, setWindowBgColor, onComplete]);

  const handleSkip = useCallback(async () => {
    setIsApplying(true);
    try {
      // Just clear the isNewUser flag
      await updateProfile({ isNewUser: false });
    } catch (error) {
      console.error('Failed to update profile:', error);
    }
    onComplete();
  }, [onComplete]);

  return (
    <div className={styles.overlay}>
      <div className={styles.wizard}>
        <div className={styles.header}>
          <h1 className={styles.title}>Welcome, {username}!</h1>
          <p className={styles.subtitle}>What's your vibe?</p>
        </div>

        <div className={styles.presets}>
          {THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`${styles.presetCard} ${selectedId === preset.id ? styles.selected : ''}`}
              onClick={() => handleSelect(preset)}
              disabled={isApplying}
            >
              {/* Mini desktop preview */}
              <div
                className={styles.preview}
                style={{ backgroundColor: preset.preview.desktop }}
              >
                {/* Mini window */}
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
                {/* Mini icon */}
                <div className={styles.miniIcon} />
              </div>

              <div className={styles.presetInfo}>
                <span className={styles.presetName}>{preset.name}</span>
                <span className={styles.presetDesc}>{preset.description}</span>
              </div>
            </button>
          ))}
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
            disabled={!selectedId || isApplying}
          >
            {isApplying ? 'Applying...' : 'Apply & Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
