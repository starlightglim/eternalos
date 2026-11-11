/**
 * Rate Limiting Middleware
 *
 * Uses a per-key Durable Object to track request counts per IP.
 * The Durable Object transaction makes each bucket update atomic under
 * concurrent requests.
 *
 * Rate limits:
 * - Auth endpoints: 60 requests/minute
 * - General API: 300 requests/minute
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

/**
 * Get client identifier for rate limiting
 * Uses CF-Connecting-IP header (set by Cloudflare) or falls back to request IP
 */
function getClientId(request: Request): string {
  // Cloudflare sets CF-Connecting-IP header
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  // Fallback to X-Forwarded-For
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // Last resort: use a hash of the request origin
  return 'unknown';
}

/**
 * Check rate limit for a request
 */
export async function checkRateLimit(
  request: Request,
  env: Env,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const clientId = getClientId(request);
  const now = Date.now();
  const windowStart = now - config.windowMs;

  // KV key for this client's rate limit bucket
  const key = `${config.keyPrefix}:${clientId}`;

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
