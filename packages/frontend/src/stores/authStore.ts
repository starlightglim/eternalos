// Authentication store for EternalOS
// Uses Cloudflare Workers API (or mock mode when API not configured)

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserProfile, AuthUser, ProfileLink } from '../types';
import {
  isApiConfigured,
  setAuthToken,
  setRefreshToken,
  clearFileToken,
  setSessionExpiredHandler,
  setTokenUpdateHandler,
  signup as apiSignup,
  login as apiLogin,
  googleLogin as apiGoogleLogin,
  logout as apiLogout,
  updateProfile as apiUpdateProfile,
  changePassword as apiChangePassword,
  changeUsername as apiChangeUsername,
  sendVerificationEmail as apiSendVerification,
} from '../services/api';
import { useWindowStore } from './windowStore';
import { useDesktopStore } from './desktopStore';

interface AuthState {
  user: AuthUser | null;
  profile: UserProfile | null;
  token: string | null;
  refreshToken: string | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
}

interface AuthActions {
  signup: (email: string, password: string, username: string, turnstileToken?: string | null) => Promise<string[] | undefined>;
  login: (email: string, password: string, turnstileToken?: string | null) => Promise<void>;
  googleLogin: (code: string, redirectUri: string) => Promise<{ isNewUser: boolean }>;
  logout: () => Promise<void>;
  clearError: () => void;
  initialize: () => () => void;
  /**
   * Optimistic profile setters: apply the value locally, PATCH it to the
   * server, and resolve to whether the server acknowledged the change.
   * On failure the profile field is rolled back to the last
   * server-acknowledged value and the promise resolves `false` (it never
   * rejects — fire-and-forget callers must not get unhandled rejections).
   */
  setWallpaper: (wallpaper: string) => Promise<boolean>;
  setWallpaperMode: (mode: 'cover' | 'tile' | 'center') => Promise<boolean>;
  setBio: (bio: string) => Promise<boolean>;
  setProfileLinks: (links: ProfileLink[]) => Promise<boolean>;
  setShareDescription: (desc: string) => Promise<boolean>;
  setAnalyticsEnabled: (enabled: boolean) => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ success: boolean; error?: string }>;
  changeUsername: (newUsername: string, password: string) => Promise<{ success: boolean; error?: string }>;
  sendVerificationEmail: () => Promise<{ success: boolean; error?: string }>;
  setEmailVerified: (verified: boolean) => void;
}

type AuthStore = AuthState & AuthActions;

// Validate username format
function validateUsername(username: string): string | null {
  if (username.length < 3) {
    return 'Username must be at least 3 characters';
  }
  if (username.length > 20) {
    return 'Username must be 20 characters or less';
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return 'Username can only contain letters, numbers, and underscores';
  }
  return null;
}

// The profile fields the optimistic setters below sync to the server.
type SyncedProfileField =
  | 'wallpaper'
  | 'wallpaperMode'
  | 'bio'
  | 'profileLinks'
  | 'shareDescription'
  | 'analyticsEnabled';

// Per-field PATCH serialization + rollback bookkeeping — the same discipline
// desktopStore applies to items (persistItemMutation / positionRollback):
//  - writes to the same field serialize, so a refusal can never land after a
//    newer edit of that field;
//  - the rollback target is captured once per save cycle (the last
//    server-acknowledged value before the first un-acked edit) and is
//    refreshed on every ack, so a failed save during a rapid edit chain
//    reverts to where the server actually is, not to an intermediate
//    optimistic value;
//  - a failed PATCH reverts only if the field is unchanged since, so a stale
//    failure never clobbers a newer edit.
const profileWriteQueues = new Map<SyncedProfileField, Promise<boolean>>();
const profileRollback = new Map<SyncedProfileField, unknown>();

function resetProfileSyncQueues(): void {
  profileWriteQueues.clear();
  profileRollback.clear();
}

// Minimal store seam the helper below needs (the zustand store's set/get).
type AuthStoreSet = (partial: Partial<AuthStore>) => void;
type AuthStoreGet = () => AuthStore;

