/**
 * BazaarWindow — Community marketplace for cursors, icons, sounds, effects, and skins.
 *
 * Users browse packs by category, preview them, and one-click install.
 * "Publish Your Own" opens a simple form to upload and share packs.
 */

import { useState, useEffect, useCallback } from 'react';
import { bazaarBrowse, bazaarInstall, bazaarPublish, bazaarMyPacks, bazaarDelete, type BazaarPack, getApiUrl } from '../../services/api';
import { useAppearanceStore } from '../../stores/appearanceStore';
import { useAuthStore } from '../../stores/authStore';

type PackType = 'cursor' | 'icon' | 'sound' | 'effect' | 'skin';
type View = 'browse' | 'publish' | 'my-packs';

const TABS: { id: PackType | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'cursor', label: 'Cursors' },
  { id: 'icon', label: 'Icons' },
  { id: 'sound', label: 'Sounds' },
  { id: 'effect', label: 'Effects' },
  { id: 'skin', label: 'Skins' },
];

export function BazaarWindow() {
  const [view, setView] = useState<View>('browse');
  const [activeType, setActiveType] = useState<PackType | 'all'>('all');
  const [packs, setPacks] = useState<BazaarPack[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const { user } = useAuthStore();

  const loadPacks = useCallback(async () => {
    setLoading(true);
    try {
      const result = await bazaarBrowse({
        type: activeType === 'all' ? undefined : activeType,
        q: searchQuery || undefined,
        page,
      });
      setPacks(result.packs || []);
      setTotal(result.total || 0);
    } catch {
      setPacks([]);
    }
    setLoading(false);
  }, [activeType, searchQuery, page]);

  useEffect(() => { loadPacks(); }, [loadPacks]);

  const handleInstall = useCallback(async (packId: string) => {
    if (!user) {
      setMessage({ type: 'error', text: 'Sign in to install packs' });
      return;
    }
    setInstalling(packId);
    try {
      const result = await bazaarInstall(packId);
      if (result.success && result.config) {
        // Merge config into appearance
        const store = useAppearanceStore.getState();
        const currentTokens = store.appearance.designTokens || {};
        const newTokens = { ...currentTokens };
        const profileUpdates: Record<string, unknown> = {};

        const legacyFields = [
          'accentColor', 'desktopColor', 'windowBgColor', 'titleBarBgColor',
          'titleBarTextColor', 'windowBorderColor', 'buttonBgColor', 'buttonTextColor',
          'buttonBorderColor', 'labelColor', 'systemFont', 'bodyFont', 'monoFont',
          'windowBorderRadius', 'controlBorderRadius', 'windowShadow', 'windowOpacity',
        ];
        for (const [key, value] of Object.entries(result.config)) {
          if (legacyFields.includes(key)) {
            profileUpdates[key] = value;
          } else {
            newTokens[key] = value as string | number | boolean;
          }
        }

        store.updateAppearance({ ...profileUpdates, designTokens: newTokens } as any);
        store.saveAppearance();
        setMessage({ type: 'success', text: `Installed "${result.pack?.name || 'pack'}"!` });
        // Refresh pack list to show updated install count
        loadPacks();
      } else {
        setMessage({ type: 'error', text: (result as any).error || 'Install failed' });
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
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--dark-gray, #555)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button onClick={() => setView('browse')} style={view === 'browse' ? activeBtn : btn}>Browse</button>
        {user && <button onClick={() => setView('my-packs')} style={view === 'my-packs' ? activeBtn : btn}>My Packs</button>}
        {user && <button onClick={() => setView('publish')} style={view === 'publish' ? activeBtn : btn}>+ Publish</button>}
        <div style={{ flex: 1 }} />
        {view === 'browse' && (
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setPage(1); }}
            style={{ padding: '2px 6px', fontSize: 11, width: 140, border: '1px solid var(--dark-gray, #555)' }}
          />
        )}
      </div>

      {/* Message banner */}
      {message && (
        <div style={{
          padding: '4px 12px', fontSize: 11,
          background: message.type === 'success' ? '#c8f7c5' : '#f7c5c5',
          borderBottom: '1px solid var(--dark-gray, #555)',
        }}>
          {message.text}
        </div>
      )}

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {view === 'browse' && <BrowseView
          packs={packs} loading={loading} activeType={activeType}
          setActiveType={t => { setActiveType(t); setPage(1); }}
          onInstall={handleInstall} installing={installing}
          page={page} setPage={setPage} total={total}
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

function BrowseView({ packs, loading, activeType, setActiveType, onInstall, installing, page, setPage, total }: {
  packs: BazaarPack[]; loading: boolean; activeType: PackType | 'all';
  setActiveType: (t: PackType | 'all') => void;
  onInstall: (id: string) => void; installing: string | null;
  page: number; setPage: (p: number) => void; total: number;
}) {
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      {/* Type tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 8, flexWrap: 'wrap' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveType(tab.id)}
            style={activeType === tab.id ? activeBtn : btn}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Grid */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: 20, fontSize: 11, color: '#666' }}>Loading...</div>
      ) : packs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 20, fontSize: 11, color: '#666' }}>
          No packs found. Be the first to publish!
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
          {packs.map(pack => (
            <PackCard key={pack.packId} pack={pack} onInstall={onInstall} installing={installing === pack.packId} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 8, fontSize: 11 }}>
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} style={btn}>Prev</button>
          <span style={{ padding: '2px 8px' }}>Page {page} of {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} style={btn}>Next</button>
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
  return (
    <div style={{
      border: '1px solid var(--dark-gray, #888)',
      background: 'var(--white, #fff)',
      padding: 6,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
      fontSize: 11,
    }}>
      <img
        src={previewSrc}
        alt={pack.name}
        style={{ width: '100%', height: 80, objectFit: 'contain', background: '#f0f0f0', imageRendering: 'pixelated' }}
        loading="lazy"
      />
      <div style={{ fontWeight: 'bold', textAlign: 'center', wordBreak: 'break-word' }}>{pack.name}</div>
      <div style={{ color: '#666', fontSize: 10 }}>@{pack.authorUsername}</div>
      <div style={{ color: '#888', fontSize: 10 }}>{pack.installs} installs</div>
      <button
        onClick={() => onInstall(pack.packId)}
        disabled={installing}
        style={{ ...btn, width: '100%', fontWeight: 'bold' }}
      >
        {installing ? 'Installing...' : 'Use'}
      </button>
    </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11 }}>
      <div style={{ fontWeight: 'bold', fontSize: 12 }}>Publish to Bazaar</div>

      <label>Type:
        <select value={type} onChange={e => setType(e.target.value as PackType)} style={{ marginLeft: 4 }}>
          <option value="cursor">Cursor Pack</option>
          <option value="icon">Icon Pack</option>
          <option value="sound">Sound Pack</option>
          <option value="effect">Effect Preset</option>
          <option value="skin">Full Skin</option>
        </select>
      </label>

      <label>Name: <input value={name} onChange={e => setName(e.target.value)} maxLength={80} style={{ width: '100%', marginTop: 2 }} /></label>
      <label>Description: <textarea value={description} onChange={e => setDescription(e.target.value)} maxLength={500} rows={2} style={{ width: '100%', marginTop: 2, resize: 'vertical' }} /></label>
      <label>Tags (comma-separated): <input value={tags} onChange={e => setTags(e.target.value)} placeholder="retro, pixel, dark" style={{ width: '100%', marginTop: 2 }} /></label>

      <label>Preview image:
        <input type="file" accept="image/*" onChange={e => setPreview(e.target.files?.[0] || null)} style={{ marginTop: 2 }} />
      </label>

      <div>
        <label>Assets:</label>
        <input type="file" accept="image/*,audio/*" multiple onChange={handleAddAsset} style={{ marginTop: 2 }} />
        {Object.keys(assets).length > 0 && (
          <div style={{ marginTop: 4, fontSize: 10, color: '#666' }}>
            {Object.entries(assets).map(([key, file]) => (
              <div key={key}>
                {key}: {file.name} ({Math.round(file.size / 1024)}KB)
                <button onClick={() => { const a = { ...assets }; delete a[key]; setAssets(a); }} style={{ marginLeft: 4, fontSize: 9, cursor: 'pointer' }}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <label>Config (JSON — token overrides applied on install):
        <textarea value={config} onChange={e => setConfig(e.target.value)} rows={4} style={{ width: '100%', marginTop: 2, fontFamily: 'monospace', fontSize: 10, resize: 'vertical' }} />
      </label>

      {error && <div style={{ color: 'red', fontSize: 10 }}>{error}</div>}

      <button onClick={handlePublish} disabled={publishing} style={{ ...btn, fontWeight: 'bold', alignSelf: 'flex-start', padding: '4px 16px' }}>
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
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    bazaarMyPacks().then(result => {
      setPacks(result.packs || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const handleDelete = async (packId: string) => {
    setDeleting(packId);
    await bazaarDelete(packId);
    setPacks(packs.filter(p => p.packId !== packId));
    setDeleting(null);
    onDeleted();
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 20, fontSize: 11 }}>Loading...</div>;
  if (packs.length === 0) return <div style={{ textAlign: 'center', padding: 20, fontSize: 11, color: '#666' }}>You haven't published any packs yet.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {packs.map(pack => (
        <div key={pack.packId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 6, border: '1px solid var(--dark-gray, #888)', fontSize: 11 }}>
          <img src={pack.previewUrl?.startsWith('/') ? getApiUrl(pack.previewUrl) : pack.previewUrl} alt={pack.name} style={{ width: 40, height: 40, objectFit: 'contain' }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 'bold' }}>{pack.name}</div>
            <div style={{ fontSize: 10, color: '#666' }}>{pack.type} &middot; {pack.installs} installs</div>
          </div>
          <button onClick={() => handleDelete(pack.packId)} disabled={deleting === pack.packId} style={{ ...btn, color: 'red', fontSize: 10 }}>
            {deleting === pack.packId ? '...' : 'Delete'}
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared button styles
// ---------------------------------------------------------------------------

const btn: React.CSSProperties = {
  padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  border: '1px solid var(--dark-gray, #888)',
  background: 'var(--white, #fff)',
  fontFamily: 'inherit',
};

const activeBtn: React.CSSProperties = {
  ...btn,
  background: 'var(--selection, #000)',
  color: 'var(--white, #fff)',
  borderColor: 'var(--selection, #000)',
};
