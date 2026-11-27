/**
 * Route Table
 *
 * Every /api/* route, in dispatch order, with an explicit policy the single
 * dispatcher (routes/router.ts) applies:
 *
 *   policy.auth        — credential mode ('none' | 'required' | 'agent-chat' |
 *                        'file' | 'handler-scoped'); see middleware/auth.ts
 *   policy.rateLimit   — bucket enforced before auth + handler; `null` is an
 *                        explicit "not rate limited" decision, documented inline
 *   policy.rateLimitHeaders — expose X-RateLimit-* on success (legacy: auth
 *                        routes + file-token only)
 *   decorate           — dispatcher wraps the response withCors unless false;
 *                        opt-outs decorate per-outcome themselves (raw
 *                        Dynamic-Worker bodies, CORS-only 400s, …)
 *
 * Entries are walked in order and the first match wins; handlers can return
 * ROUTE_FALLTHROUGH to reproduce the legacy if/else fallthrough for inner
 * method/shape checks. Unmatched paths get the legacy prefix-based rate-limit
 * bucket followed by the shared CORS-only 404 (see unmatchedRouteRateLimit).
 */

import { handleAppSkins, handlePublicAppSkin } from './appSkins';
import type { Env } from '../index';
import { issueFileToken } from '../middleware/auth';
import { withCors } from '../middleware/http';
import {
  RATE_LIMIT_AUTH,
  RATE_LIMIT_API,
  RATE_LIMIT_PUBLIC_ASSET,
  type RateLimitConfig,
} from '../middleware/rateLimit';
import { trackVisitAnalytics, handleGetAnalytics } from './analytics';
import {
  handleAgentChatForward,
  handleAgentChatWsToken,
  handleCreateAgentThread,
  handleDeleteAgentThread,
  handleDeleteRoutine,
  handleListAgentThreads,
  handleListRoutines,
  handleRenameAgentThread,
  handleRunRoutineNow,
  handleUndoCodeRun,
} from './agent';
import {
  handleAppCapability,
  handleAppDevDeploy,
  handleAppDelete,
  handleAppFsList,
  handleAppFsRead,
  handleAppPermissions,
  handleAppRevisionRestore,
  handleAppRollback,
  handleAppVersions,
  handleGetAppSourceRoute,
  handleAppBackendLogsRoute,
} from './apps';
import { handleAppRevisionGet, handleAppRevisionsList } from './appRevisions';
import { handleServeApp, handleServeAppPreview } from './appServe';
import {
  handleBazaarBrowse,
  handleBazaarDelete,
  handleBazaarGetPack,
  handleBazaarInstall,
  handleBazaarMyPacks,
  handleBazaarPublish,
  handleBazaarPublishEstheme,
  handleBazaarPublishGame,
  handleBazaarServeAsset,
} from './bazaar';
import {
  handleChangePassword,
  handleChangeUsername,
  handleCancelDeletion,
  handleDeleteAccount,
  handleExportData,
  handleForgotPassword,
  handleGoogleCallback,
  handleLogin,
  handleLogout,
  handleRefreshToken,
  handleRegenerateRecoveryCodes,
  handleResetPassword,
  handleSendVerification,
  handleSignup,
  handleUseRecoveryCode,
  handleVerifyEmail,
} from './auth';
import {
  handleCursorUpload,
  handleDeleteCursor,
  handleListCursors,
  handleServeCursor,
} from './cursors';
import {
  handleEmptyTrash,
  handleCreateDesktopItems,
  handleDeleteDesktopItem,
  handleGetCssHistory,
  handleGetDesktop,
  handleGetProfile,
  handleGetQuota,
  handleListTrash,
  handlePatchProfile,
  handlePutWindows,
  handleRestoreTrashItem,
  handleRevertCssHistory,
  handleUpdateDesktopItems,
  handleVisitorWebSocket,
} from './desktop';
import {
  handleGameCapability,
  handleGamePlay,
  handleDeleteDraft,
  handleGetDraft,
  handleListDrafts,
  handlePutDraft,
} from './games';
import { handleGuestbookSign } from './guestbook';
import { handleOgImage } from './ogImage';
import type { RouteContext, RouteDefinition, RouteHandlerResult, PathMatcher } from './router';
import {
  anyPath,
  dispatchRequest,
  exact,
  prefix,
  requireAuthContext,
  regex,
  startsAndEndsWith,
  ROUTE_FALLTHROUGH,
} from './router';
import {
  handleAnalyzeImageItem,
  handleCSSAssetUpload,
  handleDeleteCSSAsset,
  handleIconUpload,
  handleListCSSAssets,
  handleServeCSSAsset,
  handleServeFile,
  handleServeIcon,
  handleServeWallpaper,
  handleUpload,
  handleWallpaperUpload,
} from './upload';
import {
  handleDeleteSound,
  handleListSounds,
  handleServeSound,
  handleSoundUpload,
} from './sounds';
import { handleVisit } from './visit';

// ---------------------------------------------------------------------------
// Small adapters: parse path shape, enforce inner legacy conditions.
// Conditions that don't match return ROUTE_FALLTHROUGH so dispatch continues
// exactly like the legacy if/else chain did.
// ---------------------------------------------------------------------------

