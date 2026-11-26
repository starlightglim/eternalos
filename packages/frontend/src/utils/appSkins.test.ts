import { describe, expect, test } from 'vitest';
import JSZip from 'jszip';
import {
  ELLIPSE_SAFE_RECT,
  largestRect,
  polygonSafeRect,
  safeInsets,
  silhouetteAlpha,
  skinClipPath,
  layoutSkinTemplate,
  readSkinFile,
  replaceSheet,
  skinFromTemplate,
  writeSkinFile,
  SkinFileError,
  type AppSkin,
} from './appSkins';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const parts = [
  { name: 'display', w: 380, h: 40, states: ['normal'], label: 'Track display' },
  { name: 'play', w: 44, h: 32, states: ['normal', 'hover', 'pressed', 'disabled'], label: 'Play' },
  { name: 'digit', w: 12, h: 20, states: ['normal'], frames: 10, label: 'digit' },
];

describe('skin templates', () => {
  test('lay parts out in rows without overlap, one cell per state or frame', () => {
    const layout = layoutSkinTemplate(parts, ['app', 'button', 'link']);
    expect(layout.entries.map((entry) => entry.part)).toEqual(['app', 'button', 'display', 'play', 'digit']);
    const play = layout.entries.find((entry) => entry.part === 'play')!;
    expect(play.cells).toEqual(['normal', 'hover', 'pressed', 'disabled']);
    expect(layout.entries.find((entry) => entry.part === 'digit')!.cells).toHaveLength(10);
    expect(layout.entries.find((entry) => entry.part === 'button')!.slice).toBe(6);
    // No two blocks overlap and all stay inside the sheet.
    const boxes = layout.entries.map((entry) => ({ x0: entry.x, y0: entry.y, x1: entry.x + entry.w * entry.cells.length, y1: entry.y + entry.h }));
    for (const box of boxes) {
      expect(box.x1).toBeLessThanOrEqual(layout.width);
      expect(box.y1).toBeLessThanOrEqual(layout.height);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0).toBe(true);
      }
    }
    // Same parts, same layout: painted sheets keep lining up.
    expect(layoutSkinTemplate(parts, ['app', 'button', 'link'])).toEqual(layout);
  });

  test('turn a template into sprite parts at the layout coordinates', () => {
    const layout = layoutSkinTemplate(parts, ['app']);
    const skin = skinFromTemplate('Mine', layout, PNG_1x1);
    expect(skin.parts.play.sprite).toMatchObject({ asset: 'sheet', w: 44, h: 32, states: ['normal', 'hover', 'pressed', 'disabled'] });
    expect(skin.parts.digit.sprite).toMatchObject({ frames: 10 });
    expect(skin.parts.display.sprite?.states).toBeUndefined();
    expect(skin.parts.app.sprite).toMatchObject({ x: 10, w: 64, h: 64 });
  });

  test('a painted sheet must keep the template size', () => {
    const skin: AppSkin = { ...skinFromTemplate('Mine', layoutSkinTemplate(parts), PNG_1x1), assets: { sheet: { type: 'image/png', width: 512, height: 300, data: PNG_1x1 } } };
    expect(() => replaceSheet(skin, { dataUrl: PNG_1x1, width: 256, height: 150 })).toThrow(/512×300/);
    expect(replaceSheet(skin, { dataUrl: 'data:image/png;base64,AAAA', width: 512, height: 300 }).assets.sheet).toBe('data:image/png;base64,AAAA');
  });
});

describe('.eskin files', () => {
  test('round-trip a skin through a zip with images as files', async () => {
    const skin: AppSkin = {
      format: 'eternal-skin/1',
      name: 'Round Trip',
      colors: { accent: '#ff00aa' },
      fonts: {},
      parts: { app: { style: { texture: { asset: 'wood', size: 128 } } }, play: { sprite: { asset: 'sheet', x: 0, y: 0, w: 1, h: 1 } } },
      assets: { sheet: PNG_1x1, wood: { type: 'image/png', width: 1, height: 1, data: PNG_1x1 } },
    };
    const blob = await writeSkinFile(skin, { 'README.txt': 'hi' });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(['README.txt', 'images/', 'images/wood.png', 'sheet.png', 'skin.json']);
    const manifest = JSON.parse(await zip.file('skin.json')!.async('string'));
    expect(manifest.assets).toEqual({ sheet: 'sheet.png', wood: 'images/wood.png' });

    const back = await readSkinFile(blob);
    expect(back.name).toBe('Round Trip');
    expect(back.assets).toEqual({ sheet: PNG_1x1, wood: PNG_1x1 });
  });

  test('read skins zipped inside a folder, and refuse broken ones', async () => {
    const zip = new JSZip();
    zip.file('My Skin/skin.json', JSON.stringify({ name: 'Nested', assets: { sheet: 'sheet.png' }, parts: {} }));
    zip.file('My Skin/sheet.png', PNG_1x1.split(',')[1], { base64: true });
    const nested = await readSkinFile(await zip.generateAsync({ type: 'blob' }));
    expect(nested.assets.sheet).toBe(PNG_1x1);

    const escape = new JSZip();
    escape.file('skin.json', JSON.stringify({ name: 'x', assets: { sheet: '../secret.png' } }));
    await expect(readSkinFile(await escape.generateAsync({ type: 'blob' }))).rejects.toThrow(SkinFileError);
    await expect(readSkinFile(new Blob(['not a skin']))).rejects.toThrow(/not a .eskin/);
  });
});

