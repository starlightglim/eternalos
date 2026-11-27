/**
 * Dynamic-Worker app serving
 *
 *   ANY  /api/app-previews/:previewId[/...]  serve a preview app
 *   ANY  /api/apps/:appId[/...]              serve an installed app
 *
 * Both run the app's compiled bundle inside a sandboxed Dynamic Worker with no
 * arbitrary egress; the only bridge back in is the EternalService loopback
 * (ctx.exports). Capability-token checks happen inside the worker.
 *
 * These handlers decorate themselves per outcome (matching the legacy route):
 * 4xx/410 errors and the "App ID required" 400 are CORS+security wrapped,
 * while the trailing-slash 308 redirect and the worker's own response are
 * returned raw. Table entries therefore opt out of dispatcher decoration.
 *
 * Auth + rate-limit policy: handler-scoped / unlimited (see routeTable.ts).
 */

import type { AppGrantedPermissions } from '../utils/jwt';
import { withCors } from '../middleware/http';
import { allowFramingByFrontend, allowOpaqueOriginAssets } from '../utils/appFraming';
import { currentAppRuntime } from '../agents/tools/appTools';
import { appRunnerName, type AppBackendConfig } from '../durable-objects/AppRunner';
import type { RouteContext } from './router';
import type { Env } from '../index';

// Sandboxed app iframes have an opaque (null) origin, so backend calls are
// cross-origin. No cookies/credentials are ever involved — the capability is
// an explicit Bearer header — so '*' is safe.
const BACKEND_CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '300',
};

function withBackendCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(BACKEND_CORS)) headers.set(key, value);
  headers.set('x-content-type-options', 'nosniff');
  // Backend responses are data for the app iframe, served from the API's own
  // origin. Whatever content type server.js returns, it must never run
  // script or be framed there.
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** `/api/apps/{id}/api/todos` → `/api/todos`; null when not a backend path. */
function backendSubPath(mountPath: string, id: string): string | null {
  const rest = mountPath.slice(id.length);
  return rest === '/api' || rest.startsWith('/api/') ? rest : null;
}

/**
 * Forward a request to the app's server.js facet via its AppRunner.
 * Installed apps require the app capability (same gate as the bridge);
 * previews run capability-free, like the rest of the preview surface.
 */
async function serveBackend(
  c: RouteContext,
  kind: 'app' | 'preview',
  subPath: string,
  config: AppBackendConfig,
): Promise<Response> {
  if (c.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: BACKEND_CORS });
  }
  if (config.requiresCapability) {
    const authorization = c.request.headers.get('Authorization');
    const capability = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null;
    const service = eternalLoopback(c.ctx).EternalService({
      props: { uid: config.uid, appId: config.appId, granted: config.granted, requiresCapability: true },
    }) as { authorizeApp(token: string | null): Promise<boolean> };
    if (!(await service.authorizeApp(capability))) {
      return withBackendCors(Response.json({ error: 'Invalid or missing capability token' }, { status: 401 }));
    }
  }

  const incoming = new URL(c.request.url);
  const headers = new Headers(c.request.headers);
  headers.delete('authorization');
  headers.delete('cookie');
  const hasBody = !['GET', 'HEAD'].includes(c.request.method);
  const forwarded = new Request(`https://app.internal${subPath}${incoming.search}`, {
    method: c.request.method,
    headers,
    body: hasBody ? c.request.body : undefined,
  });

  const stub = c.env.APP_RUNNER.getByName(appRunnerName(kind, config.appId));
  try {
    return withBackendCors(await stub.handle(forwarded, config));
  } catch (error) {
    console.error('App backend dispatch failed:', error);
    return withBackendCors(Response.json({ error: 'App backend unavailable' }, { status: 502 }));
  }
}

// Short, stable hash of an app's grants object. Used to re-key the Dynamic
// Worker isolate cache when permissions change — so revocation takes effect
// on the next request without manually flushing anything. Not
// security-sensitive: grants are also checked at call time in EternalService.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

async function hashGrants(granted: unknown): Promise<string> {
  const canonical = JSON.stringify(canonicalize(granted ?? {}));
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest).slice(0, 6))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}

