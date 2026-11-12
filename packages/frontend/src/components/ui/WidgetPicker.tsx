/**
 * WidgetPicker - Classic Mac OS style dialog for adding widgets
 *
 * Displays available widget types with previews.
 * Users select a widget type, optionally configure it, then add to desktop.
 */

import { useState, useCallback, useEffect } from 'react';
import type { WidgetType, WidgetConfig, StickyNoteConfig, GuestbookConfig, MusicPlayerConfig, PixelCanvasConfig, LinkBoardConfig } from '../../types';
import { STICKY_NOTE_COLORS } from '../widgets/StickyNote';
import { getWidgetDefaultSize } from './widgetDefaults';
import styles from './WidgetPicker.module.css';

interface WidgetPickerProps {
  onSelect: (widgetType: WidgetType, config: WidgetConfig, name: string) => void;
  onClose: () => void;
}

interface WidgetInfo {
  type: WidgetType;
  name: string;
  description: string;
  icon: string;
  defaultConfig: WidgetConfig;
  defaultSize: { width: number; height: number };
}

const WIDGETS: WidgetInfo[] = [
  {
    type: 'sticky-note',
    name: 'Sticky Note',
    description: 'A colored note for quick messages and reminders.',
    icon: '📝',
    defaultConfig: { color: STICKY_NOTE_COLORS[0].value, text: '' } as StickyNoteConfig,
    defaultSize: getWidgetDefaultSize('sticky-note'),
  },
  {
    type: 'guestbook',
    name: 'Guestbook',
    description: 'Let visitors leave messages on your desktop!',
    icon: '📖',
    defaultConfig: { entries: [] } as GuestbookConfig,
    defaultSize: getWidgetDefaultSize('guestbook'),
  },
  {
    type: 'music-player',
    name: 'Music Player',
    description: 'A mini playlist with play, pause, and skip controls.',
    icon: '🎵',
    defaultConfig: { tracks: [] } as MusicPlayerConfig,
    defaultSize: getWidgetDefaultSize('music-player'),
  },
  {
    type: 'pixel-canvas',
    name: 'Pixel Canvas',
    description: '16×16 pixel art canvas with 8 colors. Draw your own art!',
    icon: '🎨',
    defaultConfig: {
      grid: Array(16).fill(null).map(() => Array(16).fill(1)),
      palette: ['#000000', '#FFFFFF', '#FF0000', '#0000FF', '#00FF00', '#FFFF00', '#800080', '#FFA500'],
    } as PixelCanvasConfig,
    defaultSize: getWidgetDefaultSize('pixel-canvas'),
  },
  {
    type: 'link-board',
    name: 'Link Board',
    description: 'A grid of bookmarks for your favorite sites.',
    icon: '🔗',
    defaultConfig: { links: [] } as LinkBoardConfig,
    defaultSize: getWidgetDefaultSize('link-board'),
  },
];

/**
 * WidgetPicker - Modal dialog for adding widgets to the desktop
 */
export function WidgetPicker({ onSelect, onClose }: WidgetPickerProps) {
  const [selectedWidget, setSelectedWidget] = useState<WidgetInfo | null>(null);
  const [widgetName, setWidgetName] = useState('');

  const handleAdd = useCallback(() => {
    if (!selectedWidget || !widgetName.trim()) return;
    onSelect(selectedWidget.type, selectedWidget.defaultConfig, widgetName.trim());
    onClose();
  }, [selectedWidget, widgetName, onSelect, onClose]);

  // Handle keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
      } else if (e.key === 'Enter' && selectedWidget && widgetName.trim()) {
        handleAdd();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, selectedWidget, widgetName, handleAdd]);

  // Handle overlay click
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleWidgetClick = useCallback((widget: WidgetInfo) => {
    setSelectedWidget(widget);
    setWidgetName(widget.name);
  }, []);

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.dialog}>
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.title}>Add Widget</span>
        </div>

        {/* Widget Grid */}
        <div className={styles.widgetGrid}>
          {WIDGETS.map((widget) => (
            <button
              key={widget.type}
              type="button"
              className={`${styles.widgetCard} ${
                selectedWidget?.type === widget.type ? styles.selected : ''
              }`}
              onClick={() => handleWidgetClick(widget)}
            >
              <span className={styles.widgetIcon}>{widget.icon}</span>
              <span className={styles.widgetName}>{widget.name}</span>
              <span className={styles.widgetDesc}>{widget.description}</span>
            </button>
          ))}
        </div>

        {/* Configuration panel */}
        {selectedWidget && (
          <div className={styles.configPanel}>
            <label className={styles.configLabel}>
              Widget name:
              <input
                type="text"
                className={styles.configInput}
                value={widgetName}
                onChange={(e) => setWidgetName(e.target.value)}
                placeholder="Enter a name..."
                autoFocus
              />
            </label>
          </div>
        )}

        {/* Footer with buttons */}
        <div className={styles.footer}>
          <div className={styles.spacer} />
          <button type="button" className={styles.button} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.primaryButton}`}
            onClick={handleAdd}
            disabled={!selectedWidget || !widgetName.trim()}
          >
            Add Widget
          </button>
        </div>
      </div>
    </div>
  );
}
