# EternalOS Security Audit

Date: 2026-04-20

Scope:
- `packages/worker`
- `packages/frontend`
- top-level package manifests and deployment headers

Method:
- Static review of authentication, authorization, file serving, browser storage, service worker, user-generated content handling, and deployment headers
- Dependency review with live `npm audit --json`

Limitations:
- This was a code audit, not a live penetration test
- Cloudflare account configuration, secret rotation policy, DNS/TLS settings, and runtime logs were not inspected

## Executive Summary

The repository already has several good controls in place: password hashing is server-side and constant-time, JWT sessions are tied to KV records and invalidated on password changes, file serving uses stored `r2Key` values instead of trusting URL composition, OAuth state is checked on the callback, and user-provided CSS/design-token inputs have meaningful validation.

The highest-risk issues are in the browser and file-delivery layers rather than the core auth logic:

1. Private files are returned with `Cache-Control: public, immutable`, and the service worker caches `/api/files/*` with a cache-first strategy.
2. Access and refresh tokens are persisted in browser storage, while the SPA is not protected by a Content Security Policy.
3. File tokens support scoping in the crypto layer, but the app currently issues only broad user-wide tokens.
4. The forgot-password flow is not protected by Turnstile, which leaves room for distributed abuse of the email-reset channel.

I did not find a direct unauthenticated account takeover or obvious cross-tenant object reference bug in the current worker code path.

## Findings

### 1. Private file responses are publicly cacheable, and the service worker makes them effectively sticky

Severity: High

Affected code:
- [packages/worker/src/routes/upload.ts](packages/worker/src/routes/upload.ts:1074)
- [packages/worker/src/routes/upload.ts](packages/worker/src/routes/upload.ts:1096)
- [packages/frontend/public/sw.js](packages/frontend/public/sw.js:28)
- [packages/frontend/public/sw.js](packages/frontend/public/sw.js:81)
- [packages/frontend/public/sw.js](packages/frontend/public/sw.js:120)
- [packages/frontend/src/services/api.ts](packages/frontend/src/services/api.ts:664)

What is happening:
- The private file-serving path returns `Cache-Control: public, max-age=31536000, immutable` for ranged and non-ranged responses.
- The frontend service worker treats `/api/files/` as an immutable asset class and serves it from a cache-first store.
- File URLs include the short-lived `?ft=` token in the query string, but once a response is cached, that token TTL is no longer the real control for that browser.

Impact:
- Private user files can remain readable from the service worker cache after logout or after the 5-minute file token has expired, as long as the exact cached URL is reused.
- `public` also invites intermediary/shared caching behavior for data that is only conditionally private.
- This weakens the design goal expressed in the file-token comments: short-lived media access with limited exposure if URLs leak.

Why this matters:
- The backend distinguishes owner access from public access, but the cache headers do not.
- Browser-side caching should not silently convert time-bounded authz into long-lived local availability.

Recommended fix:
- For owner-only or file-token authorized responses, use `Cache-Control: private, no-store` or at minimum `private, max-age=0, must-revalidate`.
- Only use long-lived public caching when the worker has positively determined the item is public.
- Remove `/api/files/` from the service worker asset cache, or only cache file responses when the worker marks them explicitly as public-safe.
- Consider adding `Vary: Authorization` if bearer-auth delivery remains in play anywhere on that route family.

### 2. Access and refresh tokens are persisted in browser storage without CSP protection on the SPA

Severity: High

Affected code:
- [packages/frontend/src/stores/authStore.ts](packages/frontend/src/stores/authStore.ts:499)
- [packages/frontend/public/_headers](packages/frontend/public/_headers:5)
- [packages/frontend/index.html](packages/frontend/index.html:39)

What is happening:
- The auth store persists both `token` and `refreshToken` using Zustand `persist`, which defaults to `localStorage`.
- The Pages headers add several useful headers, but they do not set a `Content-Security-Policy`.
- The application bootstraps as a normal script-driven SPA, so any future DOM XSS would be able to read persisted credentials directly.

Impact:
- Any successful XSS becomes full session theft, not just same-tab action forgery.
- Because the refresh token is also persisted, compromise survives access-token expiry.
- The lack of CSP means there is no browser-enforced backstop if a sanitizer or rendering bug is introduced later.

Why this matters:
- This codebase intentionally renders user-controlled content surfaces such as markdown, custom CSS, links, design tokens, and app iframes.
- Even if the current sanitization is mostly sound, the blast radius of one future frontend bug is unnecessarily large.

Recommended fix:
- Move session material to `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict` cookies.
- If a cookie migration is not immediately possible, keep the access token in memory only and store refresh state in a hardened cookie.
- Add a strict CSP for the app shell. At minimum:
  - `default-src 'self'`
  - `script-src 'self'`
  - `object-src 'none'`
  - `base-uri 'none'`
  - `frame-ancestors 'none'`
  - a narrowly-scoped `connect-src` and `img-src`
