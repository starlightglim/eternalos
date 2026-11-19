/**
 * EsthemePreviewBanner — the "Trying <theme>" Keep / Revert banner.
 *
 * Mounted once by the Desktop (outside the `.user-desktop` subtree, via the
 * same document.body portal pattern the CSS element picker uses), so neither
 * token-compiled rules nor imported custom CSS can restyle or hide it — the
 * escape hatch must survive whatever the previewed theme does to the page.
 *
 * Closing the banner without choosing (the ×, or Escape) is Revert.
 */

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useEsthemePreviewStore } from '../../estheme/themePreviewStore';
import styles from './EsthemePreviewBanner.module.css';

const LAYER_LABELS: Record<string, string> = {
  tokens: 'colors & window style',
  css: 'custom CSS',
  variants: 'window chrome',
  typography: 'fonts',
  cursors: 'cursors',
  sounds: 'sounds',
  wallpaper: 'wallpaper',
};

function layerList(appliedLayers: string[]): string {
  return appliedLayers.map((layer) => LAYER_LABELS[layer] ?? layer).join(', ');
}

export function EsthemePreviewBanner() {
  const status = useEsthemePreviewStore((state) => state.status);
  const info = useEsthemePreviewStore((state) => state.info);
  const error = useEsthemePreviewStore((state) => state.error);
  const keep = useEsthemePreviewStore((state) => state.keep);
  const revert = useEsthemePreviewStore((state) => state.revert);
  const dismiss = useEsthemePreviewStore((state) => state.dismiss);
  const clearError = useEsthemePreviewStore((state) => state.clearError);

  const visible = status !== 'idle' || error !== null;

  // Escape = close = Revert while previewing (dismiss handles the error-only
  // case). Registered while the banner is mounted, matching the repo's other
  // overlay surfaces.
  useEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [visible, dismiss]);

  if (!visible || typeof document === 'undefined') return null;

  const keeping = status === 'keeping';
  const importing = status === 'importing';

  const body = (
    <div className={styles.banner} role="status" aria-live="polite">
      {importing && <span className={styles.title}>Reading theme…</span>}

      {!importing && info && (
        <>
          <div className={styles.header}>
            <span className={styles.title}>
              Trying “{info.name}” v{info.version} by {info.author}
            </span>
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Close preview and revert"
              onClick={dismiss}
              disabled={keeping}
            >
              ×
            </button>
          </div>
          <div className={styles.details}>
            Changes your {layerList(info.appliedLayers)} — nothing is saved yet.
            {info.forkedFrom && (
              <span className={styles.lineage}>
                {' '}
                Forked from {info.forkedFrom.author}&rsquo;s {info.forkedFrom.name ?? info.forkedFrom.id}
                {info.forkedFrom.version ? ` (v${info.forkedFrom.version})` : ''}.
              </span>
            )}
          </div>
          {info.warnings.length > 0 && (
            <ul className={styles.warnings}>
              {info.warnings.slice(0, 4).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {info.warnings.length > 4 && <li>…and {info.warnings.length - 4} more</li>}
            </ul>
          )}
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void keep()}
              disabled={keeping}
            >
              {keeping ? 'Saving…' : 'Keep'}
            </button>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void revert()}
              disabled={keeping}
            >
              Revert
            </button>
          </div>
        </>
      )}

      {!info && !importing && error && (
        <>
          <div className={styles.header}>
            <span className={styles.title}>Theme not applied</span>
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Dismiss"
              onClick={clearError}
            >
              ×
            </button>
          </div>
          <div className={styles.error}>{error}</div>
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={clearError}>
              OK
            </button>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(body, document.body);
}

export default EsthemePreviewBanner;
