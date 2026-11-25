/**
 * App skin support inside the app's sandboxed iframe, spliced into
 * ETERNAL_RUNTIME_JS (appTools.ts). Written with String.raw so regexes need
 * no extra escaping — so this source must never contain a backtick or a
 * dollar-brace sequence.
 *
 * SKIN_CSS_JS is pure (no DOM): eternalSkinCss(skin, urls) turns a checked
 * skin into CSS. Tests evaluate it with node:vm. SKIN_RUNTIME_JS wires it
 * up: decodes the skin's images, cuts sprite cells with a canvas, injects
 * the style sheet, answers "which parts does this app have?" for templates,
 * and exposes eternal.skin.
 */

export const SKIN_CSS_JS = String.raw`
  var SKIN_COLOR_RE = /^(#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgba?|hsla?)\(\s*[-\d.]+(deg|%)?\s*(,\s*|\s+)[-\d.]+%?\s*(,\s*|\s+)[-\d.]+%?\s*((,|\/)\s*[\d.]+%?\s*)?\)|[a-z]{3,20})$/i;
  var SKIN_FONT_RE = /^[\w\s,'".-]{1,200}$/;
  var SKIN_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
  // Our own object URLs, or PNG data URLs the runtime encoded itself.
  var SKIN_URL_RE = /^(blob:[^"'\\()\s]+|data:image\/png;base64,[A-Za-z0-9+\/=]+)$/;
  var SKIN_BAD_WORDS = { inherit: 1, initial: 1, unset: 1, revert: 1, none: 1, url: 1, expression: 1, 'var': 1, env: 1, attr: 1 };
  var SKIN_THEME_COLORS = ['bg', 'surface', 'chrome', 'text', 'text-muted', 'accent', 'accent-text', 'selection', 'selection-text', 'border', 'highlight', 'shadow', 'control-bg', 'control-text', 'control-border', 'title-bar', 'title-text', 'danger', 'success'];
  var SKIN_BUTTONS = ['button', '[role="button"]', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]'];
  var SKIN_FIELDS = ['input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="file"])', 'textarea', 'select'];
  var SKIN_UNIVERSAL = { app: ['body'], button: SKIN_BUTTONS, field: SKIN_FIELDS, link: ['a'], heading: ['h1', 'h2', 'h3'] };
  var SKIN_STATE_SELECTORS = {
    hover: [':hover:not(:disabled):not([aria-disabled="true"])'],
    pressed: [':active:not(:disabled)', '[aria-pressed="true"]', '[data-skin-state~="pressed"]'],
    active: ['[aria-checked="true"]', '[aria-selected="true"]', '[aria-current="page"]', '[aria-current="true"]', '[data-skin-state~="active"]'],
    disabled: [':disabled', '[aria-disabled="true"]', '[data-skin-state~="disabled"]']
  };

  function skinColor(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim();
    if (v.length > 60 || !SKIN_COLOR_RE.test(v) || SKIN_BAD_WORDS[v.toLowerCase()]) return null;
    return v;
  }
  function skinFont(value) {
    return typeof value === 'string' && SKIN_FONT_RE.test(value.trim()) ? value.trim() : null;
  }
  function skinInt(value, min, max) {
    var n = Math.round(Number(value));
    return isFinite(n) && n >= min && n <= max ? n : null;
  }
  function skinUrl(value) {
    return typeof value === 'string' && SKIN_URL_RE.test(value) ? value : null;
  }

  /** Base selectors for a part: universal parts map to elements (unless they carry their own data-skin). */
  function skinBaseSelectors(name) {
    if (Object.prototype.hasOwnProperty.call(SKIN_UNIVERSAL, name)) {
      return SKIN_UNIVERSAL[name].map(function (sel) { return name === 'app' ? sel : sel + ':not([data-skin])'; });
    }
    return ['[data-skin~="' + name + '"]'];
  }
  function skinWithState(selectors, state) {
    if (!state || state === 'normal') return selectors;
    var out = [];
    selectors.forEach(function (sel) {
      SKIN_STATE_SELECTORS[state].forEach(function (suffix) { out.push(sel + suffix); });
    });
    return out;
  }

  function skinStyleDecls(style, urls) {
    var d = [];
    if (!style || typeof style !== 'object') return d;
    var layers = [];
    var sizes = [];
    var repeats = [];
    if (style.gradient && typeof style.gradient === 'object') {
      var from = skinColor(style.gradient.from);
      var to = skinColor(style.gradient.to);
      var angle = skinInt(style.gradient.angle, 0, 360);
      if (from && to) {
        layers.push('linear-gradient(' + (angle === null ? 180 : angle) + 'deg, ' + from + ', ' + to + ')');
        sizes.push('100% 100%');
        repeats.push('no-repeat');
      }
    }
    if (style.texture && typeof style.texture === 'object') {
      var textureUrl = skinUrl(urls.assets && urls.assets[style.texture.asset]);
      if (textureUrl) {
        var size = skinInt(style.texture.size, 8, 1024);
        layers.push('url("' + textureUrl + '")');
        sizes.push(size === null ? 'auto' : size + 'px');
        repeats.push('repeat');
      }
    }
    var background = skinColor(style.background);
    if (layers.length) {
      d.push('background-image: ' + layers.join(', '));
      d.push('background-size: ' + sizes.join(', '));
      d.push('background-repeat: ' + repeats.join(', '));
    } else if (background) {
      d.push('background-image: none');
    }
    if (background) d.push('background-color: ' + background);
    if (style.border && typeof style.border === 'object') {
      var width = skinInt(style.border.width, 0, 8);
      var borderColor = skinColor(style.border.color) || 'currentcolor';
      var borderStyle = /^(solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(style.border.style) ? style.border.style : 'solid';
      d.push('border: ' + (width === null ? 1 : width) + 'px ' + borderStyle + ' ' + borderColor);
    }
    var radius = skinInt(style.radius, 0, 64);
    if (radius !== null) d.push('border-radius: ' + radius + 'px');
    var shadows = [];
    if (style.bevel === 'raised') shadows.push('inset 1px 1px 0 var(--skin-bevel-light, rgba(255, 255, 255, 0.75))', 'inset -1px -1px 0 var(--skin-bevel-dark, rgba(0, 0, 0, 0.35))');
    if (style.bevel === 'sunken') shadows.push('inset 1px 1px 0 var(--skin-bevel-dark, rgba(0, 0, 0, 0.35))', 'inset -1px -1px 0 var(--skin-bevel-light, rgba(255, 255, 255, 0.75))');
    if (style.shadow === 'soft') shadows.push('0 2px 6px rgba(0, 0, 0, 0.25)');
    if (style.shadow === 'hard') shadows.push('2px 2px 0 rgba(0, 0, 0, 0.6)');
    if (shadows.length) d.push('box-shadow: ' + shadows.join(', '));
    else if (style.bevel === 'flat' || style.shadow === 'none') d.push('box-shadow: none');
    var text = skinColor(style.text);
    if (text) d.push('color: ' + text);
    var font = skinFont(style.font);
    if (font) d.push('font-family: ' + font);
    if (style.weight === 'bold' || style.weight === 'normal') d.push('font-weight: ' + style.weight);
    return d;
  }

  function skinSpriteDecls(name, sprite, url) {
    var d = [];
    if (!skinUrl(url)) return d;
    var slice = skinInt(sprite.slice, 1, 512);
    if (slice !== null) {
      d.push('border-style: solid', 'border-color: transparent', 'border-image: url("' + url + '") ' + slice + ' fill / ' + slice + 'px stretch', 'background: transparent');
    } else if (name === 'app') {
      d.push('background: url("' + url + '") repeat');
    } else {
      d.push('background: url("' + url + '") center / 100% 100% no-repeat', 'border-color: transparent', 'box-shadow: none');
    }
    if (sprite.pixelated) d.push('image-rendering: pixelated');
    return d;
  }

  function skinRule(selectors, decls) {
    if (!decls.length || !selectors.length) return '';
    return selectors.join(',\n') + ' {\n' + decls.map(function (decl) { return '  ' + decl + ' !important;'; }).join('\n') + '\n}\n';
  }

  /**
   * CSS for a skin. urls = { assets: { key: blobUrl }, cells: { part: { normal|hover|...: blobUrl, frames: [blobUrl] } } }.
   */
  function eternalSkinCss(skin, urls) {
    var css = '';
    if (!skin || typeof skin !== 'object') return css;
    urls = urls || {};
    var rootDecls = [];
    var colors = skin.colors && typeof skin.colors === 'object' ? skin.colors : {};
    Object.keys(colors).slice(0, 40).forEach(function (key) {
      var color = skinColor(colors[key]);
      if (!color || !/^[a-z][a-z0-9-]{0,30}$/.test(key)) return;
      rootDecls.push('--skin-' + key + ': ' + color);
      if (SKIN_THEME_COLORS.indexOf(key) !== -1) rootDecls.push('--eternal-' + key + ': ' + color);
    });
    var fonts = skin.fonts && typeof skin.fonts === 'object' ? skin.fonts : {};
    ['font', 'font-title', 'font-mono'].forEach(function (key) {
      var font = skinFont(fonts[key]);
      if (font) rootDecls.push('--eternal-' + key + ': ' + font);
    });
    css += skinRule([':root'], rootDecls);

    var parts = skin.parts && typeof skin.parts === 'object' ? skin.parts : {};
    Object.keys(parts).slice(0, 80).forEach(function (name) {
      if (!SKIN_NAME_RE.test(name)) return;
      var part = parts[name];
      if (!part || typeof part !== 'object') return;
      if (name === 'scrollbar') {
        var bar = part.style || {};
        var track = skinColor(bar.background);
        var thumb = skinColor(bar.text) || (bar.border && skinColor(bar.border.color));
        if (thumb) css += skinRule([':root'], ['scrollbar-color: ' + thumb + ' ' + (track || 'transparent')]);
        return;
      }
      var base = skinBaseSelectors(name);
      var cells = (urls.cells && urls.cells[name]) || {};
      css += skinRule(base, skinStyleDecls(part.style, urls));
      if (part.sprite && typeof part.sprite === 'object') {
        css += skinRule(base, skinSpriteDecls(name, part.sprite, cells.normal || (cells.frames && cells.frames[0])));
        if (cells.frames) {
          cells.frames.forEach(function (frameUrl, index) {
            css += skinRule(base.map(function (sel) { return sel + '[data-skin-frame="' + index + '"]'; }), skinSpriteDecls(name, part.sprite, frameUrl));
          });
        }
      }
      ['hover', 'active', 'pressed', 'disabled'].forEach(function (state) {
        var selectors = skinWithState(base, state);
        var stateStyle = part.states && part.states[state];
        if (stateStyle) css += skinRule(selectors, skinStyleDecls(stateStyle, urls));
        if (part.sprite && cells[state]) css += skinRule(selectors, skinSpriteDecls(name, part.sprite, cells[state]));
      });
    });
    return css;
  }
`;

