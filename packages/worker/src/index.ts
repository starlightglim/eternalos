/**
 * EternalOS Cloudflare Worker Entry Point
 *
 * Routes all /api/* requests to appropriate handlers.
 * Integrates with KV, R2, Durable Objects, and Workers AI.
 */

import { UserDesktop } from './durable-objects/UserDesktop';
import { DesktopChatAgent } from './agents/DesktopChatAgent';
import { handleSignup, handleLogin, handleLogout, handleForgotPassword, handleResetPassword, handleRefreshToken } from './routes/auth';
import { handleUpload, handleServeFile, handleWallpaperUpload, handleServeWallpaper, handleIconUpload, handleServeIcon, handleCSSAssetUpload, handleServeCSSAsset, handleListCSSAssets, handleDeleteCSSAsset, handleAnalyzeImageItem } from './routes/upload';
import { handleVisit } from './routes/visit';
import { handleOgImage } from './routes/ogImage';
import { trackVisitAnalytics, handleGetAnalytics } from './routes/analytics';
import { requireAuth, authenticate } from './middleware/auth';
import { getAgentByName } from 'agents';
import {
  checkRateLimit,
  rateLimitResponse,
  addRateLimitHeaders,
  RATE_LIMIT_AUTH,
  RATE_LIMIT_API,
  type RateLimitResult,
} from './middleware/rateLimit';

export interface Env {
  // KV Namespaces
  AUTH_KV: KVNamespace;
  DESKTOP_KV: KVNamespace;

  // R2 Bucket
  ETERNALOS_FILES: R2Bucket;

  // Durable Objects
  USER_DESKTOP: DurableObjectNamespace;
  DesktopChatAgent: DurableObjectNamespace<DesktopChatAgent>;

  // Workers AI
  AI: Ai;

  // Secrets
  JWT_SECRET: string;
  RESEND_API_KEY?: string; // For sending transactional emails (password reset, etc.)
  IMAGE_ANALYSIS_MODEL?: string; // Optional Workers AI model override for image metadata enrichment
  AGENT_CHAT_MODEL?: string; // Optional Workers AI model override for chat agent

  // Environment settings
  ENVIRONMENT?: 'development' | 'production';
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins for production
  FROM_EMAIL?: string; // Sender email address (e.g., "EternalOS <noreply@eternalos.app>")
  APP_URL?: string; // Base URL for the app (e.g., "https://eternalos.app")
}

export { UserDesktop, DesktopChatAgent };

// Standard security headers applied to every response
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Helper to add CORS + security headers to response
function withCors(response: Response, corsHeaders: Record<string, string>): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    newHeaders.set(key, value);
  }
  const websocket = (response as Response & { webSocket?: WebSocket }).webSocket;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
    webSocket: websocket,
  });
}

// Get CORS headers based on environment and request origin
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isProduction = env.ENVIRONMENT === 'production';

  // In development, allow all origins
  if (!isProduction) {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }

  // In production, check against allowed origins
  const allowedOrigins = env.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [];

  // Always allow the worker's own origin (for same-origin requests)
  const requestUrl = new URL(request.url);
  const selfOrigin = `${requestUrl.protocol}//${requestUrl.host}`;
  allowedOrigins.push(selfOrigin);

  // Check if the request origin is allowed
  const isAllowed = allowedOrigins.includes(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin', // Important for caching with different origins
  };
}

