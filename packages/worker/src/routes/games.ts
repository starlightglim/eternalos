/**
 * Fantasy-console game routes.
 *
 *   GET  /api/games/play/:gameId/*        serve a game via its own Dynamic Worker
 *   POST /api/games/:gameId/capability    mint a player capability token
 *   GET  /api/games/drafts                list the caller's cartridge drafts
 *   GET  /api/games/drafts/:cartId        load a full draft cartridge
 *   PUT  /api/games/drafts/:cartId        create/update a draft
 *   DELETE /api/games/drafts/:cartId      delete a draft
 *
 * Game ids:
 *   'demo'            built-in demo cartridge (no storage)
 *   'draft:{cartId}'  cartridge draft in KV (playable by URL, like app previews)
 *   '{packId}'        published bazaar game (cartridge JSON in R2)
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { Cartridge } from '../utils/cartridge';
import { validateCartridge, CARTRIDGE_LIMITS } from '../utils/cartridge';
import { signGameCapabilityToken } from '../utils/jwt';
import { createGameWorkerModule, GAME_WORKER_ENTRY_FILE } from '../games/gameWorker';
import { DEMO_CARTRIDGE } from '../games/demoCart';

const MAX_DRAFTS_PER_USER = 20;

interface DraftRecord {
  uid: string;
  updatedAt: number;
  cartridge: Cartridge;
}

interface PublishedGameMeta {
  uid: string;
  version: number;
  r2Key: string;
}

interface ResolvedGame {
  cartridge: Cartridge;
  ownerUid: string;
  isolateTag: string;
  cacheSeconds: number;
}

function draftKey(cartId: string): string {
  return `cart:draft:${cartId}`;
}

function draftIndexKey(uid: string): string {
  return `cart-index:${uid}`;
}

async function loadDraftIndex(env: Env, uid: string): Promise<string[]> {
  const ids = await env.DESKTOP_KV.get<string[]>(draftIndexKey(uid), 'json');
  return Array.isArray(ids) ? ids : [];
}

/**
 * Resolve a gameId to its cartridge + isolate cache tag. Returns null when
 * the game doesn't exist. The isolate tag changes whenever cartridge content
 * can have changed, so stale isolates are never served.
 */
export async function resolveGameCartridge(env: Env, gameId: string): Promise<ResolvedGame | null> {
  if (gameId === 'demo') {
    return {
      cartridge: DEMO_CARTRIDGE,
      ownerUid: 'system',
      isolateTag: `game-demo@v${DEMO_CARTRIDGE.meta.version}`,
      cacheSeconds: 60,
    };
  }

  if (gameId.startsWith('draft:')) {
    const cartId = gameId.slice('draft:'.length);
    if (!cartId || cartId.includes('/')) return null;
    const record = await env.DESKTOP_KV.get<DraftRecord>(draftKey(cartId), 'json');
    if (!record) return null;
    return {
      cartridge: record.cartridge,
      ownerUid: record.uid,
      isolateTag: `game-draft-${cartId}@${record.updatedAt}`,
      cacheSeconds: 0,
    };
  }

  if (gameId.includes('/') || gameId.includes(':')) return null;
  const meta = await env.DESKTOP_KV.get<PublishedGameMeta>(`game:${gameId}`, 'json');
  if (!meta) return null;
  const obj = await env.ETERNALOS_FILES.get(meta.r2Key);
  if (!obj) return null;
  const cartridge = await obj.json<Cartridge>();
  return {
    cartridge,
    ownerUid: meta.uid,
    isolateTag: `game-${gameId}@v${meta.version}`,
    cacheSeconds: 60,
  };
}

/** Whether a gameId refers to something real (cheap check for capability mint). */
export async function gameExists(env: Env, gameId: string): Promise<boolean> {
  if (gameId === 'demo') return true;
  if (gameId.startsWith('draft:')) {
    const cartId = gameId.slice('draft:'.length);
    if (!cartId || cartId.includes('/')) return false;
    return (await env.DESKTOP_KV.get(draftKey(cartId))) !== null;
  }
  if (gameId.includes('/') || gameId.includes(':')) return false;
  return (await env.DESKTOP_KV.get(`game:${gameId}`)) !== null;
}

/**
 * Serve a game through its per-game Dynamic Worker isolate.
 *
 * NOTE: the response is returned raw (no withCors / SECURITY_HEADERS) — the
 * game worker sets its own CSP, and the parent's X-Frame-Options: DENY would
 * break iframe embedding. Mirrors the app-serving path in index.ts.
 */
