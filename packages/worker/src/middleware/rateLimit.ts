/**
 * Rate Limiting Middleware
 *
 * Uses Cloudflare KV to track request counts per IP.
 * Implements a sliding window rate limiting algorithm.
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
    // Get current rate limit data from KV
    const data = await env.AUTH_KV.get<RateLimitData>(key, 'json');

    if (!data) {
      // First request - create new bucket
      const newData: RateLimitData = {
        requests: [now],
        windowStart: now,
      };

      // Store with TTL equal to window duration (in seconds)
      await env.AUTH_KV.put(key, JSON.stringify(newData), {
        expirationTtl: Math.ceil(config.windowMs / 1000) + 60, // Add 60s buffer
      });

      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetAt: now + config.windowMs,
      };
    }

    // Filter out requests outside the current window
    const validRequests = data.requests.filter(ts => ts > windowStart);

    // Check if rate limit exceeded
    if (validRequests.length >= config.maxRequests) {
      // Find when the oldest request in window will expire
      const oldestInWindow = Math.min(...validRequests);
      const resetAt = oldestInWindow + config.windowMs;
      const retryAfter = Math.ceil((resetAt - now) / 1000);

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(1, retryAfter),
      };
    }

    // Add current request to the window
    validRequests.push(now);

    const updatedData: RateLimitData = {
      requests: validRequests,
      windowStart: data.windowStart,
    };

    await env.AUTH_KV.put(key, JSON.stringify(updatedData), {
      expirationTtl: Math.ceil(config.windowMs / 1000) + 60,
    });

    return {
      allowed: true,
      remaining: config.maxRequests - validRequests.length,
      resetAt: Math.min(...validRequests) + config.windowMs,
    };

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

interface RateLimitData {
  requests: number[];  // Timestamps of requests in current window
  windowStart: number; // When the window started
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
