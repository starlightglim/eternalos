/**
 * App skins on the desktop side: the .eskin file format (zip: skin.json +
 * images), skin templates to paint, and turning a painted sheet back into a
 * skin. The worker (utils/appSkin.ts) is the authority on what a valid skin
 * is; everything here is re-checked there.
 *
 * .eskin layout:
 *   skin.json   { format: "eternal-skin/1", name, colors, fonts, parts,
 *                 assets: { sheet: "sheet.png", wood: "textures/wood.jpg" } }
 *   sheet.png, textures/…  (PNG, JPEG, GIF or WebP)
 *   README.txt  (templates: how to paint)
 */

import JSZip from 'jszip';
import type { SkinPartDescription } from '../services/appSkins';

export const SKIN_FORMAT = 'eternal-skin/1';
export const SKIN_STATE_ORDER = ['normal', 'hover', 'pressed', 'active', 'disabled'] as const;

export interface SkinStyle {
  background?: string;
  gradient?: { from: string; to: string; angle: number };
  texture?: { asset: string; size?: number };
  border?: { width: number; color: string; style: string };
  radius?: number;
  bevel?: 'raised' | 'sunken' | 'flat';
  text?: string;
  font?: string;
  weight?: 'normal' | 'bold';
  shadow?: 'none' | 'soft' | 'hard';
}

export interface SkinSprite {
  asset: string;
  x: number;
  y: number;
  w: number;
  h: number;
  states?: string[];
  frames?: number;
  slice?: number;
  pixelated?: boolean;
}

export interface SkinWindow {
  frameless: boolean;
  shape?:
    | { type: 'rounded'; radius: number }
    | { type: 'ellipse' }
    | { type: 'polygon'; points: Array<[number, number]> }
    | { type: 'mask'; asset: string; x?: number; y?: number; w?: number; h?: number };
  size?: { w: number; h: number };
  drag?: string[];
  close?: string;
  minimize?: string;
}

export interface AppSkin {
  format: typeof SKIN_FORMAT;
  name: string;
  author?: string;
  description?: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  parts: Record<string, { sprite?: SkinSprite; style?: SkinStyle; states?: Record<string, SkinStyle> }>;
  assets: Record<string, { type: string; width: number; height: number; data: string } | string>;
  window?: SkinWindow;
}

const MAX_ESKIN_BYTES = 9 * 1024 * 1024;
const IMAGE_EXT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TYPE_EXTS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export class SkinFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkinFileError';
  }
}

function assetData(value: AppSkin['assets'][string]): string {
  return typeof value === 'string' ? value : value.data;
}

// ---------------------------------------------------------------------------
// .eskin files
// ---------------------------------------------------------------------------

/** Read a .eskin (zip) or a bare skin .json into a skin document (images as data URLs). */
export async function readSkinFile(file: Blob & { name?: string }): Promise<AppSkin> {
  if (file.size > MAX_ESKIN_BYTES) throw new SkinFileError('That skin file is larger than 9MB.');
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) {
    try {
      return JSON.parse(await file.text()) as AppSkin;
    } catch {
      throw new SkinFileError('That file is not a .eskin skin.');
    }
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    throw new SkinFileError('That .eskin file could not be opened (not a valid zip).');
  }
  // skin.json at the root, or inside one top folder (zipped from a folder).
  const manifest = zip.file('skin.json') ?? zip.file(/(^|\/)skin\.json$/)[0];
  if (!manifest) throw new SkinFileError('That .eskin file has no skin.json.');
  const root = manifest.name.slice(0, manifest.name.length - 'skin.json'.length);
  let skin: AppSkin;
  try {
    skin = JSON.parse(await manifest.async('string')) as AppSkin;
  } catch {
    throw new SkinFileError('skin.json is not valid JSON.');
  }
  const assets: AppSkin['assets'] = {};
  let total = 0;
  for (const [key, value] of Object.entries(skin.assets ?? {})) {
    if (typeof value === 'string' && value.startsWith('data:')) {
      assets[key] = value;
      continue;
    }
    const path = typeof value === 'string' ? value : '';
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const type = IMAGE_EXT_TYPES[ext];
    const entry = type && !path.includes('..') ? zip.file(root + path) : null;
    if (!entry) throw new SkinFileError(`skin.json refers to "${path || key}", which is not an image in the file.`);
    const base64 = await entry.async('base64');
    total += base64.length;
    if (total > MAX_ESKIN_BYTES * 1.4) throw new SkinFileError('The skin\'s images are too large.');
    assets[key] = `data:${type};base64,${base64}`;
  }
  return { ...skin, assets };
}

