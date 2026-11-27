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

// Local front-end / worker origins the development worker accepts.
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:8787',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
];

/**
 * Get CORS headers based on environment and request origin.
 *
 * Access-Control-Allow-Origin (with Allow-Credentials) is present only when
 * the request carries an allowed Origin, and it echoes that exact origin —
 * never `*`, which browsers reject together with Allow-Credentials. A request
 * without an Origin (same-origin navigation, curl, server-to-server) needs no
 * CORS grant, and a disallowed origin gets no ACAO header at all rather than
 * an empty one. Callers detect "not allowed" by the key being absent.
 */
export function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const isProduction = env.ENVIRONMENT === 'production';

  let isAllowed: boolean;
  if (!isProduction) {
    // In development, allow known local origins instead of a wildcard.
    isAllowed = DEV_ORIGINS.includes(origin);
  } else {
    // In production, check against ALLOWED_ORIGINS plus the worker's own
    // origin (same-origin requests that still send Origin, e.g. POSTs).
    const allowedOrigins = env.ALLOWED_ORIGINS
      ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : [];
    const requestUrl = new URL(request.url);
    allowedOrigins.push(`${requestUrl.protocol}//${requestUrl.host}`);
    isAllowed = allowedOrigins.includes(origin);
  }

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin', // Important for caching with different origins
  };
  if (origin && isAllowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}