// `ctx.exports` is the loopback-bindings surface for WorkerEntrypoints
// exported from the entry module (available at runtime; typed in
// @cloudflare/workers-types/experimental but not the default path we load).
// Cast narrowly here rather than flipping the whole types path.
function eternalLoopback(ctx: ExecutionContext): {
  EternalService: (init: {
    props: { uid: string; appId: string; granted: AppGrantedPermissions; requiresCapability?: boolean };
  }) => unknown;
} {
  return (ctx as unknown as {
    exports: {
      EternalService: (init: {
        props: { uid: string; appId: string; granted: AppGrantedPermissions; requiresCapability?: boolean };
      }) => unknown;
    };
  }).exports;
}

/**
 * Backend config for an installed app, for trusted host-side callers (the
 * owner's agent). Returns null when the app does not exist. Capability is
 * not required on this path — callers must check ownership themselves.
 */
export async function resolveInstalledAppBackend(
  env: Env,
  appId: string,
): Promise<{ config: AppBackendConfig; ownerUid: string } | null> {
  const appMeta = await env.DESKTOP_KV.get<{
    uid: string;
    version: number;
    r2Prefix?: string;
    granted?: AppGrantedPermissions;
  }>(`app:${appId}`, 'json');
  if (!appMeta) return null;
  const granted = appMeta.granted ?? {};
  return {
    ownerUid: appMeta.uid,
    config: {
      codeId: `app-${appId}@v${appMeta.version}-${await hashGrants(granted)}`,
      r2Prefix: appMeta.r2Prefix ?? `apps/${appMeta.uid}/${appId}`,
      uid: appMeta.uid,
      appId,
      granted,
      requiresCapability: false,
    },
  };
}

// A missing bundle loads a stub worker that answers with this header, so
// the outcome is a plain response (not an error that has to survive the
// loader boundary). The outer handler turns it into the CORS-wrapped 404.
const BUNDLE_MISSING_HEADER = 'x-eternal-bundle-missing';
const BUNDLE_MISSING_STUB = `export default { fetch() { return new Response(null, { status: 404, headers: { '${BUNDLE_MISSING_HEADER}': '1' } }); } };`;

/**
 * Serve a request from an app's compiled bundle through a Dynamic Worker.
 *
 * bundle.json is read from R2 only inside the loader callback, i.e. only
 * when no isolate is cached for `cacheKey` (app id + version + grants).
 * Warm requests (every asset of a page load) skip the R2 read and the
 * multi-megabyte JSON parse entirely.
 */
async function serveFromBundle(
  c: RouteContext,
  options: {
    cacheKey: string;
    r2Prefix: string;
    props: { uid: string; appId: string; granted: AppGrantedPermissions; requiresCapability?: boolean };
    missingMessage: string;
    assetPath: string;
  },
): Promise<Response> {
  const { env } = c;
  const loopback = eternalLoopback(c.ctx);
  const worker = env.LOADER.get(options.cacheKey, async () => {
    const bundleObj = await env.ETERNALOS_FILES.get(`${options.r2Prefix}/bundle.json`);
    if (!bundleObj) {
      return {
        compatibilityDate: '2026-04-15',
        mainModule: 'missing.js',
        modules: { 'missing.js': BUNDLE_MISSING_STUB },
        globalOutbound: null,
      };
    }
    const bundle = await bundleObj.json<{ mainModule: string; modules: Record<string, string> }>();
    return {
      compatibilityDate: '2026-04-15',
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      // No arbitrary egress; bridge calls come back in through ETERNAL.
      globalOutbound: null,
      env: { ETERNAL: loopback.EternalService({ props: options.props }) },
    };
  });

  const response = await worker.getEntrypoint().fetch(c.request);
  if (response.status === 404 && response.headers.get(BUNDLE_MISSING_HEADER) === '1') {
    return withCors(new Response(options.missingMessage, { status: 404 }), c.corsHeaders);
  }
  return allowOpaqueOriginAssets(allowFramingByFrontend(response, env), c.request.method, options.assetPath);
}

