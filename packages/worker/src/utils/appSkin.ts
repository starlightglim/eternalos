/**
 * App skins (`.eskin`): Winamp-style skins for EternalOS apps.
 *
 * An app marks the parts of its UI that can be skinned in its own markup
 * (`data-skin="play"`, optional `data-skin-states` / `data-skin-frames` /
 * `data-skin-label`). Every app also has universal parts (app background,
 * buttons, fields, links, headings, scrollbars) so any app can be skinned.
 *
 * A skin gives each part either a sprite cut from a painted sheet (fixed
 * layout, one cell per state or frame, optional 9-slice) or a style (fill,
 * gradient, texture, border, bevel, radius, text color, font), with optional
 * per-state overrides, plus colors and fonts.
 *
 * Skins are data only: no CSS, no code, images checked by their bytes. This
 * module normalizes any skin (user import, assistant design) into a
 * canonical document; anything unknown is dropped, anything malformed is an
 * error. The app runtime re-checks values before turning them into CSS.
 */

export const SKIN_FORMAT = 'eternal-skin/1';

export const SKIN_STATES = ['normal', 'hover', 'pressed', 'active', 'disabled'] as const;
export type SkinState = (typeof SKIN_STATES)[number];

/** Parts every app has, mapped to elements by the runtime. */
export const UNIVERSAL_SKIN_PARTS = ['app', 'button', 'field', 'link', 'heading', 'scrollbar'] as const;

/** Theme color names (see frontend utils/appTheme.ts); a skin color with one of these names overrides it. */
export const THEME_COLOR_NAMES = [
  'bg', 'surface', 'chrome', 'text', 'text-muted', 'accent', 'accent-text', 'selection', 'selection-text',
  'border', 'highlight', 'shadow', 'control-bg', 'control-text', 'control-border', 'title-bar', 'title-text',
  'danger', 'success',
] as const;

export const SKIN_LIMITS = {
  nameChars: 60,
  parts: 80,
  colors: 40,
  assets: 12,
  assetBytes: 2 * 1024 * 1024,
  totalAssetBytes: 6 * 1024 * 1024,
  imageSide: 4096,
};

const PART_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const ASSET_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const COLOR_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'] as const;