/** /api/agent/chat plus any sub-path (the agent transport base). */
const agentChatPath: PathMatcher = (path) =>
  path === '/api/agent/chat' || path.startsWith('/api/agent/chat/') ? [] : null;

/** App versions/rollback: method-specific sub-routes, else fall through. */
const manageAppVersion = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const [rawAppId, action] = c.params;
  const appId = decodeURIComponent(rawAppId);
  if (action === 'versions' && c.request.method === 'GET') {
    return handleAppVersions(c.env, requireAuthContext(c), appId);
  }
  if (action === 'rollback' && c.request.method === 'POST') {
    return handleAppRollback(c.request, c.env, requireAuthContext(c), appId);
  }
  return ROUTE_FALLTHROUGH;
};

/**
 * App source revisions: method-specific sub-routes, else fall through.
 *   GET  /api/apps/:appId/revisions               list
 *   GET  /api/apps/:appId/revisions/:revisionId   one revision (files, diagnostics)
 *   POST /api/apps/:appId/revisions/:revisionId/restore
 */
const manageAppRevisions = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const rawAppId = c.params[0];
  const revisionId = c.params[1] || '';
  const action = c.params[2] || '';
  if (!rawAppId) return ROUTE_FALLTHROUGH;
  const appId = decodeURIComponent(rawAppId);
  if (!revisionId && !action && c.request.method === 'GET') {
    return handleAppRevisionsList(c.env, requireAuthContext(c), appId);
  }
  if (revisionId && !action && c.request.method === 'GET') {
    return handleAppRevisionGet(c.env, requireAuthContext(c), appId, decodeURIComponent(revisionId));
  }
  if (revisionId && action === 'restore' && c.request.method === 'POST') {
    return handleAppRevisionRestore(c.env, requireAuthContext(c), appId, decodeURIComponent(revisionId));
  }
  return ROUTE_FALLTHROUGH;
};

/** Cartridge draft item: method-specific sub-routes, else fall through. */
const manageGameDraft = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const cartId = c.params[0];
  if (c.request.method === 'GET') {
    return handleGetDraft(c.env, requireAuthContext(c), cartId);
  }
  if (c.request.method === 'PUT') {
    return handlePutDraft(c.request, c.env, requireAuthContext(c), cartId);
  }
  if (c.request.method === 'DELETE') {
    return handleDeleteDraft(c.env, requireAuthContext(c), cartId);
  }
  return ROUTE_FALLTHROUGH;
};

/** Wallpaper serving: /api/wallpaper/:uid/:wallpaperId/:filename. */
const serveWallpaper = async (c: RouteContext): Promise<Response> => {
  const parts = c.params[0].split('/');
  if (parts.length < 3) {
    return Response.json({ error: 'Invalid wallpaper path' }, { status: 400, headers: c.corsHeaders });
  }

  const [uid, wallpaperId, ...filenameParts] = parts;
  // Decode URL-encoded filename for consistency
  const filename = decodeURIComponent(filenameParts.join('/'));
  return withCors(await handleServeWallpaper(c.request, c.env, uid, wallpaperId, filename), c.corsHeaders);
};

/** Icon serving: /api/icon/:uid/:itemId/:filename. */
const serveIcon = async (c: RouteContext): Promise<Response> => {
  const parts = c.params[0].split('/');
  if (parts.length < 3) {
    return Response.json({ error: 'Invalid icon path' }, { status: 400, headers: c.corsHeaders });
  }

  const [uid, itemId, ...filenameParts] = parts;
  const filename = decodeURIComponent(filenameParts.join('/'));
  return withCors(await handleServeIcon(c.request, c.env, uid, itemId, filename), c.corsHeaders);
};

/** CSS asset serving: /api/css-assets/:uid/:assetId/:filename (public). */
const serveCssAsset = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const parts = c.params[0].split('/');
  if (parts.length < 3) {
    return ROUTE_FALLTHROUGH;
  }
  const [uid, assetId, ...filenameParts] = parts;
  const filename = decodeURIComponent(filenameParts.join('/'));
  return handleServeCSSAsset(c.request, c.env, uid, assetId, filename);
};

/** Sound delete: single-segment id only, else fall through. */
const deleteSound = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const soundId = c.params[0];
  // Only match delete for single-segment paths (not serving paths)
  if (soundId.includes('/')) {
    return ROUTE_FALLTHROUGH;
  }
  return handleDeleteSound(c.request, c.env, requireAuthContext(c), soundId);
};

/** Sound serving: /api/sounds/:uid/:soundId/:filename (public). */
const serveSound = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const parts = c.params[0].split('/');
  if (parts.length < 3) {
    return ROUTE_FALLTHROUGH;
  }
  const [uid, soundId, ...filenameParts] = parts;
  const filename = decodeURIComponent(filenameParts.join('/'));
  return handleServeSound(c.request, c.env, uid, soundId, filename);
};

/** Cursor delete: single-segment id only, else fall through. */
const deleteCursor = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const cursorId = c.params[0];
  if (cursorId.includes('/')) {
    return ROUTE_FALLTHROUGH;
  }
  return handleDeleteCursor(c.request, c.env, requireAuthContext(c), cursorId);
};

