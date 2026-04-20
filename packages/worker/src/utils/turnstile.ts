/**
 * Cloudflare Turnstile verification.
 *
 * Usage on a route:
 *   const ok = await verifyTurnstile(request, env);
 *   if (!ok) return Response.json({ error: 'CAPTCHA failed' }, { status: 400 });
 *
 * Clients send the token in one of:
 *   - `cf-turnstile-response` form field
 *   - `turnstileToken` JSON field (body already parsed upstream → pass token directly)
 *   - `CF-Turnstile-Response` header
 *
 * If `env.TURNSTILE_SECRET` is unset the verifier returns true, so dev/local
 * work continues without Turnstile until the secret is configured in prod.
 */

interface TurnstileSiteVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

interface VerifyOptions {
  token?: string;          // explicit token (already extracted by caller)
  expectedAction?: string; // optional: tie verification to a named action
}

/**
 * Extract a Turnstile token from a request. Checks header first, then falls
 * back to form data (for multipart signup / login forms).
 */
export async function extractTurnstileToken(request: Request): Promise<string | null> {
  const headerToken = request.headers.get('CF-Turnstile-Response');
  if (headerToken) return headerToken;

  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('multipart/form-data') || contentType.includes('application/x-www-form-urlencoded')) {
    // Clone — we don't want to consume the body for downstream handlers.
    const clone = request.clone();
    try {
      const form = await clone.formData();
      const token = form.get('cf-turnstile-response');
      if (typeof token === 'string' && token) return token;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Verify a Turnstile token. Returns true if verification succeeds OR if
 * TURNSTILE_SECRET is unset (dev mode). Returns false on any verification error.
 */
export async function verifyTurnstile(
  request: Request,
  env: { TURNSTILE_SECRET?: string },
  options: VerifyOptions = {}
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) {
    // Dev mode / secret not configured — allow.
    return true;
  }

  const token = options.token ?? (await extractTurnstileToken(request));
  if (!token) return false;

  const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;

  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp) body.append('remoteip', remoteIp);

  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as TurnstileSiteVerifyResponse;
    if (!result.success) return false;
    if (options.expectedAction && result.action !== options.expectedAction) return false;
    return true;
  } catch {
    return false;
  }
}
