/**
 * Dynamic OG Image Generation for EternalOS
 *
 * GET /api/og/:username.png - PNG preview of a user's desktop (og:image)
 * GET /api/og/:username.svg - the same image as SVG
 *
 * The desktop is drawn as SVG and rasterized to PNG with resvg-wasm, because
 * X, Facebook, Discord, Slack and iMessage don't render SVG og:images. resvg
 * has no system fonts on Workers, so every text element uses the desktop's
 * own ChiKareGo2 font (assets/ogFont.ts). The image includes:
 * - Custom desktop/accent colors
 * - Desktop icons (up to 12 shown)
 * - Username/display name
 * - EternalOS branding
 *
 * The SVG is designed to look like a stylized Mac OS 8 desktop screenshot.
 */

import { initWasm, Resvg } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import type { Env } from '../index';
import type { DesktopItem, UserProfile } from '../types';
import { OG_FONT_BASE64 } from '../assets/ogFont';

// OG image dimensions (Twitter/Facebook optimized)
const WIDTH = 1200;
const HEIGHT = 630;

// Grid settings for icon layout
const ICON_SIZE = 48;
const ICON_SPACING = 100;
const ICONS_PER_ROW = 6;
const MAX_ICONS = 12;

// Colors
const DEFAULT_DESKTOP_COLOR = '#C0C0C0'; // Platinum gray
const DEFAULT_ACCENT_COLOR = '#000080'; // Classic Mac blue
const WINDOW_BORDER = '#000000';

/**
 * Generate an icon SVG based on item type
 */
