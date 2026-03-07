import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useAppearanceStore, type CustomAppearance } from '../../stores/appearanceStore';
import styles from './AppearancePanel.module.css';

type TabId = 'palette' | 'windows' | 'controls' | 'preview';

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
  key: keyof Pick<CustomAppearance, 'windowBorderRadius' | 'controlBorderRadius' | 'windowShadow'>;
  label: string;
  hint: string;
  min: number;
  max: number;
  fallback: number;
}

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
        <label className={styles.colorSwatchLabel}>
          <input
            className={styles.nativeColorInput}
            type="color"
            value={value}
            onChange={(e) => updateAppearance({ [control.key]: e.target.value })}
          />
          <span className={styles.colorSwatch} style={{ backgroundColor: value }} />
        </label>

        <input
          className={styles.hexInput}
          type="text"
          value={draftValue}
          onChange={(e) => {
            const nextValue = e.target.value;
            if (/^#?[0-9A-Fa-f]{0,6}$/.test(nextValue)) {
              const normalizedValue = nextValue.startsWith('#') ? nextValue : `#${nextValue}`;
              setDraftValue(normalizedValue);
            }
          }}
          onBlur={(e) => {
            const normalizedValue = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
            if (isHexColor(normalizedValue)) {
              updateAppearance({ [control.key]: normalizedValue });
              setDraftValue(normalizedValue);
            } else {
              setDraftValue(value);
            }
          }}
          spellCheck={false}
          maxLength={7}
        />
      </div>
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

  return (
    <div className={styles.controlCard}>
      <div className={styles.controlHeader}>
        <div>
          <div className={styles.controlLabel}>{control.label}</div>
          <div className={styles.controlHint}>{control.hint}</div>
        </div>
        <div className={styles.sliderValue}>{value}px</div>
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

  const [activeTab, setActiveTab] = useState<TabId>('palette');

  const previewStyles = useMemo(
    () => ({
      backgroundColor: appearance.desktopColor || '#C0C0C0',
      '--preview-window-bg': appearance.windowBgColor || '#FFFFFF',
      '--preview-title-bg': appearance.titleBarBgColor || '#C0C0C0',
      '--preview-title-text': appearance.titleBarTextColor || '#000000',
      '--preview-border': appearance.windowBorderColor || '#000000',
      '--preview-button-bg': appearance.buttonBgColor || '#C0C0C0',
      '--preview-button-text': appearance.buttonTextColor || '#000000',
      '--preview-button-border': appearance.buttonBorderColor || '#000000',
      '--preview-label': appearance.labelColor || '#000000',
      '--preview-accent': appearance.accentColor || '#000080',
      '--preview-radius': `${appearance.windowBorderRadius ?? 0}px`,
      '--preview-control-radius': `${appearance.controlBorderRadius ?? 3}px`,
      '--preview-shadow': `0 ${Math.max(2, (appearance.windowShadow ?? 2) / 2)}px ${Math.max(4, appearance.windowShadow ?? 2)}px rgba(0, 0, 0, ${Math.min(0.45, 0.16 + (appearance.windowShadow ?? 2) / 64)})`,
    }) as CSSProperties,
    [appearance]
  );

  return (
    <div className={styles.panel}>
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
        <button className={`${styles.tab} ${activeTab === 'palette' ? styles.activeTab : ''}`} onClick={() => setActiveTab('palette')} type="button">
          Palette
        </button>
        <button className={`${styles.tab} ${activeTab === 'windows' ? styles.activeTab : ''}`} onClick={() => setActiveTab('windows')} type="button">
          Windows
        </button>
        <button className={`${styles.tab} ${activeTab === 'controls' ? styles.activeTab : ''}`} onClick={() => setActiveTab('controls')} type="button">
          Controls
        </button>
        <button className={`${styles.tab} ${activeTab === 'preview' ? styles.activeTab : ''}`} onClick={() => setActiveTab('preview')} type="button">
          Preview
        </button>
      </div>

      <div className={styles.content}>
        {activeTab === 'palette' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Core Colors</div>
              <div className={styles.sectionHint}>Shape the overall mood of the desktop before refining chrome.</div>
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
          </div>
        )}

        {activeTab === 'windows' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Window Chrome</div>
              <div className={styles.sectionHint}>Tune frame colors, corner treatment, and depth.</div>
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
              {SHAPE_CONTROLS.map((control) => (
                <SliderField
                  key={control.key}
                  control={control}
                  appearance={appearance}
                  updateAppearance={updateAppearance}
                />
              ))}
            </div>
          </div>
        )}

        {activeTab === 'controls' && (
          <div className={styles.sectionStack}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Buttons & Typography</div>
              <div className={styles.sectionHint}>Handle button styling and how text is rendered across the UI.</div>
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
          </div>
        )}

        {activeTab === 'preview' && (
          <div className={styles.previewTab}>
            <div className={styles.sectionIntro}>
              <div className={styles.sectionTitle}>Live Direction</div>
              <div className={styles.sectionHint}>This mirrors the structured appearance controls that will be saved to your profile.</div>
            </div>

            <div className={styles.previewCanvas} style={previewStyles}>
              <div className={styles.previewMenuBar}>
                <span>File</span>
                <span>Edit</span>
                <span>View</span>
                <span>Special</span>
              </div>

              <div className={styles.previewWindow}>
                <div className={styles.previewTitleBar}>
                  <div className={styles.previewControls}>
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className={styles.previewWindowTitle}>Appearance Preview</div>
                </div>
                <div className={styles.previewBody}>
                  <div className={styles.previewSidebar}>
                    <div className={styles.previewLabel}>closing.png</div>
                    <div className={styles.previewLabel}>Guestbook</div>
                  </div>
                  <div className={styles.previewInspector}>
                    <div className={styles.previewCard}>
                      <div className={styles.previewCardTitle}>Buttons</div>
                      <div className={styles.previewButtonRow}>
                        <button type="button">Apply</button>
                        <button type="button">Cancel</button>
                      </div>
                    </div>
                    <div className={styles.previewCard}>
                      <div className={styles.previewCardTitle}>Inputs</div>
                      <input type="text" value="#C0C0C0" readOnly />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.metricsRow}>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Window Radius</span>
                <span className={styles.metricValue}>{appearance.windowBorderRadius ?? 0}px</span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Control Radius</span>
                <span className={styles.metricValue}>{appearance.controlBorderRadius ?? 3}px</span>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>Shadow</span>
                <span className={styles.metricValue}>{appearance.windowShadow ?? 2}px</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <button className={styles.secondaryButton} onClick={resetAppearance} type="button">
          Reset All
        </button>
        <div className={styles.footerCopy}>For advanced selectors and textures, use Custom CSS after you set the base chrome here.</div>
        <button className={styles.primaryButton} disabled={isLoading || !hasUnsavedChanges} onClick={() => void saveAppearance()} type="button">
          {isLoading ? 'Saving...' : 'Apply & Save'}
        </button>
      </div>
    </div>
  );
}
