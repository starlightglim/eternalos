# Security Review — EternalOS

**Date:** 2026-03-09
**Scope:** Full repository (`packages/worker`, `packages/frontend`)
**Reviewer:** Claude (automated security analysis)

---

## Executive Summary

EternalOS is a Cloudflare Workers-based application with a React frontend that provides users with a virtual desktop experience. The codebase demonstrates **generally strong security practices** — proper password hashing, JWT verification, input sanitization, CORS controls, and rate limiting are all present. However, several issues ranging from **medium to low severity** were identified that should be addressed.

---

## Findings

### CRITICAL — None Found

No critical vulnerabilities (RCE, SQL injection, auth bypass) were identified.

---

### HIGH SEVERITY

#### H1. Internal Error Details Leaked to Clients in Signup Flow

**File:** `packages/worker/src/routes/auth.ts:119-179`
**Issue:** The signup handler returns internal error step identifiers and raw exception details (`String(e)`) in error responses:
```typescript
return Response.json({ error: 'signup_step_1_check_email', details: String(e) }, { status: 500 });
```
These messages leak internal implementation details (KV operation names, stack traces, internal architecture) to unauthenticated users. An attacker could use this information to understand the system's storage layout and target specific failure modes.

**Recommendation:** Return generic error messages (e.g., `"Signup failed"`) to clients. Log the detailed error server-side with `console.error()` for debugging.

---

#### H2. Auth Token in URL Query Parameter Exposes Credentials in Logs

**File:** `packages/worker/src/middleware/auth.ts:35-37`, `packages/frontend/src/services/api.ts:449-453`
**Issue:** For media elements (`<img>`, `<video>`, `<audio>`), the JWT access token is passed as a query parameter (`?token=...`). This is a known anti-pattern because:
- Tokens appear in server access logs, CDN logs, and Cloudflare analytics
- Tokens may be cached in browser history and shared in referrer headers
- Tokens can be visible in proxy logs and network monitoring tools

```typescript
// Frontend
export function getFileUrl(r2Key: string): string {
  const tokenParam = authToken ? `?token=${encodeURIComponent(authToken)}` : '';
  return `${API_URL}/api/files/${encodedKey}${tokenParam}`;
}
```

**Recommendation:** Use a short-lived, file-specific signed URL or a session cookie with `HttpOnly; SameSite=Strict` for media authentication instead of putting the access token in query parameters.

---

### MEDIUM SEVERITY

#### M1. Race Condition in Rate Limiting (KV-Based)

**File:** `packages/worker/src/middleware/rateLimit.ts:62-141`
**Issue:** The rate limiter uses KV `get` → check → `put` which is not atomic. Under concurrent requests, multiple requests can read the same count, pass the check, and all increment, effectively allowing burst traffic to exceed the configured limit. KV's eventual consistency makes this worse at scale.

**Recommendation:** Consider using Cloudflare's built-in Rate Limiting product, or use a Durable Object for atomic counting. For the current approach, accept that the limits are approximate and adjust thresholds lower to compensate.

---

#### M2. Race Condition in Analytics Counter Increment

**File:** `packages/worker/src/routes/analytics.ts:54-61`
**Issue:** The view counter uses a non-atomic read-then-write pattern:
```typescript
const currentTotal = parseInt(await env.DESKTOP_KV.get(totalKey) || '0', 10);
await env.DESKTOP_KV.put(totalKey, String(currentTotal + 1));
```
Concurrent requests can cause lost increments. While not a security vulnerability per se, it's a data integrity issue.

**Recommendation:** Accept approximate counts (current behavior is fine for analytics), or move to a Durable Object counter for exact counting.

---

#### M3. Rate Limit Fails Open

**File:** `packages/worker/src/middleware/rateLimit.ts:133-141`
**Issue:** When the KV rate limit check throws an error, the request is allowed through:
```typescript
} catch (error) {
  console.error('Rate limit check error:', error);
  return { allowed: true, ... };
}
```
If KV experiences an outage, all rate limits are effectively disabled, leaving auth endpoints unprotected against brute-force attacks.

**Recommendation:** Consider failing closed for auth-sensitive endpoints (login, signup, password reset). For general API endpoints, failing open is acceptable.