- Consider Trusted Types once the DOM injection surfaces stabilize.

### 3. File-token scoping exists in the crypto layer but is not enforced or used by the API

Severity: Medium

Affected code:
- [packages/worker/src/utils/jwt.ts](packages/worker/src/utils/jwt.ts:92)
- [packages/worker/src/middleware/auth.ts](packages/worker/src/middleware/auth.ts:133)
- [packages/worker/src/index.ts](packages/worker/src/index.ts:628)

What is happening:
- `signFileToken()` already supports an optional `scope` and its comment explicitly says scoping prevents reuse across other files.
- `issueFileToken()` always signs a token with only the user ID.
- `/api/file-token` exposes that generic token to the frontend for all file URLs.

Impact:
- Any leaked file token is valid for every private file path owned by that user during the token lifetime, not just the single URL where it appeared.
- This increases the blast radius of URL leakage through browser history, logs, extensions, screenshots, referrers to same-origin pages, or future client-side bugs.

Why this matters:
- The code already documents the correct mitigation and has the crypto plumbing for it, but the endpoint is not using it.

Recommended fix:
- Mint per-object or per-batch scoped file tokens and verify the scope in the file-serving route.
- If the frontend needs many files at once, issue a scoped token tied to a concrete item-id allowlist or a server-generated batch identifier rather than a user-wide token.
- Avoid a generic `/api/file-token` that implies broad media access unless you explicitly accept that tradeoff.

### 4. Forgot-password is not protected by Turnstile, which leaves the email channel open to distributed abuse

Severity: Medium

Affected code:
- [packages/worker/src/routes/auth.ts](packages/worker/src/routes/auth.ts:848)
- [packages/frontend/src/pages/ForgotPasswordPage.tsx](packages/frontend/src/pages/ForgotPasswordPage.tsx:118)

What is happening:
- Signup and login both use Turnstile, but forgot-password accepts only an email and relies on per-IP and per-address rate limiting.
- The UI does not render a Turnstile widget for password reset requests.

Impact:
- A distributed attacker can spray reset requests across many addresses and still trigger mail volume.
- Per-address throttling stops repeated hits on one victim, but it does not stop wide fan-out abuse.
- This can raise delivery-reputation risk and operational email costs.

Recommended fix:
- Require Turnstile on forgot-password, using a distinct action such as `forgot-password`.
- Add a global or per-subnet mail-sending throttle in addition to the existing per-address cap.
- Consider suppressing repeated reset emails when an unexpired token already exists for the same account.

## Dependency Review

Live `npm audit --json` reported 11 advisories total:
- 6 high
- 5 moderate
- 0 critical

Notable direct dependencies:
- [packages/frontend/package.json](packages/frontend/package.json:18) pins `dompurify` to `^3.3.3`, which `npm audit` currently flags as moderate.
- [packages/frontend/package.json](packages/frontend/package.json:40) pins `vite` to `^7.3.1`, which `npm audit` currently flags with multiple high-severity dev-server issues.

Important nuance:
- The `vite` advisories are mainly dev-server exposure issues. They still matter for local development, preview environments, and anyone exposing a dev server beyond localhost, but they are not equivalent to a production runtime RCE in the built frontend.
- The `dompurify` advisory is direct and worth updating even if the specific vulnerable API pattern is not obviously used here.
- Several high findings are transitive and tooling-related (`rollup`, `minimatch`, `lodash`, `flatted`, `path-to-regexp`). They should still be upgraded through lockfile refresh or direct dependency bumps.

Recommended dependency actions:
1. Upgrade `vite` to a patched release immediately.
2. Upgrade `dompurify` to the latest patched version and re-run markdown rendering tests.
3. Refresh the lockfile after dependency bumps and re-run `npm audit`.
4. Treat dev-tool advisories as real if any preview/dev environment is internet-reachable.

## Positive Controls Observed

- Passwords are hashed server-side using PBKDF2 with a per-password salt and constant-time verification.
- Sessions are stored server-side in KV and invalidated on password changes.
- File serving resolves the canonical `r2Key` from desktop state instead of trusting URL path composition.
- User-generated CSS and design tokens have meaningful server-side validation, including blocking external `url()` references in most relevant paths.
- Google OAuth uses a CSRF state token in `sessionStorage`.
- WebSocket connection attempts are rate-limited.

## Prioritized Remediation Plan

1. Fix private file caching semantics in the worker and service worker.
2. Move auth out of `localStorage` and add a real CSP for the frontend.
3. Scope file tokens and enforce the scope on the read path.
4. Add Turnstile to forgot-password.
5. Upgrade `vite`, `dompurify`, and refresh the lockfile to clear current advisories.

## Suggested Follow-Up Validation

- Add regression tests proving private `/api/files/*` responses are not cacheable.
- Add an integration test that logout or token expiry prevents reuse of prior file URLs.
- Add a test that forgot-password rejects requests without a valid Turnstile token when enabled.
- Re-run `npm audit` after dependency updates.
