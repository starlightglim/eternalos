// Authentication store for EternalOS
// Uses Cloudflare Workers API (or mock mode when API not configured)

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { UserProfile, AuthUser } from '../types';
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
  signup: (email: string, password: string, username: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  googleLogin: (code: string, redirectUri: string) => Promise<{ isNewUser: boolean }>;
  logout: () => Promise<void>;
  clearError: () => void;
  initialize: () => () => void;
  setWallpaper: (wallpaper: string) => void;
  setWallpaperMode: (mode: 'cover' | 'tile' | 'center') => void;
  setBio: (bio: string) => void;
  setProfileLinks: (links: { title: string; url: string }[]) => void;
  setShareDescription: (desc: string) => void;
  setAnalyticsEnabled: (enabled: boolean) => void;
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

      signup: async (email: string, password: string, username: string) => {
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
          // Validate username format
          const usernameError = validateUsername(username);
          if (usernameError) {
            set({ loading: false, error: usernameError });
            return;
          }

          const response = await apiSignup(email, password, username);

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
          const message = error instanceof Error ? error.message : 'Signup failed';
          set({ loading: false, error: message });
        }
      },

      login: async (email: string, password: string) => {
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
          const response = await apiLogin(email, password);

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
        // Clear window state on logout
        useWindowStore.getState().clearWindowState();
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
        const { profile } = get();
        if (profile) {
          // Update local state immediately for responsive UI
          set({
            profile: { ...profile, wallpaper },
          });

          // Sync to backend if API is configured
          if (isApiConfigured) {
            apiUpdateProfile({ wallpaper }).catch((error) => {
              console.error('Failed to sync wallpaper to backend:', error);
            });
          }
        }
      },

      setWallpaperMode: (wallpaperMode: 'cover' | 'tile' | 'center') => {
        const { profile } = get();
        if (profile) {
          set({
            profile: { ...profile, wallpaperMode },
          });

          if (isApiConfigured) {
            apiUpdateProfile({ wallpaperMode }).catch((error) => {
              console.error('Failed to sync wallpaper mode to backend:', error);
            });
          }
        }
      },

      setBio: (bio: string) => {
        const { profile } = get();
        if (profile) {
          set({ profile: { ...profile, bio } });
          if (isApiConfigured) {
            apiUpdateProfile({ bio }).catch((error) => {
              console.error('Failed to sync bio to backend:', error);
            });
          }
        }
      },

      setProfileLinks: (profileLinks: { title: string; url: string }[]) => {
        const { profile } = get();
        if (profile) {
          set({ profile: { ...profile, profileLinks } });
          if (isApiConfigured) {
            apiUpdateProfile({ profileLinks }).catch((error) => {
              console.error('Failed to sync profile links to backend:', error);
            });
          }
        }
      },

      setShareDescription: (shareDescription: string) => {
        const { profile } = get();
        if (profile) {
          set({ profile: { ...profile, shareDescription } });
          if (isApiConfigured) {
            apiUpdateProfile({ shareDescription }).catch((error) => {
              console.error('Failed to sync share description to backend:', error);
            });
          }
        }
      },

      setAnalyticsEnabled: (analyticsEnabled: boolean) => {
        const { profile } = get();
        if (profile) {
          set({ profile: { ...profile, analyticsEnabled } });
          if (isApiConfigured) {
            apiUpdateProfile({ analyticsEnabled }).catch((error) => {
              console.error('Failed to sync analytics setting to backend:', error);
            });
          }
        }
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
          useWindowStore.getState().clearWindowState();
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

        return () => {};
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