/** Pack a skin as a .eskin zip. */
export async function writeSkinFile(skin: AppSkin, extras: Record<string, string> = {}): Promise<Blob> {
  const zip = new JSZip();
  const assets: Record<string, string> = {};
  for (const [key, value] of Object.entries(skin.assets ?? {})) {
    const data = assetData(value);
    const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/.exec(data);
    if (!match) continue;
    const ext = TYPE_EXTS[match[1]] ?? 'png';
    const path = key === 'sheet' ? `sheet.${ext}` : `images/${key}.${ext}`;
    zip.file(path, match[2], { base64: true });
    assets[key] = path;
  }
  const manifest = { ...skin, format: SKIN_FORMAT, assets };
  zip.file('skin.json', JSON.stringify(manifest, null, 2));
  for (const [path, text] of Object.entries(extras)) zip.file(path, text);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip', compression: 'DEFLATE' });
}

export function safeFileName(name: string): string {
  return (name.replace(/[^\w .-]+/g, '').trim() || 'skin').slice(0, 60);
}

/** Save a Blob as a download in the user's browser. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface TemplateEntry {
  part: string;
  label: string;
  /** Top-left of the first cell. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Cell captions, left to right (states or frame numbers). */
  cells: string[];
  kind: 'states' | 'frames' | 'window';
  slice?: number;
}

export interface TemplateLayout {
  width: number;
  height: number;
  entries: TemplateEntry[];
}

const PAD = 10;
const LABEL_H = 14;

/** Universal parts that make sense as painted sprites. */
const UNIVERSAL_SPRITES: Record<string, Omit<SkinPartDescription, 'name'> & { slice?: number }> = {
  app: { w: 64, h: 64, states: ['normal'], label: 'App background (tiles)' },
  button: { w: 48, h: 24, states: ['normal', 'hover', 'pressed', 'disabled'], label: 'Buttons (9-slice)', slice: 6 },
  field: { w: 48, h: 24, states: ['normal'], label: 'Text fields (9-slice)', slice: 5 },
};

/**
 * Deterministic sheet layout: each part gets a row of cells (one per state
 * or frame) with its caption above; rows pack left to right.
 */
export function layoutSkinTemplate(
  parts: SkinPartDescription[],
  universal: string[] = [],
  options: { window?: { w: number; h: number } } = {},
): TemplateLayout {
  const items: Array<Omit<TemplateEntry, 'x' | 'y'>> = [];
  if (options.window) {
    // Window shape: its alpha cuts the window (transparent = cut away).
    const w = Math.max(200, Math.min(1200, Math.round(options.window.w)));
    const h = Math.max(150, Math.min(900, Math.round(options.window.h)));
    items.push({ part: 'window', label: 'Window shape: paint transparent where the window is cut away', w, h, cells: ['shape'], kind: 'window' });
  }
  for (const name of universal) {
    const spec = UNIVERSAL_SPRITES[name];
    if (spec) items.push({ part: name, label: spec.label, w: spec.w, h: spec.h, cells: spec.states, kind: 'states', ...(spec.slice ? { slice: spec.slice } : {}) });
  }
  for (const part of parts.slice(0, 80)) {
    const w = Math.max(4, Math.min(512, Math.round(part.w)));
    const h = Math.max(4, Math.min(512, Math.round(part.h)));
    const frames = part.frames && part.frames >= 2 ? Math.min(64, part.frames) : 0;
    const cells = frames ? Array.from({ length: frames }, (_, i) => String(i)) : (part.states.length ? part.states : ['normal']);
    items.push({ part: part.name, label: part.label || part.name, w, h, cells, kind: frames ? 'frames' : 'states' });
  }
  const width = Math.min(4096, Math.max(512, ...items.map((item) => item.w * item.cells.length + PAD * 2)));
  const entries: TemplateEntry[] = [];
  let x = PAD;
  let y = PAD;
  let rowHeight = 0;
  for (const item of items) {
    const blockW = item.w * item.cells.length;
    if (x + blockW + PAD > width && x > PAD) {
      x = PAD;
      y += rowHeight + PAD;
      rowHeight = 0;
    }
    entries.push({ ...item, x, y: y + LABEL_H });
    x += blockW + PAD * 2;
    rowHeight = Math.max(rowHeight, item.h + LABEL_H);
  }
  return { width, height: Math.min(4096, y + rowHeight + PAD), entries };
}

const CELL_FILLS: Record<string, [string, string]> = {
  normal: ['#e4e4e4', '#c4c4c4'],
  hover: ['#f2f2f2', '#d4d4d4'],
  pressed: ['#a8a8a8', '#c8c8c8'],
  active: ['#c9d8f0', '#9fb6dd'],
  disabled: ['#d8d8d8', '#d0d0d0'],
};

