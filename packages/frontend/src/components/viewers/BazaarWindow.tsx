/**
 * BazaarWindow — Community marketplace for cursors, icons, sounds, effects, and skins.
 *
 * Users browse packs by category, preview them, and one-click install.
 * "Publish Your Own" opens a simple form to upload and share packs.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { bazaarBrowse, bazaarInstall, bazaarPublish, bazaarMyPacks, bazaarDelete, createItem, type BazaarPack, getApiUrl } from '../../services/api';
import { useAppearanceStore } from '../../stores/appearanceStore';
import type { CustomAppearance } from '../../stores/appearanceStore';
import { useAuthStore } from '../../stores/authStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { AlertDialog } from '../ui/AlertDialog';
import { errorText, isAbortError, SEARCH_DEBOUNCE_MS } from './bazaarRequests';
import styles from './BazaarWindow.module.css';

type PackType = 'cursor' | 'icon' | 'sound' | 'effect' | 'skin' | 'game';
type View = 'browse' | 'publish' | 'my-packs';

const TABS: { id: PackType | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'game', label: 'Games' },
  { id: 'cursor', label: 'Cursors' },
  { id: 'icon', label: 'Icons' },
  { id: 'sound', label: 'Sounds' },
  { id: 'effect', label: 'Effects' },
  { id: 'skin', label: 'Skins' },
];

/** Open a console-player window for a published game. */
function openGameWindow(pack: BazaarPack) {
  useWindowStore.getState().openWindow({
    id: `console-player-${pack.packId}`,
    title: pack.name,
    position: { x: 140 + Math.random() * 60, y: 60 + Math.random() * 40 },
    size: { width: 420, height: 460 },
    minimized: false,
    maximized: false,
    contentType: 'console-player',
    contentId: pack.packId,
  });
}

