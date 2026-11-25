/**
 * Appearance → From Wallpaper ("pywal mode"): pull a palette out of the
 * wallpaper and apply it to the whole desktop (windows, title bars,
 * controls, menu bar, scrollbars, icon labels). Apps follow through the
 * --eternal-* theme variables. Colors only: fonts, variants, effects and
 * custom CSS are kept.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useAuthStore } from '../../stores/authStore';
import { getWallpaperUrl, uploadWallpaper } from '../../services/api';
import {
  buildRiceScheme,
  extractPalette,
  paletteFromImageUrl,
  type PaletteColor,
  type RiceFlavor,
  type RiceMode,
} from '../../utils/wallpaperPalette';
import styles from './WallpaperRice.module.css';

async function paletteFromFile(file: File): Promise<PaletteColor[]> {
  const url = URL.createObjectURL(file);
  try {
    return await paletteFromImageUrl(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Colors of a CSS-pattern wallpaper: sample the desktop element's own paint. */
function paletteFromDesktopPattern(): PaletteColor[] {
  const desktop = document.querySelector('.user-desktop');
  if (!desktop) return [];
  const style = getComputedStyle(desktop);
  const colors = `${style.backgroundColor} ${style.backgroundImage}`.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b/gi) ?? [];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  const data: number[] = [];
  for (const color of colors.slice(0, 16)) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    for (let i = 0; i < 50; i++) data.push(r, g, b, a);
  }
  return extractPalette(data, 6);
}

export function WallpaperRice() {
  const wallpaper = useAuthStore((state) => state.profile?.wallpaper ?? 'default');
  const setWallpaper = useAuthStore((state) => state.setWallpaper);
  const updateAppearance = useAppearanceStore((state) => state.updateAppearance);
  const [palette, setPalette] = useState<PaletteColor[] | null>(null);
  const [mode, setMode] = useState<RiceMode>('auto');
  const [flavor, setFlavor] = useState<RiceFlavor>('soft');
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isImage = wallpaper.startsWith('custom:');

  const readCurrent = useCallback(async () => {
    setBusy(true);
    setStatus(null);
    try {
      // Separate URL from the desktop's CSS background: that copy was fetched
      // without CORS and may be cached that way, which would taint the canvas.
      const colors = isImage ? await paletteFromImageUrl(`${getWallpaperUrl(wallpaper)}?palette=1`) : paletteFromDesktopPattern();
      setPalette(colors);
      if (!colors.length) setStatus({ text: 'No colors found in this wallpaper. Choose an image instead.', error: true });
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : 'Could not read the wallpaper.', error: true });
    } finally {
      setBusy(false);
    }
  }, [isImage, wallpaper]);

  useEffect(() => { void readCurrent(); }, [readCurrent]);

  const scheme = useMemo(() => (palette?.length ? buildRiceScheme(palette, { mode, flavor }) : null), [palette, mode, flavor]);

  const apply = () => {
    if (!scheme) return;
    const current = useAppearanceStore.getState().appearance;
    // Pattern wallpapers are painted from the desktop color: keep it, or the
    // wallpaper itself would change under the palette it came from.
    const { desktopColor, ...colors } = scheme.appearance;
    updateAppearance({
      ...colors,
      ...(isImage ? { desktopColor } : {}),
      designTokens: { ...(current.designTokens ?? {}), ...(scheme.appearance.designTokens ?? {}) },
    });
    setStatus({ text: `Applied a ${scheme.mode} look from your wallpaper. Use "Apply & Save" to keep it.` });
  };

  const chooseImage = async (file: File) => {
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setStatus({ text: 'Choose a JPG or PNG image.', error: true });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setStatus({ text: 'The image must be smaller than 2MB.', error: true });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      setPalette(await paletteFromFile(file));
      const response = await uploadWallpaper(file);
      if (!(await setWallpaper(response.wallpaper))) {
        setStatus({ text: 'Colors read, but the image could not be set as your wallpaper.', error: true });
      }
    } catch (error) {
      setStatus({ text: error instanceof Error ? error.message : 'That image could not be used.', error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.intro}>
        <div className={styles.title}>From your wallpaper</div>
        <div className={styles.hint}>
          Pulls the colors out of your wallpaper and themes everything with them: windows, title bars, buttons, the
          menu bar, scrollbars and your apps. Fonts, effects and custom CSS stay as they are.
        </div>
      </div>

      <div className={styles.source}>
        {isImage ? <img className={styles.thumb} src={getWallpaperUrl(wallpaper)} alt="Current wallpaper" crossOrigin="anonymous" /> : <div className={`${styles.thumb} ${styles.thumbPattern}`}>Pattern</div>}
        <div className={styles.sourceActions}>
          <button type="button" onClick={() => void readCurrent()} disabled={busy}>Read my wallpaper again</button>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy}>Use another image…</button>
          <span className={styles.hint}>A new image also becomes your wallpaper.</span>
        </div>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseImage(file); }} />
      </div>

      {palette && palette.length > 0 && (
        <div className={styles.palette} aria-label="Wallpaper colors">
          {palette.map((color) => (
            <span key={color.hex} className={styles.swatch} style={{ background: color.hex, flexGrow: Math.max(0.4, color.weight * 10) }} title={`${color.hex} · ${Math.round(color.weight * 100)}%`} />
          ))}
        </div>
      )}

      <div className={styles.options}>
        <div className={styles.segment} role="radiogroup" aria-label="Light or dark">
          {(['auto', 'dark', 'light'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? styles.on : undefined} onClick={() => setMode(value)}>
              {value === 'auto' ? 'Auto' : value === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
        <div className={styles.segment} role="radiogroup" aria-label="Color strength">
          {(['soft', 'vivid'] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={flavor === value} className={flavor === value ? styles.on : undefined} onClick={() => setFlavor(value)}>
              {value === 'soft' ? 'Soft' : 'Vivid'}
            </button>
          ))}
        </div>
      </div>

      {scheme && (
        <div className={styles.preview} style={{ background: scheme.appearance.desktopColor }} aria-label="Preview">
          <div className={styles.previewWindow} style={{ background: scheme.swatches.background, borderColor: scheme.swatches.border }}>
            <div className={styles.previewTitle} style={{ background: scheme.swatches.chrome, color: scheme.appearance.titleBarTextColor }}>Window</div>
            <div className={styles.previewBody} style={{ color: scheme.swatches.text }}>
              <span>Text on the window.</span>
              <span style={{ color: scheme.swatches.accent, fontWeight: 600 }}>Accent</span>
              <span className={styles.previewButton} style={{ background: scheme.appearance.buttonBgColor, color: scheme.appearance.buttonTextColor, borderColor: scheme.swatches.border }}>Button</span>
              <span className={styles.previewDot} style={{ background: scheme.swatches.accent2 }} />
            </div>
          </div>
        </div>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={apply} disabled={!scheme || busy}>Apply to desktop</button>
        {busy && <span className={styles.hint}>Reading colors…</span>}
      </div>
      {status && <p className={status.error ? styles.error : styles.status} role="status">{status.text}</p>}
    </div>
  );
}