/** Cursor serving: /api/cursors/:uid/:cursorId/:filename (public). */
const serveCursor = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const parts = c.params[0].split('/');
  if (parts.length < 3) {
    return ROUTE_FALLTHROUGH;
  }
  const [uid, cursorId, ...filenameParts] = parts;
  const filename = decodeURIComponent(filenameParts.join('/'));
  return handleServeCursor(c.request, c.env, uid, cursorId, filename);
};

/** Bazaar asset serving: /api/bazaar/assets/:packId/:filename (public). */
const serveBazaarAsset = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const parts = c.params[0].split('/');
  if (parts.length < 2) {
    return ROUTE_FALLTHROUGH;
  }
  const [packId, ...filenameParts] = parts;
  const filename = decodeURIComponent(filenameParts.join('/'));
  return handleBazaarServeAsset(c.request, c.env, packId, filename);
};

/** Bazaar pack read: single-segment packId only, else fall through. */
const getBazaarPack = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const packId = c.params[0];
  if (!packId || packId.includes('/')) {
    return ROUTE_FALLTHROUGH;
  }
  return handleBazaarGetPack(c.request, c.env, packId);
};

/** Bazaar install: single-segment packId only, else fall through. */
const installBazaarPack = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const packId = c.params[0];
  if (!packId || packId.includes('/')) {
    return ROUTE_FALLTHROUGH;
  }
  return handleBazaarInstall(c.request, c.env, requireAuthContext(c), packId);
};

/** Bazaar pack delete: single-segment packId only, else fall through. */
const deleteBazaarPack = async (c: RouteContext): Promise<RouteHandlerResult> => {
  const packId = c.params[0];
  if (!packId || packId.includes('/')) {
    return ROUTE_FALLTHROUGH;
  }
  return handleBazaarDelete(c.request, c.env, requireAuthContext(c), packId);
};

/**
 * File serving: /api/files/:uid/:itemId/:filename. The only route that
 * accepts a `?ft=` file token; visitors can also access public files without
 * any credential (policy.auth 'file' resolves null then — never rejects).
 */
const serveFile = async (c: RouteContext): Promise<Response> => {
  const parts = c.params[0].split('/');
  if (parts.length < 3) {
    return Response.json({ error: 'Invalid file path' }, { status: 400, headers: c.corsHeaders });
  }

  const [fileOwnerUid, itemId, ...filenameParts] = parts;
  // Decode URL-encoded filename (browser encodes spaces as %20, etc.)
  const filename = decodeURIComponent(filenameParts.join('/'));
  return withCors(
    await handleServeFile(c.request, c.env, fileOwnerUid, itemId, filename, c.auth),
    c.corsHeaders
  );
};

/** Visitor mode: /api/visit/:username (analytics tracked non-blocking). */
const serveVisit = async (c: RouteContext): Promise<Response> => {
  const username = c.params[0];
  if (!username) {
    return Response.json({ error: 'Username required' }, { status: 400, headers: c.corsHeaders });
  }
  const response = await handleVisit(c.request, c.env, username);

  // Track analytics non-blocking (if user opted in)
  const normalizedUsername = username.toLowerCase();
  const usernameData = await c.env.AUTH_KV.get<{ uid: string }>(`username:${normalizedUsername}`, 'json');
  if (usernameData) {
    c.ctx.waitUntil(trackVisitAnalytics(c.request, c.env, usernameData.uid));
  }

  return withCors(response, c.corsHeaders);
};

/** OG image generation: /api/og/:username.png. */
const serveOgImage = async (c: RouteContext): Promise<Response> => {
  const username = c.params[0];
  if (!username) {
    return Response.json({ error: 'Username required' }, { status: 400, headers: c.corsHeaders });
  }
  return withCors(await handleOgImage(c.request, c.env, username), c.corsHeaders);
};