/** ANY /api/app-previews/:previewId[/...] */
export async function handleServeAppPreview(c: RouteContext): Promise<Response> {
  const previewPath = c.params[0];
  const previewId = previewPath.split('/')[0];
  if (!previewId) {
    return withCors(new Response('Preview ID required', { status: 400 }), c.corsHeaders);
  }

  // Relative asset paths inside app HTML only resolve correctly when the
  // document URL ends with a trailing slash.
  if (previewPath === previewId) {
    const redirectUrl = new URL(c.request.url);
    redirectUrl.pathname = `/api/app-previews/${previewId}/`;
    return Response.redirect(redirectUrl.toString(), 308);
  }

  const previewMeta = await c.env.DESKTOP_KV.get<{
    uid: string;
    version: number;
    r2Prefix: string;
    expiresAt?: number;
    granted?: AppGrantedPermissions;
  }>(`app-preview:${previewId}`, 'json');
  if (!previewMeta) {
    return withCors(new Response('App preview not found', { status: 404 }), c.corsHeaders);
  }
  if (previewMeta.expiresAt && previewMeta.expiresAt < Date.now()) {
    return withCors(new Response('App preview expired', { status: 410 }), c.corsHeaders);
  }
  if (previewPath === `${previewId}/${RUNTIME_ASSET}`) return serveCurrentRuntime(c.request, false);

  // Previews run hermetic by default. Grants are activated only after
  // install, but keep the field configurable for future permission-review
  // previews.
  const granted = previewMeta.granted ?? {};
  const previewBackendPath = backendSubPath(previewPath, previewId);
  if (previewBackendPath) {
    return serveBackend(c, 'preview', previewBackendPath, {
      codeId: `preview-${previewId}@v${previewMeta.version}-${await hashGrants(granted)}`,
      r2Prefix: previewMeta.r2Prefix,
      uid: previewMeta.uid,
      appId: previewId,
      granted,
      requiresCapability: false,
    });
  }
  return serveFromBundle(c, {
    cacheKey: `app-preview-${previewId}@v${previewMeta.version}-${await hashGrants(granted)}`,
    r2Prefix: previewMeta.r2Prefix,
    props: { uid: previewMeta.uid, appId: previewId, granted },
    missingMessage: 'App preview bundle not found',
    assetPath: previewPath.slice(previewId.length + 1),
  });
}

const RUNTIME_ASSET = 'eternal-runtime.js';

/**
 * Every app's eternal-runtime.js is the CURRENT runtime, not the copy baked
 * into its bundle at install time: theme and skin support (and runtime
 * fixes) reach apps installed before them without a rebuild.
 */
function serveCurrentRuntime(request: Request, requiresCapability: boolean): Response {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  return new Response(request.method === 'HEAD' ? null : currentAppRuntime(requiresCapability), {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Module/classic scripts in the sandboxed (origin "null") iframe.
      'access-control-allow-origin': '*',
    },
  });
}

/** ANY /api/apps/:appId[/...] */
export async function handleServeApp(c: RouteContext): Promise<Response> {
  const appPath = c.params[0];
  const appId = appPath.split('/')[0];
  if (!appId) {
    return withCors(new Response('App ID required', { status: 400 }), c.corsHeaders);
  }

  // Relative asset paths inside app HTML only resolve correctly when the
  // document URL ends with a trailing slash.
  if (appPath === appId) {
    const redirectUrl = new URL(c.request.url);
    redirectUrl.pathname = `/api/apps/${appId}/`;
    return Response.redirect(redirectUrl.toString(), 308);
  }

  // Look up app owner + grants from KV. `granted` may be absent on older
  // apps created before manifest v1.5 — treat as hermetic (no permissions).
  const appMeta = await c.env.DESKTOP_KV.get<{
    uid: string;
    version: number;
    r2Prefix?: string;
    granted?: AppGrantedPermissions;
  }>(`app:${appId}`, 'json');
  if (!appMeta) {
    return withCors(new Response('App not found', { status: 404 }), c.corsHeaders);
  }
  if (appPath === `${appId}/${RUNTIME_ASSET}`) return serveCurrentRuntime(c.request, true);
  const granted = appMeta.granted ?? {};

  // Load the compiled app bundle from R2 and serve via Dynamic Worker.
  const r2Prefix = appMeta.r2Prefix ?? `apps/${appMeta.uid}/${appId}`;
  const appBackendPath = backendSubPath(appPath, appId);
  if (appBackendPath) {
    return serveBackend(c, 'app', appBackendPath, {
      codeId: `app-${appId}@v${appMeta.version}-${await hashGrants(granted)}`,
      r2Prefix,
      uid: appMeta.uid,
      appId,
      granted,
      requiresCapability: true,
    });
  }
  // Re-key the isolate cache on grant changes so revocation takes effect
  // on the next request without a manual flush. Hash is cheap and stable.
  return serveFromBundle(c, {
    cacheKey: `app-${appId}@v${appMeta.version}-${await hashGrants(granted)}`,
    r2Prefix,
    props: { uid: appMeta.uid, appId, granted, requiresCapability: true },
    missingMessage: 'App bundle not found',
    assetPath: appPath.slice(appId.length + 1),
  });
}