/** Paint the template sheet: captions above, plain placeholder art in every cell. */
export function drawSkinTemplate(layout: TemplateLayout): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new SkinFileError('This browser cannot draw the template.');
  ctx.fillStyle = '#20232a';
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.textBaseline = 'middle';
  for (const entry of layout.entries) {
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#9fb0c8';
    ctx.textAlign = 'left';
    ctx.fillText(`${entry.label}  [${entry.part}]`.slice(0, 60), entry.x, entry.y - LABEL_H / 2, entry.w * entry.cells.length + PAD);
    entry.cells.forEach((cell, i) => {
      const cx = entry.x + i * entry.w;
      if (entry.kind === 'window') {
        // Only this cell's transparency matters (it becomes the window mask).
        ctx.fillStyle = '#d9e2ef';
        ctx.fillRect(cx, entry.y, entry.w, entry.h);
        ctx.strokeStyle = '#7d8ba3';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(cx + 0.5, entry.y + 0.5, entry.w - 1, entry.h - 1);
        ctx.setLineDash([]);
        ctx.fillStyle = '#4a5568';
        ctx.textAlign = 'center';
        ctx.font = '12px sans-serif';
        ctx.fillText('Erase to transparent where the window should be cut away.', cx + entry.w / 2, entry.y + entry.h / 2 - 8, entry.w - 20);
        ctx.fillText('Colors here are ignored: only the shape counts.', cx + entry.w / 2, entry.y + entry.h / 2 + 10, entry.w - 20);
        return;
      }
      if (entry.part === 'app') {
        // A quiet checker tile for the background.
        for (let ty = 0; ty < entry.h; ty += 8) {
          for (let tx = 0; tx < entry.w; tx += 8) {
            ctx.fillStyle = ((tx + ty) / 8) % 2 === 0 ? '#f0f0f0' : '#e2e2e2';
            ctx.fillRect(cx + tx, entry.y + ty, 8, 8);
          }
        }
        return;
      }
      const [top, bottom] = CELL_FILLS[entry.kind === 'frames' ? 'normal' : cell] ?? CELL_FILLS.normal;
      const gradient = ctx.createLinearGradient(0, entry.y, 0, entry.y + entry.h);
      gradient.addColorStop(0, top);
      gradient.addColorStop(1, bottom);
      ctx.fillStyle = gradient;
      ctx.fillRect(cx, entry.y, entry.w, entry.h);
      // Bevel so the placeholder reads as a control.
      ctx.fillStyle = cell === 'pressed' ? '#7a7a7a' : '#ffffff';
      ctx.fillRect(cx, entry.y, entry.w, 1);
      ctx.fillRect(cx, entry.y, 1, entry.h);
      ctx.fillStyle = cell === 'pressed' ? '#ffffff' : '#7a7a7a';
      ctx.fillRect(cx, entry.y + entry.h - 1, entry.w, 1);
      ctx.fillRect(cx + entry.w - 1, entry.y, 1, entry.h);
      if (entry.h >= 10 && entry.w >= 10) {
        ctx.fillStyle = cell === 'disabled' ? '#9a9a9a' : '#333333';
        ctx.textAlign = 'center';
        ctx.font = `${Math.max(7, Math.min(11, entry.h - 6))}px sans-serif`;
        const caption = entry.kind === 'frames' ? cell : entry.part === 'button' || entry.part === 'field' ? cell : entry.cells.length > 1 ? cell : entry.label;
        ctx.fillText(caption.slice(0, 14), cx + entry.w / 2, entry.y + entry.h / 2, entry.w - 2);
      }
    });
  }
  return canvas;
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

/** A skin whose parts are sprites cut from `sheetDataUrl` at the template layout. */
export function skinFromTemplate(name: string, layout: TemplateLayout, sheetDataUrl: string): AppSkin {
  const parts: AppSkin['parts'] = {};
  let window: SkinWindow | undefined;
  for (const entry of layout.entries) {
    if (entry.kind === 'window') {
      window = {
        frameless: true,
        shape: { type: 'mask', asset: 'sheet', x: entry.x, y: entry.y, w: entry.w, h: entry.h },
        size: { w: entry.w, h: entry.h },
        drag: ['app'],
      };
      continue;
    }
    const sprite: SkinSprite = { asset: 'sheet', x: entry.x, y: entry.y, w: entry.w, h: entry.h };
    if (entry.kind === 'frames') sprite.frames = entry.cells.length;
    else if (entry.cells.length > 1 || entry.cells[0] !== 'normal') sprite.states = entry.cells;
    if (entry.slice) sprite.slice = entry.slice;
    parts[entry.part] = { sprite };
  }
  return {
    format: SKIN_FORMAT,
    name,
    colors: {},
    fonts: {},
    parts,
    assets: { sheet: sheetDataUrl },
    ...(window ? { window } : {}),
  };
}