// ---------------------------------------------------------------------------
// The table (dispatch order — first match wins).
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  // Game console serving must run before the global OPTIONS handler: the
  // console iframe has an opaque origin ("Origin: null"), so its preflights
  // would fail the dev/prod origin allowlist. The per-game Dynamic Worker
  // answers its own preflights (credential-less, capability-token auth), so
  // this route is intentionally not rate limited.
  {
    name: 'game-console-play',
    method: '*',
    match: prefix('/api/games/play/'),
    policy: { auth: 'handler-scoped', rateLimit: null },
    decorate: false,
    handler: (c) => handleGamePlay(c.request, c.env, c.ctx, c.params[0]),
  },

  // App-iframe preflights. Apps run in sandbox="allow-scripts" iframes, so
  // their origin is opaque ("Origin: null") and every capability-carrying
  // bridge or backend call (Authorization header) is preflighted. The global
  // handler below would refuse that origin, so the app mounts answer their
  // own preflights: credential-less '*' CORS, auth stays the Bearer
  // capability checked on the real request.
  {
    name: 'app-iframe-preflight',
    method: 'OPTIONS',
    match: regex(/^\/api\/(?:apps\/[^/]+\/(?:_eternal|api)(?:\/.*)?|app-previews\/.+)$/),
    policy: { auth: 'none', rateLimit: null },
    decorate: false,
    handler: () => new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-max-age': '300',
      },
    }),
  },

  // CORS preflight — path-independent (any OPTIONS request is a preflight;
  // the game console above answers its own). Production rejects disallowed
  // origins with a bare 403; otherwise CORS-only headers, no body. Never
  // rate limited.
  {
    name: 'cors-preflight',
    method: 'OPTIONS',
    match: anyPath,
    policy: { auth: 'none', rateLimit: null },
    decorate: false,
    handler: (c) => {
      if (c.env.ENVIRONMENT === 'production' && !c.corsHeaders['Access-Control-Allow-Origin']) {
        return new Response('CORS origin not allowed', { status: 403 });
      }
      return new Response(null, { headers: c.corsHeaders });
    },
  },

  // Health check: liveness probe, CORS-only headers, never rate limited.
  {
    name: 'health',
    method: '*',
    match: exact('/api/health'),
    policy: { auth: 'none', rateLimit: null },
    decorate: false,
    handler: (c) => Response.json({ status: 'ok', timestamp: Date.now() }, { headers: c.corsHeaders }),
  },

  // -------------------------------------------------------------------
  // Agent (Ask Eternal)
  // These routes historically returned before the general rate-limit block
  // and were therefore unlimited — an unauthenticated flood could hammer
  // thread CRUD, token minting, and the AI-backed chat transport. The route
  // table now closes that gap: they get the standard 300 req/min API bucket
  // (the same one every other authenticated non-auth route uses), enforced
  // before auth like the general block. The only behavior change of the
  // refactor; everything else (status codes, CORS, success headers — no
  // X-RateLimit-* on 2xx) is unchanged.
  // -------------------------------------------------------------------
  {
    name: 'agent-chat-ws-token',
    method: 'POST',
    match: exact('/api/agent/chat/ws-token'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleAgentChatWsToken,
  },
  {
    name: 'agent-threads-list',
    method: 'GET',
    match: exact('/api/agent/threads'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleListAgentThreads,
  },
  {
    name: 'agent-thread-create',
    method: 'POST',
    match: exact('/api/agent/threads'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleCreateAgentThread,
  },
  {
    name: 'agent-thread-rename',
    method: 'PATCH',
    match: regex(/^\/api\/agent\/threads\/([^/]+)$/),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleRenameAgentThread,
  },
  {
    name: 'agent-thread-delete',
    method: 'DELETE',
    match: regex(/^\/api\/agent\/threads\/([^/]+)$/),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleDeleteAgentThread,
  },
  // Code Mode undo and routines: owner-only (the agent name is derived from
  // the authenticated uid), same bucket as the other agent routes.
  {
    name: 'agent-run-undo',
    method: 'POST',
    match: regex(/^\/api\/agent\/runs\/([^/]+)\/undo$/),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleUndoCodeRun,
  },
  {
    name: 'agent-routines-list',
    method: 'GET',
    match: exact('/api/agent/routines'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleListRoutines,
  },
  {
    name: 'agent-routine-run',
    method: 'POST',
    match: regex(/^\/api\/agent\/routines\/([^/]+)\/run$/),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleRunRoutineNow,
  },
  {
    name: 'agent-routine-delete',
    method: 'DELETE',
    match: regex(/^\/api\/agent\/routines\/([^/]+)$/),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleDeleteRoutine,
  },
  // Authenticated stateful chat agent routed through a stable API path; the
  // agent instance name is derived from the authenticated uid + thread id.
  // WebSocket upgrades are origin-checked and wsToken-authenticated (the
  // 'agent-chat' mode in middleware/auth.ts).
  {
    name: 'agent-chat',
    method: '*',
    match: agentChatPath,
    policy: { auth: 'agent-chat', rateLimit: RATE_LIMIT_API },
    handler: handleAgentChatForward,
  },

  // -------------------------------------------------------------------
  // App management + sandboxed app runtime
  // Legacy: all /api/apps/* management routes bypassed the general
  // rate-limit block; the table records that decision explicitly.
  // -------------------------------------------------------------------
  {
    name: 'app-dev-deploy',
    method: 'POST',
    match: exact('/api/apps/dev-deploy'),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleAppDevDeploy(c.request, c.env, requireAuthContext(c)),
  },
  {
    name: 'app-versions-rollback',
    method: '*',
    match: regex(/^\/api\/apps\/([^/]+)\/(versions|rollback)$/),
    policy: { auth: 'required', rateLimit: null },
    handler: manageAppVersion,
  },
  // App source revisions (list / get one / restore) — same owner-only auth
  // and "not rate limited" decision as every other app-management route.
  {
    name: 'app-revisions',
    method: '*',
    match: regex(/^\/api\/apps\/([^/]+)\/revisions(?:\/([^/]+)(?:\/(restore))?)?$/),
    policy: { auth: 'required', rateLimit: null },
    handler: manageAppRevisions,
  },
  {
    name: 'app-delete',
    method: 'DELETE',
    match: regex(/^\/api\/apps\/([^/]+)$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleAppDelete(c.env, requireAuthContext(c), decodeURIComponent(c.params[0])),
  },
  {
    name: 'app-permissions',
    method: '*',
    match: regex(/^\/api\/apps\/([^/]+)\/permissions$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleAppPermissions(c.request, c.env, requireAuthContext(c), decodeURIComponent(c.params[0])),
  },
  // App skin for visitors (public apps only): GET /api/apps/:appId/public-skin
  {
    name: 'app-public-skin',
    method: 'GET',
    match: regex(/^\/api\/apps\/([^/]+)\/public-skin$/),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_API },
    handler: (c) => handlePublicAppSkin(c.env, decodeURIComponent(c.params[0])),
  },
  // App skins (owner): /api/apps/:appId/skins[/generate|/active|/:skinId]
  {
    name: 'app-skins',
    method: '*',
    match: regex(/^\/api\/apps\/([^/]+)\/skins(?:\/([^/]+))?$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleAppSkins(c.request, c.env, requireAuthContext(c), decodeURIComponent(c.params[0]), c.params[1]),
  },
  // Get App Source: GET /api/apps/:appId/source
  {
    name: 'app-source',
    method: 'GET',
    match: regex(/^\/api\/apps\/([^/]+)\/source$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleGetAppSourceRoute(c.request, c.env, requireAuthContext(c), c.params[0]),
  },
  // Full-stack app backend logs (owner): GET /api/apps/:appId/backend/logs
  {
    name: 'app-backend-logs',
    method: 'GET',
    match: regex(/^\/api\/apps\/([^/]+)\/backend\/logs$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleAppBackendLogsRoute(c.request, c.env, requireAuthContext(c), decodeURIComponent(c.params[0])),
  },
  // Mint a capability token for an app: POST /api/apps/:appId/capability.
  // Runs before the app-serving catch-all below so the capability path
  // doesn't get swallowed by the iframe-serving code.
  {
    name: 'app-capability',
    method: 'POST',
    match: regex(/^\/api\/apps\/([^/]+)\/capability$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleAppCapability(c.request, c.env, requireAuthContext(c), c.params[0]),
  },
  // App fs.list — capability-gated; auth verified inside handler.
  {
    name: 'app-fs-list',
    method: 'GET',
    match: regex(/^\/api\/apps\/([^/]+)\/fs\/list$/),
    policy: { auth: 'handler-scoped', rateLimit: null },
    handler: (c) => handleAppFsList(c.request, c.env, c.params[0]),
  },
  // App fs.read — capability-gated; streams from R2 or returns inline content.
  {
    name: 'app-fs-read',
    method: 'GET',
    match: regex(/^\/api\/apps\/([^/]+)\/fs\/read\/([^/]+)$/),
    policy: { auth: 'handler-scoped', rateLimit: null },
    handler: (c) => handleAppFsRead(c.request, c.env, c.params[0], c.params[1]),
  },
  // Serve generated app previews via Dynamic Workers.
  {
    name: 'app-preview-serve',
    method: '*',
    match: prefix('/api/app-previews/'),
    policy: { auth: 'handler-scoped', rateLimit: null },
    decorate: false,
    handler: handleServeAppPreview,
  },

  // -------------------------------------------------------------------
  // Fantasy-console game routes
  // (/api/games/play/* is dispatched at the top of the table)
  // -------------------------------------------------------------------
  // Mint a player capability token: POST /api/games/:gameId/capability
  {
    name: 'game-capability',
    method: 'POST',
    match: regex(/^\/api\/games\/([^/]+)\/capability$/),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleGameCapability(c.request, c.env, requireAuthContext(c), decodeURIComponent(c.params[0])),
  },
  // Cartridge draft CRUD (auth required)
  {
    name: 'game-drafts-list',
    method: 'GET',
    match: exact('/api/games/drafts'),
    policy: { auth: 'required', rateLimit: null },
    handler: (c) => handleListDrafts(c.env, requireAuthContext(c)),
  },
  {
    name: 'game-draft-item',
    method: '*',
    match: regex(/^\/api\/games\/drafts\/([^/]+)$/),
    policy: { auth: 'required', rateLimit: null },
    handler: manageGameDraft,
  },

  // Serve user-created apps via Dynamic Workers: /api/apps/:appId
  {
    name: 'app-serve',
    method: '*',
    match: prefix('/api/apps/'),
    policy: { auth: 'handler-scoped', rateLimit: null },
    decorate: false,
    handler: handleServeApp,
  },

  // Visitor live-sync WebSocket. Own connection-rate bucket (RATE_LIMIT_WS)
  // enforced inside the handler; non-upgrade requests fall through to the
  // unmatched-path policy, exactly like the legacy route.
  {
    name: 'visitor-ws',
    method: '*',
    match: prefix('/api/ws/'),
    policy: { auth: 'handler-scoped', rateLimit: null },
    decorate: false,
    handler: handleVisitorWebSocket,
  },

  // -------------------------------------------------------------------
  // Auth routes (60 req/min limit; success responses expose
  // X-RateLimit-* headers — the only routes that do besides file-token).
  // -------------------------------------------------------------------
  {
    name: 'auth-signup',
    method: 'POST',
    match: exact('/api/auth/signup'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleSignup(c.request, c.env, c.ctx),
  },
  {
    name: 'auth-login',
    method: 'POST',
    match: exact('/api/auth/login'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleLogin(c.request, c.env),
  },
  {
    name: 'auth-logout',
    method: 'POST',
    match: exact('/api/auth/logout'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleLogout(c.request, c.env),
  },
  {
    name: 'auth-google-callback',
    method: 'POST',
    match: exact('/api/auth/google'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleGoogleCallback(c.request, c.env),
  },
  {
    name: 'auth-forgot-password',
    method: 'POST',
    match: exact('/api/auth/forgot-password'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleForgotPassword(c.request, c.env, c.ctx),
  },
  {
    name: 'auth-reset-password',
    method: 'POST',
    match: exact('/api/auth/reset-password'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleResetPassword(c.request, c.env),
  },
  {
    name: 'auth-refresh',
    method: 'POST',
    match: exact('/api/auth/refresh'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleRefreshToken(c.request, c.env),
  },
  // Change password (authenticated)
  {
    name: 'auth-change-password',
    method: 'POST',
    match: exact('/api/auth/change-password'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleChangePassword(c.request, c.env, requireAuthContext(c)),
  },
  // Change username (authenticated)
  {
    name: 'auth-change-username',
    method: 'POST',
    match: exact('/api/auth/change-username'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleChangeUsername(c.request, c.env, requireAuthContext(c), c.ctx),
  },
  // Send verification email (authenticated)
  {
    name: 'auth-send-verification',
    method: 'POST',
    match: exact('/api/auth/send-verification'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleSendVerification(c.request, c.env, requireAuthContext(c)),
  },
  // Verify email (token-based, no auth required)
  {
    name: 'auth-verify-email',
    method: 'POST',
    match: exact('/api/auth/verify-email'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleVerifyEmail(c.request, c.env),
  },
  // Soft-delete account (authenticated) — 14-day grace period
  {
    name: 'auth-delete-account',
    method: 'POST',
    match: exact('/api/auth/delete-account'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleDeleteAccount(c.request, c.env, requireAuthContext(c)),
  },
  // Cancel a pending account deletion (no auth — soft-deleted users can't log in)
  {
    name: 'auth-cancel-deletion',
    method: 'POST',
    match: exact('/api/auth/cancel-deletion'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleCancelDeletion(c.request, c.env),
  },
  // GDPR data export (authenticated) — returns a JSON download
  {
    name: 'auth-export-data',
    method: 'GET',
    match: exact('/api/auth/export-data'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleExportData(c.request, c.env, requireAuthContext(c)),
  },
  // Use a recovery code to sign in (and optionally reset password)
  {
    name: 'auth-use-recovery-code',
    method: 'POST',
    match: exact('/api/auth/use-recovery-code'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleUseRecoveryCode(c.request, c.env),
  },
  // Regenerate recovery codes (authenticated, password confirmation required)
  {
    name: 'auth-regenerate-recovery-codes',
    method: 'POST',
    match: exact('/api/auth/regenerate-recovery-codes'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_AUTH, rateLimitHeaders: true },
    handler: (c) => handleRegenerateRecoveryCodes(c.request, c.env, requireAuthContext(c)),
  },

  // -------------------------------------------------------------------
  // Desktop state (require auth, 300 req/min limit)
  // -------------------------------------------------------------------
  {
    name: 'desktop-list',
    method: 'GET',
    match: exact('/api/desktop'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleGetDesktop,
  },
  {
    name: 'desktop-items-create',
    method: 'POST',
    match: exact('/api/desktop/items'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleCreateDesktopItems,
  },
  {
    name: 'desktop-items-update',
    method: 'PATCH',
    match: exact('/api/desktop/items'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleUpdateDesktopItems,
  },
  {
    name: 'desktop-item-delete',
    method: 'DELETE',
    match: prefix('/api/desktop/items/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleDeleteDesktopItem,
  },
  // Window state persistence
  {
    name: 'desktop-windows-put',
    method: 'PUT',
    match: exact('/api/desktop/windows'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handlePutWindows,
  },

  // Short-lived file token for media src URLs (replaces JWT-in-query-param).
  // Legacy: exposes X-RateLimit-* headers on success, like auth routes.
  {
    name: 'file-token',
    method: 'POST',
    match: exact('/api/file-token'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API, rateLimitHeaders: true },
    handler: async (c) => Response.json({ ft: await issueFileToken(c.env, requireAuthContext(c).uid) }),
  },

  // File upload
  {
    name: 'upload',
    method: 'POST',
    match: exact('/api/upload'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleUpload(c.request, c.env, requireAuthContext(c), c.ctx),
  },

  // Image metadata enrichment: POST /api/desktop/items/:id/analyze
  {
    name: 'analyze-image-item',
    method: 'POST',
    match: startsAndEndsWith('/api/desktop/items/', '/analyze'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleAnalyzeImageItem(c.env, requireAuthContext(c), c.params[0], c.ctx),
  },

  // Custom wallpaper upload
  {
    name: 'wallpaper-upload',
    method: 'POST',
    match: exact('/api/wallpaper'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleWallpaperUpload(c.request, c.env, requireAuthContext(c)),
  },
  // Wallpaper serving: /api/wallpaper/:uid/:wallpaperId/:filename
  {
    name: 'wallpaper-serve',
    method: 'GET',
    match: prefix('/api/wallpaper/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    decorate: false,
    handler: serveWallpaper,
  },

  // Custom icon upload
  {
    name: 'icon-upload',
    method: 'POST',
    match: exact('/api/icon'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleIconUpload(c.request, c.env, requireAuthContext(c)),
  },
  // Custom icon serving: /api/icon/:uid/:itemId/:filename
  {
    name: 'icon-serve',
    method: 'GET',
    match: prefix('/api/icon/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    decorate: false,
    handler: serveIcon,
  },

  // CSS asset upload
  {
    name: 'css-asset-upload',
    method: 'POST',
    match: exact('/api/css-assets'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleCSSAssetUpload(c.request, c.env, requireAuthContext(c)),
  },
  // CSS asset list
  {
    name: 'css-asset-list',
    method: 'GET',
    match: exact('/api/css-assets'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleListCSSAssets(c.request, c.env, requireAuthContext(c)),
  },
  // CSS asset delete: /api/css-assets/:assetId (public-asset bucket — the
  // legacy prefix-based selection put every /api/css-assets/* path there)
  {
    name: 'css-asset-delete',
    method: 'DELETE',
    match: prefix('/api/css-assets/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: (c) => handleDeleteCSSAsset(c.request, c.env, requireAuthContext(c), c.params[0]),
  },
  // CSS asset serving: /api/css-assets/:uid/:assetId/:filename (public)
  {
    name: 'css-asset-serve',
    method: 'GET',
    match: prefix('/api/css-assets/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: serveCssAsset,
  },

  // Sound upload
  {
    name: 'sound-upload',
    method: 'POST',
    match: exact('/api/sounds'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleSoundUpload(c.request, c.env, requireAuthContext(c)),
  },
  // Sound list
  {
    name: 'sound-list',
    method: 'GET',
    match: exact('/api/sounds'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleListSounds(c.request, c.env, requireAuthContext(c)),
  },
  // Sound delete: /api/sounds/:soundId (public-asset bucket, legacy selection)
  {
    name: 'sound-delete',
    method: 'DELETE',
    match: prefix('/api/sounds/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: deleteSound,
  },
  // Sound serving: /api/sounds/:uid/:soundId/:filename (public)
  {
    name: 'sound-serve',
    method: 'GET',
    match: prefix('/api/sounds/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: serveSound,
  },

  // Cursor upload
  {
    name: 'cursor-upload',
    method: 'POST',
    match: exact('/api/cursors'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleCursorUpload(c.request, c.env, requireAuthContext(c)),
  },
  // Cursor list
  {
    name: 'cursor-list',
    method: 'GET',
    match: exact('/api/cursors'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleListCursors(c.request, c.env, requireAuthContext(c)),
  },
  // Cursor delete: /api/cursors/:cursorId (public-asset bucket, legacy selection)
  {
    name: 'cursor-delete',
    method: 'DELETE',
    match: prefix('/api/cursors/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: deleteCursor,
  },
  // Cursor serving: /api/cursors/:uid/:cursorId/:filename (public)
  {
    name: 'cursor-serve',
    method: 'GET',
    match: prefix('/api/cursors/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: serveCursor,
  },

  // -------------------------------------------------------------------
  // Bazaar routes
  // -------------------------------------------------------------------
  // Bazaar asset serving (public, cacheable) — must be before auth-required routes
  {
    name: 'bazaar-asset-serve',
    method: 'GET',
    match: prefix('/api/bazaar/assets/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    handler: serveBazaarAsset,
  },
  // Bazaar browse (public)
  {
    name: 'bazaar-browse',
    method: 'GET',
    match: exact('/api/bazaar/browse'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleBazaarBrowse(c.request, c.env),
  },
  // Bazaar get pack (public)
  {
    name: 'bazaar-pack-get',
    method: 'GET',
    match: prefix('/api/bazaar/pack/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_API },
    handler: getBazaarPack,
  },
  // Bazaar publish (auth required) — legacy flat-config packs
  {
    name: 'bazaar-publish',
    method: 'POST',
    match: exact('/api/bazaar/publish'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleBazaarPublish(c.request, c.env, requireAuthContext(c)),
  },
  // Bazaar publish .estheme (auth required) — new theme bundle format
  {
    name: 'bazaar-publish-estheme',
    method: 'POST',
    match: exact('/api/bazaar/publish-estheme'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleBazaarPublishEstheme(c.request, c.env, requireAuthContext(c)),
  },
  // Bazaar publish game cartridge (auth required)
  {
    name: 'bazaar-publish-game',
    method: 'POST',
    match: exact('/api/bazaar/publish-game'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleBazaarPublishGame(c.request, c.env, requireAuthContext(c)),
  },
  // Bazaar install (auth required)
  {
    name: 'bazaar-install',
    method: 'POST',
    match: prefix('/api/bazaar/install/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: installBazaarPack,
  },
  // Bazaar delete (auth required, author only)
  {
    name: 'bazaar-pack-delete',
    method: 'DELETE',
    match: prefix('/api/bazaar/pack/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: deleteBazaarPack,
  },
  // Bazaar my packs (auth required)
  {
    name: 'bazaar-my-packs',
    method: 'GET',
    match: exact('/api/bazaar/my-packs'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleBazaarMyPacks(c.request, c.env, requireAuthContext(c)),
  },

  // File serving: /api/files/:uid/:itemId/:filename
  {
    name: 'file-serve',
    method: 'GET',
    match: prefix('/api/files/'),
    policy: { auth: 'file', rateLimit: RATE_LIMIT_PUBLIC_ASSET },
    decorate: false,
    handler: serveFile,
  },

  // Visitor mode: /api/visit/:username
  {
    name: 'visit',
    method: 'GET',
    match: prefix('/api/visit/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_API },
    decorate: false,
    handler: serveVisit,
  },

  // OG Image generation: /api/og/:username.png
  {
    name: 'og-image',
    method: 'GET',
    match: prefix('/api/og/'),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_API },
    decorate: false,
    handler: serveOgImage,
  },

  // -------------------------------------------------------------------
  // Profile / customization state (require auth)
  // -------------------------------------------------------------------
  {
    name: 'profile-get',
    method: 'GET',
    match: exact('/api/profile'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleGetProfile,
  },
  {
    name: 'profile-patch',
    method: 'PATCH',
    match: exact('/api/profile'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handlePatchProfile,
  },
  // GET /api/css-history - List saved custom CSS versions
  {
    name: 'css-history-list',
    method: 'GET',
    match: exact('/api/css-history'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleGetCssHistory,
  },
  // POST /api/css-history/:versionId/revert - Restore a saved custom CSS version
  {
    name: 'css-history-revert',
    method: 'POST',
    match: startsAndEndsWith('/api/css-history/', '/revert'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleRevertCssHistory,
  },
  // Quota route (requires auth)
  // GET /api/quota - Get storage quota usage
  {
    name: 'quota',
    method: 'GET',
    match: exact('/api/quota'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleGetQuota,
  },

  // -------------------------------------------------------------------
  // Trash (require auth)
  // -------------------------------------------------------------------
  // GET /api/trash - List trashed items
  {
    name: 'trash-list',
    method: 'GET',
    match: exact('/api/trash'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleListTrash,
  },
  // POST /api/trash/restore/:id - Restore item from trash
  {
    name: 'trash-restore',
    method: 'POST',
    match: prefix('/api/trash/restore/'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleRestoreTrashItem,
  },
  // DELETE /api/trash - Empty trash
  {
    name: 'trash-empty',
    method: 'DELETE',
    match: exact('/api/trash'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: handleEmptyTrash,
  },

  // Analytics route (requires auth)
  {
    name: 'analytics',
    method: 'GET',
    match: exact('/api/analytics'),
    policy: { auth: 'required', rateLimit: RATE_LIMIT_API },
    handler: (c) => handleGetAnalytics(c.request, c.env, requireAuthContext(c)),
  },

  // Guestbook (no auth required; general API bucket here plus the handler's
  // own one-entry-per-hour KV cooldown)
  // POST /api/guestbook/:uid/:itemId - Add guestbook entry
  {
    name: 'guestbook-sign',
    method: 'POST',
    match: regex(/^\/api\/guestbook\/([^/]+)\/([^/]+)$/),
    policy: { auth: 'none', rateLimit: RATE_LIMIT_API },
    handler: handleGuestbookSign,
  },
];

// ---------------------------------------------------------------------------
// Unmatched-path policy (legacy)
// ---------------------------------------------------------------------------

/**
 * Rate-limit bucket for requests that match no route — the legacy
 * prefix-based selection from the general block. Public asset GETs get the
 * high-cap limit (1000/min) — enough for a visitor page with many images,
 * tight enough to block R2 egress DoS. Method-independent, as before.
 */
export function unmatchedRouteRateLimit(path: string): RateLimitConfig {
  const isPublicAssetRoute = path.startsWith('/api/files/')
    || path.startsWith('/api/wallpaper/')
    || path.startsWith('/api/css-assets/')
    || path.startsWith('/api/sounds/')
    || path.startsWith('/api/cursors/')
    || path.startsWith('/api/bazaar/assets/');
  const isAuthRoute = path.startsWith('/api/auth/');
  return isPublicAssetRoute
    ? RATE_LIMIT_PUBLIC_ASSET
    : isAuthRoute
      ? RATE_LIMIT_AUTH
      : RATE_LIMIT_API;
}

// ---------------------------------------------------------------------------
// Entry point used by index.ts
// ---------------------------------------------------------------------------

/** Dispatch a fetch through the route table with the unmatched-path policy. */
export function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return dispatchRequest(request, env, ctx, ROUTES, {
    fallbackRateLimit: unmatchedRouteRateLimit,
  });
}
