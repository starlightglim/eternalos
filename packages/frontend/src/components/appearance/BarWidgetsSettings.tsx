/**
 * Appearance → Bar & Widgets: polybar-style menu bar modules and conky-style
 * desktop text. Stored as bar.* / conky.* design tokens.
 */

import { useAppearanceStore } from '../../stores/appearanceStore';
import { BAR_MODULES, DEFAULT_CONKY_TEXT, RICE_PLACEHOLDERS, barFromTokens, conkyFromTokens, type BarModule } from '../../utils/riceInfo';
import styles from './WallpaperRice.module.css';

const MODULE_LABELS: Record<BarModule, string> = {
  layout: 'Layout switcher ([]= ||| ###)',
  window: 'Active window',
  windows: 'Open windows',
  text: 'Custom text',
  online: 'Online status',
  battery: 'Battery',
  cores: 'CPU cores',
  uptime: 'Uptime',
  date: 'Date',
  clock: 'Clock',
  bazaar: 'Bazaar button',
};

export function BarWidgetsSettings() {
  const tokens = useAppearanceStore((state) => state.appearance.designTokens);
  const updateAppearance = useAppearanceStore((state) => state.updateAppearance);
  const bar = barFromTokens(tokens);
  const conky = conkyFromTokens(tokens);
  const set = (values: Record<string, string | number | boolean>) => {
    const current = useAppearanceStore.getState().appearance.designTokens ?? {};
    updateAppearance({ designTokens: { ...current, ...values } });
  };
  const toggleModule = (module: BarModule, on: boolean) => {
    const next = BAR_MODULES.filter((m) => (m === module ? on : bar.modules.includes(m)));
    set({ 'bar.modules': next.join(',') });
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.intro}>
        <div className={styles.title}>Menu bar</div>
        <div className={styles.hint}>Pick what shows on the right of the menu bar, like a Linux status bar.</div>
      </div>
      <div className={styles.segment} role="radiogroup" aria-label="Bar style">
        {(['classic', 'floating', 'transparent'] as const).map((style) => (
          <button key={style} type="button" role="radio" aria-checked={bar.style === style} className={bar.style === style ? styles.on : undefined} onClick={() => set({ 'bar.style': style })}>
            {style === 'classic' ? 'Classic' : style === 'floating' ? 'Floating' : 'Transparent'}
          </button>
        ))}
      </div>
      <div className={styles.checks}>
        {BAR_MODULES.map((module) => (
          <label key={module} className={styles.inline}>
            <input type="checkbox" checked={bar.modules.includes(module)} onChange={(event) => toggleModule(module, event.target.checked)} />
            {MODULE_LABELS[module]}
          </label>
        ))}
      </div>
      <div className={styles.sliders}>
        <label>
          Clock
          <select value={bar.clockFormat} onChange={(event) => set({ 'bar.clockFormat': event.target.value })}>
            <option value="12h">12-hour</option>
            <option value="24h">24-hour</option>
            <option value="seconds">24-hour with seconds</option>
          </select>
        </label>
        {bar.modules.includes('text') && (
          <label>
            Custom text
            <input value={bar.text} maxLength={80} placeholder="♫ now vibing" onChange={(event) => set({ 'bar.text': event.target.value })} />
          </label>
        )}
      </div>

      <hr />

      <div className={styles.intro}>
        <div className={styles.title}>Desktop text (conky)</div>
        <div className={styles.hint}>Live text drawn on your wallpaper. Use placeholders: {RICE_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}</div>
      </div>
      <label className={styles.inline}>
        <input type="checkbox" checked={conky.enabled} onChange={(event) => set({ 'conky.enabled': event.target.checked })} />
        Show desktop text
      </label>
      {conky.enabled && (
        <div className={styles.sliders}>
          <label>
            Text
            <textarea rows={7} value={conky.text} maxLength={500} spellCheck={false} style={{ fontFamily: 'var(--font-monaco, monospace)' }} onChange={(event) => set({ 'conky.text': event.target.value })} />
          </label>
          <div className={styles.segment} role="radiogroup" aria-label="Position">
            {(['top-left', 'top-right', 'center', 'bottom-left', 'bottom-right'] as const).map((position) => (
              <button key={position} type="button" role="radio" aria-checked={conky.position === position} className={conky.position === position ? styles.on : undefined} onClick={() => set({ 'conky.position': position })}>
                {position.replace('-', ' ')}
              </button>
            ))}
          </div>
          <label>
            Size <b>{conky.size}px</b>
            <input type="range" min={9} max={72} value={conky.size} onChange={(event) => set({ 'conky.size': Number(event.target.value) })} />
          </label>
          <button type="button" onClick={() => set({ 'conky.text': DEFAULT_CONKY_TEXT })}>Reset text</button>
        </div>
      )}
    </div>
  );
}
