import type { UserProfile } from '../types';
import { useAuthStore, pendingProfileFields, currentProfileWriteSeq } from '../stores/authStore';
import { useAlertStore } from '../stores/alertStore';
import {
  useAppearanceStore,
  profileToAppearance,
  currentAppearanceCommitSeq,
} from '../stores/appearanceStore';
import { fetchDesktop } from '../services/api';
import { mergeServerProfile } from './serverProfile';

/**
 * Adopt the profile the server returned: the cached profile (wallpaper, bio,
 * links, sound pack, design tokens, …) is replaced field by field, and the
 * appearance store reconciles against the server's look — including a reset
 * to defaults. Shared by the desktop sync and the post-assistant refresh so
 * both merge the same way.
 */
export interface SyncMarks {
  profileSeq: number;
  appearanceSeq: number;
}

/** Capture before a fetch: local writes after this win over its snapshot. */
export function captureSyncMarks(): SyncMarks {
  return { profileSeq: currentProfileWriteSeq(), appearanceSeq: currentAppearanceCommitSeq() };
}

export function applyServerProfile(server: UserProfile, marks?: SyncMarks): void {
  const cached = useAuthStore.getState().profile;
  useAuthStore.setState({
    profile: mergeServerProfile(cached, server, pendingProfileFields(marks?.profileSeq)),
  });
  useAppearanceStore
    .getState()
    .syncFromServer(profileToAppearance(server as unknown as Record<string, unknown>), marks?.appearanceSeq);
}

/**
 * Reload the desktop's look (colors, fonts, wallpaper) from the server after
 * the assistant changed it — or undid a change — so it shows right away
 * instead of on the next page load.
 */
export async function refreshLookFromServer(): Promise<void> {
  const uid = useAuthStore.getState().user?.uid;
  if (!uid) return;
  const marks = captureSyncMarks();
  const data = await fetchDesktop();
  // Logged out or switched accounts while the request was in flight.
  if (useAuthStore.getState().user?.uid !== uid) return;
  if (!data.profile) return;
  applyServerProfile(data.profile, marks);
  // Unsaved edits are kept on screen rather than clobbered — say why the
  // assistant's change isn't visible yet.
  const { hasUnsavedChanges, customCSSPreview } = useAppearanceStore.getState();
  if (hasUnsavedChanges || customCSSPreview !== undefined) {
    useAlertStore
      .getState()
      .showInfo(
        'Your look was changed, but you have unsaved appearance edits on screen. Discard them in Appearance to see the new look, or save to keep yours.',
        'Unsaved Appearance'
      );
  }
}
