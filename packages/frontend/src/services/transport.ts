/**
 * EternalOS API transport & session layer.
 *
 * Everything cross-cutting that the domain clients (`./auth`, `./desktop`,
 * `./appearance`, `./bazaar`, …) are built on:
 *   - base-URL config from `VITE_API_URL` (`API_URL` / `getApiUrl`)
 *   - in-memory JWT / refresh-token state plus the session-version guard that
 *     makes responses from a superseded session untrustworthy
 *   - proactive refresh scheduling and `refreshSession()` — token rotation
 *     with cross-tab coordination (`navigator.locks`), including the
 *     "another tab already rotated" adoption path, deduplicated in-tab via a
 *     shared promise
 *   - `apiRequest()` — the authenticated fetch wrapper: 401 refresh-and-retry
 *     (once), session-change guards, and error normalisation
 *   - the short-lived file-token cache behind the `?ft=` media URLs
 *
 * `./api` re-exports this module's public surface. `API_URL`, `apiRequest`,
 * and `refreshSession` are exported for the sibling domain clients and for
 * tests, but are deliberately NOT re-exported through `./api`.
 */

export const API_URL = import.meta.env.VITE_API_URL || '';

// Check if API is configured
export const isApiConfigured = !!API_URL;

/** Get full URL for an API-relative path (e.g. /api/bazaar/assets/... → https://api.example.com/api/bazaar/assets/...) */
export function getApiUrl(path: string): string {
  return `${API_URL}${path}`;
}

// Store JWT in memory
let authToken: string | null = null;
let refreshToken: string | null = null;
let refreshRequest: Promise<boolean> | null = null;
let sessionVersion = 0;

class SessionChangedError extends Error {
  constructor() { super('Your session changed. Please try again.'); }
}

class RefreshUnavailableError extends Error {
  constructor() { super('Unable to reconnect right now. Your session is saved; please try again.'); }
}

function readStoredSession(): { token: string; refreshToken: string } | null | undefined {
  try {
    const state = JSON.parse(localStorage.getItem('eternalos-auth') || 'null')?.state;
    return typeof state?.token === 'string' && typeof state?.refreshToken === 'string'
      ? { token: state.token, refreshToken: state.refreshToken }
      : null;
  } catch {
    // Storage may be unavailable; in-memory sessions still work in this tab.
    return undefined;
  }
}

function tokenOwner(token: string): string | undefined {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const uid = JSON.parse(atob(payload)).uid;
    return typeof uid === 'string' ? uid : undefined;
  } catch { return undefined; }
}

// Proactive JWT refresh — schedule a refresh slightly before the access token
// expires so requests never see a 401 in the happy path. Refresh tokens rotate
// on each use, so as long as the user opens the app within REFRESH_TOKEN_TTL,
// they stay logged in transparently.
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000; // matches server (15 min)
const ACCESS_TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 1 min before expiry
let proactiveRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function clearProactiveRefreshTimer(): void {
  if (proactiveRefreshTimer) {
    clearTimeout(proactiveRefreshTimer);
    proactiveRefreshTimer = null;
  }
}

/**
 * Read the `exp` claim from a JWT (best-effort, no signature check — we trust
 * our own server's token). Returns the absolute expiry in ms, or null if the
 * token is malformed.
 */
function getJwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(base64)) as { exp?: number };
    return typeof decoded.exp === 'number' ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