export class SkinValidationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid skin: ${problems.slice(0, 6).join('; ')}`);
    this.name = 'SkinValidationError';
    this.problems = problems;
  }
}

export interface SkinStyle {
  background?: string;
  gradient?: { from: string; to: string; angle: number };
  /** blend: the runtime makes the image tile seamlessly (generated textures). */
  texture?: { asset: string; size?: number; blend?: boolean };
  border?: { width: number; color: string; style: (typeof BORDER_STYLES)[number] };
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
  /** Cells laid out left to right, one per state (default: just "normal"). */
  states?: SkinState[];
  /** Cells laid out left to right, one per frame (data-skin-frame="n"). Takes precedence over states. */
  frames?: number;
  /** 9-slice inset in sheet pixels: the part stretches to any size, corners stay crisp. */
  slice?: number;
  pixelated?: boolean;
}

export interface SkinPart {
  sprite?: SkinSprite;
  style?: SkinStyle;
  states?: Partial<Record<Exclude<SkinState, 'normal'>, SkinStyle>>;
}

export interface SkinAsset {
  type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number;
  height: number;
  /** data: URL */
  data: string;
}

/**
 * The window itself (Winamp-style shaped windows). Applied by the desktop,
 * not the app: frameless hides the title bar and frame, shape cuts the
 * window (clicks outside a polygon/ellipse/rounded shape fall through), and
 * the app's painted parts named in drag/close/minimize move and close it.
 * The desktop always keeps a small handle with the app's name and a close
 * button, so a shaped window can't hide what it is or trap the user.
 */
export interface SkinWindow {
  frameless: boolean;
  shape?:
    | { type: 'rounded'; radius: number }
    | { type: 'ellipse' }
    | { type: 'polygon'; points: Array<[number, number]> }
    | { type: 'mask'; asset: string; x?: number; y?: number; w?: number; h?: number };
  /** Window size the shape was made for (the window is set to it, not resizable). */
  size?: { w: number; h: number };
  /** Part names that drag the window ("app" = any empty area). */
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
  fonts: Partial<Record<'font' | 'font-title' | 'font-mono', string>>;
  parts: Record<string, SkinPart>;
  assets: Record<string, SkinAsset>;
  window?: SkinWindow;
}

// ---------------------------------------------------------------------------
// Value checks
// ---------------------------------------------------------------------------

const NAMED_COLOR_RE = /^[a-z]{3,20}$/;
const FUNC_COLOR_RE = /^(rgba?|hsla?)\(\s*[-\d.]+(deg|%)?\s*(,\s*|\s+)[-\d.]+%?\s*(,\s*|\s+)[-\d.]+%?\s*((,|\/)\s*[\d.]+%?\s*)?\)$/;

/** Plain CSS colors only: hex, rgb(a), hsl(a) or a color keyword. */
export function isSkinColor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  if (v.length > 60) return false;
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return true;
  if (FUNC_COLOR_RE.test(v)) return true;
  return NAMED_COLOR_RE.test(v) && !['inherit', 'initial', 'unset', 'revert', 'none', 'url', 'expression', 'var', 'env', 'attr'].includes(v);
}

/** Font names, quotes, commas, spaces, dots and dashes only. */
export function isFontStack(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && /^[\w\s,'".-]+$/.test(value);
}

function int(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Type and size from the image bytes themselves (PNG, JPEG, GIF, WebP). */
export function imageInfo(bytes: Uint8Array): { type: SkinAsset['type']; width: number; height: number } | null {
  const b = bytes;
  const u32be = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u16le = (o: number) => b[o] | (b[o + 1] << 8);
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52) {
    return { type: 'image/png', width: u32be(16), height: u32be(20) };
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { type: 'image/gif', width: u16le(6), height: u16le(8) };
  }
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') return { type: 'image/webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { type: 'image/webp', width: u24le(24) + 1, height: u24le(27) + 1 };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk JPEG segments to the first start-of-frame marker.
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const marker = b[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      const length = u16be(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'image/jpeg', width: u16be(o + 7), height: u16be(o + 5) };
      }
      if (length < 2) return null;
      o += 2 + length;
    }
  }
  return null;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Check a data: URL (or raw base64 + claimed type) and describe the image. */
export function parseSkinImage(raw: unknown): SkinAsset | { error: string } {
  if (typeof raw !== 'string') return { error: 'is not an image' };
  const match = /^data:(image\/[a-z+.-]+)?(;charset=[\w-]+)?;base64,([A-Za-z0-9+/=\s]+)$/.exec(raw.trim());
  if (!match) return { error: 'must be a base64 image data URL' };
  const base64 = match[3].replace(/\s+/g, '');
  if (base64.length > Math.ceil((SKIN_LIMITS.assetBytes * 4) / 3) + 8) return { error: 'is larger than 2MB' };
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64);
  } catch {
    return { error: 'is not valid base64' };
  }
  const info = imageInfo(bytes);
  if (!info) return { error: 'is not a PNG, JPEG, GIF or WebP image' };
  if (info.width < 1 || info.height < 1 || info.width > SKIN_LIMITS.imageSide || info.height > SKIN_LIMITS.imageSide) {
    return { error: `must be at most ${SKIN_LIMITS.imageSide}px on each side` };
  }
  return { type: info.type, width: info.width, height: info.height, data: `data:${info.type};base64,${base64}` };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeStyle(raw: unknown, where: string, assets: Record<string, SkinAsset>, problems: string[]): SkinStyle | undefined {
  if (!isObject(raw)) return undefined;
  const style: SkinStyle = {};
  const color = (key: string, value: unknown): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    if (isSkinColor(value)) return value.trim();
    problems.push(`${where}.${key} is not a plain color`);
    return undefined;
  };
  style.background = color('background', raw.background);
  if (isObject(raw.gradient)) {
    const from = color('gradient.from', raw.gradient.from);
    const to = color('gradient.to', raw.gradient.to);
    if (from && to) style.gradient = { from, to, angle: int(raw.gradient.angle, 0, 360) ?? 180 };
  }
  if (isObject(raw.texture)) {
    const asset = typeof raw.texture.asset === 'string' ? raw.texture.asset : '';
    if (assets[asset]) {
      const size = int(raw.texture.size, 8, 1024);
      style.texture = { asset, ...(size ? { size } : {}), ...(raw.texture.blend === true ? { blend: true } : {}) };
    } else {
      problems.push(`${where}.texture uses missing asset "${asset}"`);
    }
  }
  if (isObject(raw.border)) {
    const width = int(raw.border.width, 0, 8) ?? 1;
    const borderColor = color('border.color', raw.border.color) ?? 'currentcolor';
    const borderStyle = (BORDER_STYLES as readonly string[]).includes(String(raw.border.style))
      ? raw.border.style as (typeof BORDER_STYLES)[number]
      : 'solid';
    style.border = { width, color: borderColor, style: borderStyle };
  }
  style.radius = int(raw.radius, 0, 64);
  if (raw.bevel === 'raised' || raw.bevel === 'sunken' || raw.bevel === 'flat') style.bevel = raw.bevel;
  style.text = color('text', raw.text);
  if (raw.font !== undefined) {
    if (isFontStack(raw.font)) style.font = raw.font.trim();
    else problems.push(`${where}.font is not a font list`);
  }
  if (raw.weight === 'normal' || raw.weight === 'bold') style.weight = raw.weight;
  if (raw.shadow === 'none' || raw.shadow === 'soft' || raw.shadow === 'hard') style.shadow = raw.shadow;
  const clean = Object.fromEntries(Object.entries(style).filter(([, value]) => value !== undefined)) as SkinStyle;
  return Object.keys(clean).length > 0 ? clean : undefined;
}

function normalizeSprite(raw: unknown, where: string, assets: Record<string, SkinAsset>, problems: string[]): SkinSprite | undefined {
  if (!isObject(raw)) return undefined;
  const asset = typeof raw.asset === 'string' ? raw.asset : '';
  const image = assets[asset];
  if (!image) {
    problems.push(`${where}.sprite uses missing asset "${asset}"`);
    return undefined;
  }
  const x = int(raw.x, 0, SKIN_LIMITS.imageSide);
  const y = int(raw.y, 0, SKIN_LIMITS.imageSide);
  const w = int(raw.w, 1, 1024);
  const h = int(raw.h, 1, 1024);
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    problems.push(`${where}.sprite needs whole-number x, y, w (1-1024) and h (1-1024)`);
    return undefined;
  }
  const frames = int(raw.frames, 1, 64);
  let states: SkinState[] | undefined;
  if (Array.isArray(raw.states)) {
    states = [...new Set(raw.states.filter((state): state is SkinState => SKIN_STATES.includes(state as SkinState)))];
    if (states.length === 0) states = undefined;
  }
  const cells = frames ?? states?.length ?? 1;
  if (x + w * cells > image.width || y + h > image.height) {
    problems.push(`${where}.sprite (${cells} cell${cells === 1 ? '' : 's'} of ${w}×${h} at ${x},${y}) runs outside the ${image.width}×${image.height} image`);
    return undefined;
  }
  const sprite: SkinSprite = { asset, x, y, w, h };
  if (frames && frames > 1) sprite.frames = frames;
  else if (states && !(states.length === 1 && states[0] === 'normal')) sprite.states = states;
  const slice = int(raw.slice, 1, Math.floor(Math.min(w, h) / 2));
  if (slice) sprite.slice = slice;
  if (raw.pixelated === true) sprite.pixelated = true;
  return sprite;
}

function normalizeWindow(raw: unknown, assets: Record<string, SkinAsset>, problems: string[]): SkinWindow | undefined {
  if (!isObject(raw)) return undefined;
  const win: SkinWindow = { frameless: raw.frameless === true };
  const partName = (value: unknown, key: string): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value === 'string' && PART_NAME_RE.test(value)) return value;
    problems.push(`window.${key} must be a part name like "close-button"`);
    return undefined;
  };
  if (isObject(raw.shape)) {
    const shape = raw.shape;
    if (shape.type === 'rounded') {
      win.shape = { type: 'rounded', radius: int(shape.radius, 0, 400) ?? 24 };
    } else if (shape.type === 'ellipse') {
      win.shape = { type: 'ellipse' };
    } else if (shape.type === 'polygon') {
      const points = Array.isArray(shape.points) ? shape.points : [];
      const clean: Array<[number, number]> = [];
      for (const point of points.slice(0, 64)) {
        const [x, y] = Array.isArray(point) ? point : [];
        const px = Number(x);
        const py = Number(y);
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || px > 100 || py < 0 || py > 100) {
          problems.push('window.shape points must be [x, y] percentages from 0 to 100');
          break;
        }
        clean.push([Math.round(px * 100) / 100, Math.round(py * 100) / 100]);
      }
      if (clean.length >= 3) win.shape = { type: 'polygon', points: clean };
      else problems.push('window.shape polygon needs 3 to 64 points');
    } else if (shape.type === 'mask') {
      const asset = typeof shape.asset === 'string' ? shape.asset : '';
      const image = assets[asset];
      if (!image) {
        problems.push(`window.shape uses missing image "${asset}"`);
      } else {
        const mask: Extract<NonNullable<SkinWindow['shape']>, { type: 'mask' }> = { type: 'mask', asset };
        const x = int(shape.x, 0, SKIN_LIMITS.imageSide);
        const y = int(shape.y, 0, SKIN_LIMITS.imageSide);
        const w = int(shape.w, 1, SKIN_LIMITS.imageSide);
        const h = int(shape.h, 1, SKIN_LIMITS.imageSide);
        if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) {
          if (x + w > image.width || y + h > image.height) problems.push('window.shape mask region runs outside its image');
          else Object.assign(mask, { x, y, w, h });
        }
        win.shape = mask;
      }
    } else if (shape.type !== undefined && shape.type !== 'rect') {
      problems.push('window.shape type must be rounded, ellipse, polygon or mask');
    }
  }
  if (isObject(raw.size)) {
    const w = int(raw.size.w, 200, 1600);
    const h = int(raw.size.h, 150, 1200);
    if (w && h) win.size = { w, h };
    else problems.push('window.size must be w 200-1600 and h 150-1200');
  }
  if (Array.isArray(raw.drag)) {
    const drag = raw.drag.map((value) => partName(value, 'drag')).filter((value): value is string => Boolean(value));
    if (drag.length) win.drag = [...new Set(drag)].slice(0, 12);
  }
  const close = partName(raw.close, 'close');
  if (close) win.close = close;
  const minimize = partName(raw.minimize, 'minimize');
  if (minimize) win.minimize = minimize;
  return win.frameless || win.shape || win.size ? win : undefined;
}

/**
 * Normalize and check a skin document. Throws SkinValidationError. With
 * `lenient` (assistant-designed skins), bad fields are dropped instead.
 */
export function normalizeSkin(raw: unknown, options: { lenient?: boolean } = {}): AppSkin {
  const problems: string[] = [];
  if (!isObject(raw)) throw new SkinValidationError(['the skin must be a JSON object']);
  if (raw.format !== undefined && raw.format !== SKIN_FORMAT) problems.push(`unknown format "${String(raw.format)}" (expected ${SKIN_FORMAT})`);
  const name = str(raw.name, SKIN_LIMITS.nameChars) ?? (options.lenient ? 'Untitled skin' : undefined);
  if (!name) problems.push('the skin needs a name');

  // Assets first: parts refer to them.
  const assets: Record<string, SkinAsset> = {};
  let totalBytes = 0;
  if (isObject(raw.assets)) {
    const entries = Object.entries(raw.assets);
    if (entries.length > SKIN_LIMITS.assets) problems.push(`at most ${SKIN_LIMITS.assets} images per skin`);
    for (const [key, value] of entries.slice(0, SKIN_LIMITS.assets)) {
      if (!ASSET_KEY_RE.test(key)) { problems.push(`image name "${key.slice(0, 40)}" must be lowercase letters, digits, - or _`); continue; }
      const image = isObject(value) ? parseSkinImage(value.data) : parseSkinImage(value);
      if ('error' in image) { problems.push(`image "${key}" ${image.error}`); continue; }
      totalBytes += Math.floor((image.data.length - image.data.indexOf(',') - 1) * 0.75);
      assets[key] = image;
    }
  }
  if (totalBytes > SKIN_LIMITS.totalAssetBytes) problems.push('the skin\'s images add up to more than 6MB');

  const colors: Record<string, string> = {};
  if (isObject(raw.colors)) {
    for (const [key, value] of Object.entries(raw.colors).slice(0, SKIN_LIMITS.colors)) {
      if (!COLOR_NAME_RE.test(key)) { problems.push(`color name "${key.slice(0, 40)}" must be lowercase letters, digits or -`); continue; }
      if (!isSkinColor(value)) { problems.push(`color "${key}" is not a plain color`); continue; }
      colors[key] = value.trim();
    }
  }

  const fonts: AppSkin['fonts'] = {};
  if (isObject(raw.fonts)) {
    for (const key of ['font', 'font-title', 'font-mono'] as const) {
      const value = raw.fonts[key];
      if (value === undefined) continue;
      if (isFontStack(value)) fonts[key] = value.trim();
      else problems.push(`fonts.${key} is not a font list`);
    }
  }

  const parts: Record<string, SkinPart> = {};
  if (isObject(raw.parts)) {
    const entries = Object.entries(raw.parts);
    if (entries.length > SKIN_LIMITS.parts) problems.push(`at most ${SKIN_LIMITS.parts} parts per skin`);
    for (const [partName, value] of entries.slice(0, SKIN_LIMITS.parts)) {
      if (!PART_NAME_RE.test(partName)) { problems.push(`part name "${partName.slice(0, 40)}" must be lowercase letters, digits or - (like data-skin="play-button")`); continue; }
      if (!isObject(value)) continue;
      const where = `parts.${partName}`;
      const part: SkinPart = {};
      const sprite = normalizeSprite(value.sprite, where, assets, problems);
      if (sprite) part.sprite = sprite;
      const style = normalizeStyle(value.style, `${where}.style`, assets, problems);
      if (style) part.style = style;
      if (isObject(value.states)) {
        const states: SkinPart['states'] = {};
        for (const state of ['hover', 'pressed', 'active', 'disabled'] as const) {
          const stateStyle = normalizeStyle(value.states[state], `${where}.states.${state}`, assets, problems);
          if (stateStyle) states[state] = stateStyle;
        }
        if (Object.keys(states).length > 0) part.states = states;
      }
      if (part.sprite || part.style || part.states) parts[partName] = part;
    }
  }

  const win = normalizeWindow(raw.window, assets, problems);

  if (problems.length > 0 && !options.lenient) throw new SkinValidationError(problems);
  if (Object.keys(parts).length === 0 && Object.keys(colors).length === 0 && Object.keys(fonts).length === 0 && !win) {
    throw new SkinValidationError(['the skin changes nothing: add parts, colors or fonts']);
  }

  // Drop images nothing uses.
  const used = new Set<string>();
  for (const part of Object.values(parts)) {
    if (part.sprite) used.add(part.sprite.asset);
    for (const style of [part.style, ...Object.values(part.states ?? {})]) if (style?.texture) used.add(style.texture.asset);
  }
  if (win?.shape?.type === 'mask') used.add(win.shape.asset);
  const usedAssets = Object.fromEntries(Object.entries(assets).filter(([key]) => used.has(key)));

  const skin: AppSkin = { format: SKIN_FORMAT, name: name!, colors, fonts, parts, assets: usedAssets };
  if (win) skin.window = win;
  const author = str(raw.author, 60);
  if (author) skin.author = author;
  const description = str(raw.description, 300);
  if (description) skin.description = description;
  return skin;
}

/** A short public summary (no image data). */
export function summarizeSkin(skin: AppSkin) {
  return {
    name: skin.name,
    author: skin.author,
    description: skin.description,
    parts: Object.keys(skin.parts),
    colors: Object.keys(skin.colors),
    images: Object.keys(skin.assets).length,
    sprites: Object.values(skin.parts).some((part) => part.sprite),
    shaped: Boolean(skin.window?.frameless || skin.window?.shape),
  };
}
