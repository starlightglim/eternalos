/**
 * Built-in demo cartridge — playable at /api/games/play/demo/ without any
 * KV/R2 state. Doubles as living documentation of the console API and the
 * starter template for new drafts in the cartridge editor.
 */

import type { Cartridge } from '../utils/cartridge';
import { blankSpritesheet } from '../utils/cartridge';

/** Stamp an 8x8 sprite (8 strings of 8 hex chars) into a spritesheet. */
export function stampSprite(sheet: string, spriteIndex: number, pixels: string[]): string {
  const rows = sheet.split('\n');
  const sx = (spriteIndex % 16) * 8;
  const sy = Math.floor(spriteIndex / 16) * 8;
  for (let y = 0; y < 8; y++) {
    const row = rows[sy + y];
    const src = (pixels[y] ?? '00000000').padEnd(8, '0').slice(0, 8).toLowerCase();
    rows[sy + y] = row.slice(0, sx) + src + row.slice(sx + 8);
  }
  return rows.join('\n');
}

// Sprite 1: a green slime with eyes. Sprite 2: a yellow gem.
const DEMO_SPRITESHEET = stampSprite(
  stampSprite(blankSpritesheet(), 1, [
    '000bb000',
    '00bbbb00',
    '0bbbbbb0',
    'bb7bb7bb',
    'bb1bb1bb',
    'bbbbbbbb',
    '0bbbbbb0',
    '00b00b00',
  ]),
  2,
  [
    '000aa000',
    '00aaaa00',
    '0aa7aaa0',
    'aaaaaaaa',
    '0aaaaaa0',
    '00aaaa00',
    '000aa000',
    '00000000',
  ],
);

const DEMO_CODE = `// GEM CATCHER — EternalOS console demo
// Move with arrows / A+D. Catch gems, don't let them drop!
//
// Console API quick reference:
//   _init() _update() _draw()        30fps game loop hooks
//   cls(c) pset pget line rect rectfill circ circfill
//   spr(n,x,y,[w,h,flipX,flipY])     8x8 sprites from the sheet
//   print(str,x,y,c)  camera(x,y)  pal(c0,c1)  palt(c,t)
//   btn(i) btnp(i)                   0=left 1=right 2=up 3=down 4=O(z) 5=X(x)
//   sfx(n)                           16 built-in sounds (0..15)
//   dset(key,val) dget(key)          cloud save (per player!)
//   rnd(n) flr ceil abs min max mid sin cos atan2 sqrt time()
//   net.host() net.join(code) ...    multiplayer relay

var px, score, best, lives, gems, tick, over, flash;

function _init() {
  px = 60;
  score = 0;
  lives = 3;
  gems = [];
  tick = 0;
  over = false;
  flash = 0;
  best = dget('best') || 0;
}

function spawnGem() {
  gems.push({ x: 4 + rnd(112), y: -8, v: 0.6 + rnd(0.8) + score * 0.01 });
}

function _update() {
  if (flash > 0) flash -= 1;

  if (over) {
    if (btnp(5)) { _init(); sfx(7); }
    return;
  }

  tick += 1;

  if (btn(0)) px -= 2;
  if (btn(1)) px += 2;
  px = mid(0, px, 120);

  if (tick % max(12, 30 - flr(score / 5)) === 0) spawnGem();

  for (var i = gems.length - 1; i >= 0; i--) {
    var g = gems[i];
    g.y += g.v;
    if (g.y > 110 && g.y < 120 && abs(g.x - px) < 8) {
      gems.splice(i, 1);
      score += 1;
      sfx(2);
      if (score > best) { best = score; dset('best', best); }
    } else if (g.y > 128) {
      gems.splice(i, 1);
      lives -= 1;
      flash = 8;
      sfx(3);
      if (lives <= 0) { over = true; sfx(13); }
    }
  }
}

function _draw() {
  cls(flash > 0 ? 2 : 1);

  // starfield
  for (var s = 0; s < 24; s++) {
    pset((s * 53 + flr(tick / 4) * (s % 3)) % 128, (s * 31) % 100, s % 2 === 0 ? 5 : 13);
  }

  // ground
  rectfill(0, 120, 127, 127, 3);
  line(0, 119, 127, 119, 11);

  for (var i = 0; i < gems.length; i++) {
    spr(2, gems[i].x - 4, gems[i].y);
  }

  spr(1, px, 112);

  print('SCORE ' + score, 2, 2, 7);
  print('BEST ' + best, 2, 9, 6);
  for (var l = 0; l < lives; l++) circfill(122 - l * 8, 5, 2, 8);

  if (over) {
    rectfill(20, 48, 108, 80, 0);
    rect(20, 48, 108, 80, 8);
    print('GAME OVER', 47, 56, 8);
    print('PRESS X TO RETRY', 33, 68, 7);
  }
}
`;

export const DEMO_CARTRIDGE: Cartridge = {
  formatVersion: 1,
  meta: {
    name: 'Gem Catcher',
    description: 'Catch the falling gems! Built-in demo for the EternalOS console.',
    author: 'eternalos',
    version: '1.0.0',
  },
  code: DEMO_CODE,
  spritesheet: DEMO_SPRITESHEET,
};
