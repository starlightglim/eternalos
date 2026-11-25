/**
 * "About This Desktop": a fastfetch/neofetch-style card for screenshots —
 * ASCII logo, user@host, the rice's facts and the palette blocks.
 */

import { useMemo, useState } from 'react';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useRiceInfo } from '../../hooks/useRiceInfo';
import { barFromTokens, riceValues } from '../../utils/riceInfo';
import styles from './FetchCard.module.css';

export const FETCH_LOGO = String.raw`
      ________
     /  ____  \
    /  / __ \  \
   |  | |  | |  |
   |  | |__| |  |
    \  \____/  /
     \________/
   e t e r n a l
`.slice(1);

const PALETTE_VARS = ['--black', '--danger', '--success', '--accent', '--selection', '--title-bar-active', '--shadow', '--highlight', '--window-bg', '--white'];

export function FetchCard() {
  const tokens = useAppearanceStore((state) => state.appearance.designTokens);
  const updateAppearance = useAppearanceStore((state) => state.updateAppearance);
  const facts = useRiceInfo({ clockFormat: barFromTokens(tokens).clockFormat });
  const v = riceValues(facts);
  const [copied, setCopied] = useState(false);

  const lines: Array<[string, string]> = useMemo(() => [
    ['OS', `EternalOS on ${v.browser} (${v.os})`],
    ['Theme', v.theme],
    ['Layout', v.layout],
    ['Font', v.font],
    ['Accent', v.accent],
    ['Wallpaper', v.wallpaper],
    ['Apps', v.apps],
    ['Items', v.items],
    ['Windows', v.windows],
    ['Uptime', v.uptime],
    ['Resolution', v.screen],
    ['CPU', v.cores === 'n/a' ? 'n/a' : `${v.cores} cores`],
    ['Memory', v.memory],
  ], [v]);

  const palette = useMemo(() => {
    const style = getComputedStyle(document.querySelector('.user-desktop') ?? document.documentElement);
    return PALETTE_VARS.map((name) => style.getPropertyValue(name).trim()).filter(Boolean);
  }, [tokens]); // eslint-disable-line react-hooks/exhaustive-deps

  const asText = () => {
    const head = `${v.user}@eternalos`;
    const info = [head, '-'.repeat(head.length), ...lines.map(([k, val]) => `${k}: ${val}`)];
    const logo = FETCH_LOGO.split('\n');
    const rows = Math.max(logo.length, info.length);
    const width = Math.max(...logo.map((l) => l.length)) + 3;
    return Array.from({ length: rows }, (_, i) => `${(logo[i] ?? '').padEnd(width)}${info[i] ?? ''}`.trimEnd()).join('\n');
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(asText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const rename = (name: string) => {
    const current = useAppearanceStore.getState().appearance.designTokens ?? {};
    updateAppearance({ designTokens: { ...current, 'rice.name': name.slice(0, 40) } });
  };

  return (
    <div className={styles.fetch} data-no-drag>
      <pre className={styles.logo} aria-hidden="true">{FETCH_LOGO}</pre>
      <div className={styles.info}>
        <div className={styles.head}>
          <span className={styles.accent}>{v.user}</span>@<span className={styles.accent}>eternalos</span>
        </div>
        <div className={styles.rule}>{'-'.repeat(`${v.user}@eternalos`.length)}</div>
        {lines.map(([key, value]) => (
          <div key={key} className={styles.line}>
            <span className={styles.key}>{key}</span>
            {key === 'Theme' ? (
              <input className={styles.themeInput} value={facts.theme === 'custom' ? '' : facts.theme} placeholder="name your rice" maxLength={40} onChange={(event) => rename(event.target.value)} aria-label="Rice name" />
            ) : (
              <span>{value}</span>
            )}
          </div>
        ))}
        <div className={styles.blocks} aria-label="Palette">
          {palette.map((color, i) => <span key={i} style={{ background: color }} title={color} />)}
        </div>
        <button type="button" className={styles.copy} onClick={() => void copy()}>{copied ? 'Copied!' : 'Copy as text'}</button>
      </div>
    </div>
  );
}
