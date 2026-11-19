/**
 * Route Dispatcher
 *
 * One dispatcher applies every route's declared policy (see the table in
 * routes/routeTable.ts): rate-limit bucket, then auth mode, then the handler
 * — decorating the response and mapping thrown errors to the canonical JSON
 * 500. This separates *what a route does* (handlers, in routes/*) from *how a
 * route is guarded* (middleware policy, declared per route).
 *
 * Behavior preserved from the original if/else chain in index.ts:
 * - Entries are walked in table order; the first match wins. A handler may
 *   return ROUTE_FALLTHROUGH when its inner conditions (e.g. a method
 *   sub-check) exclude the request, and matching continues with later
 *   entries — the legacy chain fell through the same way.
 * - A request consumes at most one rate-limit check: if an entry already
 *   applied its bucket, the unmatched-path fallback does not check again.
 * - Handler responses are decorated with CORS + security headers unless the
 *   entry opts out (routes with per-outcome decoration do it themselves).
 * - Dispatcher-generated responses keep their legacy header shapes: 401/429
 *   get CORS + security headers; the unmatched-path 404 and the error-mapping
 *   500 carry CORS headers only.
 */

import type { Env } from '../index';
import { resolveRouteAuth, type AuthContext, type AuthMode } from '../middleware/auth';
import { getCorsHeaders, withCors } from '../middleware/http';
import {
  addRateLimitHeaders,
  checkRateLimit,
  rateLimitResponse,
  type RateLimitConfig,
  type RateLimitResult,
} from '../middleware/rateLimit';

/**
 * Returned by a handler whose inner conditions exclude this request;
 * dispatch continues with later entries (mirrors the legacy if/else
 * fallthrough, e.g. method-specific sub-routes).
 */
export const ROUTE_FALLTHROUGH: unique symbol = Symbol('ROUTE_FALLTHROUGH');
export type RouteHandlerResult = Response | typeof ROUTE_FALLTHROUGH;

/**
 * Path matcher: returns captured path parameters on match, null otherwise.
 * Table order is significant — the first matching entry handles the request.
 */
export type PathMatcher = (path: string) => string[] | null;

/** Exact pathname match. */
export const exact = (expected: string): PathMatcher =>
  (path) => (path === expected ? [] : null);

/** Pathname prefix match; the remainder (may contain '/') becomes param 0. */
export const prefix = (start: string): PathMatcher =>
  (path) => (path.startsWith(start) ? [path.slice(start.length)] : null);

/** Regex match; capture groups become params. */
export const regex = (pattern: RegExp): PathMatcher =>
  (path) => {
    const match = path.match(pattern);
    return match ? match.slice(1) : null;
  };

/** startsWith + endsWith match with the legacy slicing semantics. */
export const startsAndEndsWith = (start: string, end: string): PathMatcher =>
  (path) =>
    path.startsWith(start) && path.endsWith(end)
      ? [path.slice(start.length, -end.length)]
      : null;

/** Matches every pathname (the path-independent OPTIONS handler). */
export const anyPath: PathMatcher = () => [];

/** Per-route guard policy the dispatcher applies before the handler runs. */
export interface RoutePolicy {
  /** Credential enforcement; see AuthMode in middleware/auth.ts. */
  auth: AuthMode;
  /**
   * Rate-limit bucket enforced before auth and handler. `null` is an explicit
   * "not rate limited" decision, documented per route (game console, app
   * serving, previews, capability/draft routes, health, preflights).
   */
  rateLimit: RateLimitConfig | null;
  /**
   * When true, successful handler responses carry X-RateLimit-* headers.
   * Legacy behavior: only /api/auth/* and /api/file-token expose them.
   */
  rateLimitHeaders?: boolean;
}

/** Everything a handler needs; the dispatcher fills in params, auth, CORS. */
export interface RouteContext {
  /** Route name (for diagnostics). */
  route: string;
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
  /** Captured path params from the entry's matcher. */
  params: string[];
  /**
   * Resolved credential. Non-null when policy.auth is 'required' or
   * 'agent-chat' (the dispatcher rejects unauthenticated requests first);
   * nullable for 'file'; null for 'none' / 'handler-scoped'.
   */
  auth: AuthContext | null;
  /** Environment-aware CORS headers for this request. */
  corsHeaders: Record<string, string>;
}

