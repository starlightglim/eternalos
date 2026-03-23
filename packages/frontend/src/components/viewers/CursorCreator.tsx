/**
 * CursorCreator — Standalone cursor pack creator with hotspot editor,
 * live preview, apply, and publish to Bazaar.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { uploadCursor, deleteCursor, getCursorUrl, listCursors, bazaarPublish } from '../../services/api';
import { useAppearanceStore } from '../../stores/appearanceStore';

type CursorState = 'default' | 'pointer' | 'grab' | 'grabbing' | 'text' | 'wait' | 'move' | 'nwse-resize';

const SLOTS: { state: CursorState; label: string; tokenPath: string; fallback: string }[] = [
  { state: 'default', label: 'Default', tokenPath: 'cursor.image.default', fallback: 'default' },
  { state: 'pointer', label: 'Pointer', tokenPath: 'cursor.image.pointer', fallback: 'pointer' },
  { state: 'grab', label: 'Grab', tokenPath: 'cursor.image.grab', fallback: 'grab' },
  { state: 'grabbing', label: 'Grabbing', tokenPath: 'cursor.image.grabbing', fallback: 'grabbing' },
  { state: 'text', label: 'Text', tokenPath: 'cursor.image.text', fallback: 'text' },
  { state: 'wait', label: 'Wait', tokenPath: 'cursor.image.wait', fallback: 'wait' },
  { state: 'move', label: 'Move', tokenPath: 'cursor.image.move', fallback: 'move' },
  { state: 'nwse-resize', label: 'Resize', tokenPath: 'cursor.image.nwse-resize', fallback: 'nwse-resize' },
];

interface SlotData {
  url: string | null;
  hotspotX: number;
  hotspotY: number;
  cursorId: string | null;
  file: File | null;
}

type SlotsMap = Record<CursorState, SlotData>;

const emptySlot = (): SlotData => ({ url: null, hotspotX: 0, hotspotY: 0, cursorId: null, file: null });

export function CursorCreator() {
  const { appearance, updateAppearance, saveAppearance } = useAppearanceStore();
  const [slots, setSlots] = useState<SlotsMap>(() => {
    const m: Partial<SlotsMap> = {};
    for (const s of SLOTS) m[s.state] = emptySlot();
    return m as SlotsMap;
  });
  const [selected, setSelected] = useState<CursorState>('default');
  const [uploading, setUploading] = useState<CursorState | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishName, setPublishName] = useState('');
  const [publishDesc, setPublishDesc] = useState('');
  const [publishTags, setPublishTags] = useState('');
  const [publishing, setPublishing] = useState(false);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Load existing cursors on mount
  useEffect(() => {
    const tokens = appearance?.designTokens;
    const updated = { ...slots };
    for (const s of SLOTS) {
      const val = tokens?.[s.tokenPath];
      if (typeof val === 'string' && val.trim()) {
        const parts = val.split('|');
        updated[s.state] = {
          ...updated[s.state],
          url: parts[0] || null,
          hotspotX: parseInt(parts[1], 10) || 0,
          hotspotY: parseInt(parts[2], 10) || 0,
        };
      }
    }
    // Also load cursorIds from API
    listCursors().then(assets => {
      for (const a of assets) {
        const state = a.cursorState as CursorState;
        if (updated[state]) {
          updated[state] = { ...updated[state], cursorId: a.cursorId };
        }
      }
      setSlots({ ...updated });
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flash message
  useEffect(() => {
    if (message) { const t = setTimeout(() => setMessage(null), 3000); return () => clearTimeout(t); }
  }, [message]);

  // Upload handler
  const handleUpload = useCallback(async (state: CursorState, file: File) => {
    if (file.size > 50 * 1024) { setMessage({ type: 'error', text: 'Max 50KB per cursor image' }); return; }
    setUploading(state);
    try {
      const slot = slots[state];
      const result = await uploadCursor(file, state, slot.hotspotX, slot.hotspotY);
      const url = getCursorUrl(result.asset.url);
      setSlots(prev => ({
        ...prev,
        [state]: { url, hotspotX: result.asset.hotspotX || 0, hotspotY: result.asset.hotspotY || 0, cursorId: result.asset.cursorId, file },
      }));
    } catch { setMessage({ type: 'error', text: 'Upload failed' }); }
    setUploading(null);
  }, [slots]);

  // Remove handler
  const handleRemove = useCallback(async (state: CursorState) => {
    const slot = slots[state];
    if (slot.cursorId) { try { await deleteCursor(slot.cursorId); } catch {} }
    setSlots(prev => ({ ...prev, [state]: emptySlot() }));
  }, [slots]);

  // Hotspot click
  const handleHotspotClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * 32);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * 32);
    setSlots(prev => ({
      ...prev,
      [selected]: { ...prev[selected], hotspotX: Math.max(0, Math.min(31, x)), hotspotY: Math.max(0, Math.min(31, y)) },
    }));
  }, [selected]);

  // Apply to desktop
  const handleApply = useCallback(() => {
    // Build a merged designTokens blob with all cursor values at once
    const dt = { ...(appearance.designTokens || {}) };
    for (const s of SLOTS) {
      const slot = slots[s.state];
      if (slot.url) {
        dt[s.tokenPath] = `${slot.url}|${slot.hotspotX}|${slot.hotspotY}`;
      } else {
        delete dt[s.tokenPath];
      }
    }
    updateAppearance({ designTokens: Object.keys(dt).length > 0 ? dt : undefined });
    saveAppearance();
    setMessage({ type: 'success', text: 'Cursors applied!' });
  }, [slots, appearance, updateAppearance, saveAppearance]);

  // Publish to Bazaar
  const handlePublish = useCallback(async () => {
    if (!publishName.trim()) { setMessage({ type: 'error', text: 'Name required' }); return; }
    const filledSlots = SLOTS.filter(s => slots[s.state].url);
    if (filledSlots.length === 0) { setMessage({ type: 'error', text: 'Upload at least one cursor' }); return; }

    setPublishing(true);
    try {
      // Build config
      const config: Record<string, string> = {};
      const assets: Record<string, File> = {};
      for (const s of filledSlots) {
        const slot = slots[s.state];
        // Config uses {asset:KEY} placeholder — server replaces with actual URL
        config[s.tokenPath] = `{asset:${s.state}}|${slot.hotspotX}|${slot.hotspotY}`;
        // If we have the file cached, use it; otherwise fetch from URL
        if (slot.file) {
          // Re-wrap with a safe MIME type if the original was octet-stream
          const f = slot.file;
          if (f.type && f.type !== 'application/octet-stream' && f.type !== '') {
            assets[s.state] = f;
          } else {
            assets[s.state] = new File([f], f.name || `${s.state}.png`, { type: 'image/png' });
          }
        } else if (slot.url) {
          const resp = await fetch(slot.url);
          const blob = await resp.blob();
          // Ensure a valid image MIME type (fetched blobs may come as octet-stream)
          const mimeType = blob.type && blob.type !== 'application/octet-stream' ? blob.type : 'image/png';
          const ext = mimeType.split('/')[1] || 'png';
          assets[s.state] = new File([blob], `${s.state}.${ext}`, { type: mimeType });
        }
      }

      // Use the first cursor image as preview
      const previewState = filledSlots[0].state;
      const previewFile = assets[previewState];

      const result = await bazaarPublish(
        { type: 'cursor', name: publishName.trim(), description: publishDesc.trim(), tags: publishTags.split(',').map(t => t.trim()).filter(Boolean), config },
        previewFile,
        assets,
      );

      if (result.success) {
        setMessage({ type: 'success', text: 'Published to Bazaar!' });
        setPublishOpen(false);
        setPublishName('');
        setPublishDesc('');
        setPublishTags('');
      } else {
        setMessage({ type: 'error', text: result.error || 'Publish failed' });
      }
    } catch { setMessage({ type: 'error', text: 'Publish failed' }); }
    setPublishing(false);
  }, [publishName, publishDesc, publishTags, slots]);

  const sel = slots[selected];
  const selInfo = SLOTS.find(s => s.state === selected)!;

  // Build inline cursor style for preview elements
  const cursorStyle = (state: CursorState, fallback: string): React.CSSProperties => {
    const s = slots[state];
    if (!s.url) return { cursor: fallback };
    return { cursor: `url('${s.url}') ${s.hotspotX} ${s.hotspotY}, ${fallback}` };
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 10, fontSize: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Message */}
      {message && <div style={{ padding: '4px 8px', background: message.type === 'success' ? '#c8f7c5' : '#f7c5c5', borderRadius: 2 }}>{message.text}</div>}

      {/* Cursor Slots Grid */}
      <div style={{ fontWeight: 'bold', fontSize: 12 }}>Cursor Slots</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        {SLOTS.map(({ state, label }) => {
          const slot = slots[state];
          const isSelected = selected === state;
          const isUpl = uploading === state;
          return (
            <div
              key={state}
              onClick={() => setSelected(state)}
              style={{
                border: `2px solid ${isSelected ? 'var(--selection, #000)' : 'var(--dark-gray, #888)'}`,
                background: isSelected ? 'rgba(0,0,0,0.05)' : 'var(--white, #fff)',
                padding: 4, textAlign: 'center', cursor: 'pointer', position: 'relative',
              }}
            >
              {/* Preview */}
              <div style={{
                width: '100%', height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: '#f5f5f5', imageRendering: 'pixelated', marginBottom: 4,
              }}>
                {slot.url ? (
                  <img src={slot.url} alt={label} style={{ maxWidth: 32, maxHeight: 32, imageRendering: 'pixelated' }} />
                ) : (
                  <span style={{ color: '#bbb', fontSize: 18 }}>--</span>
                )}
              </div>
              <div style={{ fontSize: 10, fontWeight: isSelected ? 'bold' : 'normal' }}>{label}</div>
              {/* Upload trigger */}
              <button
                onClick={(e) => { e.stopPropagation(); fileRefs.current[state]?.click(); }}
                disabled={isUpl}
                style={{ ...btnStyle, width: '100%', marginTop: 3, fontSize: 9 }}
              >
                {isUpl ? '...' : slot.url ? 'Replace' : 'Upload'}
              </button>
              <input
                ref={el => { fileRefs.current[state] = el; }}
                type="file" accept="image/png,image/gif,image/webp,image/svg+xml,.cur,.ani"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(state, f); e.target.value = ''; }}
              />
              {/* Remove */}
              {slot.url && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleRemove(state); }}
                  style={{ position: 'absolute', top: 2, right: 2, background: 'none', border: 'none', cursor: 'pointer', fontSize: 10, color: '#999', lineHeight: 1 }}
                  title="Remove"
                >x</button>
              )}
            </div>
          );
        })}
      </div>

      {/* Hotspot Editor */}
      {sel.url && (
        <>
          <div style={{ fontWeight: 'bold', fontSize: 12 }}>Hotspot Editor — {selInfo.label}</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <div
              onClick={handleHotspotClick}
              style={{
                width: 128, height: 128, border: '1px solid var(--dark-gray, #888)',
                background: `url('${sel.url}') no-repeat center/contain #e8e8e8`,
                imageRendering: 'pixelated', position: 'relative', cursor: 'crosshair', flexShrink: 0,
              }}
            >
              {/* Hotspot crosshair */}
              <div style={{
                position: 'absolute',
                left: `${(sel.hotspotX / 32) * 100}%`,
                top: `${(sel.hotspotY / 32) * 100}%`,
                width: 10, height: 10, marginLeft: -5, marginTop: -5,
                border: '2px solid red', borderRadius: '50%',
                pointerEvents: 'none',
              }} />
              <div style={{
                position: 'absolute',
                left: `${(sel.hotspotX / 32) * 100}%`, top: 0, bottom: 0,
                width: 1, background: 'rgba(255,0,0,0.3)', pointerEvents: 'none',
              }} />
              <div style={{
                position: 'absolute',
                top: `${(sel.hotspotY / 32) * 100}%`, left: 0, right: 0,
                height: 1, background: 'rgba(255,0,0,0.3)', pointerEvents: 'none',
              }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 10, color: '#666' }}>Click the image to set the cursor hotspot.</div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                X: <input type="number" min={0} max={31} value={sel.hotspotX}
                  onChange={e => setSlots(prev => ({ ...prev, [selected]: { ...prev[selected], hotspotX: Math.max(0, Math.min(31, parseInt(e.target.value, 10) || 0)) } }))}
                  style={{ width: 40, fontSize: 11 }} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                Y: <input type="number" min={0} max={31} value={sel.hotspotY}
                  onChange={e => setSlots(prev => ({ ...prev, [selected]: { ...prev[selected], hotspotY: Math.max(0, Math.min(31, parseInt(e.target.value, 10) || 0)) } }))}
                  style={{ width: 40, fontSize: 11 }} />
              </label>
            </div>
          </div>
        </>
      )}

      {/* Live Preview */}
      <div style={{ fontWeight: 'bold', fontSize: 12 }}>Live Preview</div>
      <div style={{
        border: '1px solid var(--dark-gray, #888)', padding: 12, background: '#f0f0f0',
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        ...cursorStyle('default', 'default'),
      }}>
        <span style={{ color: '#666', fontSize: 10 }}>Hover each element:</span>
        <a href="#" onClick={e => e.preventDefault()} style={{ ...cursorStyle('pointer', 'pointer'), color: 'blue', textDecoration: 'underline' }}>Link</a>
        <button style={{ ...btnStyle, ...cursorStyle('pointer', 'pointer') }}>Button</button>
        <input type="text" placeholder="Text input" style={{ ...cursorStyle('text', 'text'), width: 80, fontSize: 11, padding: '2px 4px' }} />
        <div style={{
          ...cursorStyle('grab', 'grab'), padding: '4px 8px',
          border: '1px dashed #888', background: '#e0e0e0', fontSize: 10, userSelect: 'none',
        }}>Drag me</div>
        <div style={{
          ...cursorStyle('move', 'move'), padding: '4px 8px',
          border: '1px dashed #888', background: '#d8d8ff', fontSize: 10, userSelect: 'none',
        }}>Move</div>
        <div style={{
          ...cursorStyle('nwse-resize', 'nwse-resize'), padding: '4px 8px',
          border: '1px dashed #888', background: '#d8ffd8', fontSize: 10, userSelect: 'none',
        }}>Resize</div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={handleApply} style={{ ...btnStyle, fontWeight: 'bold', padding: '4px 16px' }}>
          Apply to Desktop
        </button>
        <button onClick={() => setPublishOpen(!publishOpen)} style={{ ...btnStyle, padding: '4px 16px' }}>
          Publish to Bazaar
        </button>
      </div>

      {/* Publish form */}
      {publishOpen && (
        <div style={{ border: '1px solid var(--dark-gray, #888)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontWeight: 'bold' }}>Publish Cursor Pack</div>
          <label>Name: <input value={publishName} onChange={e => setPublishName(e.target.value)} maxLength={80} style={{ width: '100%', marginTop: 2, fontSize: 11 }} /></label>
          <label>Description: <input value={publishDesc} onChange={e => setPublishDesc(e.target.value)} maxLength={500} style={{ width: '100%', marginTop: 2, fontSize: 11 }} /></label>
          <label>Tags: <input value={publishTags} onChange={e => setPublishTags(e.target.value)} placeholder="retro, pixel" style={{ width: '100%', marginTop: 2, fontSize: 11 }} /></label>
          <button onClick={handlePublish} disabled={publishing} style={{ ...btnStyle, fontWeight: 'bold', alignSelf: 'flex-start', padding: '4px 16px' }}>
            {publishing ? 'Publishing...' : 'Publish'}
          </button>
        </div>
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '2px 8px', fontSize: 11, cursor: 'pointer',
  border: '1px solid var(--dark-gray, #888)',
  background: 'var(--white, #fff)', fontFamily: 'inherit',
};
