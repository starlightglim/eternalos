import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppearanceStore, type CustomAppearance, APPEARANCE_PROFILE_KEYS, buildTokenUpdate, getTokenValue } from '../../stores/appearanceStore';
import { useAuthStore } from '../../stores/authStore';
import { FONT_CATALOG, resolveFontFamily, type FontEntry } from '../../utils/fontCatalog';
import { THEME_PRESETS } from '../../utils/onboardingPresets';
import { getTokensByTab, groupTokensByGroup, type TokenDefinition } from '../../tokens/tokenSchema';
import { WALLPAPER_OPTIONS, type WallpaperId } from '../desktop/Desktop';
import { uploadWallpaper, isApiConfigured, getWallpaperUrl } from '../../services/api';
import { VariantPicker } from './VariantPicker';
import CursorEditor from '../appearance/CursorEditor';
import SpriteEditor from '../appearance/SpriteEditor';
import { listCursors, type CursorAsset } from '../../services/api';
import styles from './AppearancePanel.module.css';

type TabId = 'themes' | 'palette' | 'windows' | 'controls' | 'typography';

interface ColorControlConfig {
  key: keyof Pick<
    CustomAppearance,
    | 'accentColor'
    | 'desktopColor'
    | 'windowBgColor'
    | 'titleBarBgColor'
    | 'titleBarTextColor'
    | 'windowBorderColor'
    | 'buttonBgColor'
    | 'buttonTextColor'
    | 'buttonBorderColor'
    | 'labelColor'
  >;
  label: string;
  hint: string;
  fallback: string;
}

interface SliderControlConfig {
  key: keyof Pick<CustomAppearance, 'windowBorderRadius' | 'controlBorderRadius' | 'windowShadow' | 'windowOpacity'>;
  label: string;
  hint: string;
  min: number;
  max: number;
  fallback: number;
}

interface ColorPalettePreset {
  name: string;
  colors: Partial<Pick<CustomAppearance, 'accentColor' | 'desktopColor' | 'windowBgColor' | 'titleBarBgColor' | 'titleBarTextColor' | 'windowBorderColor' | 'buttonBgColor' | 'buttonTextColor' | 'buttonBorderColor' | 'labelColor'>>;
}

const COLOR_PALETTES: ColorPalettePreset[] = [
  { name: 'Platinum', colors: { accentColor: '#000080', desktopColor: '#C0C0C0', windowBgColor: '#FFFFFF', titleBarBgColor: '#D9D9D9', titleBarTextColor: '#000000', windowBorderColor: '#000000', buttonBgColor: '#C0C0C0', buttonTextColor: '#000000', buttonBorderColor: '#000000', labelColor: '#000000' } },
  { name: 'Dracula', colors: { accentColor: '#BD93F9', desktopColor: '#282A36', windowBgColor: '#21222C', titleBarBgColor: '#44475A', titleBarTextColor: '#F8F8F2', windowBorderColor: '#6272A4', buttonBgColor: '#44475A', buttonTextColor: '#F8F8F2', buttonBorderColor: '#6272A4', labelColor: '#F8F8F2' } },
  { name: 'Solarized', colors: { accentColor: '#268BD2', desktopColor: '#002B36', windowBgColor: '#073642', titleBarBgColor: '#073642', titleBarTextColor: '#93A1A1', windowBorderColor: '#586E75', buttonBgColor: '#073642', buttonTextColor: '#93A1A1', buttonBorderColor: '#586E75', labelColor: '#839496' } },
  { name: 'Rose Pine', colors: { accentColor: '#C4A7E7', desktopColor: '#191724', windowBgColor: '#1F1D2E', titleBarBgColor: '#26233A', titleBarTextColor: '#E0DEF4', windowBorderColor: '#403D52', buttonBgColor: '#26233A', buttonTextColor: '#E0DEF4', buttonBorderColor: '#403D52', labelColor: '#E0DEF4' } },
  { name: 'Catppuccin', colors: { accentColor: '#CBA6F7', desktopColor: '#1E1E2E', windowBgColor: '#181825', titleBarBgColor: '#313244', titleBarTextColor: '#CDD6F4', windowBorderColor: '#45475A', buttonBgColor: '#313244', buttonTextColor: '#CDD6F4', buttonBorderColor: '#45475A', labelColor: '#CDD6F4' } },
  { name: 'Cream', colors: { accentColor: '#8B7355', desktopColor: '#F5F0E8', windowBgColor: '#FFFDF8', titleBarBgColor: '#EDE6D8', titleBarTextColor: '#4A3F30', windowBorderColor: '#C4B59A', buttonBgColor: '#EDE6D8', buttonTextColor: '#4A3F30', buttonBorderColor: '#C4B59A', labelColor: '#4A3F30' } },
  { name: 'Monochrome', colors: { accentColor: '#555555', desktopColor: '#1A1A1A', windowBgColor: '#222222', titleBarBgColor: '#333333', titleBarTextColor: '#CCCCCC', windowBorderColor: '#444444', buttonBgColor: '#333333', buttonTextColor: '#CCCCCC', buttonBorderColor: '#444444', labelColor: '#AAAAAA' } },
  { name: 'Candy', colors: { accentColor: '#FF6B9D', desktopColor: '#FFF0F5', windowBgColor: '#FFFFFF', titleBarBgColor: '#FFD6E8', titleBarTextColor: '#C74B7A', windowBorderColor: '#FF9CC2', buttonBgColor: '#FFE4EE', buttonTextColor: '#C74B7A', buttonBorderColor: '#FF9CC2', labelColor: '#8B3A62' } },
];

