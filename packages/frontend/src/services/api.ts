/**
 * EternalOS API Client — public entry point.
 *
 * Communicates with the Cloudflare Workers backend.
 * Falls back to mock mode when VITE_API_URL is not configured.
 *
 * The implementation lives in focused modules:
 *   - `./transport` — base-URL config, in-memory session/token state, JWT +
 *     refresh-token rotation with cross-tab `navigator.locks` coordination,
 *     the authenticated `apiRequest` fetch wrapper + error handling, and the
 *     short-lived file-token cache behind `?ft=` media URLs.
 *   - domain clients: `./auth`, `./desktop`, `./visitor`, `./agent`,
 *     `./apps`, `./games`, `./appearance`, `./assets`, `./bazaar`,
 *     `./guestbook`, `./analytics`.
 *
 * This module re-exports the original public surface so existing
 * `…/services/api` imports keep working unchanged. `./transport` additionally
 * exports `API_URL`, `apiRequest`, and `refreshSession` for its sibling
 * modules and for tests — those are intentionally NOT re-exported here.
 */

// Transport/session — public surface only.
export {
  isApiConfigured,
  getApiUrl,
  setAuthToken,
  getAuthToken,
  setRefreshToken,
  getRefreshToken,
  setSessionExpiredHandler,
  setTokenUpdateHandler,
  subscribeToFileToken,
  getFileTokenVersion,
  getCachedFileToken,
  ensureFileToken,
  clearFileToken,
  getFileUrl,
} from './transport';

// Domain clients.
export * from './auth';
export * from './desktop';
export * from './visitor';
export * from './agent';
export * from './apps';
export * from './games';
export * from './appearance';
export * from './assets';
export * from './bazaar';
export * from './guestbook';
export * from './analytics';
