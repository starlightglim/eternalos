// Hook for syncing desktop state with Cloudflare Workers API
import { useEffect, useRef, useCallback } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useDesktopStore } from '../stores/desktopStore';
import { useAppearanceStore } from '../stores/appearanceStore';
import { isApiConfigured, fetchDesktop, ensureFileToken } from '../services/api';

/**
 * Hook to synchronize desktop state with API
 * - Loads items on mount when user is authenticated
 * - Updates profile (wallpaper, displayName) from backend
 * - Handles cleanup on unmount or user change
 */
export function useDesktopSync() {
  // Select primitives/stable references to avoid infinite loops
  const user = useAuthStore((state) => state.user);
  const setItems = useDesktopStore((state) => state.setItems);
  const setUid = useDesktopStore((state) => state.setUid);
  const setLoading = useDesktopStore((state) => state.setLoading);
  const items = useDesktopStore((state) => state.items);
  const loadDesktop = useDesktopStore((state) => state.loadDesktop);
  const fetchedRef = useRef<string | null>(null);

  // Stable callback to update profile
  const updateProfileFromBackend = useCallback((backendProfile: {
    displayName?: string;
    wallpaper?: string;
    isNewUser?: boolean;
    accentColor?: string;
    desktopColor?: string;
    windowBgColor?: string;
    titleBarBgColor?: string;
    titleBarTextColor?: string;
    windowBorderColor?: string;
    buttonBgColor?: string;
    buttonTextColor?: string;
    buttonBorderColor?: string;
    labelColor?: string;
    fontSmoothing?: boolean;
    windowBorderRadius?: number;
    controlBorderRadius?: number;
    windowShadow?: number;
    customCSS?: string;
  }) => {
    const currentProfile = useAuthStore.getState().profile;
    if (currentProfile) {
      useAuthStore.setState({
        profile: {
          ...currentProfile,
          displayName: backendProfile.displayName || currentProfile.displayName,
          wallpaper: backendProfile.wallpaper || currentProfile.wallpaper,
          isNewUser: backendProfile.isNewUser,
          accentColor: backendProfile.accentColor,
          desktopColor: backendProfile.desktopColor,
          windowBgColor: backendProfile.windowBgColor,
          titleBarBgColor: backendProfile.titleBarBgColor,
          titleBarTextColor: backendProfile.titleBarTextColor,
          windowBorderColor: backendProfile.windowBorderColor,
          buttonBgColor: backendProfile.buttonBgColor,
          buttonTextColor: backendProfile.buttonTextColor,
          buttonBorderColor: backendProfile.buttonBorderColor,
          labelColor: backendProfile.labelColor,
          fontSmoothing: backendProfile.fontSmoothing,
          windowBorderRadius: backendProfile.windowBorderRadius,
          controlBorderRadius: backendProfile.controlBorderRadius,
          windowShadow: backendProfile.windowShadow,
          customCSS: backendProfile.customCSS,
        },
      });
    }
  }, []);

  useEffect(() => {
    // Skip if API is not configured (demo mode)
    if (!isApiConfigured) {
      return;
    }

    // If no user, clear the uid and reset items
    if (!user) {
      setUid(null);
      setItems([]);
      fetchedRef.current = null;
      return;
    }

    // Prevent duplicate fetches for the same user
    if (fetchedRef.current === user.uid) {
      return;
    }

    // Set the uid for the desktop store
    setUid(user.uid);
    setLoading(true);
    fetchedRef.current = user.uid;

    // Pre-fetch a short-lived file token so media URLs are ready immediately
    ensureFileToken().catch(() => {});

    // Fetch items and profile from API
    fetchDesktop()
      .then((data) => {
        setItems(data.items);
        setLoading(false);

        // Store server window state for restoration by Desktop.tsx
        if (data.windows && data.windows.length > 0) {
          useDesktopStore.setState({ serverWindows: data.windows });
        }

        // Update profile from backend if available
        // This syncs wallpaper and other preferences from the server
        if (data.profile) {
          updateProfileFromBackend(data.profile);

          // Sync appearance settings (accent color, custom CSS, etc.) to the appearance store
          // so they get applied to the DOM. Without this, backend-saved appearance is ignored.
          const hasAppearance = data.profile.accentColor || data.profile.desktopColor ||
            data.profile.windowBgColor || data.profile.titleBarBgColor ||
            data.profile.titleBarTextColor || data.profile.windowBorderColor ||
            data.profile.buttonBgColor || data.profile.buttonTextColor ||
            data.profile.buttonBorderColor || data.profile.labelColor ||
            data.profile.fontSmoothing !== undefined || data.profile.windowBorderRadius !== undefined ||
            data.profile.controlBorderRadius !== undefined || data.profile.windowShadow !== undefined ||
            data.profile.customCSS;
          if (hasAppearance) {
            useAppearanceStore.getState().loadAppearance({
              accentColor: data.profile.accentColor,
              desktopColor: data.profile.desktopColor,
              windowBgColor: data.profile.windowBgColor,
              titleBarBgColor: data.profile.titleBarBgColor,
              titleBarTextColor: data.profile.titleBarTextColor,
              windowBorderColor: data.profile.windowBorderColor,
              buttonBgColor: data.profile.buttonBgColor,
              buttonTextColor: data.profile.buttonTextColor,
              buttonBorderColor: data.profile.buttonBorderColor,
              labelColor: data.profile.labelColor,
              fontSmoothing: data.profile.fontSmoothing,
              windowBorderRadius: data.profile.windowBorderRadius,
              controlBorderRadius: data.profile.controlBorderRadius,
              windowShadow: data.profile.windowShadow,
              customCSS: data.profile.customCSS,
            });
          }
        }
      })
      .catch((error) => {
        console.error('Failed to fetch desktop items:', error);
        setLoading(false);
        // Reset fetchedRef to allow retry
        fetchedRef.current = null;
      });

    // Cleanup on unmount or user change
    return () => {
      // No cleanup needed for API-based sync
    };
  }, [user, setItems, setUid, setLoading, updateProfileFromBackend]);

  useEffect(() => {
    if (!isApiConfigured || !user) return;

    const hasPendingImageAnalysis = items.some(
      (item) => item.type === 'image' && item.imageAnalysis?.status === 'pending'
    );

    if (!hasPendingImageAnalysis) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadDesktop();
    }, 2500);

    return () => {
      window.clearInterval(interval);
    };
  }, [items, loadDesktop, user]);
}