function getIconSvg(item: DesktopItem, x: number, y: number, canRender: (text: string) => boolean): string {
  const type = item.type;
  const iconX = x;
  const iconY = y;
  const labelY = y + ICON_SIZE + 14;

  // Truncate name if too long
  const label = renderableLabel(item.name, item.type, canRender);
  const name = label.length > 12 ? label.slice(0, 10) + '...' : label;

  // Icon graphics based on type
  let iconGraphic = '';

  switch (type) {
    case 'folder':
      iconGraphic = `
        <rect x="${iconX + 4}" y="${iconY + 8}" width="40" height="32" fill="#FFCC00" stroke="#000" stroke-width="1"/>
        <path d="M${iconX + 4} ${iconY + 8} L${iconX + 4} ${iconY + 4} L${iconX + 20} ${iconY + 4} L${iconX + 24} ${iconY + 8}" fill="#FFCC00" stroke="#000" stroke-width="1"/>
      `;
      break;
    case 'text':
      iconGraphic = `
        <rect x="${iconX + 8}" y="${iconY + 4}" width="32" height="40" fill="#FFFFFF" stroke="#000" stroke-width="1"/>
        <line x1="${iconX + 12}" y1="${iconY + 12}" x2="${iconX + 36}" y2="${iconY + 12}" stroke="#666" stroke-width="1"/>
        <line x1="${iconX + 12}" y1="${iconY + 18}" x2="${iconX + 36}" y2="${iconY + 18}" stroke="#666" stroke-width="1"/>
        <line x1="${iconX + 12}" y1="${iconY + 24}" x2="${iconX + 30}" y2="${iconY + 24}" stroke="#666" stroke-width="1"/>
      `;
      break;
    case 'image':
      iconGraphic = `
        <rect x="${iconX + 6}" y="${iconY + 4}" width="36" height="36" fill="#FFFFFF" stroke="#000" stroke-width="1"/>
        <rect x="${iconX + 10}" y="${iconY + 8}" width="28" height="28" fill="#87CEEB"/>
        <circle cx="${iconX + 18}" cy="${iconY + 16}" r="4" fill="#FFD700"/>
        <path d="M${iconX + 10} ${iconY + 32} L${iconX + 20} ${iconY + 22} L${iconX + 26} ${iconY + 28} L${iconX + 38} ${iconY + 18} L${iconX + 38} ${iconY + 36} L${iconX + 10} ${iconY + 36} Z" fill="#228B22"/>
      `;
      break;
    case 'link':
      iconGraphic = `
        <rect x="${iconX + 4}" y="${iconY + 4}" width="40" height="40" fill="#E0E0FF" stroke="#000" stroke-width="1"/>
        <text x="${iconX + 24}" y="${iconY + 32}" font-family="serif" font-size="28" text-anchor="middle" fill="#0000FF">@</text>
      `;
      break;
    case 'audio':
      iconGraphic = `
        <rect x="${iconX + 8}" y="${iconY + 4}" width="32" height="40" fill="#FFE4E1" stroke="#000" stroke-width="1"/>
        <ellipse cx="${iconX + 21}" cy="${iconY + 31}" rx="5" ry="4" fill="#FF1493"/><rect x="${iconX + 25}" y="${iconY + 14}" width="2" height="17" fill="#FF1493"/><path d="M${iconX + 27} ${iconY + 14} q6 3 5 9" stroke="#FF1493" stroke-width="2" fill="none"/>
      `;
      break;
    case 'video':
      iconGraphic = `
        <rect x="${iconX + 6}" y="${iconY + 8}" width="36" height="32" fill="#2F2F2F" stroke="#000" stroke-width="1"/>
        <polygon points="${iconX + 20},${iconY + 16} ${iconX + 20},${iconY + 32} ${iconX + 34},${iconY + 24}" fill="#FFFFFF"/>
      `;
      break;
    case 'pdf':
      iconGraphic = `
        <rect x="${iconX + 8}" y="${iconY + 4}" width="32" height="40" fill="#FFFFFF" stroke="#000" stroke-width="1"/>
        <rect x="${iconX + 10}" y="${iconY + 6}" width="28" height="8" fill="#FF0000"/>
        <text x="${iconX + 24}" y="${iconY + 13}" font-family="sans-serif" font-size="7" font-weight="bold" text-anchor="middle" fill="#FFFFFF">PDF</text>
      `;
      break;
    case 'widget':
      iconGraphic = `
        <rect x="${iconX + 6}" y="${iconY + 6}" width="36" height="36" fill="#E8E8E8" stroke="#000" stroke-width="1"/>
        <rect x="${iconX + 10}" y="${iconY + 10}" width="28" height="6" fill="#CCCCCC"/>
        <line x1="${iconX + 12}" y1="${iconY + 20}" x2="${iconX + 36}" y2="${iconY + 20}" stroke="#999" stroke-width="1"/>
        <line x1="${iconX + 12}" y1="${iconY + 26}" x2="${iconX + 32}" y2="${iconY + 26}" stroke="#999" stroke-width="1"/>
        <line x1="${iconX + 12}" y1="${iconY + 32}" x2="${iconX + 28}" y2="${iconY + 32}" stroke="#999" stroke-width="1"/>
      `;
      break;
    default:
      // Generic file icon
      iconGraphic = `
        <rect x="${iconX + 8}" y="${iconY + 4}" width="32" height="40" fill="#FFFFFF" stroke="#000" stroke-width="1"/>
        <path d="M${iconX + 28} ${iconY + 4} L${iconX + 40} ${iconY + 16} L${iconX + 28} ${iconY + 16} Z" fill="#CCCCCC" stroke="#000" stroke-width="1"/>
      `;
  }

  return `
    <g class="icon">
      ${iconGraphic}
      <text x="${iconX + ICON_SIZE / 2}" y="${labelY}" font-family="Chicago, Geneva, sans-serif" font-size="11" text-anchor="middle" fill="#000000">
        <tspan>${escapeXml(name)}</tspan>
      </text>
    </g>
  `;
}

/**
 * Escape XML special characters
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A 12×12 ⌘ drawn as shapes: the bundled pixel font has no ⌘ glyph, and the
 * rasterizer has no fallback fonts.
 */
function commandKeySvg(x: number, y: number, color: string): string {
  return `<g transform="translate(${x}, ${y})" fill="none" stroke="${color}" stroke-width="1.4">
    <rect x="4" y="4" width="4" height="4"/>
    <circle cx="2.5" cy="2.5" r="2"/><circle cx="9.5" cy="2.5" r="2"/>
    <circle cx="2.5" cy="9.5" r="2"/><circle cx="9.5" cy="9.5" r="2"/>
  </g>`;
}

