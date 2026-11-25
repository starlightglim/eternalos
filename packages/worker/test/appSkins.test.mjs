// App skins: the .eskin format (normalizeSkin), image sniffing, the CSS the
// app runtime builds from a skin (eternalSkinCss, run with node:vm), and
// finding skinnable parts in app source.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import vm from 'node:vm';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { normalizeSkin, imageInfo, isSkinColor, SkinValidationError } = await import('../src/utils/appSkin.ts');
const { SKIN_CSS_JS, SKIN_RUNTIME_JS } = await import('../src/agents/tools/skinRuntime.ts');
const { scanSkinParts } = await import('../src/agents/tools/skinTools.ts');
const { pngDataUrl } = await import('./pngFixture.mjs');

const sheet = pngDataUrl(120, 40);

describe('normalizeSkin', () => {
  it('keeps a valid skin and drops unknown fields and unused images', () => {
    const skin = normalizeSkin({
      name: '  Brushed Metal ',
      evil: '<script>',
      colors: { accent: '#3af', 'text-muted': 'rgba(0, 0, 0, 0.6)', lcd: 'hsl(120, 80%, 40%)' },
      fonts: { font: '"Trebuchet MS", sans-serif' },
      parts: {
        play: { sprite: { asset: 'sheet', x: 0, y: 0, w: 30, h: 20, states: ['normal', 'hover', 'pressed'] } },
        button: { style: { gradient: { from: '#eee', to: '#999', angle: 180 }, bevel: 'raised', radius: 4 }, states: { pressed: { bevel: 'sunken' } } },
        digit: { sprite: { asset: 'sheet', x: 0, y: 20, w: 12, h: 20, frames: 10 } },
      },
      assets: { sheet, unused: pngDataUrl(4, 4) },
    });
    assert.equal(skin.name, 'Brushed Metal');
    assert.equal(skin.format, 'eternal-skin/1');
    assert.equal('evil' in skin, false);
    assert.deepEqual(Object.keys(skin.assets), ['sheet']);
    assert.deepEqual(skin.assets.sheet.width, 120);
    assert.deepEqual(skin.parts.play.sprite.states, ['normal', 'hover', 'pressed']);
    assert.equal(skin.parts.digit.sprite.frames, 10);
    assert.equal(skin.parts.button.states.pressed.bevel, 'sunken');
  });

  it('rejects anything that could become CSS or a request', () => {
    const bad = [
      { name: 'x', colors: { accent: 'red; background: url(https://evil.example)' } },
      { name: 'x', colors: { accent: 'var(--secret)' } },
      { name: 'x', colors: { accent: 'expression(alert(1))' } },
      { name: 'x', fonts: { font: 'x;}body{color:red' } },
      { name: 'x', parts: { 'bad name!': { style: { background: '#fff' } } } },
      { name: 'x', parts: { play: { style: { background: 'url(x)' } } } },
      { name: 'x', parts: { play: { sprite: { asset: 'sheet', x: 100, y: 0, w: 30, h: 20 } } }, assets: { sheet } },
      { name: 'x', parts: { play: { style: { texture: { asset: 'nope' } } } } },
      { name: 'x', parts: { play: { style: { background: '#fff' } } }, assets: { sheet: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') } },
      { name: 'x', parts: { play: { style: { background: '#fff' } } }, assets: { sheet: 'https://evil.example/x.png' } },
      { name: 'x' },
    ];
    for (const raw of bad) {
      assert.throws(() => normalizeSkin(raw), SkinValidationError, JSON.stringify(raw).slice(0, 120));
    }
  });

  it('takes a shaped, frameless window and refuses bad shapes', () => {
    const shaped = normalizeSkin({
      name: 'Round',
      window: { frameless: true, shape: { type: 'polygon', points: [[50, 0], [100, 50], [50, 100], [0, 50.123]] }, size: { w: 300, h: 300 }, drag: ['app', 'display'], close: 'close-button', evil: 1 },
    });
    assert.deepEqual(shaped.window, { frameless: true, shape: { type: 'polygon', points: [[50, 0], [100, 50], [50, 100], [0, 50.12]] }, size: { w: 300, h: 300 }, drag: ['app', 'display'], close: 'close-button' });
    const masked = normalizeSkin({ name: 'Mask', window: { frameless: true, shape: { type: 'mask', asset: 'm', x: 0, y: 0, w: 60, h: 40 } }, assets: { m: sheet } });
    assert.deepEqual(Object.keys(masked.assets), ['m'], 'the mask image is kept');
    for (const bad of [
      { shape: { type: 'polygon', points: [[0, 0], [200, 0], [0, 100]] } },
      { shape: { type: 'polygon', points: [[0, 0], [1, 1]] } },
      { shape: { type: 'mask', asset: 'nope' } },
      { shape: { type: 'mask', asset: 'm', x: 100, y: 0, w: 60, h: 40 } },
      { shape: { type: 'clip-path(url(x))' } },
      { frameless: true, close: 'x"]{}' },
      { frameless: true, size: { w: 10, h: 10 } },
    ]) {
      assert.throws(() => normalizeSkin({ name: 'x', window: bad, assets: { m: sheet } }), SkinValidationError, JSON.stringify(bad));
    }
  });

  it('lenient mode (assistant skins) drops bad fields instead', () => {
    const skin = normalizeSkin({ colors: { accent: 'url(x)', text: '#111' }, parts: { app: { style: { background: 'nope()', text: '#222' } } } }, { lenient: true });
    assert.equal(skin.name, 'Untitled skin');
    assert.deepEqual(skin.colors, { text: '#111' });
    assert.deepEqual(skin.parts.app.style, { text: '#222' });
  });

  it('knows colors and image types by their bytes', () => {
    for (const ok of ['#abc', '#aabbcc80', 'rgb(1, 2, 3)', 'rgba(1,2,3,0.5)', 'hsl(120 50% 40%)', 'tomato']) assert.equal(isSkinColor(ok), true, ok);
    for (const no of ['inherit', 'var(--x)', 'red;', '#ab', 'url(x)', 'rgb(1,2,3);x', '']) assert.equal(isSkinColor(no), false, no);
    const png = Buffer.from(sheet.split(',')[1], 'base64');
    assert.deepEqual(imageInfo(new Uint8Array(png)), { type: 'image/png', width: 120, height: 40 });
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    assert.deepEqual(imageInfo(new Uint8Array(gif)), { type: 'image/gif', width: 1, height: 1 });
    // JPEG: SOI, APP0, SOF0 with 16x8.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x10, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(imageInfo(jpeg), { type: 'image/jpeg', width: 16, height: 8 });
    assert.equal(imageInfo(new TextEncoder().encode('<svg></svg>')), null);
  });
});

describe('eternalSkinCss (app runtime)', () => {
  const eternalSkinCss = vm.runInNewContext(`${SKIN_CSS_JS}; eternalSkinCss`);

  it('styles universal and declared parts with states, frames and colors', () => {
    const css = eternalSkinCss({
      colors: { accent: '#ff00aa', lcd: '#0f0' },
      fonts: { font: 'Georgia, serif' },
      parts: {
        button: { style: { background: '#ddd', bevel: 'raised', radius: 3 }, states: { pressed: { bevel: 'sunken' }, disabled: { text: '#999' } } },
        play: { sprite: { asset: 'sheet', x: 0, y: 0, w: 30, h: 20, states: ['normal', 'hover'] } },
        digit: { sprite: { asset: 'sheet', x: 0, y: 20, w: 12, h: 20, frames: 2 } },
        app: { style: { texture: { asset: 'wood', size: 256 }, background: '#553' } },
        scrollbar: { style: { background: '#222', text: '#888' } },
      },
    }, {
      assets: { wood: 'blob:null/wood-1' },
      cells: { play: { normal: 'blob:null/p0', hover: 'blob:null/p1' }, digit: { frames: ['blob:null/d0', 'blob:null/d1'] } },
    });
    assert.match(css, /:root \{[^}]*--eternal-accent: #ff00aa !important;[^}]*--skin-lcd: #0f0 !important;[^}]*--eternal-font: Georgia, serif !important;/s);
    assert.match(css, /button:not\(\[data-skin\]\)[\s\S]*background-color: #ddd !important;/);
    assert.match(css, /button:not\(\[data-skin\]\):active:not\(:disabled\)[\s\S]*box-shadow: inset 1px 1px 0 var\(--skin-bevel-dark/);
    assert.match(css, /button:not\(\[data-skin\]\):disabled[\s\S]*color: #999 !important;/);
    assert.match(css, /\[data-skin~="play"\] \{\n  background: url\("blob:null\/p0"\)/);
    assert.match(css, /\[data-skin~="play"\]:hover:not\(:disabled\)[^{]*\{\n  background: url\("blob:null\/p1"\)/);
    assert.match(css, /\[data-skin~="digit"\]\[data-skin-frame="1"\] \{\n  background: url\("blob:null\/d1"\)/);
    assert.match(css, /body \{[^}]*background-image: url\("blob:null\/wood-1"\)[^}]*background-size: 256px/s);
    assert.match(css, /scrollbar-color: #888 #222/);
  });

  it('drops hostile values even if they get past the server', () => {
    const css = eternalSkinCss({
      colors: { accent: 'red;}body{display:none', 'x}y': '#fff' },
      fonts: { font: 'a;}*{x:y' },
      parts: {
        'evil"]{}': { style: { background: '#fff' } },
        play: { style: { background: 'url(https://evil.example)', border: { width: 2, color: 'red;}', style: 'solid;}' }, radius: '4px;}' } },
        pic: { sprite: { asset: 'a', x: 0, y: 0, w: 1, h: 1 } },
      },
    }, { assets: { a: 'https://evil.example/x.png' }, cells: { pic: { normal: 'javascript:alert(1)', hover: 'data:image/svg+xml;base64,PHN2Zz4=', pressed: 'data:image/png;base64,AAA")}body{x:url(evil' } } });
    assert.doesNotMatch(css, /evil|display:none|javascript|x\}y|;\}/);
    assert.match(css, /\[data-skin~="play"\] \{\n  border: 2px solid currentcolor !important;\n\}/);
  });

  it('is plain script that parses inside the runtime', () => {
    assert.doesNotThrow(() => new vm.Script(`(function(){${SKIN_RUNTIME_JS}})`));
  });
});

describe('scanSkinParts', () => {
  it('finds data-skin parts in HTML and JS, with labels and frames', () => {
    const parts = scanSkinParts({
      'index.html': '<button data-skin="play" data-skin-label="Play">▶</button><div class="lcd" data-skin="display panel"></div><span data-skin="digit" data-skin-frames="10"></span><button data-skin="button">x</button>',
      'app.js': "el.dataset.skin = 'knob'; other.setAttribute('data-skin', 'eq-slider');",
      'server.js': "html = '<b data-skin=\"secret\">'",
    });
    assert.deepEqual(parts.map((part) => part.name), ['play', 'display', 'panel', 'digit', 'knob', 'eq-slider']);
    assert.equal(parts[0].label, 'Play');
    assert.deepEqual(parts[0].states, ['normal', 'hover', 'pressed', 'disabled']);
    assert.equal(parts.find((part) => part.name === 'digit').frames, 10);
  });
});
