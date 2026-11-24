import { useAuthStore } from '../stores/authStore';
import { useAppearanceStore, profileToAppearance } from '../stores/appearanceStore';
import { fetchDesktop } from '../services/api';

/**
 * Reload the desktop's look (colors, fonts, wallpaper) from the server after
 * the assistant changed it — or undid a change — so it shows right away
 * instead of on the next page load.
 */
export async function refreshLookFromServer(): Promise<void> {
  const data = await fetchDesktop();
  if (!data.profile) return;
  const current = useAuthStore.getState().profile;
  if (current) useAuthStore.setState({ profile: { ...current, ...data.profile } });
  useAppearanceStore.getState().loadAppearance(profileToAppearance(data.profile as unknown as Record<string, unknown>));
}