/**
 * Generate title bar stripe pattern (classic Mac OS 8)
 */
function getTitleBarPattern(id: string): string {
  return `
    <pattern id="${id}" patternUnits="userSpaceOnUse" width="2" height="2">
      <rect width="2" height="1" fill="white"/>
      <rect y="1" width="2" height="1" fill="black"/>
    </pattern>
  `;
}

/**
 * An item's label in what the font can draw: unsupported characters are
 * dropped; if nothing readable is left, the item type stands in.
 */
function renderableLabel(name: string, type: string, canRender: (text: string) => boolean): string {
  if (canRender(name)) return name;
  const kept = Array.from(name).filter((ch) => canRender(ch)).join('').replace(/\s+/g, ' ').trim();
  if (/[a-z0-9]/i.test(kept)) return kept;
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Truncate a string to a max length, adding ellipsis if needed
 */
function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Word-wrap text into lines of max width (approximate character count)
 */
function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 > maxCharsPerLine) {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.slice(0, 3); // Max 3 lines
}

/**
 * Generate the complete SVG for a user's desktop
 */
export function generateDesktopSvg(
  username: string,
  rawDisplayName: string,
  items: DesktopItem[],
  profile: Partial<UserProfile>,
  canRender: (text: string) => boolean = () => true
): string {
  // Text the rasterizer's font can't draw would come out blank.
  const displayName = canRender(rawDisplayName) ? rawDisplayName : username;
  const desktopColor = profile.desktopColor || DEFAULT_DESKTOP_COLOR;
  const accentColor = profile.accentColor || DEFAULT_ACCENT_COLOR;

  // Filter to root items only (exclude stickers), limit to MAX_ICONS
  const rootItems = items
    .filter(item => item.parentId === null && !item.isTrashed && item.type !== 'sticker')
    .slice(0, MAX_ICONS);

  // Calculate icon positions
  const iconsStartX = 60;
  const iconsStartY = 80;
  const iconsSvg = rootItems.map((item, index) => {
    const row = Math.floor(index / ICONS_PER_ROW);
    const col = index % ICONS_PER_ROW;
    const x = iconsStartX + col * ICON_SPACING;
    const y = iconsStartY + row * ICON_SPACING;
    return getIconSvg(item, x, y, canRender);
  }).join('');

  // Generate item count text
  const itemCount = items.filter(i => !i.isTrashed).length;
  const itemText = itemCount === 1 ? '1 item' : `${itemCount} items`;

  // Build description text for the info window
  const rawDescription = profile.shareDescription || profile.bio || '';
  const shareDescription = canRender(rawDescription) ? rawDescription : '';
  const descriptionLines = shareDescription
    ? wrapText(truncateText(shareDescription, 120), 35)
    : [];

  // Dynamically size the info window based on description
  const baseWindowHeight = 140;
  const descLineHeight = 16;
  const extraDescHeight = descriptionLines.length > 0 ? (descriptionLines.length * descLineHeight + 12) : 0;
  const windowHeight = baseWindowHeight + extraDescHeight;
  const windowY = HEIGHT - windowHeight - 40;

  // Description SVG lines
  const descriptionSvg = descriptionLines.map((line, i) =>
    `<text x="${WIDTH - 300}" y="${windowY + 88 + (i * descLineHeight)}" font-family="Geneva, system-ui, sans-serif" font-size="11" fill="#444444" font-style="italic">${escapeXml(line)}</text>`
  ).join('\n    ');

  // Content positions
  const contentStartY = windowY + 50;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <defs>
    ${getTitleBarPattern('titleStripes')}
    <!-- Drop shadow filter -->
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="3" dy="3" stdDeviation="2" flood-opacity="0.3"/>
    </filter>
  </defs>

  <!-- Desktop background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${escapeXml(desktopColor)}"/>

  <!-- Menu bar -->
  <rect x="0" y="0" width="${WIDTH}" height="22" fill="#FFFFFF" stroke="${WINDOW_BORDER}" stroke-width="1"/>
  ${commandKeySvg(12, 5, "#000000")}
  <text x="36" y="16" font-family="Chicago, system-ui, sans-serif" font-size="12" font-weight="bold" fill="#000000">File</text>
  <text x="70" y="16" font-family="Chicago, system-ui, sans-serif" font-size="12" font-weight="bold" fill="#000000">Edit</text>
  <text x="104" y="16" font-family="Chicago, system-ui, sans-serif" font-size="12" font-weight="bold" fill="#000000">View</text>
  <text x="142" y="16" font-family="Chicago, system-ui, sans-serif" font-size="12" font-weight="bold" fill="#000000">Special</text>

  <!-- Desktop icons -->
  ${iconsSvg}

  <!-- Info window (bottom right) -->
  <g filter="url(#shadow)">
    <!-- Window border -->
    <rect x="${WIDTH - 320}" y="${windowY}" width="280" height="${windowHeight}" fill="#FFFFFF" stroke="${WINDOW_BORDER}" stroke-width="2"/>
    <!-- Title bar -->
    <rect x="${WIDTH - 318}" y="${windowY + 2}" width="276" height="20" fill="url(#titleStripes)"/>
    <!-- Close box -->
    <rect x="${WIDTH - 314}" y="${windowY + 6}" width="12" height="12" fill="#FFFFFF" stroke="${WINDOW_BORDER}" stroke-width="1"/>
    <!-- Title -->
    <rect x="${WIDTH - 220}" y="${windowY + 4}" width="120" height="16" fill="#FFFFFF"/>
    <text x="${WIDTH - 180}" y="${windowY + 17}" font-family="Chicago, system-ui, sans-serif" font-size="12" font-weight="bold" text-anchor="middle" fill="#000000">@${escapeXml(username)}</text>

    <!-- Window content -->
    <text x="${WIDTH - 300}" y="${contentStartY}" font-family="Geneva, system-ui, sans-serif" font-size="14" fill="#000000">${escapeXml(displayName)}'s Desktop</text>
    <text x="${WIDTH - 300}" y="${contentStartY + 22}" font-family="Geneva, system-ui, sans-serif" font-size="12" fill="#666666">${itemText} on display</text>

    ${descriptionSvg ? `<!-- Share description -->
    ${descriptionSvg}` : ''}

    <!-- Accent color indicator -->
    <rect x="${WIDTH - 300}" y="${windowY + windowHeight - 36}" width="16" height="16" fill="${escapeXml(accentColor)}" stroke="${WINDOW_BORDER}" stroke-width="1"/>
    <text x="${WIDTH - 278}" y="${windowY + windowHeight - 24}" font-family="Geneva, system-ui, sans-serif" font-size="11" fill="#666666">Theme color</text>
  </g>

  <!-- EternalOS logo badge (bottom right corner) -->
  <g transform="translate(${WIDTH - 160}, ${HEIGHT - 28})">
    <!-- Badge background -->
    <rect x="0" y="0" width="140" height="20" rx="3" fill="rgba(0,0,0,0.6)"/>
    <!-- Mac-style command key icon -->
    ${commandKeySvg(7, 4, "#FFFFFF")}
    <!-- Brand text -->
    <text x="24" y="14" font-family="Chicago, system-ui, sans-serif" font-size="10" fill="#FFFFFF">EternalOS</text>
  </g>
</svg>`;
}

export type OgFormat = 'png' | 'svg';

/** `alice.png` → { username: 'alice', format: 'png' }. PNG unless `.svg`. */
export function parseOgTarget(raw: string): { username: string; format: OgFormat } {
  const lower = raw.toLowerCase();
  const match = lower.match(/^(.*)\.(png|svg)$/);
  if (!match) return { username: lower, format: 'png' };
  return { username: match[1], format: match[2] as OgFormat };
}

let wasmReady: Promise<void> | null = null;
let fontBytes: Uint8Array | null = null;

function ensureResvg(): Promise<void> {
  wasmReady ??= initWasm(resvgWasm).catch((error: unknown) => {
    wasmReady = null;
    throw error;
  });
  return wasmReady;
}

function ogFont(): Uint8Array {
  if (!fontBytes) {
    const binary = atob(OG_FONT_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    fontBytes = bytes;
  }
  return fontBytes;
}

/**
 * The code points a TrueType font maps (cmap formats 4 and 12), so text the
 * font can't draw is never rasterized as blanks.
 */
export function fontCodePoints(font: Uint8Array): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const points = new Set<number>();
  const numTables = view.getUint16(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (String.fromCharCode(font[rec], font[rec + 1], font[rec + 2], font[rec + 3]) === 'cmap') {
      cmap = view.getUint32(rec + 8);
    }
  }
  if (cmap < 0) return points;
  const subtables = view.getUint16(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const platform = view.getUint16(cmap + 4 + i * 8);
    const encoding = view.getUint16(cmap + 6 + i * 8);
    if (!(platform === 3 && (encoding === 1 || encoding === 10)) && platform !== 0) continue;
    const at = cmap + view.getUint32(cmap + 8 + i * 8);
    const format = view.getUint16(at);
    if (format === 4) {
      const segX2 = view.getUint16(at + 6);
      const ends = at + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const offsets = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = view.getUint16(ends + s);
        const start = view.getUint16(starts + s);
        const delta = view.getUint16(deltas + s);
        const rangeOffset = view.getUint16(offsets + s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (rangeOffset === 0) {
            glyph = (c + delta) & 0xffff;
          } else {
            const glyphAt = offsets + s + rangeOffset + (c - start) * 2;
            glyph = glyphAt + 1 < font.byteLength ? view.getUint16(glyphAt) : 0;
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) points.add(c);
        }
      }
    } else if (format === 12) {
      const groups = view.getUint32(at + 12);
      for (let g = 0; g < groups; g++) {
        const start = view.getUint32(at + 16 + g * 12);
        const end = Math.min(view.getUint32(at + 20 + g * 12), start + 0xffff);
        const glyph = view.getUint32(at + 24 + g * 12);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) points.add(c);
      }
    }
  }
  return points;
}

let coverage: Set<number> | null = null;

/** Whether the bundled og font can draw every character of `text`. */
export function ogFontCanRender(text: string): boolean {
  coverage ??= fontCodePoints(ogFont());
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x20 || code === 0x0a || code === 0x09) continue;
    if (!coverage.has(code)) return false;
  }
  return true;
}

/** Rasterize one of our og SVGs to a 1200×630 PNG. */
export async function rasterizeOgSvg(svg: string): Promise<Uint8Array> {
  await ensureResvg();
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontBuffers: [ogFont()],
      loadSystemFonts: false,
      defaultFontFamily: 'ChiKareGo2',
      sansSerifFamily: 'ChiKareGo2',
      serifFamily: 'ChiKareGo2',
      monospaceFamily: 'ChiKareGo2',
    },
  });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

interface EncodedImage {
  body: Uint8Array | string;
  contentType: 'image/png' | 'image/svg+xml';
}

/**
 * Encode an og SVG in the requested format. If rasterizing fails the SVG is
 * served instead, under its real content type (never SVG bytes as "PNG").
 */
async function encodeImage(svg: string, format: OgFormat): Promise<EncodedImage> {
  if (format === 'png') {
    try {
      return { body: await rasterizeOgSvg(svg), contentType: 'image/png' };
    } catch (error) {
      console.error('OG image rasterization failed; serving SVG:', error);
    }
  }
  return { body: svg, contentType: 'image/svg+xml' };
}

// The not-found and error cards are the same for every request, so each
// isolate encodes them once (unknown usernames can't each cost a render).
const fixedImages = new Map<string, Promise<EncodedImage>>();

function fixedImage(kind: 'not-found' | 'error', format: OgFormat): Promise<EncodedImage> {
  const key = `${kind}:${format}`;
  let image = fixedImages.get(key);
  if (!image) {
    image = encodeImage(kind === 'not-found' ? notFoundSvg() : errorSvg(), format);
    fixedImages.set(key, image);
    // Don't pin an SVG fallback from a transient rasterizer failure.
    image.then((encoded) => {
      if (format === 'png' && encoded.contentType !== 'image/png') fixedImages.delete(key);
    }, () => fixedImages.delete(key));
  }
  return image;
}

function imageResponse(image: EncodedImage, status: number, cacheControl: string): Response {
  return new Response(image.body, {
    status,
    headers: { 'Content-Type': image.contentType, 'Cache-Control': cacheControl },
  });
}

const OG_CACHE_CONTROL = 'public, max-age=300'; // 5 minutes

/**
 * Handle OG image generation request
 * GET /api/og/:username.png (or .svg)
 */
export async function handleOgImage(
  _request: Request,
  env: Env,
  target: string
): Promise<Response> {
  const { username: normalizedUsername, format } = parseOgTarget(target);
  try {
    // Look up user
    const usernameData = await env.AUTH_KV.get<{ uid: string }>(
      `username:${normalizedUsername}`,
      'json'
    );

    if (!usernameData) {
      return imageResponse(await fixedImage('not-found', format), 404, 'public, max-age=60');
    }

    const { uid } = usernameData;

    // Try KV cache first (one entry per format)
    const cacheKey = `og:${format}:${uid}`;
    const cached = await env.DESKTOP_KV.getWithMetadata<{ contentType?: string }>(
      cacheKey,
      'arrayBuffer'
    );
    if (cached.value) {
      return new Response(cached.value, {
        headers: {
          'Content-Type': cached.metadata?.contentType || 'application/octet-stream',
          'Cache-Control': OG_CACHE_CONTROL,
        },
      });
    }

    // Fetch from Durable Object
    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);
    const doResponse = await stub.fetch(
      new Request('http://internal/public-snapshot')
    );

    const canRender = format === 'png' ? ogFontCanRender : undefined;
    let svg: string;
    if (doResponse.ok) {
      const data = await doResponse.json() as { items: DesktopItem[]; profile?: UserProfile };
      const profile = data.profile;
      svg = generateDesktopSvg(
        normalizedUsername,
        profile?.displayName || normalizedUsername,
        data.items,
        profile || {},
        canRender
      );
    } else {
      // User exists but has no public items
      svg = generateDesktopSvg(normalizedUsername, normalizedUsername, [], {}, canRender);
    }
    const image = await encodeImage(svg, format);

    // Cache for 5 minutes — but not an SVG fallback under the PNG key, so a
    // transient rasterizer failure doesn't stick.
    if (format === 'svg' || image.contentType === 'image/png') {
      await env.DESKTOP_KV.put(cacheKey, image.body, {
        expirationTtl: 300,
        metadata: { contentType: image.contentType },
      });
    }

    return imageResponse(image, 200, OG_CACHE_CONTROL);
  } catch (error) {
    console.error('OG image generation error:', error);
    return imageResponse(await fixedImage('error', format), 500, 'no-store');
  }
}

/**
 * "Desktop not found" placeholder image
 */
function notFoundSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#C0C0C0"/>
  <rect x="${WIDTH / 2 - 200}" y="${HEIGHT / 2 - 80}" width="400" height="160" fill="#FFFFFF" stroke="#000000" stroke-width="2"/>
  <rect x="${WIDTH / 2 - 198}" y="${HEIGHT / 2 - 78}" width="396" height="20" fill="#CCCCCC"/>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2 - 62}" font-family="Chicago, system-ui, sans-serif" font-size="12" font-weight="bold" text-anchor="middle" fill="#000000">Error</text>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2 + 10}" font-family="Geneva, system-ui, sans-serif" font-size="16" text-anchor="middle" fill="#000000">This desktop doesn't exist</text>
  <text x="${WIDTH - 20}" y="${HEIGHT - 10}" font-family="Chicago, system-ui, sans-serif" font-size="10" text-anchor="end" fill="#666666">EternalOS</text>
</svg>`;
}

/**
 * Generic error image
 */
function errorSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#C0C0C0"/>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2}" font-family="Chicago, system-ui, sans-serif" font-size="18" text-anchor="middle" fill="#000000">EternalOS</text>
  <text x="${WIDTH / 2}" y="${HEIGHT / 2 + 30}" font-family="Geneva, system-ui, sans-serif" font-size="12" text-anchor="middle" fill="#666666">A personal corner of the internet</text>
</svg>`;
}
