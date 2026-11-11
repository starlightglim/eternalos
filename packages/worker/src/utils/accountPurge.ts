/**
 * Account hard-deletion (purge).
 *
 * Soft-delete (handleDeleteAccount) marks a user `deletedAt` + `hardDeleteAt`
 * and writes a `pending-deletion:{uid}` index entry. After the grace period the
 * scheduled handler calls {@link purgeAccount} for each past-deadline entry.
 *
 * Design:
 * - **Efficient enumeration.** The cron scans the small `pending-deletion:`
 *   index instead of every user record.
 * - **Idempotent + resumable.** Every delete is a no-op if the key is already
 *   gone. The AUTH_KV "anchor" keys (user record, uid index, username, and the
 *   pending-deletion marker) are removed LAST, so a crash mid-purge leaves the
 *   account still enumerable and the next cron run re-purges cleanly. No
 *   separate checkpoint is needed.
 * - **Retention policy (chosen 2026-11).** Published content is also deleted:
 *   the user's bazaar packs, their listings, and their R2 assets are removed,
 *   which breaks installs for other users. See design/CORE-ROADMAP.md
 *   Foundations / R2.
 *
 * Documented residuals (not purged here):
 * - Session / refresh tokens are keyed by token with no per-uid index. They are
 *   already invalidated at soft-delete (passwordChangedAt bump) and expire via
 *   their KV TTLs.
 * - Per-game saves `gamesave:{gameId}:{uid}` are keyed by a uid *suffix*;
 *   finding them needs a full keyspace scan. They are orphaned (small, tied to
 *   a uid that no longer resolves to an account).
 */

import type { Env } from '../index';
import type { UserRecord } from '../types';
import { getAgentByName } from 'agents';
import { buildThreadAgentName } from '../agents/threadRegistry';
import type { OrchestratorAgent } from '../agents/OrchestratorAgent';

const PENDING_DELETION_PREFIX = 'pending-deletion:';

export interface PendingDeletion {
  uid: string;
  email: string;
  hardDeleteAt: number;
}

export function pendingDeletionKey(uid: string): string {
  return `${PENDING_DELETION_PREFIX}${uid}`;
}

/**
 * Record that an account is scheduled for hard deletion. Lets the scheduled
 * purge enumerate pending accounts without scanning all users.
 */
export async function markPendingDeletion(
  env: Env,
  uid: string,
  email: string,
  hardDeleteAt: number,
): Promise<void> {
  const value: PendingDeletion = { uid, email, hardDeleteAt };
  await env.AUTH_KV.put(pendingDeletionKey(uid), JSON.stringify(value));
}

/** Cancel a scheduled deletion (grace-period reactivation). Idempotent. */
export async function clearPendingDeletion(env: Env, uid: string): Promise<void> {
  await env.AUTH_KV.delete(pendingDeletionKey(uid)).catch(() => {});
}

/** List every `pending-deletion:` entry whose deadline has passed. */
export async function listDuePendingDeletions(env: Env, now: number): Promise<PendingDeletion[]> {
  const due: PendingDeletion[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.AUTH_KV.list({ prefix: PENDING_DELETION_PREFIX, cursor });
    for (const key of res.keys) {
      const raw = await env.AUTH_KV.get(key.name);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw) as PendingDeletion;
        if (typeof entry.hardDeleteAt === 'number' && entry.hardDeleteAt <= now) {
          due.push(entry);
        }
      } catch {
        // Malformed marker — drop it so it can't wedge the cron.
        await env.AUTH_KV.delete(key.name).catch(() => {});
      }
    }
    cursor = res.list_complete ? undefined : (res.cursor ?? undefined);
  } while (cursor);
  return due;
}

export interface PurgeResult {
  uid: string;
  r2Deleted: number;
  kvDeleted: number;
  packsDeleted: number;
  completed: boolean;
}