/**
 * Optimistically apply a profile field, then PATCH it to the server.
 * Resolves true when the server acknowledged the change (or in demo mode,
 * where there is no server to refuse it); resolves false after rolling the
 * field back to the last server-acknowledged value.
 */
function syncProfileField(
  set: AuthStoreSet,
  get: AuthStoreGet,
  field: SyncedProfileField,
  value: unknown,
  payload: Record<string, unknown>
): Promise<boolean> {
  const { profile } = get();
  if (!profile) return Promise.resolve(false);

  // Update local state immediately for responsive UI.
  set({ profile: { ...profile, [field]: value } as UserProfile });

  // Demo mode: no server to refuse the change; the local value stands.
  if (!isApiConfigured) return Promise.resolve(true);

  // Capture the rollback target once per save cycle: the last
  // server-acknowledged value before the first un-acked edit.
  if (!profileWriteQueues.has(field)) {
    profileRollback.set(field, profile[field]);
  }

  const previous = profileWriteQueues.get(field) ?? Promise.resolve(true);
  const pending: Promise<boolean> = previous.catch(() => false).then(async () => {
    await apiUpdateProfile(payload as Parameters<typeof apiUpdateProfile>[0]);
    return true;
  });
  profileWriteQueues.set(field, pending);

  return pending
    .then(() => {
      // Acknowledged: this value is now the server-known rollback target
      // for any edit still queued behind it.
      profileRollback.set(field, value);
      return true;
    })
    .catch((error: unknown) => {
      console.error(`Failed to sync ${field} to backend:`, error);
      // The server refused (offline / 401 / 429 / 500): revert to the last
      // server-known value — unless the user edited again in the meantime,
      // in which case this stale failure must not clobber the newer edit
      // (it gets its own save).
      const current = get().profile;
      if (current && current[field] === value) {
        set({ profile: { ...current, [field]: profileRollback.get(field) } as UserProfile });
      }
      return false;
    })
    .finally(() => {
      // Only the last write of the cycle retires the bookkeeping — an
      // earlier one finishing must leave it for the edits queued behind it.
      if (profileWriteQueues.get(field) === pending) {
        profileWriteQueues.delete(field);
        profileRollback.delete(field);
      }
    });
}

// Mock user for demo mode
const mockUser: AuthUser = {
  uid: 'demo-user',
  username: 'demo',
  email: 'demo@eternalos.local',
};

