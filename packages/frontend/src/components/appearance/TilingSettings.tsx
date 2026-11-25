/**
 * Appearance → Windows → Layout: floating windows, or tiling (i3/dwm style)
 * with gaps. Stored as layout.* design tokens, so it saves and exports with
 * the rest of the look.
 */

import { useAppearanceStore } from '../../stores/appearanceStore';
import { tilingFromTokens, type TilingMode } from '../../utils/tiling';
import styles from './WallpaperRice.module.css';

const MODES: Array<{ id: TilingMode; label: string; hint: string }> = [
  { id: 'floating', label: 'Floating', hint: 'Windows go wherever you put them.' },
  { id: 'master', label: 'Master + stack', hint: 'One big window on the left, the rest stacked on the right. Drag a window onto another to swap them.' },
  { id: 'columns', label: 'Columns', hint: 'Side-by-side columns.' },
  { id: 'grid', label: 'Grid', hint: 'An even grid.' },
];

export function TilingSettings() {
  const tokens = useAppearanceStore((state) => state.appearance.designTokens);
  const updateAppearance = useAppearanceStore((state) => state.updateAppearance);
  const settings = tilingFromTokens(tokens);
  const set = (key: string, value: string | number | boolean) => {
    const current = useAppearanceStore.getState().appearance.designTokens ?? {};
    updateAppearance({ designTokens: { ...current, [key]: value } });
  };
  const hint = MODES.find((mode) => mode.id === settings.mode)?.hint;

  return (
    <div className={styles.wrap}>
      <div className={styles.segment} role="radiogroup" aria-label="Window layout">
        {MODES.map((mode) => (
          <button key={mode.id} type="button" role="radio" aria-checked={settings.mode === mode.id} className={settings.mode === mode.id ? styles.on : undefined} onClick={() => set('layout.mode', mode.id)}>
            {mode.label}
          </button>
        ))}
      </div>
      {hint && <div className={styles.hint}>{hint}</div>}
      {settings.mode !== 'floating' && (
        <div className={styles.sliders}>
          <label>
            Gap between windows <b>{settings.gap}px</b>
            <input type="range" min={0} max={48} value={settings.gap} onChange={(event) => set('layout.gap', Number(event.target.value))} />
          </label>
          <label>
            Outer gap <b>{settings.outerGap}px</b>
            <input type="range" min={0} max={80} value={settings.outerGap} onChange={(event) => set('layout.outerGap', Number(event.target.value))} />
          </label>
          {settings.mode === 'master' && (
            <label>
              Master width <b>{Math.round(settings.masterRatio * 100)}%</b>
              <input type="range" min={30} max={75} value={Math.round(settings.masterRatio * 100)} onChange={(event) => set('layout.masterRatio', Number(event.target.value) / 100)} />
            </label>
          )}
          <label className={styles.inline}>
            <input type="checkbox" checked={settings.reserveIcons} onChange={(event) => set('layout.reserveIcons', event.target.checked)} />
            Keep the desktop icons visible
          </label>
        </div>
      )}
    </div>
  );
}
