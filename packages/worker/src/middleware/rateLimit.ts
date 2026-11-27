/**
 * Rate Limiting Middleware
 *
 * Uses a per-key Durable Object (RateLimiter) holding a fixed-window counter
 * per bucket — per IP (CF-Connecting-IP) for the route-table buckets, per
 * account uid for the expensive authenticated routes. The Durable Object
 * transaction makes each bucket update atomic under concurrent requests.
 *
 * Rate limits (per window of 1 minute):
 * - Auth endpoints: 60 / IP
 * - General API: 300 / IP
 * - Public assets: 1000 / IP
 * - App deploy 20, app skins 60, app capability 120, game drafts 120 / user
 */

import type { Env } from '../index';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export interface RateLimitConfig {
  maxRequests: number;     // Maximum requests allowed in window
  windowMs: number;        // Window size in milliseconds
  keyPrefix: string;       // Prefix for KV key (e.g., 'auth' or 'api')
}

// Default configurations
export const RATE_LIMIT_AUTH: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:auth',
};

export const RATE_LIMIT_API: RateLimitConfig = {
  maxRequests: 300,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:api',
};

// Public asset endpoints (files, wallpapers, css-assets, sounds, cursors, bazaar).
// Limit must be generous because a single visitor page can pull 20-50 assets,
// but still cap the endpoint against R2 egress DoS and enumeration.
export const RATE_LIMIT_PUBLIC_ASSET: RateLimitConfig = {
  maxRequests: 1000,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:asset',
};

// WebSocket connection attempts per IP. Each connection keeps a Durable Object
// warm, so rapid reconnection must be rate-limited to prevent cost inflation.
export const RATE_LIMIT_WS: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:ws',
};

// ---------------------------------------------------------------------------
// Per-user buckets (keyed by account uid, checked after authentication).
// Used by expensive authenticated routes where an IP bucket is the wrong unit:
// many users can share an IP (NAT, offices), and one account can rotate IPs.
// ---------------------------------------------------------------------------

// App dev-deploy: compiles a bundle (up to 6MB JSON) and writes R2 + DO state.
// The most expensive write route; a human or the demo deploys a handful a
// minute at most.
export const RATE_LIMIT_APP_DEPLOY: RateLimitConfig = {
  maxRequests: 20,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:user:app-deploy',
};

// App skins: PUT bodies up to 9MB and AI skin generation.
export const RATE_LIMIT_APP_SKINS: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:user:app-skins',
};

// App capability minting: one per app window open/reload.
export const RATE_LIMIT_APP_CAPABILITY: RateLimitConfig = {
  maxRequests: 120,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:user:app-capability',
};

// Cartridge draft read/save/delete (editor saves).
export const RATE_LIMIT_GAME_DRAFT: RateLimitConfig = {
  maxRequests: 120,
  windowMs: 60 * 1000, // 1 minute
  keyPrefix: 'ratelimit:user:game-draft',
};

/**
 * Client identifier for per-IP rate limiting.
 *
 * Only CF-Connecting-IP is trusted: Cloudflare sets it on every request that
 * reaches the worker and overwrites any client-supplied value. X-Forwarded-For
 * is client-controlled (anyone can send a fresh value per request to get a
 * fresh bucket), so it is never consulted. Without CF-Connecting-IP (local
 * tooling, internal calls) requests share one 'unknown' bucket — stricter, not
 * looser, so a missing header can't be used to dodge the limit.
 */
export function getClientId(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP')?.trim();
  return cfIp || 'unknown';
}

/**
 * Check the per-IP rate limit for a request.
 */
export function checkRateLimit(
  request: Request,
  env: Env,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  return checkRateLimitKey(env, `${config.keyPrefix}:${getClientId(request)}`, config);
}

/**
 * Check a per-account rate limit (call after authentication).
 */
export function checkUserRateLimit(
  env: Env,
  uid: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  return checkRateLimitKey(env, `${config.keyPrefix}:${uid}`, config);
}

async function checkRateLimitKey(
  env: Env,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();

  try {
    const limiterId = env.RATE_LIMITER.idFromName(key);
    const limiter = env.RATE_LIMITER.get(limiterId);
    const response = await limiter.fetch('https://rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxRequests: config.maxRequests,
        windowMs: config.windowMs,
        now,
      }),
    });
    if (!response.ok) {
      throw new Error(`Rate limiter returned ${response.status}`);
    }
    return await response.json<RateLimitResult>();
  } catch (error) {
    // SECURITY: Fail closed on KV outage for ALL endpoints.
    // Previously only auth endpoints failed closed; API endpoints failed open,
    // allowing unlimited requests during KV outages. Failing closed is safer —
    // a brief availability dip is preferable to unbounded access.
    console.error('Rate limit check error:', error);
    return {
      allowed: false,
      remaining: 0,
      resetAt: now + config.windowMs,
      retryAfter: Math.ceil(config.windowMs / 1000),
    };
  }
}

/**
 * Create a 429 Too Many Requests response with proper headers
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };

  if (result.retryAfter) {
    headers['Retry-After'] = String(result.retryAfter);
  }

  return new Response(
    JSON.stringify({
      error: 'Too many requests. Please try again later.',
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers,
    }
  );
}

/**
 * Add rate limit headers to a successful response
 */
export function addRateLimitHeaders(
  response: Response,
  result: RateLimitResult,
  config: RateLimitConfig
): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('X-RateLimit-Limit', String(config.maxRequests));
  newHeaders.set('X-RateLimit-Remaining', String(result.remaining));
  newHeaders.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