export async function handleGamePlay(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  playPath: string,
): Promise<Response> {
  const gameId = playPath.split('/')[0];
  if (!gameId) {
    return Response.json({ error: 'Game ID required' }, { status: 400 });
  }

  // Relative asset paths (./runtime.js, ./cartridge.json) only resolve when
  // the document URL ends with a trailing slash.
  if (playPath === gameId) {
    const redirectUrl = new URL(request.url);
    redirectUrl.pathname = `/api/games/play/${gameId}/`;
    return Response.redirect(redirectUrl.toString(), 308);
  }

  const resolved = await resolveGameCartridge(env, gameId);
  if (!resolved) {
    return Response.json({ error: 'Game not found' }, { status: 404 });
  }

  const modules = createGameWorkerModule({
    gameId,
    cartridge: resolved.cartridge,
    cacheSeconds: resolved.cacheSeconds,
  });

  // ctx.exports is the loopback-bindings surface for WorkerEntrypoints
  // exported from this worker (same narrow cast as the app path in index.ts).
  const loopback = (ctx as unknown as {
    exports: {
      EternalService: (init: { props: { uid: string; appId: string; granted: Record<string, never> } }) => unknown;
    };
  }).exports;

  const worker = env.LOADER.get(resolved.isolateTag, async () => ({
    compatibilityDate: '2026-04-15',
    mainModule: GAME_WORKER_ENTRY_FILE,
    modules,
    // No arbitrary egress: saves and realtime tokens come back in through
    // the capability-checked EternalService binding.
    globalOutbound: null,
    env: {
      ETERNAL: loopback.EternalService({
        props: { uid: resolved.ownerUid, appId: `game:${gameId}`, granted: {} },
      }),
    },
  }));

  return worker.getEntrypoint().fetch(request);
}

/**
 * POST /api/games/:gameId/capability
 * Mint a player capability for any existing game. The token only grants
 * access to the caller's own save slot for that game, so any authenticated
 * player may mint one.
 */
export async function handleGameCapability(
  request: Request,
  env: Env,
  auth: AuthContext,
  gameId: string,
): Promise<Response> {
  if (!(await gameExists(env, gameId))) {
    return Response.json({ error: 'Game not found' }, { status: 404 });
  }
  const { token, expiresAt } = await signGameCapabilityToken(
    auth.uid,
    auth.username,
    gameId,
    env.JWT_SECRET,
  );
  return Response.json({ capability: token, expiresAt });
}

// ---------------------------------------------------------------------------
// Cartridge drafts
// ---------------------------------------------------------------------------

export async function handleListDrafts(env: Env, auth: AuthContext): Promise<Response> {
  const ids = await loadDraftIndex(env, auth.uid);
  const drafts = await Promise.all(
    ids.map(async (cartId) => {
      const record = await env.DESKTOP_KV.get<DraftRecord>(draftKey(cartId), 'json');
      if (!record || record.uid !== auth.uid) return null;
      return {
        cartId,
        name: record.cartridge.meta.name,
        version: record.cartridge.meta.version,
        updatedAt: record.updatedAt,
      };
    }),
  );
  return Response.json({
    drafts: drafts.filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  });
}

export async function handleGetDraft(env: Env, auth: AuthContext, cartId: string): Promise<Response> {
  const record = await env.DESKTOP_KV.get<DraftRecord>(draftKey(cartId), 'json');
  if (!record || record.uid !== auth.uid) {
    return Response.json({ error: 'Draft not found' }, { status: 404 });
  }
  return Response.json({ cartId, updatedAt: record.updatedAt, cartridge: record.cartridge });
}

export async function handlePutDraft(
  request: Request,
  env: Env,
  auth: AuthContext,
  cartId: string,
): Promise<Response> {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(cartId)) {
    return Response.json({ error: 'Invalid draft id' }, { status: 400 });
  }

  let body: { cartridge?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const validation = validateCartridge(body.cartridge);
  if (!validation.ok || !validation.cartridge) {
    // First detail rides in `error` because the frontend api client only
    // surfaces that field.
    return Response.json(
      { error: `Invalid cartridge: ${validation.errors[0] ?? 'unknown'}`, details: validation.errors },
      { status: 400 },
    );
  }

  const existing = await env.DESKTOP_KV.get<DraftRecord>(draftKey(cartId), 'json');
  if (existing && existing.uid !== auth.uid) {
    return Response.json({ error: 'Draft not found' }, { status: 404 });
  }

  const index = await loadDraftIndex(env, auth.uid);
  if (!existing && index.length >= MAX_DRAFTS_PER_USER) {
    return Response.json({ error: `Draft limit reached (${MAX_DRAFTS_PER_USER})` }, { status: 400 });
  }

  // The author signs their drafts; published carts re-stamp this at publish.
  validation.cartridge.meta.author = auth.username;

  const record: DraftRecord = {
    uid: auth.uid,
    updatedAt: Date.now(),
    cartridge: validation.cartridge,
  };
  await env.DESKTOP_KV.put(draftKey(cartId), JSON.stringify(record));
  if (!index.includes(cartId)) {
    index.push(cartId);
    await env.DESKTOP_KV.put(draftIndexKey(auth.uid), JSON.stringify(index));
  }

  return Response.json({ cartId, updatedAt: record.updatedAt });
}

export async function handleDeleteDraft(env: Env, auth: AuthContext, cartId: string): Promise<Response> {
  const record = await env.DESKTOP_KV.get<DraftRecord>(draftKey(cartId), 'json');
  if (!record || record.uid !== auth.uid) {
    return Response.json({ error: 'Draft not found' }, { status: 404 });
  }
  await env.DESKTOP_KV.delete(draftKey(cartId));
  const index = await loadDraftIndex(env, auth.uid);
  await env.DESKTOP_KV.put(draftIndexKey(auth.uid), JSON.stringify(index.filter((id) => id !== cartId)));
  return Response.json({ deleted: true, cartId });
}

export { CARTRIDGE_LIMITS };
