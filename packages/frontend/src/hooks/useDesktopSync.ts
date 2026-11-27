// Hook for syncing desktop state with Cloudflare Workers API
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useDesktopStore } from '../stores/desktopStore';
import { useAlertStore } from '../stores/alertStore';
import { currentDesktopSession } from '../stores/desktopItemSync';
import { isApiConfigured, fetchDesktop, ensureFileToken } from '../services/api';
import type { DesktopResponse } from '../services/api';
import { applyServerProfile, captureSyncMarks, type SyncMarks } from '../utils/refreshLook';

export type DesktopSyncResult = 'applied' | 'stale' | 'failed';

export const DESKTOP_LOAD_FAILED_MESSAGE =
  'Could not load your desktop. Check your connection, then press OK to try again.';

/** Write a server desktop snapshot into the stores. */
export function applyDesktopSnapshot(data: DesktopResponse, marks?: SyncMarks): void {
  const desktop = useDesktopStore.getState();
  desktop.setItems(data.items);
  desktop.setLoading(false);

  // Store server window state for restoration by Desktop.tsx
  if (data.windows && data.windows.length > 0) {
    useDesktopStore.setState({ serverWindows: data.windows });
  }

  // Server profile wins for every server-owned field; appearance always
  // reconciles (a server reset clears the cached look).
  if (data.profile) {
    applyServerProfile(data.profile, marks);
  }
}

/**
 * Fetch the desktop once and apply it — unless `isCurrent()` says the
 * request went stale while in flight (logout, account switch, unmount), in
 * which case nothing is written: a late response must never paint the
 * previous user's items or look.
 */
export async function syncDesktopOnce(isCurrent: () => boolean): Promise<DesktopSyncResult> {
  const marks = captureSyncMarks();
  try {
    const data = await fetchDesktop();
    if (!isCurrent()) return 'stale';
    applyDesktopSnapshot(data, marks);
    return 'applied';
  } catch (error) {
    if (!isCurrent()) return 'stale';
    console.error('Failed to fetch desktop items:', error);
    useDesktopStore.getState().setLoading(false);
    return 'failed';
  }
}

/**
 * Hook to synchronize desktop state with API
 * - Loads items, windows, profile and appearance when a user is signed in
 * - Ignores responses that land after logout / account switch / unmount
 * - Surfaces a load failure (with retry) when there is no cache to show
 *
 * Called once per owner view in App.tsx so it covers both the desktop and
 * the mobile layout.
 */
export function useDesktopSync() {
  const uid = useAuthStore((state) => state.user?.uid ?? null);
  const setItems = useDesktopStore((state) => state.setItems);
  const setUid = useDesktopStore((state) => state.setUid);
  const setLoading = useDesktopStore((state) => state.setLoading);
  const items = useDesktopStore((state) => state.items);
  const loadDesktop = useDesktopStore((state) => state.loadDesktop);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Skip if API is not configured (demo mode)
    if (!isApiConfigured) {
      return;
    }

    // If no user, clear the uid and reset items
    if (!uid) {
      setUid(null);
      setItems([]);
      return;
    }

    // Set the uid for the desktop store (bumps the desktop session on change)
    setUid(uid);
    setLoading(true);
    const session = currentDesktopSession();
    let cancelled = false;
    const isCurrent = () =>
      !cancelled &&
      session === currentDesktopSession() &&
      useAuthStore.getState().user?.uid === uid;

    // Pre-fetch a short-lived file token so media URLs are ready immediately
    ensureFileToken().catch(() => {});

    void syncDesktopOnce(isCurrent).then((result) => {
      if (result !== 'failed' || !isCurrent()) return;
      // With cached items the desktop still shows something useful; the
      // next sync (reload, image-analysis poll) will reconcile. Without a
      // cache the user would be staring at an empty desktop — say so.
      if (useDesktopStore.getState().items.length > 0) return;
      useAlertStore.getState().showConfirm(
        DESKTOP_LOAD_FAILED_MESSAGE,
        () => setAttempt((n) => n + 1),
        undefined,
        'Loading Failed'
      );
    });

    return () => {
      cancelled = true;
    };
  }, [uid, attempt, setItems, setUid, setLoading]);

  useEffect(() => {
    if (!isApiConfigured || !uid) return;

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
  }, [items, loadDesktop, uid]);
}
