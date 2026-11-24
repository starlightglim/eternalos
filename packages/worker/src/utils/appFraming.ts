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

/**
 * App iframes are sandboxed without allow-same-origin, so the app document's
 * origin is opaque ("null") and every request it makes, its own files included,
 * is cross-origin. A `<script type="module">` (how every app loads its
 * code) is fetched in CORS mode: without Access-Control-Allow-Origin the
 * browser refuses to run it and the app sits on its static HTML forever.
 *
 * Static app files are public and never use cookies, so `*` is safe for
 * them. Bridge (`_eternal/…`) and backend (`api/…`) responses keep their
 * own, capability-gated CORS handling and are left alone, as is any
 * response that already chose a policy.
 */
export function allowOpaqueOriginAssets(response: Response, method: string, appRelativePath: string): Response {
  if (method !== 'GET' && method !== 'HEAD') return response;
  if (/^(?:_eternal|api)(?:\/|$)/.test(appRelativePath)) return response;
  if (response.headers.has('access-control-allow-origin')) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
