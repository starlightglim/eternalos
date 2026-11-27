/**
 * Skins panel for an app window (overlay inside AppViewer): switch skins,
 * make one with AI, paint one from a template, import/export .eskin files,
 * and tweak a skin's colors.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteAppSkin,
  generateAppSkin,
  getAppSkin,
  installAppSkin,
  listAppSkins,
  replaceAppSkin,
  setActiveAppSkin,
  type AppSkinIndex,
  type SkinPartDescription,
} from '../../services/appSkins';
import { useAlertStore } from '../../stores/alertStore';
import {
  TEMPLATE_README,
  canvasToDataUrl,
  downloadBlob,
  drawSkinTemplate,
  layoutSkinTemplate,
  readImageFile,
  readSkinFile,
  replaceSheet,
  safeFileName,
  skinFromTemplate,
  writeSkinFile,
  type AppSkin,
} from '../../utils/appSkins';
import { SkinArrangeEditor } from './SkinArrangeEditor';
import styles from './AppSkinsPanel.module.css';

export interface DescribedParts {
  title: string;
  parts: SkinPartDescription[];
  universal: string[];
  viewport?: { w: number; h: number };
}

interface AppSkinsPanelProps {
  appId: string;
  appName: string;
  /** Ask the running app which parts it has (sizes, states, frames). */
  describeParts: () => Promise<DescribedParts | null>;
  /** The active skin changed or was edited: restyle the app. */
  onChanged: () => void;
  onClose: () => void;
}

const COLOR_NAMES = ['bg', 'surface', 'text', 'text-muted', 'accent', 'accent-text', 'border', 'control-bg', 'control-text', 'chrome', 'title-bar', 'title-text', 'highlight', 'shadow', 'selection', 'selection-text'];

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return 'Something went wrong.';
}

function toHexColor(value: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : /^#[0-9a-f]{3}$/i.test(value) ? `#${value.slice(1).split('').map((c) => c + c).join('')}` : null;
}

