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
import type { RouteContext } from './router';

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

  // Previews run hermetic by default. Grants are activated only after
  // install, but keep the field configurable for future permission-review
  // previews.
  const granted = previewMeta.granted ?? {};
  const bundleObj = await c.env.ETERNALOS_FILES.get(`${previewMeta.r2Prefix}/bundle.json`);
  if (!bundleObj) {
    return withCors(new Response('App preview bundle not found', { status: 404 }), c.corsHeaders);
  }

  const bundle = await bundleObj.json<{ mainModule: string; modules: Record<string, string> }>();
  const grantsHash = await hashGrants(granted);
  const loopback = eternalLoopback(c.ctx);
  const worker = c.env.LOADER.get(`app-preview-${previewId}@v${previewMeta.version}-${grantsHash}`, async () => ({
    compatibilityDate: '2026-04-15',
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    globalOutbound: null,
    env: {
      ETERNAL: loopback.EternalService({
        props: { uid: previewMeta.uid, appId: previewId, granted },
      }),
    },
  }));

  return worker.getEntrypoint().fetch(c.request);
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
  const granted = appMeta.granted ?? {};

  // Load the compiled app bundle from R2 and serve via Dynamic Worker.
  const r2Prefix = appMeta.r2Prefix ?? `apps/${appMeta.uid}/${appId}`;
  const bundleObj = await c.env.ETERNALOS_FILES.get(`${r2Prefix}/bundle.json`);
  if (!bundleObj) {
    return withCors(new Response('App bundle not found', { status: 404 }), c.corsHeaders);
  }

  const bundle = await bundleObj.json<{ mainModule: string; modules: Record<string, string> }>();
  // Re-key the isolate cache on grant changes so revocation takes effect
  // on the next request without a manual flush. Hash is cheap and stable.
  const grantsHash = await hashGrants(granted);
  const loopback = eternalLoopback(c.ctx);
  const worker = c.env.LOADER.get(`app-${appId}@v${appMeta.version}-${grantsHash}`, async () => ({
    compatibilityDate: '2026-04-15',
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    // No arbitrary egress; bridge calls come back in through ETERNAL.
    globalOutbound: null,
    env: {
      ETERNAL: loopback.EternalService({
        props: { uid: appMeta.uid, appId, granted, requiresCapability: true },
      }),
    },
  }));

  const entrypoint = worker.getEntrypoint();
  return entrypoint.fetch(c.request);
}