export function BazaarWindow() {
  const [view, setView] = useState<View>('browse');
  const [activeType, setActiveType] = useState<PackType | 'all'>('all');
  const [packs, setPacks] = useState<BazaarPack[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [loadError, setLoadError] = useState<string | null>(null);
  const browseRequest = useRef<AbortController | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const { user } = useAuthStore();

  // Only the newest browse request may update state: each call aborts the
  // previous one, so a slow earlier response can't overwrite newer results.
  const loadPacks = useCallback(async () => {
    browseRequest.current?.abort();
    const controller = new AbortController();
    browseRequest.current = controller;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await bazaarBrowse({
        type: activeType === 'all' ? undefined : activeType,
        q: searchQuery || undefined,
        page,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setPacks(result.packs);
      setTotal(result.total);
      setPageSize(result.pageSize);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setPacks([]);
      setTotal(0);
      setLoadError(errorText(err, 'Could not load packs'));
    }
    if (browseRequest.current === controller) {
      browseRequest.current = null;
      setLoading(false);
    }
  }, [activeType, searchQuery, page]);

  useEffect(() => {
    const request = window.setTimeout(() => { void loadPacks(); }, 0);
    return () => window.clearTimeout(request);
  }, [loadPacks]);

  // Cancel any in-flight browse when the window closes.
  useEffect(() => () => browseRequest.current?.abort(), []);

  // Debounce typing: the query (and page reset) follows the input after a pause.
  useEffect(() => {
    const next = searchInput.trim();
    if (next === searchQuery) return;
    const timer = window.setTimeout(() => {
      setSearchQuery(next);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchQuery]);

  const handleInstall = useCallback(async (packId: string) => {
    if (!user) {
      setMessage({ type: 'error', text: 'Sign in to install packs' });
      return;
    }
    setInstalling(packId);
    try {
      const result = await bazaarInstall(packId);
      if (result.success && result.pack?.type === 'game') {
        // Games install as a cartridge item on the desktop, not as theme config.
        const item = await createItem({
          type: 'cartridge',
          name: result.pack.name,
          parentId: null,
          position: { x: 80 + Math.random() * 240, y: 80 + Math.random() * 160 },
          cartridgeRef: { packId: result.pack.packId, coverUrl: result.pack.previewUrl },
        });
        useDesktopStore.getState().addItem(item);
        setMessage({ type: 'success', text: `"${result.pack.name}" added to your desktop!` });
        loadPacks();
      } else if (result.success && result.config) {
        // Merge config into appearance
        const store = useAppearanceStore.getState();
        const currentTokens = store.appearance.designTokens || {};
        const newTokens = { ...currentTokens };
        const profileUpdates: Partial<CustomAppearance> = {};

        const legacyFields = new Set<keyof CustomAppearance>([
          'accentColor', 'desktopColor', 'windowBgColor', 'titleBarBgColor',
          'titleBarTextColor', 'windowBorderColor', 'buttonBgColor', 'buttonTextColor',
          'buttonBorderColor', 'labelColor', 'systemFont', 'bodyFont', 'monoFont',
          'windowBorderRadius', 'controlBorderRadius', 'windowShadow', 'windowOpacity',
        ]);
        for (const [key, value] of Object.entries(result.config)) {
          if (legacyFields.has(key as keyof CustomAppearance)) {
            profileUpdates[key as keyof CustomAppearance] = value as never;
          } else {
            newTokens[key] = value as string | number | boolean;
          }
        }

        store.updateAppearance({ ...profileUpdates, designTokens: newTokens });
        await store.saveAppearance();
        setMessage({ type: 'success', text: `Installed "${result.pack?.name || 'pack'}"!` });
        // Refresh pack list to show updated install count
        loadPacks();
      } else {
        setMessage({ type: 'error', text: result.error || 'Install failed' });
      }
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Install failed' });
    }
    setInstalling(null);
  }, [user, loadPacks]);

  // Clear message after 3s
  useEffect(() => {
    if (message) {
      const t = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(t);
    }
  }, [message]);

  return (
    <div className={styles.shell}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.nav}>
          <button className={`${styles.navButton} ${view === 'browse' ? styles.navButtonActive : ''}`} onClick={() => setView('browse')}>Browse</button>
          {user && <button className={`${styles.navButton} ${view === 'my-packs' ? styles.navButtonActive : ''}`} onClick={() => setView('my-packs')}>My Packs</button>}
          {user && <button className={`${styles.navButton} ${view === 'publish' ? styles.navButtonActive : ''}`} onClick={() => setView('publish')}>+ Publish</button>}
        </div>
        {view === 'browse' && (
          <input
            className={styles.search}
            type="text"
            placeholder="Search..."
            aria-label="Search packs"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
          />
        )}
      </div>

      {/* Message banner */}
      {message && (
        <div className={`${styles.message} ${message.type === 'success' ? styles.successMessage : styles.errorMessage}`}>
          {message.text}
        </div>
      )}

      {/* Content */}
      <div className={styles.content}>
        {view === 'browse' && <BrowseView
          packs={packs} loading={loading} activeType={activeType}
          setActiveType={t => { setActiveType(t); setPage(1); }}
          onInstall={handleInstall} installing={installing}
          page={page} setPage={setPage} total={total} pageSize={pageSize}
          error={loadError} onRetry={() => { void loadPacks(); }}
        />}
        {view === 'publish' && <PublishView onPublished={() => { setView('browse'); loadPacks(); }} />}
        {view === 'my-packs' && <MyPacksView onDeleted={loadPacks} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browse view
// ---------------------------------------------------------------------------

function BrowseView({ packs, loading, activeType, setActiveType, onInstall, installing, page, setPage, total, pageSize, error, onRetry }: {
  packs: BazaarPack[]; loading: boolean; activeType: PackType | 'all';
  setActiveType: (t: PackType | 'all') => void;
  onInstall: (id: string) => void; installing: string | null;
  page: number; setPage: (p: number) => void; total: number; pageSize: number;
  error: string | null; onRetry: () => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      {/* Type tabs */}
      <div className={styles.filterBar}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveType(tab.id)}
            className={`${styles.filterButton} ${activeType === tab.id ? styles.filterButtonActive : ''}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div className={styles.loading}>Loading packs...</div>
      ) : error ? (
        <div className={styles.emptyState} role="alert">
          <strong>Couldn't load the Bazaar</strong>
          <span>{error}</span>
          <button className={styles.navButton} onClick={onRetry}>Try Again</button>
        </div>
      ) : packs.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>✦</div>
          <strong>No packs found</strong>
          <span>Be the first to share a customizable pack with the community.</span>
        </div>
      ) : (
        <div className={styles.packGrid}>
          {packs.map(pack => (
            <PackCard key={pack.packId} pack={pack} onInstall={onInstall} installing={installing === pack.packId} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && !error && (
        <div className={styles.pagination}>
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} className={styles.navButton}>Prev</button>
          <span className={styles.paginationLabel}>Page {page} of {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} className={styles.navButton}>Next</button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pack card
// ---------------------------------------------------------------------------

function PackCard({ pack, onInstall, installing }: { pack: BazaarPack; onInstall: (id: string) => void; installing: boolean }) {
  const previewSrc = pack.previewUrl?.startsWith('/') ? getApiUrl(pack.previewUrl) : pack.previewUrl;
  const isGame = pack.type === 'game';
  return (
    <article className={styles.packCard}>
      <img
        src={previewSrc}
        alt={pack.name}
        className={`${styles.packPreview} ${isGame ? styles.gamePreview : ''}`}
        loading="lazy"
      />
      <div className={styles.packName}>{pack.name}</div>
      <div className={styles.packAuthor}>@{pack.authorUsername}</div>
      <div className={styles.packMeta}>{pack.installs} installs</div>
      {isGame ? (
        <div className={styles.packActions}>
          <button
            onClick={() => openGameWindow(pack)}
            className={`${styles.actionButton} ${styles.primaryAction}`}
          >
            ▶ Play
          </button>
          <button
            onClick={() => onInstall(pack.packId)}
            disabled={installing}
            className={styles.actionButton}
          >
            {installing ? '...' : 'Install'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => onInstall(pack.packId)}
          disabled={installing}
          className={`${styles.actionButton} ${styles.primaryAction}`}
        >
          {installing ? 'Installing...' : 'Use'}
        </button>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Publish view
// ---------------------------------------------------------------------------

function PublishView({ onPublished }: { onPublished: () => void }) {
  const [type, setType] = useState<PackType>('cursor');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [preview, setPreview] = useState<File | null>(null);
  const [assets, setAssets] = useState<Record<string, File>>({});
  const [config, setConfig] = useState('{}');
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddAsset = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const newAssets = { ...assets };
    for (const file of Array.from(files)) {
      const key = file.name.replace(/\.[^.]+$/, '').replace(/\s+/g, '-').toLowerCase();
      newAssets[key] = file;
    }
    setAssets(newAssets);
    e.target.value = '';
  };

  const handlePublish = async () => {
    if (!name.trim()) { setError('Name required'); return; }
    if (!preview) { setError('Preview image required'); return; }

    let configObj: Record<string, string | number | boolean>;
    try {
      configObj = JSON.parse(config);
    } catch {
      setError('Invalid config JSON');
      return;
    }

    setPublishing(true);
    setError(null);
    const result = await bazaarPublish(
      { type, name: name.trim(), description: description.trim(), tags: tags.split(',').map(t => t.trim()).filter(Boolean), config: configObj },
      preview,
      assets,
    );
    setPublishing(false);
    if (result.success) {
      onPublished();
    } else {
      setError(result.error || 'Publish failed');
    }
  };

  return (
    <div className={styles.publishForm}>
      <div className={styles.formTitle}>Publish to Bazaar</div>

      <label className={styles.formLabel}>Type
        <select className={styles.formControl} value={type} onChange={e => setType(e.target.value as PackType)}>
          <option value="cursor">Cursor Pack</option>
          <option value="icon">Icon Pack</option>
          <option value="sound">Sound Pack</option>
          <option value="effect">Effect Preset</option>
          <option value="skin">Full Skin</option>
        </select>
      </label>

      <label className={styles.formLabel}>Name <input className={styles.formControl} value={name} onChange={e => setName(e.target.value)} maxLength={80} /></label>
      <label className={styles.formLabel}>Description <textarea className={styles.formControl} value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={2} /></label>
      <label className={styles.formLabel}>Tags (comma-separated) <input className={styles.formControl} value={tags} onChange={e => setTags(e.target.value)} placeholder="retro, pixel, dark" /></label>

      <label className={styles.formLabel}>Preview image
        <input className={styles.fileInput} type="file" accept="image/*" onChange={e => setPreview(e.target.files?.[0] || null)} />
      </label>

      <div>
        <label className={styles.formLabel}>Assets</label>
        <input className={styles.fileInput} type="file" accept="image/*,audio/*" multiple onChange={handleAddAsset} />
        {Object.keys(assets).length > 0 && (
          <div className={styles.fileList}>
            {Object.entries(assets).map(([key, file]) => (
              <div className={styles.fileItem} key={key}>
                {key}: {file.name} ({Math.round(file.size / 1024)}KB)
                <button className={styles.removeButton} onClick={() => { const a = { ...assets }; delete a[key]; setAssets(a); }}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <label className={styles.formLabel}>Config (JSON — token overrides applied on install)
        <textarea className={`${styles.formControl} ${styles.codeControl}`} value={config} onChange={e => setConfig(e.target.value)} rows={4} />
      </label>

      {error && <div className={styles.formError}>{error}</div>}

      <button onClick={handlePublish} disabled={publishing} className={`${styles.actionButton} ${styles.primaryAction} ${styles.publishButton}`}>
        {publishing ? 'Publishing...' : 'Publish to Bazaar'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Packs view
// ---------------------------------------------------------------------------

function MyPacksView({ onDeleted }: { onDeleted: () => void }) {
  const [packs, setPacks] = useState<BazaarPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BazaarPack | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    bazaarMyPacks().then(result => {
      if (!mounted.current) return;
      setPacks(result.packs);
      setLoading(false);
    }).catch((err: unknown) => {
      if (!mounted.current) return;
      setLoadError(errorText(err, 'Could not load your packs'));
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    const request = window.setTimeout(load, 0);
    return () => window.clearTimeout(request);
  }, [load]);

  const handleDelete = async (pack: BazaarPack) => {
    setConfirming(null);
    setDeleting(pack.packId);
    setDeleteError(null);
    const result = await bazaarDelete(pack.packId);
    if (!mounted.current) return;
    setDeleting(null);
    if (!result.success) {
      setDeleteError(`Couldn't delete "${pack.name}": ${result.error || 'Delete failed'}`);
      return;
    }
    setPacks(prev => prev.filter(p => p.packId !== pack.packId));
    onDeleted();
  };

  if (loading) return <div className={styles.loading}>Loading your packs...</div>;
  if (loadError) {
    return (
      <div className={styles.emptyState} role="alert">
        <strong>Couldn't load your packs</strong>
        <span>{loadError}</span>
        <button className={styles.navButton} onClick={load}>Try Again</button>
      </div>
    );
  }
  if (packs.length === 0) return <div className={styles.emptyState}><div className={styles.emptyIcon}>✦</div><strong>No published packs yet</strong><span>Your shared customizations will appear here.</span></div>;

  return (
    <div className={styles.myPacks}>
      {deleteError && <div className={`${styles.message} ${styles.formError}`} role="alert">{deleteError}</div>}
      {packs.map(pack => (
        <div className={styles.myPack} key={pack.packId}>
          <img className={styles.myPackPreview} src={pack.previewUrl?.startsWith('/') ? getApiUrl(pack.previewUrl) : pack.previewUrl} alt={pack.name} />
          <div className={styles.myPackInfo}>
            <div className={styles.packName}>{pack.name}</div>
            <div className={styles.packMeta}>{pack.type} &middot; {pack.installs} installs</div>
          </div>
          <button onClick={() => setConfirming(pack)} disabled={deleting !== null} className={`${styles.actionButton} ${styles.deleteButton}`}>
            {deleting === pack.packId ? '...' : 'Delete'}
          </button>
        </div>
      ))}
      {confirming && (
        <AlertDialog
          type="warning"
          title="Delete this pack?"
          message={`"${confirming.name}" will be removed from the Bazaar for everyone. This can't be undone.`}
          onClose={() => setConfirming(null)}
          buttons={[
            { label: 'Cancel', onClick: () => setConfirming(null), primary: true },
            { label: 'Delete', onClick: () => void handleDelete(confirming) },
          ]}
        />
      )}
    </div>
  );
}
