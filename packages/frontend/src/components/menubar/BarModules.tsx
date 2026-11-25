/**
 * Right side of the menu bar, polybar/waybar style: the modules chosen in
 * Appearance → Bar & Widgets (bar.modules token), in that order.
 */

import { useAppearanceStore } from '../../stores/appearanceStore';
import { useRiceInfo } from '../../hooks/useRiceInfo';
import { barFromTokens, LAYOUT_SYMBOLS, riceValues, type BarModule } from '../../utils/riceInfo';
import type { TilingMode } from '../../utils/tiling';
import styles from './MenuBar.module.css';

const NEXT_LAYOUT: Record<TilingMode, TilingMode> = { floating: 'master', master: 'columns', columns: 'grid', grid: 'floating' };

export function BarModules({ onOpenBazaar }: { onOpenBazaar: () => void }) {
  const tokens = useAppearanceStore((state) => state.appearance.designTokens);
  const updateAppearance = useAppearanceStore((state) => state.updateAppearance);
  const bar = barFromTokens(tokens);
  const facts = useRiceInfo({ tickSeconds: bar.clockFormat === 'seconds' || bar.modules.includes('uptime'), clockFormat: bar.clockFormat });
  const values = riceValues(facts);

  const cycleLayout = () => {
    const current = useAppearanceStore.getState().appearance.designTokens ?? {};
    updateAppearance({ designTokens: { ...current, 'layout.mode': NEXT_LAYOUT[facts.layout] } });
  };

  const render = (module: BarModule) => {
    switch (module) {
      case 'bazaar':
        return <div key={module} className={styles.bazaarButton} onClick={onOpenBazaar} title="Open Bazaar — browse themes, cursors, apps">★ Bazaar</div>;
      case 'clock':
        return <div key={module} className={styles.clock}>{values.time}</div>;
      case 'date':
        return <div key={module} className={styles.barModule}>{values.date}</div>;
      case 'layout':
        return (
          <button key={module} type="button" className={`${styles.barModule} ${styles.barButton}`} onClick={cycleLayout} title={`Layout: ${facts.layout} (click to change)`}>
            {LAYOUT_SYMBOLS[facts.layout]}
          </button>
        );
      case 'window':
        return <div key={module} className={`${styles.barModule} ${styles.barWindow}`} title={values.window}>{values.window}</div>;
      case 'windows':
        return <div key={module} className={styles.barModule} title="Open windows">▣ {values.windows}</div>;
      case 'online':
        return <div key={module} className={styles.barModule} title={values.online}>{facts.online ? '● online' : '○ offline'}</div>;
      case 'battery':
        return facts.battery ? <div key={module} className={styles.barModule} title="Battery">▮ {values.battery}</div> : null;
      case 'cores':
        return facts.cores ? <div key={module} className={styles.barModule} title="CPU cores">⚙ {values.cores}</div> : null;
      case 'uptime':
        return <div key={module} className={styles.barModule} title="Time since this page opened">up {values.uptime}</div>;
      case 'text':
        return bar.text ? <div key={module} className={styles.barModule}>{bar.text}</div> : null;
      default:
        return null;
    }
  };

  return <div className={styles.barModules}>{bar.modules.map(render)}</div>;
}