const PALETTE_CONTROLS: ColorControlConfig[] = [
  { key: 'accentColor', label: 'Accent', hint: 'Selections, active states, highlights', fallback: '#000080' },
  { key: 'desktopColor', label: 'Desktop', hint: 'Main desktop fill under wallpaper and icons', fallback: '#C0C0C0' },
  { key: 'windowBgColor', label: 'Window Surface', hint: 'Window content backgrounds', fallback: '#FFFFFF' },
  { key: 'labelColor', label: 'Labels', hint: 'Desktop item labels and similar metadata text', fallback: '#000000' },
];

const WINDOW_CONTROLS: ColorControlConfig[] = [
  { key: 'titleBarBgColor', label: 'Title Bar', hint: 'Window title strip color', fallback: '#C0C0C0' },
  { key: 'titleBarTextColor', label: 'Title Text', hint: 'Window title text color', fallback: '#000000' },
  { key: 'windowBorderColor', label: 'Window Border', hint: 'Window outline and frame color', fallback: '#000000' },
];

const BUTTON_CONTROLS: ColorControlConfig[] = [
  { key: 'buttonBgColor', label: 'Button Fill', hint: 'Buttons, inputs, selects, and controls', fallback: '#C0C0C0' },
  { key: 'buttonTextColor', label: 'Button Text', hint: 'Button and control label color', fallback: '#000000' },
  { key: 'buttonBorderColor', label: 'Button Border', hint: 'Button and control stroke color', fallback: '#000000' },
];

const SHAPE_CONTROLS: SliderControlConfig[] = [
  { key: 'windowBorderRadius', label: 'Window Radius', hint: 'Outer rounding of windows', min: 0, max: 24, fallback: 0 },
  { key: 'controlBorderRadius', label: 'Control Radius', hint: 'Buttons, fields, and window controls', min: 0, max: 24, fallback: 3 },
  { key: 'windowShadow', label: 'Window Shadow', hint: 'Depth and shadow softness', min: 0, max: 32, fallback: 2 },
  { key: 'windowOpacity', label: 'Window Opacity', hint: 'Transparency of window content (hover restores full)', min: 30, max: 100, fallback: 100 },
];

function isHexColor(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value);
}

function titleCaseBoolean(value: boolean | undefined): string {
  return value ? 'Enabled' : 'Disabled';
}

interface ColorFieldProps {
  control: ColorControlConfig;
  appearance: CustomAppearance;
  updateAppearance: (updates: Partial<CustomAppearance>) => void;
}