---

#### M4. Custom CSS `url()` Validation Can Be Bypassed

**File:** `packages/worker/src/durable-objects/UserDesktop.ts:631-640`
**Issue:** The `url()` validation in custom CSS only checks that the URL starts with one of the allowed prefixes:
```typescript
const allowedUrlPrefixes = ['/api/css-assets/', '/api/wallpaper/', '/api/icon/'];
```
This regex-based extraction may miss edge cases with CSS encoding, comments, or escaped characters that could bypass the check. For example, `url(  /api/css-assets/../../../some/other/path)` could potentially work depending on how the browser resolves the path.

**Recommendation:** Normalize the URL (resolve `..` sequences, decode percent-encoding) before checking against the allowlist.

---

#### M5. Signup Creates Multiple KV Records Without Transaction Rollback

**File:** `packages/worker/src/routes/auth.ts:156-179`
**Issue:** The signup handler creates multiple KV entries sequentially (user record, username index, uid index, user_index). If any intermediate step fails, previously written records are orphaned. For example, if `username:X` is written but `uid:Y` fails, the username is permanently reserved but the account is broken.

**Recommendation:** This is difficult to solve with KV's lack of transactions. Consider using a single compound record, or implementing a cleanup/garbage collection mechanism for orphaned records.

---

#### M6. Email Enumeration Partially Mitigated but Timing Side-Channel Exists

**File:** `packages/worker/src/routes/auth.ts:121-123`
**Issue:** While the login endpoint correctly uses generic error messages (`"Invalid email or password"`), and forgot-password always returns success, the **signup endpoint** explicitly returns `"Email already registered"` (line 122) and `"Username already taken"` (line 133). This allows enumeration of registered emails and usernames.

**Recommendation:** For signup, this is generally acceptable since users need to know why signup failed. However, consider adding a CAPTCHA or proof-of-work challenge to the signup endpoint to prevent automated enumeration.

---

### LOW SEVERITY

#### L1. WebSocket Endpoint Has No Rate Limiting

**File:** `packages/worker/src/index.ts:234-252`
**Issue:** The WebSocket upgrade endpoint (`/api/ws/:username`) is not rate limited. An attacker could open many WebSocket connections to a user's Durable Object, consuming resources.

**Recommendation:** Add connection limits per IP and per Durable Object instance. Cloudflare Durable Objects have built-in hibernation support which helps, but explicit connection limits would add defense in depth.

---

#### L2. Guestbook Entry Sanitization Relies on React JSX Escaping

**File:** `packages/worker/src/durable-objects/UserDesktop.ts:969-974`
**Issue:** Guestbook entries are stored with only `trim()` and `slice()`, with a comment noting "XSS prevention handled by React's automatic JSX escaping on the frontend render path." While React does escape by default, this means:
- The raw unsanitized data is stored in the Durable Object
- Any future consumer that doesn't use React (API response, email, export) could render the XSS
- If the visitor page ever renders with `dangerouslySetInnerHTML`, XSS would occur

**Recommendation:** Apply `sanitizeText()` from the existing sanitization utilities to guestbook entries on write, providing defense in depth.

---

#### L3. Password Reset Token Exposed in Dev Mode Response

**File:** `packages/worker/src/routes/auth.ts:760`
**Issue:** In non-production environments, the forgot-password endpoint returns the reset token and URL in the response body:
```typescript
...(isDev ? { resetToken, resetUrl } : {}),
```
If `ENVIRONMENT` is not explicitly set to `'production'`, this leaks the reset token. The check relies on `env.ENVIRONMENT !== 'production'`, meaning an unset or typo'd value defaults to exposing tokens.

**Recommendation:** Default to secure: only expose the token if `ENVIRONMENT === 'development'` explicitly, rather than checking `!== 'production'`.

---

#### L4. Missing Content-Security-Policy Header

**File:** `packages/worker/src/index.ts:57-63`, `packages/frontend/public/_headers`
**Issue:** The application sets several security headers (`X-Content-Type-Options`, `X-Frame-Options`, `HSTS`, `Referrer-Policy`, `Permissions-Policy`) but does not set a `Content-Security-Policy` header. A CSP would provide an additional layer of protection against XSS by restricting script sources.