export type RouteHandler = (c: RouteContext) => Promise<RouteHandlerResult> | RouteHandlerResult;

export interface RouteDefinition {
  /** Stable identifier for diagnostics and policy review. */
  name: string;
  /** HTTP method, or '*' for any. */
  method: string | '*';
  /** Path matcher; first matching entry wins. */
  match: PathMatcher;
  policy: RoutePolicy;
  /**
   * When true (the default) the dispatcher wraps the handler response with
   * CORS + security headers. Entries with per-outcome decoration (raw
   * Dynamic-Worker bodies vs CORS'd errors, CORS-only 400s) set false and
   * decorate themselves using the context's corsHeaders.
   */
  decorate?: boolean;
  handler: RouteHandler;
}

export interface DispatchOptions {
  /**
   * Rate-limit bucket for requests that match no route — the legacy
   * prefix-based selection. Skipped when an entry already consumed the
   * request's single rate-limit check via fallthrough.
   */
  fallbackRateLimit?: (path: string) => RateLimitConfig | null;
}

/**
 * For handlers whose policy.auth is 'required' or 'agent-chat': the dispatcher
 * guarantees a resolved credential. Fails loudly (surfaced through the
 * dispatcher's error mapping as a 500) if a table entry ever violates that
 * contract.
 */
export function requireAuthContext(c: RouteContext): AuthContext {
  if (!c.auth) {
    throw new Error(`Route ${c.route}: auth policy required a credential but none was resolved`);
  }
  return c.auth;
}

/**
 * Walk the route table and apply the matched entry's policy. See the module
 * comment for the exact legacy semantics being preserved.
 */
export async function dispatchRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  routes: RouteDefinition[],
  options: DispatchOptions = {}
): Promise<Response> {
  const url = new URL(request.url);
  const corsHeaders = getCorsHeaders(request, env);

  try {
    let rateLimitChecked = false;

    for (const route of routes) {
      if (route.method !== '*' && route.method !== request.method) continue;
      const params = route.match(url.pathname);
      if (!params) continue;

      // --- middleware: rate limit (the entry's bucket) ---
      let rateLimitResult: RateLimitResult | null = null;
      if (route.policy.rateLimit) {
        rateLimitResult = await checkRateLimit(request, env, route.policy.rateLimit);
        rateLimitChecked = true;
        if (!rateLimitResult.allowed) {
          return withCors(rateLimitResponse(rateLimitResult), corsHeaders);
        }
      }

      // --- middleware: auth (the entry's credential mode) ---
      const auth = await resolveRouteAuth(route.policy.auth, request, env, corsHeaders);
      if (auth instanceof Response) {
        return withCors(auth, corsHeaders);
      }

      // --- dispatch: handler ---
      const result = await route.handler({
        route: route.name,
        request,
        env,
        ctx,
        url,
        params,
        auth,
        corsHeaders,
      });
      if (result === ROUTE_FALLTHROUGH) continue;

      // --- decoration (per the entry's policy) ---
      let response: Response = result;
      if (route.policy.rateLimitHeaders && rateLimitResult && route.policy.rateLimit) {
        response = addRateLimitHeaders(response, rateLimitResult, route.policy.rateLimit);
      }
      if (route.decorate !== false) {
        response = withCors(response, corsHeaders);
      }
      return response;
    }

    // --- no route matched: the legacy unmatched-path policy ---
    // One rate-limit check per request (skipped when an entry already
    // consumed it through fallthrough), then the shared CORS-only 404.
    if (options.fallbackRateLimit && !rateLimitChecked) {
      const config = options.fallbackRateLimit(url.pathname);
      if (config) {
        const result = await checkRateLimit(request, env, config);
        if (!result.allowed) {
          return withCors(rateLimitResponse(result), corsHeaders);
        }
      }
    }
    return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders });
  } catch (error) {
    // Canonical error mapping (legacy catch-block shape: CORS-only headers).
    console.error('Worker error:', error);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders }
    );
  }
}