describe('shaped windows', () => {
  test('shapes become clip-paths built from numbers only', () => {
    expect(skinClipPath({ type: 'rounded', radius: 24 })).toBe('inset(0 round 24px)');
    expect(skinClipPath({ type: 'ellipse' })).toBe('ellipse(50% 50% at 50% 50%)');
    expect(skinClipPath({ type: 'polygon', points: [[50, 0], [100, 100], [0, 100]] })).toBe('polygon(50% 0%, 100% 100%, 0% 100%)');
    expect(skinClipPath({ type: 'polygon', points: [[50, 0], [100, 100], ['0); x' as unknown as number, 100]] })).toBeNull();
    expect(skinClipPath({ type: 'rounded', radius: 9999 })).toBeNull();
    expect(skinClipPath(undefined)).toBeNull();
  });

  test('a template with a window layer makes a frameless, masked, fixed-size skin', () => {
    const layout = layoutSkinTemplate(parts, ['app'], { window: { w: 420, h: 300 } });
    expect(layout.entries[0]).toMatchObject({ part: 'window', kind: 'window', w: 420, h: 300 });
    const skin = skinFromTemplate('Shaped', layout, PNG_1x1);
    expect(skin.parts.window).toBeUndefined();
    expect(skin.window).toEqual({
      frameless: true,
      shape: { type: 'mask', asset: 'sheet', x: layout.entries[0].x, y: layout.entries[0].y, w: 420, h: 300 },
      size: { w: 420, h: 300 },
      drag: ['app'],
    });
  });
});

describe('safe area inside shapes', () => {
  test('largestRect finds the biggest all-true box', () => {
    // 4x3 grid with a 2x2 hole-free block at the right.
    const grid = [
      false, true, true, true,
      false, false, true, true,
      true, false, true, true,
    ].map(Boolean);
    expect(largestRect(grid, 4, 3)).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(largestRect([false, false], 2, 1)).toBeNull();
  });

  test('a diamond polygon gives a centered box inside it; insets stay inside the window', () => {
    const rect = polygonSafeRect([[50, 0], [100, 50], [50, 100], [0, 50]])!;
    expect(rect.x + rect.w / 2).toBeCloseTo(0.5, 1);
    expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 1);
    expect(rect.w * rect.h).toBeGreaterThan(0.2);
    expect(rect.w * rect.h).toBeLessThanOrEqual(0.5);
    const insets = safeInsets({ safeRect: ELLIPSE_SAFE_RECT }, 400, 400);
    expect(insets.left).toBe(Math.round(400 * ELLIPSE_SAFE_RECT.x + 6));
    expect(insets.left + insets.right).toBeLessThan(400);
    expect(safeInsets({ safeRadius: 40 }, 300, 200).top).toBe(Math.round(40 * (1 - 1 / Math.SQRT2) + 6));
    expect(safeInsets(null, 300, 200)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  test('silhouettes cut a plain background away and skip art that fills the frame', () => {
    const w = 10;
    const h = 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const object = x >= 3 && x <= 6 && y >= 3 && y <= 6;
        rgba.set(object ? [120, 40, 200, 255] : [250, 250, 250, 255], i);
      }
    }
    const alpha = silhouetteAlpha(rgba, w, h)!;
    expect(alpha[0]).toBe(0);
    expect(alpha[4 * w + 4]).toBe(255);
    expect(Array.from(alpha).filter((a) => a === 255)).toHaveLength(16);
    const full = new Uint8ClampedArray(w * h * 4).fill(128);
    for (let i = 0; i < w * h; i++) full[i * 4 + 3] = 255;
    expect(silhouetteAlpha(full, w, h)).toBeNull();
  });
});