function scheduleProactiveRefresh(expiresInSeconds?: number): void {
  clearProactiveRefreshTimer();
  if (!refreshToken || !authToken) return;

  let delayMs: number;
  if (typeof expiresInSeconds === 'number') {
    // Fresh login/refresh — server reported the exact TTL.
    delayMs = expiresInSeconds * 1000 - ACCESS_TOKEN_REFRESH_BUFFER_MS;
  } else {
    // Rehydration after a page refresh — the stored token may already be
    // partway through its lifetime. Use its `exp` claim to schedule precisely.
    const expiryMs = getJwtExpiryMs(authToken);
    delayMs = expiryMs
      ? expiryMs - Date.now() - ACCESS_TOKEN_REFRESH_BUFFER_MS
      : ACCESS_TOKEN_TTL_MS - ACCESS_TOKEN_REFRESH_BUFFER_MS;
  }

  // If the token is already inside the buffer window (or expired), refresh
  // very soon — but not synchronously, to avoid re-entrancy with whatever
  // call site triggered this scheduling.
  delayMs = Math.max(1_000, delayMs);
  proactiveRefreshTimer = setTimeout(async () => {
    try {
      const ok = await refreshSession();
      if (!ok && authToken) {
        setAuthToken(null);
        setRefreshToken(null);
        onSessionExpired?.();
      }
    } catch (error) {
      // Connectivity failures and rate limits are not revoked credentials.
      if (error instanceof RefreshUnavailableError && authToken && refreshToken) {
        scheduleProactiveRefresh(90); // Retry in 30 seconds, without a tight loop.
      }
    }
  }, delayMs);
}

/**
 * Set the auth token for API requests
 */
export function setAuthToken(token: string | null): void {
  // Credential rotation within one account is not an identity change.
  if (authToken !== token && (!authToken || !token || tokenOwner(authToken) !== tokenOwner(token))) {
    sessionVersion += 1;
  }
  authToken = token;
  if (!token) {
    clearProactiveRefreshTimer();
  } else if (refreshToken) {
    // Token (re)set externally (login, rehydration). Assume a fresh full TTL —
    // worst case we refresh slightly early.
    scheduleProactiveRefresh();
  }
}

/**
 * Get the current auth token
 */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Set the refresh token for session rotation.
 */
export function setRefreshToken(token: string | null): void {
  if (Boolean(refreshToken) !== Boolean(token)) sessionVersion += 1;
  refreshToken = token;
  if (!token) {
    clearProactiveRefreshTimer();
  } else if (authToken && !proactiveRefreshTimer) {
    // Defensive: rehydration may set tokens in either order. If authToken was
    // already restored before refreshToken, schedule the refresh now.
    scheduleProactiveRefresh();
  }
}

/**
 * Get the current refresh token.
 */
export function getRefreshToken(): string | null {
  return refreshToken;
}

// Callback for handling session expiry — set by authStore during init
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

// Callback for syncing refreshed tokens back to the persisted store
let onTokenUpdate: ((token: string, refreshToken: string) => void) | null = null;

export function setTokenUpdateHandler(handler: ((token: string, refreshToken: string) => void) | null): void {
  onTokenUpdate = handler;
}

interface RefreshResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