function ColorField({ control, appearance, updateAppearance }: ColorFieldProps) {
  const value = (appearance[control.key] as string | undefined) ?? control.fallback;
  const [draftValue, setDraftValue] = useState(value);
  const isHex = isHexColor(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <div className={styles.controlCard}>
      <div className={styles.controlHeader}>
        <div>
          <div className={styles.controlLabel}>{control.label}</div>
          <div className={styles.controlHint}>{control.hint}</div>
        </div>
        <button
          className={styles.clearButton}
          onClick={() => updateAppearance({ [control.key]: undefined })}
          type="button"
        >
          Reset
        </button>
      </div>

      <div className={styles.colorFieldRow}>
        {isHex ? (
          <label className={styles.colorSwatchLabel}>
            <input
              className={styles.nativeColorInput}
              type="color"
              value={value}
              onChange={(e) => updateAppearance({ [control.key]: e.target.value })}
            />
            <span className={styles.colorSwatch} style={{ backgroundColor: value }} />
          </label>
        ) : (
          <span className={styles.colorSwatch} style={{ background: value }} />
        )}

        <input
          className={styles.hexInput}
          type="text"
          value={draftValue}
          placeholder="hex, rgb(), or gradient"
          onChange={(e) => setDraftValue(e.target.value)}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (!v) {
              updateAppearance({ [control.key]: undefined });
              setDraftValue(control.fallback);
            } else if (isHexColor(v)) {
              updateAppearance({ [control.key]: v });
              setDraftValue(v);
            } else if (v.length > 3) {
              // Accept any non-trivial CSS value (gradient, rgb, etc.)
              updateAppearance({ [control.key]: v });
              setDraftValue(v);
            } else {
              setDraftValue(value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
        />
      </div>
      {!isHex && value !== control.fallback && (
        <div className={styles.fontPreview} style={{ background: value, height: 24, padding: 0 }} />
      )}
    </div>
  );
}

interface SliderFieldProps {
  control: SliderControlConfig;
  appearance: CustomAppearance;
  updateAppearance: (updates: Partial<CustomAppearance>) => void;
}

function SliderField({ control, appearance, updateAppearance }: SliderFieldProps) {
  const value = (appearance[control.key] as number | undefined) ?? control.fallback;
  const unit = control.key === 'windowOpacity' ? '%' : 'px';

  return (
    <div className={styles.controlCard}>
      <div className={styles.controlHeader}>
        <div>
          <div className={styles.controlLabel}>{control.label}</div>
          <div className={styles.controlHint}>{control.hint}</div>
        </div>
        <div className={styles.sliderValue}>{value}{unit}</div>
      </div>

      <input
        className={styles.slider}
        type="range"
        min={control.min}
        max={control.max}
        value={value}
        onChange={(e) => updateAppearance({ [control.key]: Number(e.target.value) })}
      />
    </div>
  );
}

interface FontSlotConfig {
  key: keyof Pick<CustomAppearance, 'systemFont' | 'bodyFont' | 'monoFont'>;
  label: string;
  hint: string;
  defaultId: string;
  /** Font categories to show in the picker for this slot */
  categories: string[];
}

const FONT_SLOTS: FontSlotConfig[] = [
  { key: 'systemFont', label: 'System Font', hint: 'Titles, menus, and window chrome', defaultId: 'chicago', categories: ['system', 'pixel', 'modern'] },
  { key: 'bodyFont', label: 'Body Font', hint: 'Labels, content, and descriptive text', defaultId: 'geneva', categories: ['system', 'pixel', 'modern'] },
  { key: 'monoFont', label: 'Mono Font', hint: 'Code, hex values, and fixed-width text', defaultId: 'monaco', categories: ['system', 'pixel', 'mono'] },
];

const CATEGORY_LABELS: Record<string, string> = {
  system: 'System',
  pixel: 'Pixel',
  modern: 'Modern',
  mono: 'Monospace',
};

interface FontFieldProps {
  slot: FontSlotConfig;
  appearance: CustomAppearance;
  updateAppearance: (updates: Partial<CustomAppearance>) => void;
}

function FontField({ slot, appearance, updateAppearance }: FontFieldProps) {
  const currentId = (appearance[slot.key] as string | undefined) ?? slot.defaultId;

  // Filter catalog to this slot's categories
  const options: Array<{ id: string; entry: FontEntry }> = [];
  for (const [id, entry] of Object.entries(FONT_CATALOG)) {
    if (slot.categories.includes(entry.category)) {
      options.push({ id, entry });
    }
  }

  // Group by category
  const grouped = new Map<string, Array<{ id: string; entry: FontEntry }>>();
  for (const opt of options) {
    const cat = opt.entry.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(opt);
  }

  return (
    <div className={styles.controlCard}>
      <div className={styles.controlHeader}>
        <div>
          <div className={styles.controlLabel}>{slot.label}</div>
          <div className={styles.controlHint}>{slot.hint}</div>
        </div>
        <button
          className={styles.clearButton}
          onClick={() => updateAppearance({ [slot.key]: undefined })}
          type="button"
        >
          Reset
        </button>
      </div>

      <div className={styles.fontPickerGrid}>
        {[...grouped.entries()].map(([category, fonts]) => (
          <div key={category} className={styles.fontCategory}>
            <div className={styles.fontCategoryLabel}>{CATEGORY_LABELS[category] ?? category}</div>
            {fonts.map(({ id, entry }) => (
              <button
                key={id}
                type="button"
                className={`${styles.fontOption} ${currentId === id ? styles.fontOptionActive : ''}`}
                style={{ fontFamily: entry.family }}
                onClick={() => updateAppearance({ [slot.key]: id })}
              >
                {entry.label}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div
        className={styles.fontPreview}
        style={{ fontFamily: resolveFontFamily(currentId, slot.defaultId) }}
      >
        The quick brown fox jumps over the lazy dog. 0123456789
      </div>
    </div>
  );
}

/**
 * Generic token field that renders new (non-legacy) tokens from the schema.
 * Supports: color, cssColor, number.
 */
interface TokenFieldProps {
  token: TokenDefinition;
  appearance: CustomAppearance;
  updateAppearance: (updates: Partial<CustomAppearance>) => void;
}

function TokenField({ token, appearance, updateAppearance }: TokenFieldProps) {
  const value = getTokenValue(token.path, appearance);
  const handleChange = (newValue: string | number | boolean | undefined) => {
    updateAppearance(buildTokenUpdate(token.path, newValue, appearance));
  };

  if (token.valueType === 'number' && token.numberConstraints) {
    const numValue = (value as number | undefined) ?? (token.defaultValue as number);
    const { min, max, unit } = token.numberConstraints;
    return (
      <div className={styles.controlCard}>
        <div className={styles.controlHeader}>
          <div>
            <div className={styles.controlLabel}>{token.label}</div>
            <div className={styles.controlHint}>{token.hint}</div>
          </div>
          <div className={styles.sliderValue}>{numValue}{unit}</div>
        </div>
        <input
          className={styles.slider}
          type="range"
          min={min}
          max={max}
          step={token.numberConstraints.step ?? 1}
          value={numValue}
          onChange={(e) => handleChange(Number(e.target.value))}
        />
      </div>
    );
  }

  if (token.valueType === 'color') {
    const strValue = (value as string | undefined) ?? '';
    return (
      <div className={styles.controlCard}>
        <div className={styles.controlHeader}>
          <div>
            <div className={styles.controlLabel}>{token.label}</div>
            <div className={styles.controlHint}>{token.hint}</div>
          </div>
          <button
            className={styles.clearButton}
            onClick={() => handleChange(undefined)}
            type="button"
          >
            Reset
          </button>
        </div>
        <div className={styles.colorFieldRow}>
          <label className={styles.colorSwatchLabel}>
            <input
              className={styles.nativeColorInput}
              type="color"
              value={strValue || '#000000'}
              onChange={(e) => handleChange(e.target.value)}
            />
            <span className={styles.colorSwatch} style={{ backgroundColor: strValue || 'transparent' }} />
          </label>
          <input
            className={styles.hexInput}
            type="text"
            value={strValue}
            placeholder={String(token.defaultValue) || 'inherit'}
            onChange={(e) => {
              const v = e.target.value;
              if (/^#[0-9A-Fa-f]{6}$/.test(v)) handleChange(v);
            }}
            onBlur={(e) => {
              const v = e.target.value;
              if (!v) handleChange(undefined);
              else if (/^#[0-9A-Fa-f]{6}$/.test(v)) handleChange(v);
            }}
            spellCheck={false}
            maxLength={7}
          />
        </div>
      </div>
    );
  }

  if (token.valueType === 'cssColor') {
    const strValue = (value as string | undefined) ?? '';
    const isHexValue = /^#[0-9A-Fa-f]{6}$/.test(strValue);
    return (
      <div className={styles.controlCard}>
        <div className={styles.controlHeader}>
          <div>
            <div className={styles.controlLabel}>{token.label}</div>
            <div className={styles.controlHint}>{token.hint}</div>
          </div>
          <button
            className={styles.clearButton}
            onClick={() => handleChange(undefined)}
            type="button"
          >
            Reset
          </button>
        </div>
        <div className={styles.colorFieldRow}>
          {isHexValue || !strValue ? (
            <label className={styles.colorSwatchLabel}>
              <input
                className={styles.nativeColorInput}
                type="color"
                value={strValue || '#000000'}
                onChange={(e) => handleChange(e.target.value)}
              />
              <span className={styles.colorSwatch} style={{ backgroundColor: strValue || 'transparent' }} />
            </label>
          ) : (
            <span className={styles.colorSwatch} style={{ background: strValue }} />
          )}
          <input
            className={styles.hexInput}
            type="text"
            value={strValue}
            placeholder={String(token.defaultValue) || 'color, gradient, or CSS value'}
            onChange={(e) => handleChange(e.target.value || undefined)}
            spellCheck={false}
          />
        </div>
        {strValue && !isHexValue && (
          <div className={styles.fontPreview} style={{ background: strValue, height: 24, padding: 0 }} />
        )}
      </div>
    );
  }

  if (token.valueType === 'boolean') {
    const boolValue = (value as boolean | undefined) ?? (token.defaultValue as boolean);
    return (
      <div className={styles.controlCard}>
        <div className={styles.controlHeader}>
          <div>
            <div className={styles.controlLabel}>{token.label}</div>
            <div className={styles.controlHint}>{token.hint}</div>
          </div>
          <div className={styles.sliderValue}>{boolValue ? 'On' : 'Off'}</div>
        </div>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={boolValue}
            onChange={(e) => handleChange(e.target.checked)}
          />
          <span>{boolValue ? 'Enabled' : 'Disabled'}</span>
        </label>
      </div>
    );
  }

  return null;
}

/**
 * Renders a group of tokens from the schema for a given tab.
 * Skips tokens that have legacy profileKeys (those are rendered by hardcoded controls).
 */
function TokenGroupSection({ tab, appearance, updateAppearance }: {
  tab: TokenDefinition['tab'];
  appearance: CustomAppearance;
  updateAppearance: (updates: Partial<CustomAppearance>) => void;
}) {
  const tokens = getTokensByTab(tab).filter((t) => t.profileKey === null);
  if (tokens.length === 0) return null;

  const groups = groupTokensByGroup(tokens);

  return (
    <>
      {[...groups.entries()].map(([group, groupTokens]) => (
        <div key={group} className={styles.sectionStack} style={{ marginTop: 16 }}>
          {group !== '_default' && (
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>{group}</div>
            </div>
          )}
          <div className={styles.grid}>
            {groupTokens.map((token) => (
              <TokenField
                key={token.path}
                token={token}
                appearance={appearance}
                updateAppearance={updateAppearance}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Export current appearance as a downloadable JSON file */
function exportTheme(appearance: CustomAppearance) {
  const theme: Record<string, unknown> = { _format: 'eternalos-theme-v3' };
  for (const key of APPEARANCE_PROFILE_KEYS) {
    if (key === 'customCSS') continue;
    if (appearance[key] !== undefined) {
      theme[key] = appearance[key];
    }
  }
  // Include extended design tokens
  if (appearance.designTokens && Object.keys(appearance.designTokens).length > 0) {
    theme.designTokens = appearance.designTokens;
  }
  // Include variant selections
  if (appearance.variants && Object.keys(appearance.variants).length > 0) {
    theme.variants = appearance.variants;
  }
  const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'eternalos-theme.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse and validate an imported theme file */
function parseThemeFile(text: string): CustomAppearance | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj === null) return null;
    const result: Record<string, unknown> = {};
    for (const key of APPEARANCE_PROFILE_KEYS) {
      if (key === 'customCSS') continue;
      if (obj[key] !== undefined) {
        result[key] = obj[key];
      }
    }
    // Import extended design tokens
    if (obj.designTokens && typeof obj.designTokens === 'object') {
      result.designTokens = obj.designTokens;
    }
    // Import variant selections
    if (obj.variants && typeof obj.variants === 'object') {
      result.variants = obj.variants;
    }
    return Object.keys(result).length > 0 ? (result as CustomAppearance) : null;
  } catch {
    return null;
  }
}

export function AppearancePanel() {
  const {
    appearance,
    updateAppearance,
    setFontSmoothing,
    resetAppearance,
    saveAppearance,
    isLoading,
    hasUnsavedChanges,
  } = useAppearanceStore();

  const [activeTab, setActiveTab] = useState<TabId>('themes');
  const importInputRef = useRef<HTMLInputElement>(null);
  const wallpaperInputRef = useRef<HTMLInputElement>(null);

  // Wallpaper state (moved from Preferences Desktop tab)
  const { profile, setWallpaper } = useAuthStore();
  const currentWallpaper = profile?.wallpaper || 'default';
  const isCustomWallpaper = currentWallpaper.startsWith('custom:');
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Cursor assets state
  const [cursorAssets, setCursorAssets] = useState<CursorAsset[]>([]);
  const loadCursorAssets = useCallback(() => {
    if (isApiConfigured) {
      listCursors().then(setCursorAssets).catch(console.error);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'controls') {
      loadCursorAssets();
    }
  }, [activeTab, loadCursorAssets]);

  const handleSelectWallpaper = useCallback(
    (id: WallpaperId) => {
      setWallpaper(id);
      setUploadError(null);
    },
    [setWallpaper]
  );

  const handleWallpaperUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png'].includes(file.type)) {
        setUploadError('Only JPG and PNG files are allowed');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        setUploadError('File must be smaller than 2MB');
        return;
      }
      setUploadError(null);
      setUploadProgress(0);
      try {
        const response = await uploadWallpaper(file, (progress) => {
          setUploadProgress(progress);
        });
        setWallpaper(response.wallpaper);
        setUploadProgress(null);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : 'Upload failed');
        setUploadProgress(null);
      }
      if (wallpaperInputRef.current) {
        wallpaperInputRef.current.value = '';
      }
    },
    [setWallpaper]
  );

  const handleImport = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const parsed = parseThemeFile(reader.result as string);
      if (parsed) {
        updateAppearance(parsed);
      }
    };
    reader.readAsText(file);
    // Reset so the same file can be re-imported
    e.target.value = '';
  }, [updateAppearance]);

  // previewStyles removed — preview tab was deleted

  return (
    <div className={styles.panel} data-theme-immune>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Custom Appearance</div>
          <h2 className={styles.title}>Build your own chrome</h2>
          <p className={styles.subtitle}>
            Direct controls for color, radius, and contrast. No themes, no overlap.
          </p>
        </div>
        <div className={styles.headerMeta}>
          <span className={styles.statusPill}>{hasUnsavedChanges ? 'Unsaved' : 'Saved'}</span>
        </div>
      </div>

      <div className={styles.tabBar}>
        <button className={`${styles.tab} ${activeTab === 'themes' ? styles.activeTab : ''}`} onClick={() => setActiveTab('themes')} type="button">
          Themes
        </button>
        <button className={`${styles.tab} ${activeTab === 'palette' ? styles.activeTab : ''}`} onClick={() => setActiveTab('palette')} type="button">
          Palette
        </button>
        <button className={`${styles.tab} ${activeTab === 'windows' ? styles.activeTab : ''}`} onClick={() => setActiveTab('windows')} type="button">
          Windows
        </button>
        <button className={`${styles.tab} ${activeTab === 'controls' ? styles.activeTab : ''}`} onClick={() => setActiveTab('controls')} type="button">
          Controls
        </button>
        <button className={`${styles.tab} ${activeTab === 'typography' ? styles.activeTab : ''}`} onClick={() => setActiveTab('typography')} type="button">
          Typography
        </button>
{/* Preview tab removed — the real desktop IS the preview */}
      </div>

      <div className={styles.content}>
        {activeTab === 'themes' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Theme Presets</div>
              <div className={styles.sectionHint}>One-click themes. Apply as a starting point, then customize in other tabs.</div>
            </div>
            <div className={styles.themeGrid}>
              {THEME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={styles.themeCard}
                  onClick={() => updateAppearance(preset.appearance)}
                >
                  <div className={styles.themePreview}>
                    <div className={styles.themePreviewDesktop} style={{ backgroundColor: preset.preview.desktop }}>
                      <div className={styles.themePreviewWindow} style={{ backgroundColor: preset.preview.window, borderColor: preset.preview.accent }}>
                        <div className={styles.themePreviewTitleBar} style={{ backgroundColor: preset.preview.titleBar }}>
                          <span style={{ backgroundColor: preset.preview.accent }} />
                          <span style={{ backgroundColor: preset.preview.accent }} />
                        </div>
                      </div>
                      <div className={styles.themePreviewIcon}>
                        <div className={styles.themePreviewIconLabel} style={{ color: preset.preview.label }}>Aa</div>
                      </div>
                    </div>
                  </div>
                  <div className={styles.themeInfo}>
                    <div className={styles.themeName}>{preset.name}</div>
                    <div className={styles.themeDesc}>{preset.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'palette' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Color Palettes</div>
              <div className={styles.sectionHint}>Quick-apply a color scheme, then fine-tune individual colors below.</div>
            </div>
            <div className={styles.paletteRow}>
              {COLOR_PALETTES.map((palette) => (
                <button
                  key={palette.name}
                  type="button"
                  className={styles.paletteChip}
                  onClick={() => updateAppearance(palette.colors)}
                  title={palette.name}
                >
                  <span className={styles.paletteSwatches}>
                    <span style={{ backgroundColor: palette.colors.desktopColor }} />
                    <span style={{ backgroundColor: palette.colors.accentColor }} />
                    <span style={{ backgroundColor: palette.colors.windowBgColor }} />
                    <span style={{ backgroundColor: palette.colors.titleBarBgColor }} />
                  </span>
                  <span className={styles.paletteName}>{palette.name}</span>
                </button>
              ))}
            </div>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Fine-Tune</div>
            </div>
            <div className={styles.grid}>
              {PALETTE_CONTROLS.map((control) => (
                <ColorField
                  key={control.key}
                  control={control}
                  appearance={appearance}
                  updateAppearance={updateAppearance}
                />
              ))}
            </div>
            <TokenGroupSection tab="palette" appearance={appearance} updateAppearance={updateAppearance} />

            <hr className={styles.sectionDivider} />

            {/* --- Desktop Pattern --- */}
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Desktop Pattern</div>
              <div className={styles.sectionHint}>Background pattern for the desktop surface.</div>
            </div>
            <div className={styles.patternGrid}>
              {WALLPAPER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`${styles.patternButton} ${currentWallpaper === option.id ? styles.patternButtonActive : ''}`}
                  onClick={() => handleSelectWallpaper(option.id)}
                  title={option.name}
                >
                  <div className={`${styles.patternPreview} wallpaper-${option.id}`} />
                  <span className={styles.patternName}>{option.name}</span>
                </button>
              ))}
            </div>

            {/* --- Custom Wallpaper Upload --- */}
            {isApiConfigured && (
              <>
                {isCustomWallpaper && (
                  <div className={styles.wallpaperPreview}>
                    <img
                      src={getWallpaperUrl(currentWallpaper)}
                      alt="Current wallpaper"
                      className={styles.wallpaperImage}
                    />
                  </div>
                )}
                <div className={styles.uploadRow}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => wallpaperInputRef.current?.click()}
                    disabled={uploadProgress !== null}
                  >
                    {uploadProgress !== null ? `Uploading ${uploadProgress}%` : 'Upload Image'}
                  </button>
                  <span className={styles.sectionHint}>JPG or PNG, max 2MB</span>
                  <input
                    ref={wallpaperInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    style={{ display: 'none' }}
                    onChange={handleWallpaperUpload}
                  />
                </div>
                {uploadError && (
                  <div className={styles.uploadError}>{uploadError}</div>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'windows' && (
          <div className={styles.sectionStack}>
            {/* --- Style Variants --- */}
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Style</div>
              <div className={styles.sectionHint}>Pick a visual style for each part of the window.</div>
            </div>
            <VariantPicker slotId="window.chrome" label="Frame" />
            <VariantPicker slotId="window.titleBar" label="Title Bar" />
            <VariantPicker slotId="window.buttons" label="Buttons" />
            <VariantPicker slotId="window.resizeHandle" label="Resize Grip" />

            <hr className={styles.sectionDivider} />

            {/* --- Colors --- */}
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Colors</div>
              <div className={styles.sectionHint}>Tune frame and title bar colors.</div>
            </div>
            <div className={styles.grid}>
              {WINDOW_CONTROLS.map((control) => (
                <ColorField
                  key={control.key}
                  control={control}
                  appearance={appearance}
                  updateAppearance={updateAppearance}
                />
              ))}
            </div>

            <hr className={styles.sectionDivider} />

            {/* --- Shape & Depth --- */}
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Shape & Depth</div>
              <div className={styles.sectionHint}>Corner rounding, shadow, and opacity.</div>
            </div>
            <div className={styles.grid}>
              {SHAPE_CONTROLS.map((control) => (
                <SliderField
                  key={control.key}
                  control={control}
                  appearance={appearance}
                  updateAppearance={updateAppearance}
                />
              ))}
            </div>
            <TokenGroupSection tab="windows" appearance={appearance} updateAppearance={updateAppearance} />

            {/* Sprite upload UI — shown when any sprite variant is active */}
            {(appearance.variants?.['window.chrome'] === 'sprite' ||
              appearance.variants?.['window.titleBar'] === 'sprite' ||
              appearance.variants?.['window.buttons'] === 'sprite' ||
              appearance.variants?.['window.resizeHandle'] === 'sprite') && (
              <>
                <hr className={styles.sectionDivider} />
                <div className={styles.sectionIntro}>
                  <div className={styles.sectionTitle}>Sprite Assets</div>
                  <div className={styles.sectionHint}>Upload custom images for your sprite-based window chrome.</div>
                </div>
                <SpriteEditor
                  showChrome={appearance.variants?.['window.chrome'] === 'sprite'}
                  showTitleBar={appearance.variants?.['window.titleBar'] === 'sprite'}
                  showButtons={appearance.variants?.['window.buttons'] === 'sprite'}
                  showResize={appearance.variants?.['window.resizeHandle'] === 'sprite'}
                />
              </>
            )}
          </div>
        )}

        {activeTab === 'controls' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Buttons & Controls</div>
              <div className={styles.sectionHint}>Style buttons, inputs, selects, and other interactive elements.</div>
            </div>
            <div className={styles.grid}>
              {BUTTON_CONTROLS.map((control) => (
                <ColorField
                  key={control.key}
                  control={control}
                  appearance={appearance}
                  updateAppearance={updateAppearance}
                />
              ))}
            </div>
            <TokenGroupSection tab="controls" appearance={appearance} updateAppearance={updateAppearance} />

            {/* Custom Cursors */}
            <div style={{ marginTop: 12 }}>
              <CursorEditor
                cursorAssets={cursorAssets}
                onAssetsChange={loadCursorAssets}
              />
            </div>
          </div>
        )}

        {activeTab === 'typography' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Fonts</div>
              <div className={styles.sectionHint}>Choose fonts for each role. System fonts are bundled; others load from Google Fonts.</div>
            </div>
            {FONT_SLOTS.map((slot) => (
              <FontField
                key={slot.key}
                slot={slot}
                appearance={appearance}
                updateAppearance={updateAppearance}
              />
            ))}
            <div className={styles.controlCard}>
              <div className={styles.controlHeader}>
                <div>
                  <div className={styles.controlLabel}>Font Smoothing</div>
                  <div className={styles.controlHint}>Crisper retro edges or softer text rendering.</div>
                </div>
                <div className={styles.sliderValue}>{titleCaseBoolean(appearance.fontSmoothing)}</div>
              </div>
              <label className={styles.toggleRow}>
                <input
                  type="checkbox"
                  checked={appearance.fontSmoothing ?? false}
                  onChange={(e) => setFontSmoothing(e.target.checked)}
                />
                <span>Use antialiased text</span>
              </label>
            </div>
          </div>
        )}

{/* Preview tab removed — the desktop itself is the live preview */}
      </div>

      <div className={styles.footer}>
        <button className={styles.secondaryButton} onClick={resetAppearance} type="button">
          Reset All
        </button>
        <button className={styles.secondaryButton} onClick={() => exportTheme(appearance)} type="button">
          Export
        </button>
        <button className={styles.secondaryButton} onClick={() => importInputRef.current?.click()} type="button">
          Import
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImport}
        />
        <div className={styles.footerCopy} />
        <button className={styles.primaryButton} disabled={isLoading || !hasUnsavedChanges} onClick={() => void saveAppearance()} type="button">
          {isLoading ? 'Saving...' : 'Apply & Save'}
        </button>
      </div>
    </div>
  );
}
