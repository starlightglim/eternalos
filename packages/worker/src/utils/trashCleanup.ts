/**
 * Daily trash cleanup (the scheduled handler's first job).
 *
 * Kept out of index.ts so it can be exercised with fakes under plain
 * `node --test`: only the bindings it touches are typed here.
 */

/** R2's multi-key delete accepts at most 1000 keys per call. */
export const R2_DELETE_BATCH = 1000;

/** Delete R2 keys in as few calls as possible (chunks of up to 1000). */
export async function deleteR2Keys(
  bucket: { delete(keys: string | string[]): Promise<void> },
  keys: string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
  }
}

export interface TrashCleanupEnv {
  AUTH_KV: {
    list(options: { prefix: string; cursor?: string }): Promise<{
      keys: Array<{ name: string }>;
      list_complete: boolean;
      cursor?: string;
    }>;
  };
  USER_DESKTOP: {
    idFromName(name: string): unknown;
    get(id: never): { fetch(request: Request): Promise<Response> };
  };
  ETERNALOS_FILES: { delete(keys: string | string[]): Promise<void> };
}

export interface TrashCleanupSummary {
  users: number;
  itemsDeleted: number;
  r2Deleted: number;
  failures: number;
}

// Workers have a subrequest limit. Each user costs 1 DO fetch plus one R2
// delete call per 1000 keys, so users are processed in modest batches.
const USER_BATCH = 50;

export async function runTrashCleanup(env: TrashCleanupEnv): Promise<TrashCleanupSummary> {
  // Enumerate all users via per-user index keys (`user_index:{uid}`).
  const userUids: string[] = [];
  let cursor: string | undefined;
  do {
    const listResult = await env.AUTH_KV.list({ prefix: 'user_index:', cursor });
    for (const key of listResult.keys) userUids.push(key.name.slice('user_index:'.length));
    cursor = listResult.list_complete ? undefined : (listResult.cursor ?? undefined);
  } while (cursor);

  const summary: TrashCleanupSummary = { users: userUids.length, itemsDeleted: 0, r2Deleted: 0, failures: 0 };

  for (let i = 0; i < userUids.length; i += USER_BATCH) {
    const batch = userUids.slice(i, i + USER_BATCH);
    const results = await Promise.allSettled(
      batch.map(async (uid) => {
        const stub = env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid) as never);
        const response = await stub.fetch(new Request('http://internal/trash/cleanup', { method: 'POST' }));
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`trash cleanup for ${uid} returned ${response.status}`);
        }
        const result = await response.json() as { deleted?: unknown; r2Keys?: unknown };
        const deleted = typeof result.deleted === 'number' ? result.deleted : 0;
        const r2Keys = Array.isArray(result.r2Keys)
          ? result.r2Keys.filter((key): key is string => typeof key === 'string' && key.length > 0)
          : [];
        if (r2Keys.length > 0) await deleteR2Keys(env.ETERNALOS_FILES, r2Keys);
        return { deleted, r2Deleted: r2Keys.length };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        summary.itemsDeleted += result.value.deleted;
        summary.r2Deleted += result.value.r2Deleted;
      } else {
        summary.failures += 1;
        console.error('Trash cleanup failed for a user:', result.reason);
      }
    }
  }

  return summary;
}