export async function refreshSession(): Promise<boolean> {
  if (!refreshToken) {
    return false;
  }

  if (refreshRequest) {
    return refreshRequest;
  }

  const version = sessionVersion;
  const originalToken = authToken;
  const originalRefresh = refreshToken;
  const rotate = async () => {
    try {
      if (sessionVersion !== version) throw new SessionChangedError();
      // Re-read inside the cross-tab lock: another tab may already have rotated.
      const stored = readStoredSession();
      if (stored === null) throw new SessionChangedError();
      if (stored && stored.refreshToken !== originalRefresh) {
        const uid = originalToken && tokenOwner(originalToken);
        if (!uid || tokenOwner(stored.token) !== uid) throw new SessionChangedError();
        authToken = stored.token;
        refreshToken = stored.refreshToken;
        onTokenUpdate?.(stored.token, stored.refreshToken);
        clearFileToken();
        scheduleProactiveRefresh();
        return true;
      }
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: originalRefresh }),
      });

      const latest = readStoredSession();
      if (sessionVersion !== version || latest === null
        || (latest && latest.refreshToken !== originalRefresh)) {
        throw new SessionChangedError();
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return false;
        throw new RefreshUnavailableError();
      }

      const data = await response.json() as RefreshResponse;
      if (sessionVersion !== version) throw new SessionChangedError();
      if (!data.token || !data.refreshToken || !Number.isFinite(data.expiresIn)) {
        throw new RefreshUnavailableError();
      }
      authToken = data.token;
      refreshToken = data.refreshToken;
      // Sync new tokens to persisted store so page reloads don't restore stale tokens
      onTokenUpdate?.(data.token, data.refreshToken);
      // Refreshed JWTs invalidate the cached file token (they're scoped to a
      // session and the new file token will be fresher anyway).
      cachedFileToken = null;
      fileTokenExpiresAt = 0;
      void fetchFileToken();
      // Schedule the next proactive refresh based on the server-reported TTL.
      scheduleProactiveRefresh(data.expiresIn);
      return true;
    } catch (error) {
      if (error instanceof SessionChangedError) throw error;
      throw new RefreshUnavailableError();
    }
  };

  // Web Locks serialize refresh across tabs on supported browsers. The
  // module-local promise also deduplicates callers within each tab.
  refreshRequest = (async () => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request('eternalos-session-refresh', rotate);
    }
    return await rotate();
  })().finally(() => { refreshRequest = null; });

  return refreshRequest;
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  allowRetry = true
): Promise<T> {
  const requestSessionVersion = sessionVersion;
  const requestAuthToken = authToken;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (authToken) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });
  if (sessionVersion !== requestSessionVersion) throw new SessionChangedError();

  if (!response.ok) {
    if (response.status === 401 && authToken && allowRetry) {
      if (authToken !== requestAuthToken) return apiRequest<T>(path, options, false);
      // Refresh once. Temporary failures propagate without discarding credentials.
      const refreshed = await refreshSession();
      if (refreshed) {
        return apiRequest<T>(path, options, false);
      }
    }
    // Handle expired/invalid token after refresh attempt
    if (response.status === 401 && authToken) {
      setAuthToken(null);
      setRefreshToken(null);
      onSessionExpired?.();
      throw new Error('Session expired. Please log in again.');
    }

    const rawText = await response.text().catch(() => '');
    let errorMessage = '';

    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { error?: string };
        errorMessage = parsed.error || '';
      } catch {
        errorMessage = rawText.trim();
      }
    }

    if (!errorMessage) {
      errorMessage = response.statusText || 'Request failed';
    }

    throw new Error(`${response.status} ${errorMessage}`);
  }

  const data = await response.json();
  if (sessionVersion !== requestSessionVersion) throw new SessionChangedError();
  return data;
}

// ============ File URL ============

/**
 * Short-lived file token for media src URLs.
 * Replaces the old approach of putting the full JWT in query params, which
 * leaked credentials into server logs, browser history, and referrer headers.
 *
 * Token TTL is 5 min on the server. We refresh ~1 min before expiry so URLs
 * already on the page never see a 401.
 *
 * Components subscribe via `subscribeToFileToken` / `getFileTokenVersion` so
 * they re-render when the token first loads (after a page refresh) or rotates.
 */
const FILE_TOKEN_TTL_MS = 5 * 60 * 1000;
const FILE_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

let cachedFileToken: string | null = null;
let fileTokenExpiresAt = 0;
let fileTokenRequest: Promise<string | null> | null = null;
let fileTokenRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let fileTokenVersion = 0;
const fileTokenSubscribers = new Set<() => void>();

function notifyFileTokenSubscribers(): void {
  fileTokenVersion += 1;
  for (const sub of fileTokenSubscribers) {
    try { sub(); } catch { /* ignore subscriber errors */ }
  }
}

/**
 * Subscribe to file-token changes. Returns an unsubscribe function.
 * Use with `useSyncExternalStore` (see hooks/useFileToken.ts).
 */
export function subscribeToFileToken(callback: () => void): () => void {
  fileTokenSubscribers.add(callback);
  return () => {
    fileTokenSubscribers.delete(callback);
  };
}

