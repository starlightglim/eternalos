import type { UserProfile } from '../types';

/**
 * Merge the profile the server just returned into the locally cached one.
 *
 * authStore persists the whole profile and the desktop paints from it, so a
 * partial merge leaves stale values on screen after a reload (a wallpaper
 * cleared on the server came back, bio/links/sound pack/design tokens never
 * updated). The server is the source of truth for every profile field: a
 * field it omits is a field it doesn't have, so it is dropped locally too.
 *
 * Two narrow exceptions keep the merge from fighting the user:
 *  - `keepLocal`: fields with an optimistic PATCH still in flight keep the
 *    local value (the server copy predates the edit; the PATCH's own
 *    ack/rollback settles it).
 *  - a missing displayName falls back to the cached one, then the username.
 *
 * Works when nothing is cached (first load after login, or a cleared cache).
 * Cached values never leak across accounts: they are only consulted when the
 * cached profile belongs to the same uid.
 */
export function mergeServerProfile(
  cached: UserProfile | null,
  server: UserProfile,
  keepLocal: readonly string[] = []
): UserProfile {
  const sameUser = !!cached && (!server.uid || cached.uid === server.uid);
  const merged = { ...server } as UserProfile & Record<string, unknown>;

  if (sameUser && cached) {
    // Identity fields an older/partial server payload might omit.
    if (!merged.uid) merged.uid = cached.uid;
    if (!merged.username) merged.username = cached.username;
    if (!merged.createdAt) merged.createdAt = cached.createdAt;

    const cachedRecord = cached as unknown as Record<string, unknown>;
    for (const key of keepLocal) {
      if (key in cachedRecord) merged[key] = cachedRecord[key];
      else delete merged[key];
    }
  }

  if (!merged.displayName) {
    merged.displayName = (sameUser && cached?.displayName) || merged.username;
  }

  return merged;
}
