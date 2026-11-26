/**
 * Arrange a skin's layout by hand (modern-Winamp-style skins): drag the
 * app's controls to where the art wants them and set the box the app's
 * content lives in. Shows the window at its size with the shape and face.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { skinWindowChrome, type AppSkin } from '../../utils/appSkins';
import type { WindowSkinChrome } from '../../stores/windowSkinStore';
import type { SkinPartDescription } from '../../services/appSkins';
import styles from './SkinArrangeEditor.module.css';

type Place = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

interface Props {
  skin: AppSkin;
  parts: SkinPartDescription[];
  viewport?: { w: number; h: number };
  onSave: (skin: AppSkin) => void;
  onCancel: () => void;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round = (n: number) => Math.round(n * 10) / 10;

function assetData(skin: AppSkin, key: string | undefined): string | null {
  if (!key) return null;
  const asset = skin.assets?.[key];
  return asset ? (typeof asset === 'string' ? asset : asset.data) : null;
}

export function SkinArrangeEditor({ skin, parts, viewport, onSave, onCancel }: Props) {
  const win = skin.window;
  const size = win?.size ?? viewport ?? { w: 420, h: 360 };
  const [places, setPlaces] = useState<Record<string, Place>>(() =>
    Object.fromEntries(Object.entries(skin.parts ?? {}).filter(([, p]) => p.place).map(([name, p]) => [name, { x: p.place!.x, y: p.place!.y }])));
  const [content, setContent] = useState<Box | null>(win?.content ?? null);
  const [chrome, setChrome] = useState<WindowSkinChrome | null>(null);
  const [scale, setScale] = useState(1);
  const areaRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const face = assetData(skin, win?.face?.asset);

  useEffect(() => {
    let cancelled = false;
    void skinWindowChrome(skin).then((next) => { if (!cancelled) setChrome(next); });
    return () => { cancelled = true; };
  }, [skin]);

  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const fit = () => setScale(Math.min(1.4, (area.clientWidth - 24) / size.w, (area.clientHeight - 24) / size.h));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(area);
    return () => observer.disconnect();
  }, [size.w, size.h]);

  const list = useMemo(() => (parts.length
    ? parts
    : Object.keys(skin.parts ?? {}).filter((name) => !['app', 'button', 'field', 'link', 'heading', 'scrollbar'].includes(name)).map((name) => ({ name, w: 44, h: 32, states: ['normal'], label: name }))), [parts, skin.parts]);

  /** Pointer drag in stage percent coordinates. */
  const drag = (event: React.PointerEvent, onMove: (dx: number, dy: number) => void) => {
    event.preventDefault();
    event.stopPropagation();
    const stage = stageRef.current?.getBoundingClientRect();
    if (!stage) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (e: PointerEvent) => onMove(((e.clientX - startX) / stage.width) * 100, ((e.clientY - startY) / stage.height) * 100);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const startPart = (name: string, event: React.PointerEvent) => {
    const origin = places[name] ?? { x: 50, y: 50 };
    drag(event, (dx, dy) => setPlaces((current) => ({ ...current, [name]: { x: round(clamp(origin.x + dx, 0, 100)), y: round(clamp(origin.y + dy, 0, 100)) } })));
  };

  const startContent = (event: React.PointerEvent, mode: 'move' | 'resize') => {
    const origin = content ?? { x: 15, y: 15, w: 70, h: 40 };
    drag(event, (dx, dy) => setContent(mode === 'move'
      ? { ...origin, x: round(clamp(origin.x + dx, 0, 100 - origin.w)), y: round(clamp(origin.y + dy, 0, 100 - origin.h)) }
      : { ...origin, w: round(clamp(origin.w + dx, 5, 100 - origin.x)), h: round(clamp(origin.h + dy, 5, 100 - origin.y)) }));
  };

  const save = () => {
    const nextParts: AppSkin['parts'] = { ...skin.parts };
    for (const { name } of list) {
      const rest = { ...(nextParts[name] ?? {}) };
      delete rest.place;
      nextParts[name] = places[name] ? { ...rest, place: places[name] } : rest;
      if (Object.keys(nextParts[name]).length === 0) delete nextParts[name];
    }
    const nextWindow = { ...(win ?? { frameless: false }) };
    if (content) nextWindow.content = content;
    else delete nextWindow.content;
    onSave({ ...skin, parts: nextParts, window: nextWindow });
  };

  const stageStyle: React.CSSProperties = {
    width: size.w,
    height: size.h,
    transform: `scale(${scale})`,
    clipPath: chrome?.clipPath,
    ...(chrome?.maskUrl ? { maskImage: `url("${chrome.maskUrl}")`, WebkitMaskImage: `url("${chrome.maskUrl}")`, maskSize: '100% 100%', WebkitMaskSize: '100% 100%' } : {}),
  };

  return (
    <div className={styles.editor} role="dialog" aria-label="Arrange skin">
      <div className={styles.toolbar}>
        <strong>Arrange “{skin.name}”</strong>
        <span className={styles.hint}>Drag controls where the art wants them. The dashed box is where the app's own content goes.</span>
      </div>
      <div ref={areaRef} className={styles.area}>
        <div className={styles.stageWrap} style={{ width: size.w * scale, height: size.h * scale }}>
          <div ref={stageRef} className={styles.stage} style={stageStyle}>
            {face && <div className={styles.face} style={{ backgroundImage: `url("${face}")` }} />}
            {content && (
              <div
                className={styles.content}
                style={{ left: `${content.x}%`, top: `${content.y}%`, width: `${content.w}%`, height: `${content.h}%` }}
                onPointerDown={(event) => startContent(event, 'move')}
              >
                <span>App content</span>
                <span className={styles.resize} onPointerDown={(event) => startContent(event, 'resize')} aria-label="Resize content box" />
              </div>
            )}
            {list.map((part) => {
              const place = places[part.name];
              if (!place) return null;
              return (
                <div
                  key={part.name}
                  className={styles.part}
                  style={{ left: `${place.x}%`, top: `${place.y}%`, width: part.w, height: part.h }}
                  onPointerDown={(event) => startPart(part.name, event)}
                  title={`${part.label} (${place.x}%, ${place.y}%)`}
                >
                  {part.label || part.name}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className={styles.side}>
        <div className={styles.sideTitle}>Controls</div>
        {list.map((part) => (
          <label key={part.name} className={styles.row}>
            <input
              type="checkbox"
              checked={Boolean(places[part.name])}
              onChange={(event) => setPlaces((current) => {
                const next = { ...current };
                if (event.target.checked) next[part.name] = { x: 50, y: 50 };
                else delete next[part.name];
                return next;
              })}
            />
            {part.label || part.name}
          </label>
        ))}
        <label className={styles.row}>
          <input type="checkbox" checked={Boolean(content)} onChange={(event) => setContent(event.target.checked ? { x: 15, y: 15, w: 70, h: 40 } : null)} />
          Content box
        </label>
      </div>
      <div className={styles.actions}>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" onClick={() => { setPlaces({}); setContent(null); }}>Clear layout</button>
        <button type="button" className={styles.primary} onClick={save}>Save layout</button>
      </div>
    </div>
  );
}