export const TEMPLATE_README = `EternalOS app skin template
===========================

1. Open sheet.png in any image editor (Aseprite, Photoshop, GIMP, Paint...).
2. Paint over the boxes. Keep every box exactly where it is and the same size:
   EternalOS cuts the skin out of these exact rectangles.
   - Each row is one part of the app. The caption above it says which.
   - Boxes left to right are the part's states (normal, hover, pressed,
     disabled) or frames (0, 1, 2...).
   - "9-slice" parts stretch to any size: keep the corners and edges crisp,
     the middle stretches.
   - The app background tile repeats.
   - The big "Window shape" box (if present) cuts the window itself: erase
     to transparent wherever the window should be cut away (round corners,
     a circle, a guitar...). Its colors don't matter, only transparency.
     Drag the window by any empty area; the small tab above it closes it.
   - Transparent pixels stay see-through.
3. Save sheet.png (same name, same size), zip skin.json + sheet.png together,
   rename the zip to MySkin.eskin and drop it on the app's window.
   Or: in the app's Skins panel choose your template skin and use
   "Replace sheet image..." with your painted PNG.

skin.json also takes colors (#hex), fonts and styles; see the EternalOS docs.
`;

/** Read an image file as a data URL plus its size. */
export async function readImageFile(file: Blob): Promise<{ dataUrl: string; width: number; height: number }> {
  if (file.size > 2 * 1024 * 1024) throw new SkinFileError('Images in a skin must be 2MB or smaller.');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new SkinFileError('That image could not be read.'));
    reader.readAsDataURL(file);
  });
  const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new SkinFileError('That file is not an image.'));
    image.src = dataUrl;
  });
  return { dataUrl, ...size };
}

/** Swap a sprite skin's sheet for a painted one of the same size. */
export function replaceSheet(skin: AppSkin, sheet: { dataUrl: string; width: number; height: number }): AppSkin {
  const current = skin.assets.sheet;
  if (!current) throw new SkinFileError('This skin has no sheet to replace.');
  if (typeof current !== 'string' && (current.width !== sheet.width || current.height !== sheet.height)) {
    throw new SkinFileError(`The painted image must be ${current.width}×${current.height} pixels, the same size as the template (it is ${sheet.width}×${sheet.height}).`);
  }
  return { ...skin, assets: { ...skin.assets, sheet: sheet.dataUrl } };
}

// ---------------------------------------------------------------------------
// Shaped windows
// ---------------------------------------------------------------------------

const num = (value: unknown, min: number, max: number): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
};

/** CSS clip-path for a (checked) skin window shape, or null. Numbers only. */
export function skinClipPath(shape: SkinWindow['shape']): string | null {
  if (!shape) return null;
  if (shape.type === 'rounded') {
    const radius = num(shape.radius, 0, 400);
    return radius === null ? null : `inset(0 round ${radius}px)`;
  }
  if (shape.type === 'ellipse') return 'ellipse(50% 50% at 50% 50%)';
  if (shape.type === 'polygon') {
    const points = (shape.points ?? []).slice(0, 64).map(([x, y]) => [num(x, 0, 100), num(y, 0, 100)]);
    if (points.length < 3 || points.some(([x, y]) => x === null || y === null)) return null;
    return `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(', ')})`;
  }
  return null;
}

/** Cut a region of a PNG data URL into its own PNG data URL (for mask shapes). */
async function cropDataUrl(dataUrl: string, region?: { x?: number; y?: number; w?: number; h?: number }): Promise<string | null> {
  if (!/^data:image\/(png|gif|webp);base64,/.test(dataUrl)) return null;
  if (!region || region.x === undefined || region.y === undefined || !region.w || !region.h) return dataUrl;
  const image = await new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
  if (!image) return null;
  const canvas = document.createElement('canvas');
  canvas.width = region.w;
  canvas.height = region.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  return canvas.toDataURL('image/png');
}

/** The desktop-side window chrome a skin asks for, or null for a normal window. */
export async function skinWindowChrome(skin: AppSkin | null): Promise<import('../stores/windowSkinStore').WindowSkinChrome | null> {
  const win = skin?.window;
  if (!win || (!win.frameless && !win.shape && !win.size)) return null;
  const chrome: import('../stores/windowSkinStore').WindowSkinChrome = { frameless: win.frameless === true };
  const clipPath = skinClipPath(win.shape);
  if (clipPath) chrome.clipPath = clipPath;
  if (win.shape?.type === 'mask') {
    const asset = skin?.assets?.[win.shape.asset];
    const data = asset ? (typeof asset === 'string' ? asset : asset.data) : null;
    const maskUrl = data ? await cropDataUrl(data, win.shape) : null;
    if (maskUrl) chrome.maskUrl = maskUrl;
  }
  if (win.size) {
    const w = num(win.size.w, 200, 1600);
    const h = num(win.size.h, 150, 1200);
    if (w && h) chrome.size = { w: Math.round(w), h: Math.round(h) };
  }
  return chrome;
}
