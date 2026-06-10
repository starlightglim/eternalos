/**
 * Frontend constants for the fantasy console.
 * Mirrors packages/worker/src/utils/cartridge.ts — keep in sync.
 */

import type { Cartridge } from '../../types';

export const CONSOLE_SCREEN = 128;

/** PICO-8 default palette */
export const DEFAULT_PALETTE: readonly string[] = [
  '#000000', '#1D2B53', '#7E2553', '#008751',
  '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
  '#FF004D', '#FFA300', '#FFEC27', '#00E436',
  '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
];

export function blankSpritesheet(): string {
  const row = '0'.repeat(CONSOLE_SCREEN);
  return Array.from({ length: CONSOLE_SCREEN }, () => row).join('\n');
}

const STARTER_CODE = `// New cartridge! The console runs _init/_update/_draw at 30fps.
//
// API: cls pset pget line rect rectfill circ circfill spr sspr print
//      camera pal palt btn btnp sfx rnd flr ceil abs min max mid
//      sin cos atan2 sqrt time fget fset dset dget net.*
// Buttons: 0=left 1=right 2=up 3=down 4=O(z) 5=X(x)
// Sprites: edit the "sprites" tab — 128x128 hex grid, 8x8 cells, spr(n,x,y)

var x, y, dx, dy;

function _init() {
  x = 60; y = 60;
  dx = 1.2; dy = 0.8;
}

function _update() {
  x += dx; y += dy;
  if (x < 4 || x > 124) { dx = -dx; sfx(0); }
  if (y < 4 || y > 124) { dy = -dy; sfx(0); }
  if (btn(0)) x -= 2;
  if (btn(1)) x += 2;
}

function _draw() {
  cls(1);
  print('HELLO ETERNALOS', 34, 8, 7);
  circfill(x, y, 4, 8);
  circ(x, y, 4, 7);
}
`;

export function createStarterCartridge(name: string, author: string): Cartridge {
  return {
    formatVersion: 1,
    meta: { name, author, version: '1.0.0' },
    code: STARTER_CODE,
    spritesheet: blankSpritesheet(),
  };
}

/** Draw a spritesheet hex grid onto a canvas (1px per pixel, caller scales). */
export function drawSpritesheet(
  canvas: HTMLCanvasElement,
  spritesheet: string,
  palette?: string[],
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const pal = palette && palette.length === 16 ? palette : DEFAULT_PALETTE;
  const rows = spritesheet.split('\n');
  ctx.clearRect(0, 0, CONSOLE_SCREEN, CONSOLE_SCREEN);
  for (let y = 0; y < CONSOLE_SCREEN; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < CONSOLE_SCREEN; x++) {
      const v = parseInt(row[x] ?? '0', 16) || 0;
      if (v === 0) continue;
      ctx.fillStyle = pal[v];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