export const SKIN_RUNTIME_JS = SKIN_CSS_JS + String.raw`
  // App skins (.eskin): sent by the window hosting this app; see
  // utils/appSkin.ts for the format. Images are re-checked by their bytes,
  // sprite cells are cut with a canvas, and the CSS is built only from
  // checked values (eternalSkinCss).
  var skinCurrent = null;
  var skinStyleEl = null;
  var skinUrls = [];
  var skinApplyToken = 0;
  var skinHandlers = new Set();

  function skinDecode(dataUrl) {
    var match = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl || ''));
    if (!match || match[2].length > 2900000) return null;
    var binary;
    try { binary = atob(match[2]); } catch (_) { return null; }
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    var type = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'image/png'
      : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 ? 'image/gif'
      : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45 ? 'image/webp'
      : null;
    return type ? new Blob([bytes], { type: type }) : null;
  }

  /**
   * Make an image tile seamlessly, one axis at a time: a copy shifted by half
   * the tile shows at the edges (where it is continuous with the next tile)
   * and the original fades in toward the middle (where the copy's seam is).
   */
  function skinBlendAxis(source, w, h, horizontal) {
    var out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    var ctx = out.getContext('2d');
    var half = Math.floor((horizontal ? w : h) / 2);
    if (horizontal) {
      ctx.drawImage(source, half, 0, w - half, h, 0, 0, w - half, h);
      ctx.drawImage(source, 0, 0, half, h, w - half, 0, half, h);
    } else {
      ctx.drawImage(source, 0, half, w, h - half, 0, 0, w, h - half);
      ctx.drawImage(source, 0, 0, w, half, 0, h - half, w, half);
    }
    var top = document.createElement('canvas');
    top.width = w;
    top.height = h;
    var tctx = top.getContext('2d');
    tctx.drawImage(source, 0, 0, w, h);
    tctx.globalCompositeOperation = 'destination-in';
    var fade = horizontal ? tctx.createLinearGradient(0, 0, w, 0) : tctx.createLinearGradient(0, 0, 0, h);
    fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fade.addColorStop(0.5, 'rgba(0, 0, 0, 1)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
    tctx.fillStyle = fade;
    tctx.fillRect(0, 0, w, h);
    ctx.drawImage(top, 0, 0);
    return out;
  }

  function skinSeamless(bitmap) {
    return new Promise(function (resolve) {
      try {
        var w = Math.min(bitmap.width, 1024);
        var h = Math.min(bitmap.height, 1024);
        var start = document.createElement('canvas');
        start.width = w;
        start.height = h;
        start.getContext('2d').drawImage(bitmap, 0, 0, w, h, 0, 0, w, h);
        var out = skinBlendAxis(skinBlendAxis(start, w, h, true), w, h, false);
        // toDataURL, not toBlob: toBlob is throttled in out-of-process frames.
        resolve(out.toDataURL('image/png'));
      } catch (_) {
        resolve(null);
      }
    });
  }

  function skinCut(bitmap, x, y, w, h) {
    return new Promise(function (resolve) {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
        // Synchronous on purpose: canvas.toBlob is heavily throttled when the
        // app runs as an out-of-process iframe, and a skin has many cells.
        resolve(canvas.toDataURL('image/png'));
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function skinApply(skin) {
    var token = ++skinApplyToken;
    var created = [];
    var urls = { assets: {}, cells: {} };
    var parts = {};
    if (skin && typeof skin === 'object') {
      var assets = skin.assets && typeof skin.assets === 'object' ? skin.assets : {};
      var bitmaps = {};
      var keys = Object.keys(assets).slice(0, 12);
      for (var k = 0; k < keys.length; k++) {
        var asset = assets[keys[k]];
        var blob = skinDecode(asset && typeof asset === 'object' ? asset.data : asset);
        if (!blob) continue;
        var assetUrl = URL.createObjectURL(blob);
        created.push(assetUrl);
        urls.assets[keys[k]] = assetUrl;
        try { bitmaps[keys[k]] = await createImageBitmap(blob); } catch (_) {}
      }
      parts = skin.parts && typeof skin.parts === 'object' ? skin.parts : {};
      var names = Object.keys(parts).slice(0, 80);
      // Textures marked blend tile seamlessly.
      var blended = {};
      names.forEach(function (name) {
        var part = parts[name] || {};
        [part.style].concat(part.states ? Object.keys(part.states).map(function (key) { return part.states[key]; }) : []).forEach(function (style) {
          if (style && style.texture && style.texture.blend === true && bitmaps[style.texture.asset]) blended[style.texture.asset] = true;
        });
      });
      var blendKeys = Object.keys(blended);
      for (var b = 0; b < blendKeys.length; b++) {
        var seamlessUrl = await skinSeamless(bitmaps[blendKeys[b]]);
        if (seamlessUrl) { created.push(seamlessUrl); urls.assets[blendKeys[b]] = seamlessUrl; }
      }
      for (var n = 0; n < names.length; n++) {
        var sprite = parts[names[n]] && parts[names[n]].sprite;
        if (!sprite || typeof sprite !== 'object') continue;
        var bitmap = bitmaps[sprite.asset];
        var x = skinInt(sprite.x, 0, 4096);
        var y = skinInt(sprite.y, 0, 4096);
        var w = skinInt(sprite.w, 1, 1024);
        var h = skinInt(sprite.h, 1, 1024);
        if (!bitmap || x === null || y === null || w === null || h === null) continue;
        var cells = {};
        var frames = skinInt(sprite.frames, 2, 64);
        if (frames) {
          cells.frames = [];
          for (var f = 0; f < frames; f++) {
            var frameUrl = await skinCut(bitmap, x + f * w, y, w, h);
            if (frameUrl) created.push(frameUrl);
            cells.frames.push(frameUrl);
          }
        } else {
          var states = Array.isArray(sprite.states) && sprite.states.length ? sprite.states.slice(0, 5) : ['normal'];
          for (var s = 0; s < states.length; s++) {
            if (!/^(normal|hover|pressed|active|disabled)$/.test(states[s])) continue;
            var cellUrl = await skinCut(bitmap, x + s * w, y, w, h);
            if (cellUrl) { created.push(cellUrl); cells[states[s]] = cellUrl; }
          }
        }
        urls.cells[names[n]] = cells;
      }
    }
    if (token !== skinApplyToken) {
      created.forEach(function (url) { if (url.indexOf('blob:') === 0) URL.revokeObjectURL(url); });
      return;
    }
    if (!skinStyleEl) {
      skinStyleEl = document.createElement('style');
      skinStyleEl.setAttribute('data-eternal-skin', '');
    }
    skinStyleEl.textContent = skin ? eternalSkinCss(skin, urls) : '';
    // Last in <head>, after the app's own styles.
    (document.head || document.documentElement).appendChild(skinStyleEl);
    skinUrls.forEach(function (url) { if (url.indexOf('blob:') === 0) URL.revokeObjectURL(url); });
    skinUrls = created;
    skinCurrent = skin ? Object.freeze({ name: String(skin.name || 'Skin').slice(0, 60), parts: Object.freeze(Object.keys(parts)) }) : null;
    skinWindow = skin && skin.window && typeof skin.window === 'object' && skin.window.frameless === true ? skin.window : null;
    if (skinWindow) document.documentElement.setAttribute('data-eternal-frameless', '');
    else document.documentElement.removeAttribute('data-eternal-frameless');
    if (skinCurrent) document.documentElement.setAttribute('data-eternal-skin', skinCurrent.name);
    else document.documentElement.removeAttribute('data-eternal-skin');
    skinHandlers.forEach(function (handler) { try { handler(skinCurrent); } catch (_) {} });
  }

  function skinIsButtonLike(el) {
    var tag = el.tagName.toLowerCase();
    return tag === 'button' || el.getAttribute('role') === 'button' || (tag === 'input' && /^(button|submit|reset)$/i.test(el.getAttribute('type') || ''));
  }

  /** The skinnable parts this app has right now, for skin templates. */
  function skinDescribe() {
    var found = {};
    var order = [];
    var elements = document.querySelectorAll('[data-skin]');
    for (var i = 0; i < elements.length && order.length < 80; i++) {
      var el = elements[i];
      var tokens = String(el.getAttribute('data-skin') || '').split(/\s+/);
      for (var t = 0; t < tokens.length; t++) {
        var name = tokens[t];
        if (!SKIN_NAME_RE.test(name) || found[name] || Object.prototype.hasOwnProperty.call(SKIN_UNIVERSAL, name) || name === 'scrollbar') continue;
        var rect = el.getBoundingClientRect();
        var frames = skinInt(el.getAttribute('data-skin-frames'), 2, 64);
        var statesAttr = String(el.getAttribute('data-skin-states') || '').split(/\s+/).filter(function (state) { return /^(normal|hover|pressed|active|disabled)$/.test(state); });
        var states = statesAttr.length ? statesAttr : (skinIsButtonLike(el) ? ['normal', 'hover', 'pressed', 'disabled'] : ['normal']);
        if (states[0] !== 'normal') states = ['normal'].concat(states.filter(function (state) { return state !== 'normal'; }));
        var label = String(el.getAttribute('data-skin-label') || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        found[name] = {
          name: name,
          w: Math.max(4, Math.min(1024, Math.round(rect.width) || 32)),
          h: Math.max(4, Math.min(1024, Math.round(rect.height) || 32)),
          states: frames ? ['normal'] : states,
          frames: frames || undefined,
          label: label || name
        };
        order.push(name);
      }
    }
    var universal = ['app'];
    if (document.querySelector(SKIN_BUTTONS.join(','))) universal.push('button');
    if (document.querySelector(SKIN_FIELDS.join(','))) universal.push('field');
    if (document.querySelector('a')) universal.push('link');
    if (document.querySelector('h1, h2, h3')) universal.push('heading');
    universal.push('scrollbar');
    return {
      title: String(document.title || '').slice(0, 80),
      parts: order.map(function (name) { return found[name]; }),
      universal: universal,
      viewport: { w: Math.round(window.innerWidth), h: Math.round(window.innerHeight) }
    };
  }

  // Shaped, frameless windows (skin.window): painted parts move, close and
  // minimize the window. The desktop draws the shape and keeps its own
  // always-visible handle; here we only report what the pointer does.
  var skinWindow = null;
  var skinDrag = null;
  function skinInteractive(el) {
    return Boolean(el && el.closest && el.closest('button, a, input, textarea, select, label, summary, [role="button"], [role="slider"], [contenteditable=""], [contenteditable="true"], [data-skin-nodrag]'));
  }
  function skinPart(el, name) {
    return el && el.closest && SKIN_NAME_RE.test(name) ? el.closest('[data-skin~="' + name + '"]') : null;
  }
  function skinPost(type, extra) {
    try { window.parent.postMessage(Object.assign({ type: type }, extra || {}), '*'); } catch (_) {}
  }
  document.addEventListener('click', function (event) {
    if (!skinWindow) return;
    if (skinWindow.close && skinPart(event.target, skinWindow.close)) {
      event.preventDefault();
      event.stopPropagation();
      skinPost('eternal:window:close');
    } else if (skinWindow.minimize && skinPart(event.target, skinWindow.minimize)) {
      event.preventDefault();
      event.stopPropagation();
      skinPost('eternal:window:minimize');
    }
  }, true);
  document.addEventListener('pointerdown', function (event) {
    skinDrag = null;
    if (!skinWindow || event.button !== 0) return;
    var target = event.target;
    var handle = target && target.closest ? target.closest('[data-skin-drag]') : null;
    if (!handle) {
      if (skinInteractive(target)) return;
      var names = Array.isArray(skinWindow.drag) ? skinWindow.drag : [];
      for (var i = 0; i < names.length && !handle; i++) {
        handle = names[i] === 'app' ? document.body : skinPart(target, names[i]);
      }
    }
    if (!handle) return;
    skinDrag = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  }, true);
  document.addEventListener('pointermove', function (event) {
    if (!skinDrag || event.pointerId !== skinDrag.id) return;
    if (!skinDrag.moved) {
      if (Math.abs(event.clientX - skinDrag.x) + Math.abs(event.clientY - skinDrag.y) < 4) return;
      skinDrag.moved = true;
      try { document.documentElement.setPointerCapture(event.pointerId); } catch (_) {}
      skinPost('eternal:window:dragStart', { clientX: skinDrag.x, clientY: skinDrag.y });
    }
    event.preventDefault();
    skinPost('eternal:window:dragMove', { clientX: event.clientX, clientY: event.clientY });
  }, true);
  function skinDragEnd(event) {
    if (!skinDrag || event.pointerId !== skinDrag.id) return;
    if (skinDrag.moved) {
      skinPost('eternal:window:dragEnd');
      // A drag is not a click on whatever was under the pointer.
      var swallow = function (click) { click.stopPropagation(); click.preventDefault(); };
      document.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(function () { document.removeEventListener('click', swallow, true); }, 0);
    }
    skinDrag = null;
  }
  document.addEventListener('pointerup', skinDragEnd, true);
  document.addEventListener('pointercancel', skinDragEnd, true);

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === 'eternal:skin') {
      skinApply(event.data.skin || null);
    } else if (event.data.type === 'eternal:skin:describe') {
      var described = null;
      try { described = skinDescribe(); } catch (_) {}
      window.parent.postMessage({ type: 'eternal:skin:parts', requestId: String(event.data.requestId || '').slice(0, 64), parts: described }, '*');
    }
  });
  try { window.parent.postMessage({ type: 'eternal:skin:request' }, '*'); } catch (_) {}

  var skin = Object.freeze({
    get: function () { return skinCurrent; },
    onChange: function (handler) {
      if (typeof handler !== 'function') return function () {};
      skinHandlers.add(handler);
      return function () { skinHandlers.delete(handler); };
    }
  });
`;