const mockProfile: UserProfile = {
  uid: 'demo-user',
  username: 'demo',
  displayName: 'Demo User',
  wallpaper: 'default',
  createdAt: Date.now(),
};

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      user: null,
      profile: null,
      token: null,
      refreshToken: null,
      loading: false,
      error: null,
      initialized: false,

      signup: async (email: string, password: string, username: string, turnstileToken?: string | null) => {
        // In demo mode, just set mock user
        if (!isApiConfigured) {
          set({
            user: mockUser,
            profile: mockProfile,
            loading: false,
            initialized: true,
          });
          return undefined;
        }

        set({ loading: true, error: null });

        try {
          // Validate username format
          const usernameError = validateUsername(username);
          if (usernameError) {
            set({ loading: false, error: usernameError });
            return undefined;
          }

          const response = await apiSignup(email, password, username, turnstileToken);

          // Store token in API client
          setAuthToken(response.token);
          setRefreshToken(response.refreshToken);

          const user: AuthUser = {
            uid: response.user.uid,
            username: response.user.username,
            email: response.user.email,
            emailVerified: response.user.emailVerified || false,
          };

          const profile: UserProfile = {
            uid: response.user.uid,
            username: response.user.username,
            displayName: response.user.username,
            createdAt: Date.now(),
            // Signup always creates a fresh account — flag as new so the
            // QuickStartWizard appears on first desktop render.
            isNewUser: true,
          };

          set({
            user,
            profile,
            token: response.token,
            refreshToken: response.refreshToken,
            loading: false,
            initialized: true,
          });

          // Return recovery codes so the page can show the save-codes modal
          // before navigating away. Server returns these exactly once.
          return response.recoveryCodes;
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Signup failed';
          set({ loading: false, error: message });
          return undefined;
        }
      },

      login: async (email: string, password: string, turnstileToken?: string | null) => {
        // In demo mode, just set mock user
        if (!isApiConfigured) {
          set({
            user: mockUser,
            profile: mockProfile,
            loading: false,
            initialized: true,
          });
          return;
        }

        set({ loading: true, error: null });

        try {
          const response = await apiLogin(email, password, turnstileToken);

          // Store token in API client
          setAuthToken(response.token);
          setRefreshToken(response.refreshToken);

          const user: AuthUser = {
            uid: response.user.uid,
            username: response.user.username,
            email: response.user.email,
            emailVerified: response.user.emailVerified || false,
          };

          // Note: Full profile would come from desktop fetch
          const profile: UserProfile = {
            uid: response.user.uid,
            username: response.user.username,
            displayName: response.user.username,
            createdAt: Date.now(),
          };

          set({
            user,
            profile,
            token: response.token,
            refreshToken: response.refreshToken,
            loading: false,
            initialized: true,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Login failed';
          set({ loading: false, error: message });
        }
      },

      googleLogin: async (code: string, redirectUri: string) => {
        set({ loading: true, error: null });

        try {
          const response = await apiGoogleLogin(code, redirectUri);

          setAuthToken(response.token);
          setRefreshToken(response.refreshToken);

          const user: AuthUser = {
            uid: response.user.uid,
            username: response.user.username,
            email: response.user.email,
            emailVerified: response.user.emailVerified || false,
          };

          const profile: UserProfile = {
            uid: response.user.uid,
            username: response.user.username,
            displayName: response.user.username,
            createdAt: Date.now(),
            // Propagate the server-reported new-user flag so the
            // QuickStartWizard appears for first-time Google signups.
            isNewUser: response.isNewUser,
          };

          set({
            user,
            profile,
            token: response.token,
            refreshToken: response.refreshToken,
            loading: false,
            initialized: true,
          });

          return { isNewUser: response.isNewUser };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Google sign-in failed';
          set({ loading: false, error: message });
          throw error;
        }
      },

      logout: async () => {
        const { token } = get();

        set({ loading: true, error: null });

        try {
          if (isApiConfigured && token) {
            // apiLogout handles clearing authToken, refreshToken, and fileToken
            await apiLogout();
          }
        } catch {
          // Ignore logout API errors — we clear state regardless
        }
        // Wipe every per-user cache so the next sign-in can't see the
        // previous user's items, windows, or image URLs.
        resetProfileSyncQueues();
        useWindowStore.getState().resetOnLogout();
        useDesktopStore.getState().reset();
        clearFileToken();
        set({
          user: null,
          profile: null,
          token: null,
          refreshToken: null,
          loading: false,
        });
      },

      clearError: () => set({ error: null }),

      setWallpaper: (wallpaper: string) => {
        return syncProfileField(set, get, 'wallpaper', wallpaper, { wallpaper });
      },

      setWallpaperMode: (wallpaperMode: 'cover' | 'tile' | 'center') => {
        return syncProfileField(set, get, 'wallpaperMode', wallpaperMode, { wallpaperMode });
      },

      setBio: (bio: string) => {
        return syncProfileField(set, get, 'bio', bio, { bio });
      },

      setProfileLinks: (profileLinks: ProfileLink[]) => {
        return syncProfileField(set, get, 'profileLinks', profileLinks, { profileLinks });
      },

      setShareDescription: (shareDescription: string) => {
        return syncProfileField(set, get, 'shareDescription', shareDescription, { shareDescription });
      },

      setAnalyticsEnabled: (analyticsEnabled: boolean) => {
        return syncProfileField(set, get, 'analyticsEnabled', analyticsEnabled, { analyticsEnabled });
      },

      changePassword: async (currentPassword: string, newPassword: string) => {
        if (!isApiConfigured) return { success: false, error: 'API not configured' };

        try {
          const response = await apiChangePassword(currentPassword, newPassword);

          // Update tokens
          setAuthToken(response.token);
          setRefreshToken(response.refreshToken);
          set({
            token: response.token,
            refreshToken: response.refreshToken,
          });

          return { success: true };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to change password';
          return { success: false, error: message };
        }
      },

      changeUsername: async (newUsername: string, password: string) => {
        if (!isApiConfigured) return { success: false, error: 'API not configured' };

        const usernameError = validateUsername(newUsername);
        if (usernameError) {
          return { success: false, error: usernameError };
        }

        try {
          const response = await apiChangeUsername(newUsername, password);

          // Update tokens and user/profile
          setAuthToken(response.token);
          setRefreshToken(response.refreshToken);

          const { user, profile } = get();
          set({
            token: response.token,
            refreshToken: response.refreshToken,
            user: user ? { ...user, username: response.username } : null,
            profile: profile ? { ...profile, username: response.username } : null,
          });

          return { success: true };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to change username';
          return { success: false, error: message };
        }
      },

      sendVerificationEmail: async () => {
        if (!isApiConfigured) return { success: false, error: 'API not configured' };

        try {
          await apiSendVerification();
          return { success: true };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to send verification email';
          return { success: false, error: message };
        }
      },

      setEmailVerified: (verified: boolean) => {
        const { user } = get();
        if (user) {
          set({ user: { ...user, emailVerified: verified } });
        }
      },

      initialize: () => {
        const { token, refreshToken: storedRefreshToken } = get();

        // If we have a stored token, restore it to the API client
        if (token) {
          setAuthToken(token);
        }
        if (storedRefreshToken) {
          setRefreshToken(storedRefreshToken);
        }

        // Register session expired handler so API 401s trigger logout
        setSessionExpiredHandler(() => {
          setAuthToken(null);
          setRefreshToken(null);
          clearFileToken();
          resetProfileSyncQueues();
          useWindowStore.getState().resetOnLogout();
          useDesktopStore.getState().reset();
          set({
            user: null,
            profile: null,
            token: null,
            refreshToken: null,
            loading: false,
            error: 'Your session has expired. Please log in again.',
          });
          // Navigate to login — use window.location since store can't access React Router
          window.location.href = '/login';
        });

        // Sync refreshed tokens back to the persisted store so page reloads
        // don't restore stale (consumed) tokens and trigger reuse detection
        setTokenUpdateHandler((newToken, newRefreshToken) => {
          set({ token: newToken, refreshToken: newRefreshToken });
        });

        // In demo mode, auto-login with mock user
        if (!isApiConfigured) {
          set({
            user: mockUser,
            profile: mockProfile,
            initialized: true,
            loading: false,
          });
          return () => {};
        }

        // With API configured, check if we have a valid token
        // The actual validation happens on API calls
        if (token) {
          // We have a stored token - assume valid until API call fails
          // Profile will be loaded when desktop is fetched
          set({ initialized: true, loading: false });
        } else {
          set({
            user: null,
            profile: null,
            initialized: true,
            loading: false,
          });
        }

        const onStorage = (event: StorageEvent) => {
          if (event.key !== 'eternalos-auth' && event.key !== null) return;
          let next: Partial<AuthState> | null;
          try {
            next = event.newValue ? JSON.parse(event.newValue)?.state : null;
          } catch { return; }

          if (!next?.token || !next.refreshToken || next.user?.uid !== get().user?.uid) {
            // Do not persist an empty session over another tab's new account.
            // Reload rehydrates the new identity and discards all old requests.
            setAuthToken(null);
            setRefreshToken(null);
            clearFileToken();
            useWindowStore.getState().resetOnLogout();
            useDesktopStore.getState().reset();
            window.location.reload();
            return;
          }
          if (next.token !== get().token || next.refreshToken !== get().refreshToken) {
            setAuthToken(next.token);
            setRefreshToken(next.refreshToken);
            clearFileToken();
            set({ token: next.token, refreshToken: next.refreshToken });
          }
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
      },
    }),
    {
      name: 'eternalos-auth',
      // Only persist token
      partialize: (state) => ({
        token: state.token,
        refreshToken: state.refreshToken,
        user: state.user,
        profile: state.profile,
      }),
      // Set auth token in API module after hydration completes
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          setAuthToken(state.token);
        }
        if (state?.refreshToken) {
          setRefreshToken(state.refreshToken);
        }
      },
    }
  )
);