export function AppSkinsPanel({ appId, appName, describeParts, onChanged, onClose }: AppSkinsPanelProps) {
  const [index, setIndex] = useState<AppSkinIndex | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [shapedTemplate, setShapedTemplate] = useState(false);
  const [arranging, setArranging] = useState<DescribedParts | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSkin, setSelectedSkin] = useState<AppSkin | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listAppSkins(appId);
      setIndex(next);
      setSelected((current) => current ?? next.active);
    } catch (error) {
      setStatus({ text: errorText(error), error: true });
    }
  }, [appId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    setSelectedSkin(null);
    if (!selected) return;
    getAppSkin(appId, selected)
      .then((result) => { if (!cancelled) setSelectedSkin(result.skin); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [appId, selected, index]);

  const run = useCallback(async (label: string, work: () => Promise<string | void>) => {
    setBusy(label);
    setStatus(null);
    try {
      const message = await work();
      if (message) setStatus({ text: message });
    } catch (error) {
      setStatus({ text: errorText(error), error: true });
    } finally {
      setBusy(null);
    }
  }, []);

  const activate = (skinId: string | null) => run('switch', async () => {
    await setActiveAppSkin(appId, skinId);
    setSelected(skinId);
    await refresh();
    onChanged();
  });

  const generate = () => run('generate', async () => {
    const described = await describeParts();
    const result = await generateAppSkin(appId, prompt.trim(), described?.parts);
    setSelected(result.skinId);
    setPrompt('');
    await refresh();
    onChanged();
    return `Made "${result.entry.name}"${result.textures ? ` with ${result.textures} generated texture${result.textures === 1 ? '' : 's'}` : ''}.`;
  });

  const template = async (): Promise<{ skin: AppSkin; sheet: string }> => {
    const described = await describeParts();
    if (!described) throw new Error('The app did not answer. Wait for it to finish loading and try again.');
    const layout = layoutSkinTemplate(described.parts, described.universal, shapedTemplate && described.viewport ? { window: described.viewport } : {});
    const sheet = canvasToDataUrl(drawSkinTemplate(layout));
    return { skin: skinFromTemplate(`${appName} template`, layout, sheet), sheet };
  };

  const startFromTemplate = () => run('template', async () => {
    const { skin, sheet } = await template();
    const result = await installAppSkin(appId, { ...skin, name: `${appName} (painted)` });
    downloadBlob(await (await fetch(sheet)).blob(), `${safeFileName(appName)} skin sheet.png`);
    setSelected(result.skinId);
    await refresh();
    onChanged();
    return 'Installed a paintable skin and downloaded its sheet. Paint the PNG (keep every box in place), then use "Replace sheet image…".';
  });

  const downloadTemplate = () => run('download', async () => {
    const { skin } = await template();
    downloadBlob(await writeSkinFile(skin, { 'README.txt': TEMPLATE_README }), `${safeFileName(appName)} template.eskin`);
    return 'Downloaded the template. Paint sheet.png inside it, zip it back up and drop the .eskin on this window.';
  });

  const importFile = (file: File) => run('import', async () => {
    const skin = await readSkinFile(file);
    const result = await installAppSkin(appId, skin);
    setSelected(result.skinId);
    await refresh();
    onChanged();
    return `Installed "${result.entry.name}".`;
  });

  const replaceSheetImage = (file: File) => run('sheet', async () => {
    if (!selected || !selectedSkin) throw new Error('Choose a painted skin first.');
    const updated = replaceSheet(selectedSkin, await readImageFile(file));
    await replaceAppSkin(appId, selected, updated);
    await refresh();
    if (index?.active === selected) onChanged();
    return 'Sheet replaced.';
  });

  const exportSkin = (skinId: string) => run('export', async () => {
    const { skin } = await getAppSkin(appId, skinId);
    downloadBlob(await writeSkinFile(skin), `${safeFileName(skin.name)}.eskin`);
  });

  // The delete confirm is async: read the active skin and selection as they
  // are when the user presses OK, not when they clicked Delete.
  const latestRef = useRef({ index, selected });
  useEffect(() => { latestRef.current = { index, selected }; });

  const removeSkin = (skinId: string, name: string) => {
    useAlertStore.getState().showConfirm(`Delete the skin "${name}"? This can't be undone.`, () => {
      void run('delete', async () => {
        const wasActive = latestRef.current.index?.active === skinId;
        await deleteAppSkin(appId, skinId);
        setSelected((current) => (current === skinId ? null : current));
        await refresh();
        if (wasActive) onChanged();
      });
    }, undefined, 'Delete skin');
  };

  const setColor = (name: string, value: string | null) => {
    if (!selected || !selectedSkin) return;
    const colors = { ...selectedSkin.colors };
    if (value === null) delete colors[name];
    else colors[name] = value;
    const updated = { ...selectedSkin, colors };
    setSelectedSkin(updated);
    void run('colors', async () => {
      await replaceAppSkin(appId, selected, updated);
      if (index?.active === selected) onChanged();
    });
  };

  const openArrange = () => run('arrange', async () => {
    const described = await describeParts();
    setArranging(described ?? { title: appName, parts: [], universal: [] });
  });

  const saveArrange = (updated: AppSkin) => {
    if (!selected) return;
    setArranging(null);
    setSelectedSkin(updated);
    void run('arrange-save', async () => {
      await replaceAppSkin(appId, selected, updated);
      await refresh();
      if (index?.active === selected) onChanged();
      return 'Layout saved.';
    });
  };

  const selectedEntry = index?.skins.find((entry) => entry.id === selected);
  const unusedColors = COLOR_NAMES.filter((name) => !(selectedSkin?.colors && name in selectedSkin.colors));

  return (
    <div className={styles.backdrop} data-no-drag onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={styles.panel} role="dialog" aria-label={`Skins for ${appName}`}>
        <header className={styles.header}>
          <strong>Skins</strong>
          <span className={styles.subtle}>{appName}</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close skins">×</button>
        </header>

        <section className={styles.section}>
          <ul className={styles.list} role="radiogroup" aria-label="Installed skins">
            <li>
              <label className={styles.row}>
                <input type="radio" name={`skin-${appId}`} checked={index?.active === null} onChange={() => void activate(null)} disabled={!index || Boolean(busy)} />
                <span className={styles.rowName}>Original look</span>
              </label>
            </li>
            {index?.skins.map((entry) => (
              <li key={entry.id} className={selected === entry.id ? styles.selectedRow : undefined}>
                <label className={styles.row} onClick={() => setSelected(entry.id)}>
                  <input type="radio" name={`skin-${appId}`} checked={index.active === entry.id} onChange={() => void activate(entry.id)} disabled={Boolean(busy)} />
                  <span className={styles.rowName}>{entry.name}</span>
                  <span className={styles.badge}>{entry.source === 'assistant' ? 'AI' : entry.summary.sprites ? 'painted' : 'imported'}</span>
                  {entry.summary.shaped ? <span className={styles.badge}>shaped</span> : null}
                </label>
                <span className={styles.rowActions}>
                  <button type="button" onClick={() => void exportSkin(entry.id)} disabled={Boolean(busy)}>Export</button>
                  <button type="button" onClick={() => removeSkin(entry.id, entry.name)} disabled={Boolean(busy)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
          {index && index.skins.length === 0 && <p className={styles.hint}>No skins yet. Make one below, or drop a .eskin file on this window.</p>}
        </section>

        <section className={styles.section}>
          <h3>Make one with AI</h3>
          <form className={styles.generate} onSubmit={(event) => { event.preventDefault(); if (prompt.trim().length >= 3) void generate(); }}>
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="brushed metal with green LCD text"
              maxLength={300}
              aria-label="Describe the look"
              disabled={Boolean(busy)}
            />
            <button type="submit" disabled={Boolean(busy) || prompt.trim().length < 3}>{busy === 'generate' ? 'Designing…' : 'Make skin'}</button>
          </form>
          {busy === 'generate' && <p className={styles.hint}>Designing the skin and painting textures. This can take up to a minute.</p>}
        </section>

        <section className={styles.section}>
          <h3>Paint your own</h3>
          <div className={styles.buttons}>
            <button type="button" onClick={() => void startFromTemplate()} disabled={Boolean(busy)}>Start from template</button>
            <button type="button" onClick={() => sheetRef.current?.click()} disabled={Boolean(busy) || !selectedSkin?.assets?.sheet}>Replace sheet image…</button>
            <button type="button" onClick={() => void downloadTemplate()} disabled={Boolean(busy)}>Download template (.eskin)</button>
            <button type="button" onClick={() => importRef.current?.click()} disabled={Boolean(busy)}>Import .eskin…</button>
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={shapedTemplate} onChange={(event) => setShapedTemplate(event.target.checked)} disabled={Boolean(busy)} />
            Shaped window: the template gets a layer that cuts the window into any shape (no title bar)
          </label>
          <input ref={importRef} type="file" accept=".eskin,.json,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
          <input ref={sheetRef} type="file" accept="image/png,image/gif,image/webp,image/jpeg" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void replaceSheetImage(file); }} />
        </section>

        {selectedEntry && selectedSkin && (
          <section className={styles.section}>
            <h3>Layout of “{selectedEntry.name}”</h3>
            <p className={styles.hint}>Place the app's controls where the skin's art wants them, and choose where its content goes.</p>
            <div className={styles.buttons}>
              <button type="button" onClick={() => void openArrange()} disabled={Boolean(busy)}>Arrange…</button>
            </div>
          </section>
        )}

        {selectedEntry && selectedSkin && (
          <section className={styles.section}>
            <h3>Colors in “{selectedEntry.name}”</h3>
            <div className={styles.colors}>
              {Object.entries(selectedSkin.colors ?? {}).map(([name, value]) => {
                const hex = toHexColor(value);
                return (
                  <label key={name} className={styles.color} title={value}>
                    {hex
                      ? <input type="color" value={hex} onChange={(event) => setColor(name, event.target.value)} disabled={Boolean(busy)} />
                      : <span className={styles.swatch} style={{ background: value }} />}
                    <span>{name}</span>
                    <button type="button" onClick={() => setColor(name, null)} aria-label={`Remove ${name}`} disabled={Boolean(busy)}>×</button>
                  </label>
                );
              })}
              {unusedColors.length > 0 && (
                <select
                  value=""
                  onChange={(event) => { if (event.target.value) setColor(event.target.value, '#888888'); }}
                  aria-label="Add a color"
                  disabled={Boolean(busy)}
                >
                  <option value="">+ Add color…</option>
                  {unusedColors.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              )}
            </div>
          </section>
        )}

        {status && <p className={status.error ? styles.error : styles.status} role="status">{status.text}</p>}
      </div>
      {arranging && selectedSkin && (
        <SkinArrangeEditor
          skin={selectedSkin}
          parts={arranging.parts}
          viewport={arranging.viewport}
          onSave={saveArrange}
          onCancel={() => setArranging(null)}
        />
      )}
    </div>
  );
}
