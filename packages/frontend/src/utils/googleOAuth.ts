/**
 * Google OAuth utilities
 *
 * Handles the redirect flow for Google Sign-In.
 * Uses the server-side authorization code exchange pattern —
 * no Google JS SDK needed.
 */

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_STATE_KEY = 'google_oauth_state';

/**
 * Get the Google Client ID from environment.
 * Returns null if not configured (Google sign-in will be hidden).
 */
export function getGoogleClientId(): string | null {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || null;
}

/**
 * Redirect the user to Google's OAuth consent screen.
 * Stores a CSRF state token in sessionStorage for verification on callback.
 */
export function redirectToGoogle(): void {
  const clientId = getGoogleClientId();
  if (!clientId) {
    console.error('Google OAuth not configured: VITE_GOOGLE_CLIENT_ID is missing');
    return;
  }

  // Generate CSRF state token
  const state = crypto.randomUUID();
  sessionStorage.setItem(OAUTH_STATE_KEY, state);

  const redirectUri = `${window.location.origin}/auth/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account',
    access_type: 'offline',
  });

  window.location.href = `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * Verify the CSRF state token from the OAuth callback.
 * Returns true if valid, false if mismatch (possible CSRF attack).
 */
export function verifyOAuthState(state: string): boolean {
  const stored = sessionStorage.getItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY); // One-time use
  return stored === state;
}

/**
 * Get the redirect URI for the current origin.
 * Must match what was sent to Google in the initial redirect.
 */
export function getOAuthRedirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}
