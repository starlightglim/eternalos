/**
 * HTTP Middleware
 *
 * CORS resolution and security-header decoration applied to responses by the
 * route dispatcher (routes/router.ts). Environment-aware: development allows
 * known local origins; production checks ALLOWED_ORIGINS.
 */

import type { Env } from '../index';

// Standard security headers applied to every decorated response
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

// Helper to add CORS + security headers to response
export function withCors(response: Response, corsHeaders: Record<string, string>): Response {
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
export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isProduction = env.ENVIRONMENT === 'production';

  // In development, allow known local origins instead of wildcard
  if (!isProduction) {
    const devOrigins = ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:8787', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'];
    const isDevAllowed = !origin || devOrigins.includes(origin);
    return {
      'Access-Control-Allow-Origin': isDevAllowed ? (origin || '*') : '',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
      'Vary': 'Origin',
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
