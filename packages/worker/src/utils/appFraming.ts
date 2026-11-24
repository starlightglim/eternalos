interface FramingEnv {
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
}

/**
 * App documents carry a CSP baked in at build time with
 * `frame-ancestors 'self'` — which names the API origin, not the frontend
 * that actually frames them, so browsers refused to render every installed
 * app on eternalos.me. Rewrite that directive at serve time to the real
 * frontend origins; this also fixes apps built before the change.
 */
export function frameAncestorsFor(env: FramingEnv): string {
  if (env.ENVIRONMENT !== 'production') return "'self' http://localhost:* http://127.0.0.1:*";
  const origins = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin));
  return ["'self'", ...origins].join(' ');
}

export function allowFramingByFrontend(response: Response, env: FramingEnv): Response {
  const csp = response.headers.get('content-security-policy');
  if (!csp || !/frame-ancestors/i.test(csp)) return response;
  const headers = new Headers(response.headers);
  headers.set('content-security-policy', csp.replace(/frame-ancestors[^;]*/i, `frame-ancestors ${frameAncestorsFor(env)}`));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