async function deleteR2Prefix(env: Env, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const res = await env.ETERNALOS_FILES.list({ prefix, cursor });
    if (res.objects.length > 0) {
      await Promise.all(res.objects.map((o) => env.ETERNALOS_FILES.delete(o.key)));
      deleted += res.objects.length;
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return deleted;
}

async function listR2Keys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.ETERNALOS_FILES.list({ prefix, cursor });
    for (const o of res.objects) keys.push(o.key);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Hard-delete every store an account occupies. Safe to call repeatedly.
 *
 * Order matters for resumability: the authoritative AUTH_KV records (user,
 * uid, username, pending-deletion marker) are deleted only after every other
 * store has been cleared.
 */
export async function purgeAccount(env: Env, pending: PendingDeletion): Promise<PurgeResult> {
  const { uid, email } = pending;
  let r2Deleted = 0;
  let kvDeleted = 0;
  let packsDeleted = 0;

  // 1. Load the record (for username + oauth provider ids) if it still exists.
  //    A re-run after a partial purge may find it already gone — that's fine.
  let record: UserRecord | null = null;
  const userJson = await env.AUTH_KV.get(`user:${email}`);
  if (userJson) {
    try { record = JSON.parse(userJson) as UserRecord; } catch { record = null; }
  }

  // 2. Owned app registry entries (DESKTOP_KV `app:{appId}`). appIds are derived
  //    from the uid-scoped R2 prefix `apps/{uid}/{appId}/...` before R2 is wiped.
  const appObjectKeys = await listR2Keys(env, `apps/${uid}/`);
  const appIds = new Set<string>();
  for (const key of appObjectKeys) {
    const appId = key.slice(`apps/${uid}/`.length).split('/')[0];
    if (appId) appIds.add(appId);
  }
  for (const appId of appIds) {
    await env.DESKTOP_KV.delete(`app:${appId}`).catch(() => {});
    kvDeleted++;
  }

  // 3. Authored bazaar packs — delete the pack, remove it from its type index,
  //    drop its game-registry mirror, and delete its R2 assets. (Policy: delete
  //    published content.)
  const authorKey = `bazaar:author:${uid}`;
  const authorStr = await env.DESKTOP_KV.get(authorKey);
  if (authorStr) {
    let packIds: string[] = [];
    try { packIds = JSON.parse(authorStr) as string[]; } catch { packIds = []; }
    for (const packId of packIds) {
      const packStr = await env.DESKTOP_KV.get(`bazaar:pack:${packId}`);
      if (packStr) {
        let packType: string | undefined;
        try { packType = (JSON.parse(packStr) as { type?: string }).type; } catch { /* ignore */ }
        if (packType) {
          const typeKey = `bazaar:type:${packType}`;
          const typeStr = await env.DESKTOP_KV.get(typeKey);
          if (typeStr) {
            try {
              const ids = (JSON.parse(typeStr) as string[]).filter((id) => id !== packId);
              await env.DESKTOP_KV.put(typeKey, JSON.stringify(ids));
            } catch { /* ignore */ }
          }
        }
      }
      await env.DESKTOP_KV.delete(`bazaar:pack:${packId}`).catch(() => {});
      await env.DESKTOP_KV.delete(`game:${packId}`).catch(() => {});
      r2Deleted += await deleteR2Prefix(env, `bazaar/${packId}/`);
      packsDeleted++;
    }
    await env.DESKTOP_KV.delete(authorKey).catch(() => {});
    kvDeleted++;
  }

  // 4. Agent chat threads: wipe each per-thread agent DO, then the registry and
  //    any uid-scoped app storage.
  const threadsKey = `agent_threads:${uid}`;
  const threadsStr = await env.DESKTOP_KV.get(threadsKey);
  if (threadsStr) {
    try {
      const threads = JSON.parse(threadsStr) as Array<{ id: string }>;
      for (const thread of threads) {
        try {
          const stub = await getAgentByName<Env, OrchestratorAgent>(
            env.OrchestratorAgent,
            buildThreadAgentName(uid, thread.id),
          );
          await stub.purgeThreadData();
        } catch {
          // Best-effort: an unreachable thread DO is orphaned, not account-visible.
        }
      }
    } catch { /* ignore malformed registry */ }
    await env.DESKTOP_KV.delete(threadsKey).catch(() => {});
    kvDeleted++;
  }

  // 5. Uid-scoped DESKTOP_KV: public snapshot + app storage namespace.
  await env.DESKTOP_KV.delete(`public:${uid}`).catch(() => {});
  kvDeleted++;
  {
    let cursor: string | undefined;
    do {
      const res = await env.DESKTOP_KV.list({ prefix: `app-storage:${uid}:`, cursor });
      for (const key of res.keys) {
        await env.DESKTOP_KV.delete(key.name).catch(() => {});
        kvDeleted++;
      }
      cursor = res.list_complete ? undefined : (res.cursor ?? undefined);
    } while (cursor);
  }

  // 6. UserDesktop DO: wipe all desktop state (items, profile, trash, assets,
  //    css history, guestbook).
  try {
    const doId = env.USER_DESKTOP.idFromName(uid);
    const stub = env.USER_DESKTOP.get(doId);
    await stub.fetch(new Request('http://internal/purge', { method: 'POST' }));
  } catch {
    // If the DO fetch fails the R2 sweep below still removes the bytes; the DO
    // record is uid-named and unreachable without an account.
  }

  // 7. R2: every uid-scoped prefix.
  r2Deleted += await deleteR2Prefix(env, `${uid}/`);
  r2Deleted += await deleteR2Prefix(env, `apps/${uid}/`);
  r2Deleted += await deleteR2Prefix(env, `app-previews/${uid}/`);

  // 8. AUTH_KV anchors — LAST, so a crash before this point is re-purged next run.
  if (record) {
    if (record.username) {
      await env.AUTH_KV.delete(`username:${record.username.toLowerCase()}`).catch(() => {});
      kvDeleted++;
    }
    for (const provider of record.oauthProviders ?? []) {
      if (provider.provider === 'google' && provider.providerId) {
        await env.AUTH_KV.delete(`oauth:google:${provider.providerId}`).catch(() => {});
        kvDeleted++;
      }
    }
  }
  await env.AUTH_KV.delete(`user:${email}`).catch(() => {});
  await env.AUTH_KV.delete(`uid:${uid}`).catch(() => {});
  await env.AUTH_KV.delete(`user_index:${uid}`).catch(() => {});
  kvDeleted += 3;
  // The pending-deletion marker is the very last thing to go.
  await env.AUTH_KV.delete(pendingDeletionKey(uid)).catch(() => {});

  return { uid, r2Deleted, kvDeleted, packsDeleted, completed: true };
}