**Recommendation:** Add a CSP header. For this application, something like:
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://eternalos-api.*.workers.dev; frame-src 'self'
```

---

#### L5. CORS Allows All Origins in Non-Production

**File:** `packages/worker/src/index.ts:88-95`
**Issue:** In non-production mode, CORS allows `*` for all origins. If the worker is deployed to a staging environment without `ENVIRONMENT=production`, any website can make authenticated cross-origin requests.

**Recommendation:** Use an explicit development origin allowlist (e.g., `localhost:5173`) rather than wildcard.

---

#### L6. iFrame Sandbox Allows `allow-same-origin`

**File:** `packages/frontend/src/components/viewers/WebsiteViewer.tsx:174`
**Issue:** The website viewer iframe uses:
```
sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
```
The combination of `allow-scripts` and `allow-same-origin` effectively negates the sandbox — an embedded page could remove the sandbox attribute and gain full access to the parent page's origin.

**Recommendation:** Remove `allow-same-origin` from the sandbox. If full functionality is needed, consider using a separate subdomain for embedded content, or only embedding known-safe content.

---

#### L7. Email HTML Template Vulnerable to Injection

**File:** `packages/worker/src/utils/email.ts:88-97`
**Issue:** The `username` parameter is interpolated directly into the HTML email template without escaping:
```html
<p>Hi @${username},</p>
```
and
```html
<a href="${resetUrl}" ...>
```
While `username` is validated to only contain `[a-zA-Z0-9_]` during registration, and `resetUrl` is constructed server-side, this pattern is fragile — if username validation is ever relaxed, this becomes an HTML injection vector in emails.

**Recommendation:** HTML-escape the `username` in email templates for defense in depth.

---

## Positive Security Practices Observed

1. **Password hashing:** PBKDF2 with 100,000 iterations, random salt, constant-time comparison — solid implementation.
2. **JWT implementation:** HMAC-SHA256, proper expiration checks, signature verification before payload parsing.
3. **Token rotation:** Refresh tokens are single-use with proper rotation, and old tokens are cleaned up.
4. **Session invalidation on password change:** `passwordChangedAt` timestamp properly invalidates all pre-existing sessions.
5. **Input sanitization:** Comprehensive `sanitize.ts` with functions for text, filenames, usernames, emails, and URLs.
6. **File upload validation:** MIME type allowlist, file size limits, quota enforcement, filename sanitization.
7. **IDOR prevention:** Update endpoint uses an allowlist of modifiable fields, preventing overwrite of `r2Key`, `id`, etc.
8. **Circular reference prevention:** Folder move operations detect and prevent cycles in the hierarchy.
9. **Custom CSS validation:** Blocks dangerous patterns (`@import`, `javascript:`, `expression()`), restricts `url()` references.
10. **Security headers:** HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy all set.
11. **Secrets management:** `.gitignore` properly excludes `.env`, `.dev.vars`; secrets stored via `wrangler secret put`.
12. **Path traversal prevention:** `sanitizeFilename()` strips `..`, `/`, `\` characters.
13. **User enumeration mitigation:** Login returns generic errors; forgot-password always returns success.
14. **Analytics privacy:** IP addresses are hashed before storage; raw IPs are not persisted.

---

## Recommendations Priority

| Priority | Finding | Effort |
|----------|---------|--------|
| High     | H1. Leak of internal error details in signup | Low |
| High     | H2. JWT token in URL query parameters | Medium |
| Medium   | M3. Rate limit fails open on error | Low |
| Medium   | M4. CSS `url()` bypass via path traversal | Low |
| Medium   | M6. Signup email/username enumeration | Low |
| Low      | L1. WebSocket no rate limiting | Medium |
| Low      | L2. Guestbook stored without sanitization | Low |
| Low      | L3. Reset token default-open in non-prod | Low |
| Low      | L4. Missing CSP header | Medium |
| Low      | L5. CORS wildcard in non-production | Low |
| Low      | L6. iFrame sandbox `allow-same-origin` | Low |
| Low      | L7. Email template injection risk | Low |
