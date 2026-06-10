import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cartridge, CartridgeDraftSummary } from '../../types';
import {
  listCartridgeDrafts,
  getCartridgeDraft,
  saveCartridgeDraft,
  deleteCartridgeDraft,
} from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { ConsolePlayer } from './ConsolePlayer';
import { createStarterCartridge, drawSpritesheet, CONSOLE_SCREEN } from './consoleSpec';
import styles from './CartridgeEditor.module.css';

type EditorTab = 'code' | 'sprites' | 'meta';

export function CartridgeEditor() {
  const username = useAuthStore((s) => s.user?.username) ?? 'me';

  const [drafts, setDrafts] = useState<CartridgeDraftSummary[]>([]);
  const [cartId, setCartId] = useState<string | null>(null);
  const [cartridge, setCartridge] = useState<Cartridge | null>(null);
  const [tab, setTab] = useState<EditorTab>('code');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [dirty, setDirty] = useState(false);
  // 0 = never run; bumping reloads the embedded player against the saved draft
  const [runKey, setRunKey] = useState(0);
  const spriteCanvasRef = useRef<HTMLCanvasElement>(null);

  const refreshDrafts = useCallback(async () => {
    try {
      setDrafts(await listCartridgeDrafts());
    } catch {
      setStatus({ kind: 'error', text: 'Could not load drafts' });
    }
  }, []);

  useEffect(() => {
    refreshDrafts();
  }, [refreshDrafts]);

  // Keep the sprite preview canvas in sync while on the sprites tab.
  useEffect(() => {
    if (tab !== 'sprites' || !cartridge || !spriteCanvasRef.current) return;
    drawSpritesheet(spriteCanvasRef.current, cartridge.spritesheet, cartridge.palette);
  }, [tab, cartridge]);

  const updateCartridge = useCallback((updates: Partial<Cartridge>) => {
    setCartridge((prev) => (prev ? { ...prev, ...updates } : prev));
    setDirty(true);
  }, []);

  const updateMeta = useCallback((updates: Partial<Cartridge['meta']>) => {
    setCartridge((prev) => (prev ? { ...prev, meta: { ...prev.meta, ...updates } } : prev));
    setDirty(true);
  }, []);

  const handleNew = useCallback(() => {
    const id = crypto.randomUUID();
    setCartId(id);
    setCartridge(createStarterCartridge('My Game', username));
    setTab('code');
    setRunKey(0);
    setDirty(true);
    setStatus({ kind: 'ok', text: 'New cartridge — save or run to store it' });
  }, [username]);

  const handleSelect = useCallback(async (id: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const { cartridge: cart } = await getCartridgeDraft(id);
      setCartId(id);
      setCartridge(cart);
      setTab('code');
      setRunKey(0);
      setDirty(false);
    } catch {
      setStatus({ kind: 'error', text: 'Failed to load draft' });
    } finally {
      setBusy(false);
    }
  }, []);

  const persistDraft = useCallback(async (): Promise<boolean> => {
    if (!cartId || !cartridge) return false;
    setBusy(true);
    setStatus(null);
    try {
      await saveCartridgeDraft(cartId, cartridge);
      setDirty(false);
      await refreshDrafts();
      return true;
    } catch (err) {
      const details = (err as { details?: string[] })?.details;
      setStatus({
        kind: 'error',
        text: Array.isArray(details) && details.length > 0
          ? `Invalid cartridge: ${details[0]}`
          : err instanceof Error ? err.message : 'Save failed',
      });
      return false;
    } finally {
      setBusy(false);
    }
  }, [cartId, cartridge, refreshDrafts]);

  const handleSave = useCallback(async () => {
    if (await persistDraft()) {
      setStatus({ kind: 'ok', text: 'Draft saved' });
    }
  }, [persistDraft]);

  const handleRun = useCallback(async () => {
    if (await persistDraft()) {
      setStatus({ kind: 'ok', text: 'Running' });
      setRunKey(Date.now());
    }
  }, [persistDraft]);

  const handleDelete = useCallback(async () => {
    if (!cartId) return;
    if (!window.confirm('Delete this cartridge draft? This cannot be undone.')) return;
    setBusy(true);
    try {
      await deleteCartridgeDraft(cartId);
      setCartId(null);
      setCartridge(null);
      setRunKey(0);
      await refreshDrafts();
      setStatus({ kind: 'ok', text: 'Draft deleted' });
    } catch {
      setStatus({ kind: 'error', text: 'Delete failed' });
    } finally {
      setBusy(false);
    }
  }, [cartId, refreshDrafts]);

  return (
    <div className={styles.editor} data-no-drag>
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span>Carts</span>
          <button type="button" className={styles.newButton} onClick={handleNew}>+ New</button>
        </div>
        <div className={styles.draftList}>
          {drafts.map((d) => (
            <div
              key={d.cartId}
              className={`${styles.draftItem} ${d.cartId === cartId ? styles.draftItemActive : ''}`}
              onClick={() => handleSelect(d.cartId)}
            >
              <div>{d.name}</div>
              <div className={styles.draftMeta}>v{d.version}</div>
            </div>
          ))}
          {drafts.length === 0 && (
            <div className={styles.draftItem} style={{ cursor: 'default', opacity: 0.6 }}>
              No drafts yet
            </div>
          )}
        </div>
      </div>

      <div className={styles.main}>
        {!cartridge ? (
          <div className={styles.emptyState}>
            <div>Build games for the EternalOS console.</div>
            <button type="button" onClick={handleNew}>Create a cartridge</button>
          </div>
        ) : (
          <>
            <div className={styles.toolbar}>
              <button type="button" className={styles.runButton} onClick={handleRun} disabled={busy}>
                ▶ Run
              </button>
              <button type="button" onClick={handleSave} disabled={busy || !dirty}>
                Save
              </button>
              <button type="button" onClick={handleDelete} disabled={busy}>
                Delete
              </button>
              {status && (
                <span className={`${styles.statusText} ${status.kind === 'error' ? styles.statusError : styles.statusOk}`}>
                  {status.text}
                </span>
              )}
            </div>

            <div className={styles.workArea}>
              <div className={styles.editPane}>
                <div className={styles.tabs}>
                  {(['code', 'sprites', 'meta'] as EditorTab[]).map((t) => (
                    <div
                      key={t}
                      className={`${styles.tab} ${tab === t ? styles.tabActive : ''}`}
                      onClick={() => setTab(t)}
                    >
                      {t}
                    </div>
                  ))}
                </div>

                {tab === 'code' && (
                  <textarea
                    className={styles.codeArea}
                    value={cartridge.code}
                    onChange={(e) => updateCartridge({ code: e.target.value })}
                    spellCheck={false}
                  />
                )}

                {tab === 'sprites' && (
                  <div className={styles.spritesPane}>
                    <textarea
                      className={styles.codeArea}
                      value={cartridge.spritesheet}
                      onChange={(e) => updateCartridge({ spritesheet: e.target.value })}
                      spellCheck={false}
                      wrap="off"
                    />
                    <div className={styles.spritePreview}>
                      <canvas
                        ref={spriteCanvasRef}
                        className={styles.spriteCanvas}
                        width={CONSOLE_SCREEN}
                        height={CONSOLE_SCREEN}
                      />
                      <div>
                        128×128 hex grid — one palette index (0–f) per pixel.
                        Each 8×8 cell is a sprite: spr(0) top-left, spr(1) next, …
                        0 is transparent.
                      </div>
                    </div>
                  </div>
                )}

                {tab === 'meta' && (
                  <div className={styles.metaPane}>
                    <label className={styles.metaField}>
                      Name
                      <input
                        value={cartridge.meta.name}
                        maxLength={80}
                        onChange={(e) => updateMeta({ name: e.target.value })}
                      />
                    </label>
                    <label className={styles.metaField}>
                      Description
                      <textarea
                        rows={3}
                        value={cartridge.meta.description ?? ''}
                        maxLength={500}
                        onChange={(e) => updateMeta({ description: e.target.value })}
                      />
                    </label>
                    <label className={styles.metaField}>
                      Version
                      <input
                        value={cartridge.meta.version}
                        maxLength={32}
                        onChange={(e) => updateMeta({ version: e.target.value })}
                      />
                    </label>
                  </div>
                )}
              </div>

              <div className={styles.previewPane}>
                <div className={styles.previewHeader}>
                  <span>Preview</span>
                  {dirty && runKey > 0 && <span>unsaved changes</span>}
                </div>
                {runKey > 0 && cartId ? (
                  <div className={styles.previewBody}>
                    <ConsolePlayer gameId={`draft:${cartId}`} reloadKey={runKey} />
                  </div>
                ) : (
                  <div className={styles.previewEmpty}>
                    Press ▶ Run to play your cartridge here
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