export default {
  /**
   * Scheduled handler - runs daily to clean up old trashed items
   * Cron: 0 3 * * * (3:00 AM UTC daily)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled trash cleanup...');

    // Enumerate all users via per-user index keys (avoids race condition of a single JSON array).
    // KV.list() returns keys in pages of up to 1000.
    const userUids: string[] = [];
    let cursor: string | undefined;
    do {
      const listResult = await env.AUTH_KV.list({ prefix: 'user_index:', cursor });
      for (const key of listResult.keys) {
        // key.name is "user_index:{uid}" — extract uid
        userUids.push(key.name.slice('user_index:'.length));
      }
      cursor = listResult.list_complete ? undefined : (listResult.cursor ?? undefined);
    } while (cursor);

    if (userUids.length === 0) {
      console.log('No users found, skipping cleanup');
      return;
    }

    console.log(`Processing ${userUids.length} users for trash cleanup`);

    let totalDeleted = 0;
    let totalR2Deleted = 0;

    // Workers have a 1000 subrequest limit. Each user needs 1 DO fetch + N R2 deletes.
    // Process in batches to stay within limits and avoid timeout.
    const BATCH_SIZE = 50; // Conservative: leaves room for R2 deletes per batch

    for (let i = 0; i < userUids.length; i += BATCH_SIZE) {
      const batch = userUids.slice(i, i + BATCH_SIZE);

      // Process batch concurrently
      const results = await Promise.allSettled(
        batch.map(async (uid) => {
          const doId = env.USER_DESKTOP.idFromName(uid);
          const stub = env.USER_DESKTOP.get(doId);
          const response = await stub.fetch(new Request('http://internal/trash/cleanup', {
            method: 'POST',
          }));

          const result = await response.json() as { deleted: number; r2Keys: string[] };

          if (result.deleted > 0) {
            console.log(`User ${uid}: deleted ${result.deleted} old trash items`);

            // Clean up R2 files
            if (result.r2Keys.length > 0) {
              await Promise.all(result.r2Keys.map((key) => env.ETERNALOS_FILES.delete(key)));
            }
          }

          return result;
        })
      );

      // Tally results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalDeleted += result.value.deleted;
          totalR2Deleted += result.value.r2Keys.length;
        } else {
          console.error('Batch cleanup error:', result.reason);
        }
      }
    }

    console.log(`Scheduled cleanup complete: ${totalDeleted} items deleted, ${totalR2Deleted} R2 files cleaned up`);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Get environment-aware CORS headers
    const corsHeaders = getCorsHeaders(request, env);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      // In production, reject requests from disallowed origins
      if (env.ENVIRONMENT === 'production' && !corsHeaders['Access-Control-Allow-Origin']) {
        return new Response('CORS origin not allowed', { status: 403 });
      }
      return new Response(null, { headers: corsHeaders });
    }

    // Health check (no rate limiting)
    if (path === '/api/health') {
      return Response.json({ status: 'ok', timestamp: Date.now() }, { headers: corsHeaders });
    }

    // Authenticated stateful chat agent routed through a stable API path.
    // The actual agent instance name is the authenticated uid, not a client-provided value.
    if (path === '/api/agent/chat' || path.startsWith('/api/agent/chat/')) {
      const authResult = await requireAuth(request, env);
      if (authResult instanceof Response) {
        return withCors(authResult, corsHeaders);
      }

      const agentStub = await getAgentByName<Env, DesktopChatAgent>(env.DesktopChatAgent, authResult.uid);
      const forwardUrl = new URL(request.url);
      const remainder = path.slice('/api/agent/chat'.length);
      forwardUrl.pathname = remainder || '/';

      const agentResponse = await agentStub.fetch(new Request(forwardUrl.toString(), request));
      return withCors(agentResponse, corsHeaders);
    }

    // WebSocket live-sync for visitors: /api/ws/:username
    if (path.startsWith('/api/ws/') && request.headers.get('Upgrade') === 'websocket') {
      const wsUsername = path.slice('/api/ws/'.length).toLowerCase();
      if (!wsUsername) {
        return new Response('Username required', { status: 400 });
      }

      // Look up uid by username (stored as JSON { uid })
      const usernameData = await env.AUTH_KV.get<{ uid: string }>(`username:${wsUsername}`, 'json');
      if (!usernameData) {
        return new Response('User not found', { status: 404 });
      }

      // Forward WebSocket upgrade to user's Durable Object
      const doId = env.USER_DESKTOP.idFromName(usernameData.uid);
      const stub = env.USER_DESKTOP.get(doId);
      return stub.fetch(new Request('http://internal/ws', {
        headers: request.headers,
      }));
    }

    // Route to appropriate handler
    try {
      let response: Response;
      let rateLimitResult: RateLimitResult | null = null;

      // Determine rate limit config based on path
      const isAuthRoute = path.startsWith('/api/auth/');
      const rateLimitConfig = isAuthRoute ? RATE_LIMIT_AUTH : RATE_LIMIT_API;

      // Check rate limit (skip for file serving to avoid latency)
      const skipRateLimit = path.startsWith('/api/files/') || path.startsWith('/api/wallpaper/') || path.startsWith('/api/css-assets/');
      if (!skipRateLimit) {
        rateLimitResult = await checkRateLimit(request, env, rateLimitConfig);
        if (!rateLimitResult.allowed) {
          return withCors(rateLimitResponse(rateLimitResult), corsHeaders);
        }
      }

      // Auth routes (60 req/min limit)
      if (path === '/api/auth/signup' && request.method === 'POST') {
        response = await handleSignup(request, env);
        if (rateLimitResult) {
          response = addRateLimitHeaders(response, rateLimitResult, rateLimitConfig);
        }
        return withCors(response, corsHeaders);
      }

      if (path === '/api/auth/login' && request.method === 'POST') {
        response = await handleLogin(request, env);
        if (rateLimitResult) {
          response = addRateLimitHeaders(response, rateLimitResult, rateLimitConfig);
        }
        return withCors(response, corsHeaders);
      }

      if (path === '/api/auth/logout' && request.method === 'POST') {
        response = await handleLogout(request, env);
        if (rateLimitResult) {
          response = addRateLimitHeaders(response, rateLimitResult, rateLimitConfig);
        }
        return withCors(response, corsHeaders);
      }

      if (path === '/api/auth/forgot-password' && request.method === 'POST') {
        response = await handleForgotPassword(request, env);
        if (rateLimitResult) {
          response = addRateLimitHeaders(response, rateLimitResult, rateLimitConfig);
        }
        return withCors(response, corsHeaders);
      }

      if (path === '/api/auth/reset-password' && request.method === 'POST') {
        response = await handleResetPassword(request, env);
        if (rateLimitResult) {
          response = addRateLimitHeaders(response, rateLimitResult, rateLimitConfig);
        }
        return withCors(response, corsHeaders);
      }

      if (path === '/api/auth/refresh' && request.method === 'POST') {
        response = await handleRefreshToken(request, env);
        if (rateLimitResult) {
          response = addRateLimitHeaders(response, rateLimitResult, rateLimitConfig);
        }
        return withCors(response, corsHeaders);
      }

      // Desktop routes (require auth, 300 req/min limit)
      if (path === '/api/desktop' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        // Forward to user's Durable Object
        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request('http://internal/items'));
        return withCors(doResponse, corsHeaders);
      }

      if (path === '/api/desktop/items' && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const body = await request.text();
        const doResponse = await stub.fetch(new Request('http://internal/items', {
          method: 'POST',
          body,
        }));
        return withCors(doResponse, corsHeaders);
      }

      if (path === '/api/desktop/items' && request.method === 'PATCH') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const body = await request.text();
        const doResponse = await stub.fetch(new Request('http://internal/items', {
          method: 'PATCH',
          body,
        }));
        return withCors(doResponse, corsHeaders);
      }

      if (path.startsWith('/api/desktop/items/') && request.method === 'DELETE') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const itemId = path.slice('/api/desktop/items/'.length);
        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request(`http://internal/items/${itemId}`, {
          method: 'DELETE',
        }));

        // Clean up R2 files (including cascaded children)
        const result = await doResponse.json() as { deleted: boolean; r2Key?: string; r2Keys?: string[] };
        const keysToDelete = result.r2Keys || (result.r2Key ? [result.r2Key] : []);
        if (keysToDelete.length > 0) {
          await Promise.all(keysToDelete.map((key) => env.ETERNALOS_FILES.delete(key)));
        }

        return withCors(Response.json(result), corsHeaders);
      }

      // Window state persistence
      if (path === '/api/desktop/windows' && request.method === 'PUT') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const body = await request.text();
        const doResponse = await stub.fetch(new Request('http://internal/windows', {
          method: 'PUT',
          body,
        }));
        return withCors(doResponse, corsHeaders);
      }

      // File upload
      if (path === '/api/upload' && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        response = await handleUpload(request, env, authResult, ctx);
        return withCors(response, corsHeaders);
      }

      if (path.startsWith('/api/desktop/items/') && path.endsWith('/analyze') && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const itemId = path.slice('/api/desktop/items/'.length, -'/analyze'.length);
        response = await handleAnalyzeImageItem(env, authResult, itemId, ctx);
        return withCors(response, corsHeaders);
      }

      // Custom wallpaper upload
      if (path === '/api/wallpaper' && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        response = await handleWallpaperUpload(request, env, authResult);
        return withCors(response, corsHeaders);
      }

      // Wallpaper serving: /api/wallpaper/:uid/:wallpaperId/:filename
      if (path.startsWith('/api/wallpaper/') && request.method === 'GET') {
        const parts = path.slice('/api/wallpaper/'.length).split('/');
        if (parts.length < 3) {
          return Response.json({ error: 'Invalid wallpaper path' }, { status: 400, headers: corsHeaders });
        }

        const [uid, wallpaperId, ...filenameParts] = parts;
        // Decode URL-encoded filename for consistency
        const filename = decodeURIComponent(filenameParts.join('/'));

        response = await handleServeWallpaper(request, env, uid, wallpaperId, filename);
        return withCors(response, corsHeaders);
      }

      // Custom icon upload
      if (path === '/api/icon' && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        response = await handleIconUpload(request, env, authResult);
        return withCors(response, corsHeaders);
      }

      // Custom icon serving: /api/icon/:uid/:itemId/:filename
      if (path.startsWith('/api/icon/') && request.method === 'GET') {
        const parts = path.slice('/api/icon/'.length).split('/');
        if (parts.length < 3) {
          return Response.json({ error: 'Invalid icon path' }, { status: 400, headers: corsHeaders });
        }

        const [uid, itemId, ...filenameParts] = parts;
        const filename = decodeURIComponent(filenameParts.join('/'));

        response = await handleServeIcon(request, env, uid, itemId, filename);
        return withCors(response, corsHeaders);
      }

      // CSS asset upload
      if (path === '/api/css-assets' && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        response = await handleCSSAssetUpload(request, env, authResult);
        return withCors(response, corsHeaders);
      }

      // CSS asset list
      if (path === '/api/css-assets' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        response = await handleListCSSAssets(request, env, authResult);
        return withCors(response, corsHeaders);
      }

      // CSS asset delete: /api/css-assets/:assetId
      if (path.startsWith('/api/css-assets/') && request.method === 'DELETE') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        const assetId = path.slice('/api/css-assets/'.length);
        response = await handleDeleteCSSAsset(request, env, authResult, assetId);
        return withCors(response, corsHeaders);
      }

      // CSS asset serving: /api/css-assets/:uid/:assetId/:filename (public)
      if (path.startsWith('/api/css-assets/') && request.method === 'GET') {
        const parts = path.slice('/api/css-assets/'.length).split('/');
        if (parts.length >= 3) {
          const [uid, assetId, ...filenameParts] = parts;
          const filename = decodeURIComponent(filenameParts.join('/'));
          response = await handleServeCSSAsset(request, env, uid, assetId, filename);
          return withCors(response, corsHeaders);
        }
      }

      // File serving: /api/files/:uid/:itemId/:filename
      if (path.startsWith('/api/files/') && request.method === 'GET') {
        const parts = path.slice('/api/files/'.length).split('/');
        if (parts.length < 3) {
          return Response.json({ error: 'Invalid file path' }, { status: 400, headers: corsHeaders });
        }

        const [fileOwnerUid, itemId, ...filenameParts] = parts;
        // Decode URL-encoded filename (browser encodes spaces as %20, etc.)
        const filename = decodeURIComponent(filenameParts.join('/'));

        // Authenticate but don't require it (visitors can access public files)
        const auth = await authenticate(request, env);

        response = await handleServeFile(request, env, fileOwnerUid, itemId, filename, auth);
        return withCors(response, corsHeaders);
      }

      // Visitor mode: /api/visit/:username
      if (path.startsWith('/api/visit/') && request.method === 'GET') {
        const username = path.slice('/api/visit/'.length);
        if (!username) {
          return Response.json({ error: 'Username required' }, { status: 400, headers: corsHeaders });
        }
        response = await handleVisit(request, env, username);

        // Track analytics non-blocking (if user opted in)
        const normalizedUsername = username.toLowerCase();
        const usernameData = await env.AUTH_KV.get<{ uid: string }>(`username:${normalizedUsername}`, 'json');
        if (usernameData) {
          ctx.waitUntil(trackVisitAnalytics(request, env, usernameData.uid));
        }

        return withCors(response, corsHeaders);
      }

      // OG Image generation: /api/og/:username.png
      if (path.startsWith('/api/og/') && request.method === 'GET') {
        const username = path.slice('/api/og/'.length);
        if (!username) {
          return Response.json({ error: 'Username required' }, { status: 400, headers: corsHeaders });
        }
        response = await handleOgImage(request, env, username);
        return withCors(response, corsHeaders);
      }

      // Profile routes (require auth)
      // GET /api/profile - Get user profile
      if (path === '/api/profile' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request('http://internal/profile'));
        return withCors(doResponse, corsHeaders);
      }

      // PATCH /api/profile - Update user profile
      if (path === '/api/profile' && request.method === 'PATCH') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const body = await request.text();
        const doResponse = await stub.fetch(new Request('http://internal/profile', {
          method: 'PATCH',
          body,
        }));
        return withCors(doResponse, corsHeaders);
      }

      // GET /api/css-history - List saved custom CSS versions
      if (path === '/api/css-history' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request('http://internal/css-history'));
        return withCors(doResponse, corsHeaders);
      }

      // POST /api/css-history/:versionId/revert - Restore a saved custom CSS version
      if (path.startsWith('/api/css-history/') && path.endsWith('/revert') && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const versionId = path.slice('/api/css-history/'.length, -'/revert'.length);
        if (!versionId) {
          return withCors(Response.json({ error: 'Version ID required' }, { status: 400 }), corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request(`http://internal/css-history/${versionId}/revert`, {
          method: 'POST',
        }));
        return withCors(doResponse, corsHeaders);
      }

      // Quota route (requires auth)
      // GET /api/quota - Get storage quota usage
      if (path === '/api/quota' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request('http://internal/quota'));
        return withCors(doResponse, corsHeaders);
      }

      // Trash routes (require auth)
      // GET /api/trash - List trashed items
      if (path === '/api/trash' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request('http://internal/trash'));
        return withCors(doResponse, corsHeaders);
      }

      // POST /api/trash/restore/:id - Restore item from trash
      if (path.startsWith('/api/trash/restore/') && request.method === 'POST') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const itemId = path.slice('/api/trash/restore/'.length);
        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request(`http://internal/trash/restore/${itemId}`, {
          method: 'POST',
        }));
        return withCors(doResponse, corsHeaders);
      }

      // DELETE /api/trash - Empty trash
      if (path === '/api/trash' && request.method === 'DELETE') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }

        const doId = env.USER_DESKTOP.idFromName(authResult.uid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(new Request('http://internal/trash', {
          method: 'DELETE',
        }));

        // Clean up R2 files for deleted items
        const result = await doResponse.json() as { deleted: number; r2Keys: string[] };
        if (result.r2Keys.length > 0) {
          await Promise.all(result.r2Keys.map((key) => env.ETERNALOS_FILES.delete(key)));
        }

        return withCors(Response.json(result), corsHeaders);
      }

      // Analytics route (requires auth)
      if (path === '/api/analytics' && request.method === 'GET') {
        const authResult = await requireAuth(request, env);
        if (authResult instanceof Response) {
          return withCors(authResult, corsHeaders);
        }
        response = await handleGetAnalytics(request, env, authResult);
        return withCors(response, corsHeaders);
      }

      // Guestbook route (no auth required, rate limited)
      // POST /api/guestbook/:uid/:itemId - Add guestbook entry
      const guestbookMatch = path.match(/^\/api\/guestbook\/([^/]+)\/([^/]+)$/);
      if (guestbookMatch && request.method === 'POST') {
        const [, ownerUid, itemId] = guestbookMatch;

        // Rate limit by IP: 1 entry per hour per widget
        const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
        const rateLimitKey = `guestbook:${ownerUid}:${itemId}:${ip}`;
        const lastEntry = await env.AUTH_KV.get(rateLimitKey);

        if (lastEntry) {
          const lastTime = parseInt(lastEntry, 10);
          const elapsed = Date.now() - lastTime;
          const oneHour = 60 * 60 * 1000;
          if (elapsed < oneHour) {
            const retryAfter = Math.ceil((oneHour - elapsed) / 1000);
            return withCors(
              Response.json(
                { error: 'You can only sign once per hour. Please try again later.' },
                {
                  status: 429,
                  headers: { 'Retry-After': retryAfter.toString() },
                }
              ),
              corsHeaders
            );
          }
        }

        // Get the entry data
        let entryData: { name: string; message: string };
        try {
          entryData = await request.json();
        } catch {
          return withCors(
            Response.json({ error: 'Invalid request body' }, { status: 400 }),
            corsHeaders
          );
        }

        if (!entryData.name || !entryData.message) {
          return withCors(
            Response.json({ error: 'Name and message are required' }, { status: 400 }),
            corsHeaders
          );
        }

        // Validate input lengths
        if (entryData.name.length > 50) {
          return withCors(
            Response.json({ error: 'Name must be 50 characters or less' }, { status: 400 }),
            corsHeaders
          );
        }

        if (entryData.message.length > 500) {
          return withCors(
            Response.json({ error: 'Message must be 500 characters or less' }, { status: 400 }),
            corsHeaders
          );
        }

        // Forward to the owner's Durable Object
        const doId = env.USER_DESKTOP.idFromName(ownerUid);
        const stub = env.USER_DESKTOP.get(doId);
        const doResponse = await stub.fetch(
          new Request(`http://internal/guestbook/${itemId}`, {
            method: 'POST',
            body: JSON.stringify(entryData),
          })
        );

        if (doResponse.ok) {
          // Store rate limit timestamp
          await env.AUTH_KV.put(rateLimitKey, Date.now().toString(), {
            expirationTtl: 3600, // 1 hour TTL
          });
        }

        return withCors(doResponse, corsHeaders);
      }

      // 404 for unmatched routes
      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });

    } catch (error) {
      console.error('Worker error:', error);
      return Response.json(
        { error: 'Internal server error' },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
