/**
 * Conky-style text drawn on the wallpaper (Appearance → Bar & Widgets):
 * a template with {placeholders} that update live. Never takes clicks.
 */

import { useAppearanceStore } from '../../stores/appearanceStore';
import { useRiceInfo } from '../../hooks/useRiceInfo';
import { barFromTokens, conkyFromTokens, fillTemplate, riceValues } from '../../utils/riceInfo';
import styles from './ConkyLayer.module.css';

export function ConkyLayer() {
  const tokens = useAppearanceStore((state) => state.appearance.designTokens);
  const conky = conkyFromTokens(tokens);
  const clockFormat = barFromTokens(tokens).clockFormat;
  const facts = useRiceInfo({ tickSeconds: conky.enabled && /\{(time|uptime)\}/.test(conky.text), clockFormat });
  if (!conky.enabled || !conky.text.trim()) return null;
  return (
    <div className={`${styles.conky} ${styles[conky.position.replace('-', '_')] ?? ''}`} style={{ fontSize: conky.size }} aria-hidden="true" eos-part="conky">
      {fillTemplate(conky.text, riceValues(facts))}
    </div>
  );
}
