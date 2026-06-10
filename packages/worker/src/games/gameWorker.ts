/**
 * Per-game Dynamic Worker module builder.
 *
 * Every cartridge is served by its own Worker isolate via env.LOADER (same
 * Worker Loaders pipeline as user apps in index.ts). The generated module:
 *
 *   GET  /                       console shell HTML (canvas + runtime script)
 *   GET  /runtime.js             trusted fantasy-console runtime
 *   GET  /cartridge.json         the cartridge (code + sprites + meta)
 *   GET  /_console/save          player save, gated by a game capability token
 *   PUT  /_console/save          write player save (≤ 32KB)
 *   POST /_console/realtime-token  exchange capability for a room-bound WS token
 *
 * The isolate has globalOutbound: null — its only door to the platform is the
 * env.ETERNAL service binding (EternalService WorkerEntrypoint), which
 * verifies the player's capability token on every privileged call. Player
 * identity therefore never depends on who owns the game.
 */

import { CONSOLE_RUNTIME_JS } from './consoleRuntime';
import type { Cartridge } from '../utils/cartridge';

export const GAME_WORKER_ENTRY_FILE = 'game.js';

export interface GameWorkerOptions {
  gameId: string;
  cartridge: Cartridge;
  /** Browser cache TTL for shell/cartridge responses. 0 = no-store (drafts). */
  cacheSeconds?: number;
  /**
   * URL path prefix the worker is mounted at, exactly as it appears in
   * incoming request paths (i.e. still percent-encoded if the client encoded
   * the gameId). Defaults to the unencoded gameId path.
   */
  mountPath?: string;
}

export function createGameWorkerModule(options: GameWorkerOptions): Record<string, string> {
  const { gameId, cartridge } = options;
  const cacheSeconds = options.cacheSeconds ?? 0;
  const mountPath = options.mountPath ?? `/api/games/play/${gameId}`;

  const entry = `
const CARTRIDGE_JSON = ${JSON.stringify(JSON.stringify(cartridge))};
const RUNTIME_JS = ${JSON.stringify(CONSOLE_RUNTIME_JS)};
const GAME_ID = ${JSON.stringify(gameId)};
const MOUNT_PATH = ${JSON.stringify(mountPath)};
const CACHE_CONTROL = ${JSON.stringify(cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store')};

// The console iframe runs with an opaque origin (sandbox="allow-scripts"),
// so every request it makes here is cross-origin. No credentials are ever
// used — auth rides in the Capability header — so '*' is safe.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '300',
};

function withHeaders(body, status, headers) {
  return new Response(body, { status, headers: { ...CORS, ...headers } });
}

function shellHtml(origin) {
  // Origins are emitted explicitly (not 'self') because the document's
  // browsing-context origin is opaque under the sandbox.
  const wsOrigin = origin.replace(/^http/, 'ws');
  const csp = [
    "default-src 'none'",
    // 'unsafe-eval' is required for the Function-constructor cartridge
    // loader in runtime.js — confined to this opaque-origin sandbox.
    "script-src 'unsafe-eval' " + origin,
    "style-src 'unsafe-inline'",
    'connect-src ' + origin + ' ' + wsOrigin,
    "img-src data:",
    "media-src data:",
  ].join('; ');

  const html = '<!doctype html>\\n<html>\\n<head>\\n'
    + '<meta charset="utf-8">\\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">\\n'
    + '<style>\\n'
    + 'html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}\\n'
    + 'body{display:flex;align-items:center;justify-content:center}\\n'
    + '#screen{image-rendering:pixelated;image-rendering:crisp-edges;'
    + 'width:min(100vw,100vh);height:min(100vw,100vh);outline:none}\\n'
    + '</style>\\n</head>\\n<body>\\n'
    + '<canvas id="screen" width="128" height="128" tabindex="0"></canvas>\\n'
    + '<script src="./runtime.js"><' + '/script>\\n'
    + '</body>\\n</html>\\n';

  return withHeaders(html, 200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'cache-control': CACHE_CONTROL,
  });
}

async function readCapability(request) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Capability ')) return null;
  return auth.slice('Capability '.length).trim() || null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    let sub = url.pathname.startsWith(MOUNT_PATH) ? url.pathname.slice(MOUNT_PATH.length) : url.pathname;
    if (sub === '') sub = '/';

    if (sub === '/' && request.method === 'GET') {
      return shellHtml(url.origin);
    }

    if (sub === '/runtime.js' && request.method === 'GET') {
      return withHeaders(RUNTIME_JS, 200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': CACHE_CONTROL,
      });
    }

    if (sub === '/cartridge.json' && request.method === 'GET') {
      return withHeaders(CARTRIDGE_JSON, 200, {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': CACHE_CONTROL,
      });
    }

    if (sub === '/_console/save') {
      const capability = await readCapability(request);
      if (!capability) {
        return withHeaders(JSON.stringify({ error: 'Capability required' }), 401, {
          'content-type': 'application/json',
        });
      }
      if (!env || !env.ETERNAL) {
        return withHeaders(JSON.stringify({ error: 'Bridge not available' }), 503, {
          'content-type': 'application/json',
        });
      }
      try {
        if (request.method === 'GET') {
          const data = await env.ETERNAL.gameSaveGet(capability);
          return withHeaders(JSON.stringify({ data: data ?? null }), 200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
        }
        if (request.method === 'PUT') {
          const body = await request.json();
          await env.ETERNAL.gameSavePut(capability, String(body && body.data != null ? body.data : ''));
          return withHeaders(JSON.stringify({ ok: true }), 200, { 'content-type': 'application/json' });
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const status = /capability/i.test(message) ? 401 : 400;
        return withHeaders(JSON.stringify({ error: message }), status, { 'content-type': 'application/json' });
      }
    }

    if (sub === '/_console/realtime-token' && request.method === 'POST') {
      const capability = await readCapability(request);
      if (!capability) {
        return withHeaders(JSON.stringify({ error: 'Capability required' }), 401, {
          'content-type': 'application/json',
        });
      }
      if (!env || !env.ETERNAL || typeof env.ETERNAL.mintGameRealtimeToken !== 'function') {
        return withHeaders(JSON.stringify({ error: 'Multiplayer not available' }), 503, {
          'content-type': 'application/json',
        });
      }
      try {
        const body = await request.json();
        const result = await env.ETERNAL.mintGameRealtimeToken(capability, String(body && body.roomCode || ''));
        return withHeaders(JSON.stringify(result), 200, { 'content-type': 'application/json' });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        return withHeaders(JSON.stringify({ error: message }), 400, { 'content-type': 'application/json' });
      }
    }

    return withHeaders(JSON.stringify({ error: 'Not found' }), 404, { 'content-type': 'application/json' });
  },
};
`;

  return { [GAME_WORKER_ENTRY_FILE]: entry };
}