/**
 * Get the current file-token version (incremented on every token change).
 * Stable across renders when the token hasn't changed — safe for useSyncExternalStore.
 */
export function getFileTokenVersion(): number {
  return fileTokenVersion;
}

function clearFileTokenRefreshTimer(): void {
  if (fileTokenRefreshTimer) {
    clearTimeout(fileTokenRefreshTimer);
    fileTokenRefreshTimer = null;
  }
}

async function fetchFileToken(): Promise<string | null> {
  if (!authToken) return null;

  // Return cached token if still valid (with refresh buffer)
  if (cachedFileToken && Date.now() < fileTokenExpiresAt - FILE_TOKEN_REFRESH_BUFFER_MS) {
    return cachedFileToken;
  }

  // Deduplicate concurrent requests
  if (fileTokenRequest) return fileTokenRequest;

  fileTokenRequest = (async () => {
    try {
      // Use apiRequest so a 401 here goes through the JWT refresh path. Doing
      // a bare fetch would silently fail when the JWT had expired during
      // page-load idle time, leaving images broken until the next user action.
      const data = await apiRequest<{ ft: string }>('/api/file-token', {
        method: 'POST',
      });
      cachedFileToken = data.ft;
      fileTokenExpiresAt = Date.now() + FILE_TOKEN_TTL_MS;
      // Schedule a background refresh shortly before the token would expire
      // so existing img/video src URLs never go stale.
      clearFileTokenRefreshTimer();
      fileTokenRefreshTimer = setTimeout(() => {
        cachedFileToken = null;
        fileTokenExpiresAt = 0;
        void fetchFileToken();
      }, FILE_TOKEN_TTL_MS - FILE_TOKEN_REFRESH_BUFFER_MS);
      // Wake any subscribed components so they re-render with the new URL.
      notifyFileTokenSubscribers();
      return cachedFileToken;
    } catch {
      return null;
    } finally {
      fileTokenRequest = null;
    }
  })();

  return fileTokenRequest;
}

/**
 * Get the current cached file token synchronously.
 * Returns null if no token is available yet — call ensureFileToken() first.
 */
export function getCachedFileToken(): string | null {
  if (cachedFileToken && Date.now() < fileTokenExpiresAt - FILE_TOKEN_REFRESH_BUFFER_MS) {
    return cachedFileToken;
  }
  return null;
}

/**
 * Ensure a file token is available. Call this before rendering media.
 * Returns the token (or null if not authenticated).
 */
export async function ensureFileToken(): Promise<string | null> {
  return fetchFileToken();
}

/**
 * Clear cached file token (called on logout).
 */
export function clearFileToken(): void {
  cachedFileToken = null;
  fileTokenExpiresAt = 0;
  clearFileTokenRefreshTimer();
  notifyFileTokenSubscribers();
}

/**
 * Get the URL for a file stored in R2.
 * Uses a short-lived file token (not the full JWT) in the query param.
 *
 * If the token isn't ready yet (page just loaded), this still returns a usable
 * URL — public files will load and private files will 401, but components that
 * subscribe via `useFileTokenVersion()` will re-render and pick up the proper
 * URL as soon as the token arrives. Always trigger an `ensureFileToken()` so
 * that subscribers are eventually notified.
 *
 * @param r2Key - The full R2 key path (e.g., "uid/itemId/filename")
 */
export function getFileUrl(r2Key: string): string {
  const ft = getCachedFileToken();
  // Encode each path segment to handle special characters in filenames
  const encodedKey = r2Key.split('/').map(encodeURIComponent).join('/');
  // New cache namespace for clients that previously cached immutable file URLs.
  const baseUrl = `${API_URL}/api/files/${encodedKey}?v=2`;
  if (ft) {
    return `${baseUrl}&ft=${encodeURIComponent(ft)}`;
  }
  // Fire-and-forget — when the token arrives, subscribers re-render and call
  // getFileUrl again with a token attached.
  if (authToken) {
    void fetchFileToken();
  }
  return baseUrl;
}
