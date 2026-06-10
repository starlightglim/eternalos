/**
 * CONSOLE_RUNTIME_JS — the EternalOS fantasy-console runtime.
 *
 * Served by the per-game Dynamic Worker as `runtime.js` and loaded by the
 * console shell HTML inside a sandboxed iframe (sandbox="allow-scripts",
 * opaque origin). This file is the trusted half of the sandbox: it draws the
 * 128x128 screen, runs the fixed 30fps game loop, synthesizes sound effects,
 * and brokers saves/multiplayer through the host via postMessage and the
 * game worker's /_console endpoints.
 *
 * Untrusted cartridge code is compiled with the Function constructor inside
 * this iframe. That is the deliberate, designed sandbox boundary: the iframe
 * has an opaque origin, no cookies, no parent DOM access, and a CSP without
 * connect-src escape hatches — game code can only talk to the world through
 * the console API surface defined here.
 *
 * Mirrors the spec constants in utils/cartridge.ts. Same string-constant
 * delivery pattern as ETERNAL_RUNTIME_JS in agents/tools/appTools.ts.
 *
 * NOTE: written without template literals or '</' + 'script' sequences so it
 * can be embedded safely anywhere.
 */

export const CONSOLE_RUNTIME_JS = String.raw`(() => {
  'use strict';

  var SCREEN = 128;
  var TARGET_FPS = 30;
  var SAVE_FLUSH_MS = 5000;
  var MAX_SAVE_BYTES = 32 * 1024;

  var DEFAULT_PALETTE = [
    '#000000', '#1D2B53', '#7E2553', '#008751',
    '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
    '#FF004D', '#FFA300', '#FFEC27', '#00E436',
    '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA'
  ];

  // ------------------------------------------------------------------
  // Canvas + framebuffer
  // ------------------------------------------------------------------
  var canvas = document.getElementById('screen');
  var ctx2d = canvas.getContext('2d');
  var imageData = ctx2d.createImageData(SCREEN, SCREEN);
  var fb = new Uint8Array(SCREEN * SCREEN);        // palette indices
  var sprites = new Uint8Array(SCREEN * SCREEN);   // sprite sheet pixels
  var spriteFlags = new Uint8Array(256);
  var palR = new Uint8Array(16);
  var palG = new Uint8Array(16);
  var palB = new Uint8Array(16);

  function setPalette(hexList) {
    for (var i = 0; i < 16; i++) {
      var hex = (hexList && hexList[i]) || DEFAULT_PALETTE[i];
      palR[i] = parseInt(hex.slice(1, 3), 16);
      palG[i] = parseInt(hex.slice(3, 5), 16);
      palB[i] = parseInt(hex.slice(5, 7), 16);
    }
  }
  setPalette(null);

  function flip() {
    var d = imageData.data;
    for (var i = 0, j = 0; i < fb.length; i++, j += 4) {
      var c = fb[i];
      d[j] = palR[c];
      d[j + 1] = palG[c];
      d[j + 2] = palB[c];
      d[j + 3] = 255;
    }
    ctx2d.putImageData(imageData, 0, 0);
  }

  // ------------------------------------------------------------------
  // Draw state
  // ------------------------------------------------------------------
  var camX = 0, camY = 0;
  var drawPal = new Uint8Array(16);
  var transparent = new Uint8Array(16);
  function resetDrawPal() {
    for (var i = 0; i < 16; i++) { drawPal[i] = i; transparent[i] = 0; }
    transparent[0] = 1;
  }
  resetDrawPal();

  function col(c) {
    c = Math.floor(Number(c) || 0);
    return ((c % 16) + 16) % 16;
  }

  function pset(x, y, c) {
    x = Math.floor(x) - camX;
    y = Math.floor(y) - camY;
    if (x < 0 || y < 0 || x >= SCREEN || y >= SCREEN) return;
    fb[y * SCREEN + x] = drawPal[col(c)];
  }

  function pget(x, y) {
    x = Math.floor(x); y = Math.floor(y);
    if (x < 0 || y < 0 || x >= SCREEN || y >= SCREEN) return 0;
    return fb[y * SCREEN + x];
  }

  function cls(c) {
    fb.fill(c === undefined ? 0 : col(c));
  }

  function line(x0, y0, x1, y1, c) {
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    x1 = Math.floor(x1); y1 = Math.floor(y1);
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    for (;;) {
      pset(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  function rect(x0, y0, x1, y1, c) {
    line(x0, y0, x1, y0, c);
    line(x1, y0, x1, y1, c);
    line(x1, y1, x0, y1, c);
    line(x0, y1, x0, y0, c);
  }

  function rectfill(x0, y0, x1, y1, c) {
    var xa = Math.floor(Math.min(x0, x1)), xb = Math.floor(Math.max(x0, x1));
    var ya = Math.floor(Math.min(y0, y1)), yb = Math.floor(Math.max(y0, y1));
    for (var y = ya; y <= yb; y++) {
      for (var x = xa; x <= xb; x++) pset(x, y, c);
    }
  }

  function circ(cx, cy, r, c) {
    cx = Math.floor(cx); cy = Math.floor(cy); r = Math.floor(Math.abs(r));
    var x = r, y = 0, err = 1 - r;
    while (x >= y) {
      pset(cx + x, cy + y, c); pset(cx + y, cy + x, c);
      pset(cx - y, cy + x, c); pset(cx - x, cy + y, c);
      pset(cx - x, cy - y, c); pset(cx - y, cy - x, c);
      pset(cx + y, cy - x, c); pset(cx + x, cy - y, c);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  }

  function circfill(cx, cy, r, c) {
    cx = Math.floor(cx); cy = Math.floor(cy); r = Math.floor(Math.abs(r));
    for (var dy = -r; dy <= r; dy++) {
      var w = Math.floor(Math.sqrt(r * r - dy * dy));
      for (var dx = -w; dx <= w; dx++) pset(cx + dx, cy + dy, c);
    }
  }

  function camera(x, y) {
    camX = x === undefined ? 0 : Math.floor(x);
    camY = y === undefined ? 0 : Math.floor(y);
  }

  function pal(c0, c1) {
    if (c0 === undefined) { resetDrawPal(); return; }
    drawPal[col(c0)] = col(c1 === undefined ? c0 : c1);
  }

  function palt(c, t) {
    if (c === undefined) {
      for (var i = 0; i < 16; i++) transparent[i] = 0;
      transparent[0] = 1;
      return;
    }
    transparent[col(c)] = t ? 1 : 0;
  }

  // ------------------------------------------------------------------
  // Sprites
  // ------------------------------------------------------------------
  function sheetPixel(sx, sy) {
    if (sx < 0 || sy < 0 || sx >= SCREEN || sy >= SCREEN) return 0;
    return sprites[sy * SCREEN + sx];
  }

  function blitPixel(sx, sy, dx, dy) {
    var c = sheetPixel(sx, sy);
    if (transparent[c]) return;
    dx = dx - camX; dy = dy - camY;
    if (dx < 0 || dy < 0 || dx >= SCREEN || dy >= SCREEN) return;
    fb[dy * SCREEN + dx] = drawPal[c];
  }

  function spr(n, x, y, w, h, flipX, flipY) {
    n = Math.floor(n) & 255;
    w = w === undefined ? 1 : w;
    h = h === undefined ? 1 : h;
    x = Math.floor(x); y = Math.floor(y);
    var sx0 = (n % 16) * 8;
    var sy0 = Math.floor(n / 16) * 8;
    var pw = Math.floor(w * 8), ph = Math.floor(h * 8);
    for (var py = 0; py < ph; py++) {
      for (var px = 0; px < pw; px++) {
        var sx = sx0 + (flipX ? pw - 1 - px : px);
        var sy = sy0 + (flipY ? ph - 1 - py : py);
        blitPixel(sx, sy, x + px, y + py);
      }
    }
  }

  function sspr(sx, sy, sw, sh, dx, dy, dw, dh, flipX, flipY) {
    dw = dw === undefined ? sw : dw;
    dh = dh === undefined ? sh : dh;
    sx = Math.floor(sx); sy = Math.floor(sy);
    sw = Math.floor(sw); sh = Math.floor(sh);
    dx = Math.floor(dx); dy = Math.floor(dy);
    dw = Math.floor(dw); dh = Math.floor(dh);
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    for (var py = 0; py < dh; py++) {
      for (var px = 0; px < dw; px++) {
        var u = Math.floor(px * sw / dw);
        var v = Math.floor(py * sh / dh);
        var ssx = sx + (flipX ? sw - 1 - u : u);
        var ssy = sy + (flipY ? sh - 1 - v : v);
        blitPixel(ssx, ssy, dx + px, dy + py);
      }
    }
  }

  function fget(n, f) {
    var bits = spriteFlags[Math.floor(n) & 255];
    if (f === undefined) return bits;
    return (bits >> Math.floor(f)) & 1 ? true : false;
  }

  function fset(n, f, v) {
    n = Math.floor(n) & 255;
    if (v === undefined) { spriteFlags[n] = Math.floor(f) & 255; return; }
    var bit = 1 << Math.floor(f);
    if (v) spriteFlags[n] |= bit; else spriteFlags[n] &= ~bit;
  }

  // ------------------------------------------------------------------
  // 3x5 bitmap font (rows top to bottom, 3 bits per row, bit 2 = left)
  // ------------------------------------------------------------------
  var FONT = {
    'A': [2,5,7,5,5], 'B': [6,5,6,5,6], 'C': [3,4,4,4,3], 'D': [6,5,5,5,6],
    'E': [7,4,6,4,7], 'F': [7,4,6,4,4], 'G': [3,4,5,5,3], 'H': [5,5,7,5,5],
    'I': [7,2,2,2,7], 'J': [1,1,1,5,2], 'K': [5,5,6,5,5], 'L': [4,4,4,4,7],
    'M': [5,7,7,5,5], 'N': [6,5,5,5,5], 'O': [2,5,5,5,2], 'P': [6,5,6,4,4],
    'Q': [2,5,5,6,3], 'R': [6,5,6,5,5], 'S': [3,4,2,1,6], 'T': [7,2,2,2,2],
    'U': [5,5,5,5,7], 'V': [5,5,5,5,2], 'W': [5,5,7,7,5], 'X': [5,5,2,5,5],
    'Y': [5,5,2,2,2], 'Z': [7,1,2,4,7],
    '0': [7,5,5,5,7], '1': [2,6,2,2,7], '2': [6,1,2,4,7], '3': [7,1,3,1,7],
    '4': [5,5,7,1,1], '5': [7,4,6,1,6], '6': [3,4,7,5,7], '7': [7,1,2,2,2],
    '8': [7,5,7,5,7], '9': [7,5,7,1,6],
    ' ': [0,0,0,0,0], '.': [0,0,0,0,2], ',': [0,0,0,2,4], '!': [2,2,2,0,2],
    '?': [6,1,2,0,2], ':': [0,2,0,2,0], ';': [0,2,0,2,4], '-': [0,0,7,0,0],
    '_': [0,0,0,0,7], '+': [0,2,7,2,0], '/': [1,1,2,4,4], '\\': [4,4,2,1,1],
    '(': [1,2,2,2,1], ')': [4,2,2,2,4], '[': [3,2,2,2,3], ']': [6,2,2,2,6],
    '<': [1,2,4,2,1], '>': [4,2,1,2,4], '=': [0,7,0,7,0], '*': [5,2,7,2,5],
    "'": [2,2,0,0,0], '"': [5,5,0,0,0], '%': [5,1,2,4,5], '#': [5,7,5,7,5],
    '@': [2,5,7,4,3], '&': [2,5,2,5,3], '^': [2,5,0,0,0], '~': [0,1,7,4,0],
    '|': [2,2,2,2,2], '{': [3,2,6,2,3], '}': [6,2,3,2,6], '$': [3,6,2,3,6]
  };

  var printCursorX = 0, printCursorY = 0;

  function print(str, x, y, c) {
    if (str === undefined || str === null) str = '';
    str = String(str);
    if (x === undefined) { x = printCursorX; y = printCursorY; printCursorY += 6; }
    if (c === undefined) c = 7;
    var cx = Math.floor(x), cy = Math.floor(y);
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch === '\n') { cx = Math.floor(x); cy += 6; continue; }
      var glyph = FONT[ch] || FONT[ch.toUpperCase()] || FONT['?'];
      for (var row = 0; row < 5; row++) {
        var bits = glyph[row];
        if (bits & 4) pset(cx, cy + row, c);
        if (bits & 2) pset(cx + 1, cy + row, c);
        if (bits & 1) pset(cx + 2, cy + row, c);
      }
      cx += 4;
    }
    return cx;
  }

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------
  var BTN_COUNT = 6;
  var btnState = new Uint8Array(BTN_COUNT);
  var btnPrev = new Uint8Array(BTN_COUNT);
  var btnHeld = new Int32Array(BTN_COUNT);

  var KEYMAP = {
    'ArrowLeft': 0, 'a': 0, 'A': 0,
    'ArrowRight': 1, 'd': 1, 'D': 1,
    'ArrowUp': 2, 'w': 2, 'W': 2,
    'ArrowDown': 3, 's': 3, 'S': 3,
    'z': 4, 'Z': 4, 'c': 4, 'C': 4, 'n': 4, 'N': 4,
    'x': 5, 'X': 5, 'v': 5, 'V': 5, 'm': 5, 'M': 5
  };

  function setBtn(i, down) {
    if (i >= 0 && i < BTN_COUNT) btnState[i] = down ? 1 : 0;
  }

  window.addEventListener('keydown', function (e) {
    unlockAudio();
    var b = KEYMAP[e.key];
    if (b !== undefined) { setBtn(b, true); e.preventDefault(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === ' ') e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    var b = KEYMAP[e.key];
    if (b !== undefined) { setBtn(b, false); e.preventDefault(); }
  });
  window.addEventListener('pointerdown', function () { unlockAudio(); });
  window.addEventListener('blur', function () { btnState.fill(0); });

  function btn(i) {
    if (i === undefined) {
      var mask = 0;
      for (var b = 0; b < BTN_COUNT; b++) if (btnState[b]) mask |= (1 << b);
      return mask;
    }
    return !!btnState[Math.floor(i)];
  }

  function btnp(i) {
    i = Math.floor(i);
    if (i < 0 || i >= BTN_COUNT) return false;
    var held = btnHeld[i];
    // PICO-8 style key repeat: fires on press, again at 15 frames, then every 4.
    return held === 1 || (held >= 15 && (held - 15) % 4 === 0);
  }

  function tickInput() {
    for (var i = 0; i < BTN_COUNT; i++) {
      if (btnState[i]) btnHeld[i] = btnPrev[i] ? btnHeld[i] + 1 : 1;
      else btnHeld[i] = 0;
      btnPrev[i] = btnState[i];
    }
  }

  // ------------------------------------------------------------------
  // Audio — 16 synthesized SFX, WebAudio, unlocked on first gesture
  // ------------------------------------------------------------------
  var audioCtx = null;
  var audioUnlocked = false;

  function unlockAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) { return; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    audioUnlocked = true;
  }

  function noiseBuffer(seconds) {
    var len = Math.floor(audioCtx.sampleRate * seconds);
    var buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  function tone(type, f0, f1, dur, vol) {
    var t = audioCtx.currentTime;
    var osc = audioCtx.createOscillator();
    var gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function noise(dur, vol, filterFreq) {
    var t = audioCtx.currentTime;
    var src = audioCtx.createBufferSource();
    src.buffer = noiseBuffer(dur);
    var filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, t);
    filter.frequency.exponentialRampToValueAtTime(100, t + dur);
    var gain = audioCtx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(audioCtx.destination);
    src.start(t);
  }

  function arp(type, freqs, noteDur, vol) {
    var t = audioCtx.currentTime;
    for (var i = 0; i < freqs.length; i++) {
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freqs[i], t + i * noteDur);
      gain.gain.setValueAtTime(0.0001, t + i * noteDur);
      gain.gain.linearRampToValueAtTime(vol, t + i * noteDur + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (i + 1) * noteDur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + i * noteDur);
      osc.stop(t + (i + 1) * noteDur + 0.02);
    }
  }

  var SFX_TABLE = [
    function () { tone('square', 880, 880, 0.06, 0.15); },                 // 0 blip
    function () { tone('square', 150, 600, 0.18, 0.2); },                  // 1 jump
    function () { arp('square', [988, 1319], 0.07, 0.18); },               // 2 coin
    function () { tone('sawtooth', 400, 90, 0.25, 0.25); },                // 3 hurt
    function () { noise(0.5, 0.35, 1200); },                               // 4 explosion
    function () { arp('square', [262, 330, 392, 523, 659], 0.06, 0.16); }, // 5 powerup
    function () { tone('sawtooth', 1200, 180, 0.12, 0.2); },               // 6 laser
    function () { tone('triangle', 660, 660, 0.05, 0.2); },                // 7 select
    function () { arp('sine', [523, 784], 0.06, 0.2); },                   // 8 pickup
    function () { tone('triangle', 110, 70, 0.1, 0.3); },                  // 9 bump
    function () { noise(0.18, 0.2, 2500); },                               // 10 splash
    function () { noise(0.05, 0.1, 1800); },                               // 11 step
    function () { arp('square', [523, 659, 784, 1047], 0.1, 0.18); },      // 12 win
    function () { arp('square', [392, 330, 262, 196], 0.12, 0.18); },      // 13 lose
    function () { tone('square', 440, 440, 0.1, 0.15); },                  // 14 beep low
    function () { tone('square', 1760, 1760, 0.08, 0.12); }                // 15 beep high
  ];

  function sfx(n) {
    if (!audioUnlocked || !audioCtx) return;
    var f = SFX_TABLE[Math.floor(n) & 15];
    if (f) { try { f(); } catch (e) { /* audio is best-effort */ } }
  }

  // ------------------------------------------------------------------
  // Math helpers (PICO-8 conventions: trig in turns, sin inverted)
  // ------------------------------------------------------------------
  var TAU = Math.PI * 2;
  function flr(x) { return Math.floor(x); }
  function ceil(x) { return Math.ceil(x); }
  function abs(x) { return Math.abs(x); }
  function sqrt(x) { return Math.sqrt(Math.max(0, x)); }
  function min(a, b) { return Math.min(a, b); }
  function max(a, b) { return Math.max(a, b); }
  function mid(a, b, c) {
    var lo = Math.min(a, Math.min(b, c));
    var hi = Math.max(a, Math.max(b, c));
    return a + b + c - lo - hi;
  }
  function sin(x) { return -Math.sin((x || 0) * TAU); }
  function cos(x) { return Math.cos((x || 0) * TAU); }
  function atan2(dx, dy) {
    var a = Math.atan2(-dy, dx) / TAU;
    return a < 0 ? a + 1 : a;
  }
  function rnd(n) {
    if (Array.isArray(n)) return n[Math.floor(Math.random() * n.length)];
    return Math.random() * (n === undefined ? 1 : n);
  }

  var bootTime = performance.now();
  function time() { return (performance.now() - bootTime) / 1000; }

  var actualFps = 0;
  function stat(n) {
    n = Math.floor(n);
    if (n === 0) return actualFps;
    if (n === 7) return TARGET_FPS;
    return 0;
  }

  // ------------------------------------------------------------------
  // Host messaging
  // ------------------------------------------------------------------
  function toHost(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* detached */ }
  }

  // ------------------------------------------------------------------
  // Saves — dset/dget backed by /_console/save (capability) or host
  // localStorage (anonymous visitors, via postMessage fallback)
  // ------------------------------------------------------------------
  var saveData = {};
  var saveDirty = false;
  var saveTimer = null;
  var capability = null;

  function dset(key, value) {
    key = String(key);
    try { JSON.stringify(value); } catch (e) { throw new Error('dset value must be JSON-serializable'); }
    saveData[key] = value;
    saveDirty = true;
    if (!saveTimer) saveTimer = setTimeout(flushSave, SAVE_FLUSH_MS);
  }

  function dget(key) {
    return saveData[String(key)];
  }

  function flushSave() {
    saveTimer = null;
    if (!saveDirty) return;
    var body = JSON.stringify(saveData);
    if (body.length > MAX_SAVE_BYTES) {
      console.warn('[console] save data exceeds 32KB; not saved');
      return;
    }
    saveDirty = false;
    if (capability) {
      fetch('./_console/save', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'authorization': 'Capability ' + capability },
        body: JSON.stringify({ data: body })
      }).catch(function () { saveDirty = true; });
    } else {
      toHost({ type: 'console:save', data: body });
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSave();
  });
  window.addEventListener('pagehide', flushSave);

  function loadSave() {
    if (!capability) return Promise.resolve();
    return fetch('./_console/save', {
      headers: { 'authorization': 'Capability ' + capability }
    }).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (json) {
      if (json && typeof json.data === 'string' && json.data) {
        try { saveData = JSON.parse(json.data) || {}; } catch (e) { saveData = {}; }
      }
    }).catch(function () { /* play without cloud save */ });
  }

  // ------------------------------------------------------------------
  // Multiplayer (net.*) — relay plumbing; host bridges to RealtimeRoom
  // ------------------------------------------------------------------
  var netState = {
    connected: false,
    selfId: null,
    roomCode: null,
    peers: [],
    pending: null,
    onMessage: [],
    onPeerJoin: [],
    onPeerLeave: []
  };

  function netConnect(roomCode) {
    if (netState.pending) return netState.pending.promise;
    var resolve, reject;
    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    netState.pending = { promise: promise, resolve: resolve, reject: reject };
    toHost({ type: 'net:connect', roomCode: roomCode || null });
    setTimeout(function () {
      if (netState.pending) {
        netState.pending.reject(new Error('multiplayer unavailable'));
        netState.pending = null;
      }
    }, 10000);
    return promise;
  }

  var net = {
    host: function () { return netConnect(null); },
    join: function (roomCode) { return netConnect(String(roomCode || '').toUpperCase()); },
    leave: function () {
      toHost({ type: 'net:leave' });
      netState.connected = false;
      netState.peers = [];
      netState.roomCode = null;
    },
    send: function (data, to) {
      if (!netState.connected) return;
      toHost({ type: 'net:send', data: data, to: to || null });
    },
    onMessage: function (cb) { netState.onMessage.push(cb); return function () { remove(netState.onMessage, cb); }; },
    onPeerJoin: function (cb) { netState.onPeerJoin.push(cb); return function () { remove(netState.onPeerJoin, cb); }; },
    onPeerLeave: function (cb) { netState.onPeerLeave.push(cb); return function () { remove(netState.onPeerLeave, cb); }; },
    peers: function () { return netState.peers.slice(); },
    id: function () { return netState.selfId; },
    roomCode: function () { return netState.roomCode; },
    connected: function () { return netState.connected; }
  };

  function remove(arr, item) {
    var i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  }

  function fire(list, arg1, arg2) {
    for (var i = 0; i < list.length; i++) {
      try { list[i](arg1, arg2); } catch (e) { console.error(e); }
    }
  }

  // ------------------------------------------------------------------
  // Crash screen
  // ------------------------------------------------------------------
  var crashed = false;

  function crash(err, phase) {
    if (crashed) return;
    crashed = true;
    var message = err && err.message ? err.message : String(err);
    var stack = err && err.stack ? String(err.stack) : '';
    toHost({ type: 'console:error', message: message, stack: stack, phase: phase });
    camera();
    resetDrawPal();
    cls(1);
    rectfill(0, 0, 127, 8, 8);
    print('CRASH!', 2, 2, 7);
    var words = (phase + ': ' + message).split(' ');
    var lineText = '', cy = 14;
    for (var i = 0; i < words.length && cy < 110; i++) {
      var next = lineText ? lineText + ' ' + words[i] : words[i];
      if (next.length > 31) {
        print(lineText, 2, cy, 7);
        cy += 7;
        lineText = words[i];
      } else {
        lineText = next;
      }
    }
    if (lineText && cy < 110) print(lineText, 2, cy, 7);
    print('CHECK CODE AND RE-RUN', 2, 118, 6);
    flip();
  }

  // ------------------------------------------------------------------
  // Cartridge loading + game loop
  // ------------------------------------------------------------------
  var hooks = { _init: null, _update: null, _update60: null, _draw: null };
  var running = false;
  var paused = false;

  function parseSpritesheet(text) {
    var rows = String(text || '').split('\n');
    for (var y = 0; y < SCREEN; y++) {
      var row = rows[y] || '';
      for (var x = 0; x < SCREEN; x++) {
        var ch = row.charCodeAt(x);
        var v = 0;
        if (ch >= 48 && ch <= 57) v = ch - 48;
        else if (ch >= 97 && ch <= 102) v = ch - 87;
        else if (ch >= 65 && ch <= 70) v = ch - 55;
        sprites[y * SCREEN + x] = v;
      }
    }
  }

  function parseFlags(hex) {
    hex = String(hex || '');
    for (var i = 0; i < 256; i++) {
      var pair = hex.slice(i * 2, i * 2 + 2);
      spriteFlags[i] = pair ? parseInt(pair, 16) || 0 : 0;
    }
  }

  function compileCart(code) {
    var api = {
      cls: cls, pset: pset, pget: pget, line: line, rect: rect, rectfill: rectfill,
      circ: circ, circfill: circfill, spr: spr, sspr: sspr, print: print,
      camera: camera, pal: pal, palt: palt, btn: btn, btnp: btnp, sfx: sfx,
      rnd: rnd, flr: flr, ceil: ceil, abs: abs, min: min, max: max, mid: mid,
      sin: sin, cos: cos, atan2: atan2, sqrt: sqrt, time: time, t: time,
      fget: fget, fset: fset, stat: stat, dset: dset, dget: dget, net: net
    };
    var names = Object.keys(api);
    var body = '"use strict";\n' + code +
      '\nreturn {' +
      ' _init: (typeof _init !== "undefined") ? _init : null,' +
      ' _update: (typeof _update !== "undefined") ? _update : null,' +
      ' _update60: (typeof _update60 !== "undefined") ? _update60 : null,' +
      ' _draw: (typeof _draw !== "undefined") ? _draw : null };' +
      '\n//# sourceURL=cartridge.js';
    // The Function constructor is the designed execution mechanism for
    // untrusted cartridge code: this iframe (opaque origin, restrictive CSP)
    // is the sandbox boundary. See file header.
    var factory = Function.apply(null, names.concat([body]));
    var result = factory.apply(null, names.map(function (k) { return api[k]; }));
    hooks._init = typeof result._init === 'function' ? result._init : null;
    hooks._update = typeof result._update === 'function' ? result._update : null;
    hooks._update60 = typeof result._update60 === 'function' ? result._update60 : null;
    hooks._draw = typeof result._draw === 'function' ? result._draw : null;
  }

  var accumulator = 0;
  var lastFrame = 0;
  var frameCount = 0;
  var fpsWindowStart = 0;

  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);
    if (paused || crashed) { lastFrame = now; return; }

    var dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    accumulator += dt;

    var use60 = !!hooks._update60;
    var step = use60 ? 1 / 60 : 1 / TARGET_FPS;
    var updated = false;

    while (accumulator >= step) {
      accumulator -= step;
      tickInput();
      try {
        if (use60) hooks._update60();
        else if (hooks._update) hooks._update();
      } catch (err) {
        crash(err, '_update');
        return;
      }
      updated = true;
    }

    if (updated && hooks._draw) {
      try { hooks._draw(); } catch (err) { crash(err, '_draw'); return; }
      flip();
      frameCount++;
    }

    if (now - fpsWindowStart >= 1000) {
      actualFps = frameCount;
      frameCount = 0;
      fpsWindowStart = now;
    }
  }

  function startGame(code) {
    try {
      compileCart(code);
    } catch (err) {
      crash(err, 'load');
      return;
    }
    if (hooks._init) {
      try { hooks._init(); } catch (err) { crash(err, '_init'); return; }
    }
    bootTime = performance.now();
    running = true;
    lastFrame = performance.now();
    fpsWindowStart = lastFrame;
    if (hooks._draw) {
      try { hooks._draw(); flip(); } catch (err) { crash(err, '_draw'); }
    }
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------
  // Boot: fetch cartridge, wait for host init, go
  // ------------------------------------------------------------------
  var cartridge = null;
  var hostInitialized = false;

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'console:init':
        if (hostInitialized) return;
        hostInitialized = true;
        capability = typeof msg.capability === 'string' ? msg.capability : null;
        if (!capability && typeof msg.saveData === 'string' && msg.saveData) {
          try { saveData = JSON.parse(msg.saveData) || {}; } catch (e) { saveData = {}; }
        }
        loadSave().then(function () {
          if (cartridge) startGame(cartridge.code);
        });
        break;
      case 'console:capability':
        // Host refreshes the short-lived capability before it expires.
        if (typeof msg.capability === 'string') capability = msg.capability;
        break;
      case 'console:setBtn':
        setBtn(Math.floor(msg.i), !!msg.down);
        break;
      case 'console:pause': paused = true; break;
      case 'console:resume': paused = false; lastFrame = performance.now(); break;
      case 'net:joined':
        netState.connected = true;
        netState.selfId = msg.self && msg.self.peerId;
        netState.roomCode = msg.roomCode || null;
        netState.peers = Array.isArray(msg.peers) ? msg.peers : [];
        if (netState.pending) {
          netState.pending.resolve({ roomCode: netState.roomCode, selfId: netState.selfId, peers: netState.peers.slice() });
          netState.pending = null;
        }
        break;
      case 'net:error':
        if (netState.pending) {
          netState.pending.reject(new Error(msg.message || 'multiplayer error'));
          netState.pending = null;
        }
        break;
      case 'net:peerJoin':
        if (msg.peer) {
          netState.peers.push(msg.peer);
          fire(netState.onPeerJoin, msg.peer);
        }
        break;
      case 'net:peerLeave':
        netState.peers = netState.peers.filter(function (p) { return p.peerId !== msg.peerId; });
        fire(netState.onPeerLeave, msg.peerId);
        break;
      case 'net:msg':
        fire(netState.onMessage, msg.data, msg.from);
        break;
      default:
        break;
    }
  });

  fetch('./cartridge.json')
    .then(function (res) {
      if (!res.ok) throw new Error('cartridge load failed (' + res.status + ')');
      return res.json();
    })
    .then(function (cart) {
      cartridge = cart;
      if (cart.palette) setPalette(cart.palette);
      parseSpritesheet(cart.spritesheet);
      parseFlags(cart.flags);
      cls(0);
      print((cart.meta && cart.meta.name) || 'LOADING', 4, 58, 7);
      flip();
      toHost({
        type: 'console:meta',
        name: cart.meta ? cart.meta.name : '',
        author: cart.meta ? cart.meta.author : ''
      });
      toHost({ type: 'console:ready' });
      // If no host responds within 1.5s (e.g. cartridge opened directly),
      // start anonymously so the game is still playable.
      setTimeout(function () {
        if (!hostInitialized && cartridge) {
          hostInitialized = true;
          startGame(cartridge.code);
        }
      }, 1500);
    })
    .catch(function (err) {
      crash(err, 'boot');
    });
})();
`;
