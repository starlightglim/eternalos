/**
 * Analytics Routes
 *
 * Optional view tracking for user desktops.
 * Only tracks if the user has analyticsEnabled=true in their profile.
 *
 * - trackVisitAnalytics: Called non-blocking after handleVisit()
 * - handleGetAnalytics: GET /api/analytics - Returns view counts for the authenticated user
 *
 * Storage (DESKTOP_KV):
 *
 *   viewlog:{uid}:{hash}                 dedup marker, one per visitor per day (24h TTL)
 *   views:{uid}:total:s{n}               all-time count, shard n of VIEW_SHARDS
 *   views:{uid}:daily:{date}:s{n}        daily count, shard n (90-day TTL)
 *   views:{uid}:total / :daily:{date}    legacy unsharded keys: still summed
 *                                        on read, never written any more
 *
 * Tradeoff: KV has no atomic increment, so every counter is read-modify-write
 * and two visitors counted at the same moment can lose one increment; a single
 * hot key is also capped at ~1 write/second. Instead of one key per counter,
 * each counted visit goes to one of VIEW_SHARDS keys picked from the visitor's
 * (already computed) hash, so writes, and collisions, spread over VIEW_SHARDS
 * keys and the per-key write rate drops by that factor. Reads sum the shards
 * (all issued in parallel). Counts stay approximate under heavy concurrency;
 * exact counting would need an atomic counter in a Durable Object, which this
 * route deliberately avoids (see isAnalyticsEnabled).
 */

import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import { isAccountSoftDeleted } from './visit';

/** Number of KV shards per counter. Lowering it orphans counts in dropped shards. */
export const VIEW_SHARDS = 4;

const DAILY_TTL_SECONDS = 90 * 86400;

function shardKeys(baseKey: string): string[] {
  const keys = [baseKey]; // legacy unsharded key
  for (let shard = 0; shard < VIEW_SHARDS; shard++) keys.push(`${baseKey}:s${shard}`);
  return keys;
}

async function readCount(env: Env, key: string): Promise<number> {
  const value = parseInt((await env.DESKTOP_KV.get(key)) || '0', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Sum a counter across its legacy key and all shards, in parallel. */
async function readShardedCount(env: Env, baseKey: string): Promise<number> {
  const counts = await Promise.all(shardKeys(baseKey).map((key) => readCount(env, key)));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function incrementKey(
  env: Env,
  key: string,
  options?: KVNamespacePutOptions
): Promise<void> {
  const current = await readCount(env, key);
  await env.DESKTOP_KV.put(key, String(current + 1), options);
}

/**
 * Whether the owner opted in to analytics. Reads the KV copy of the public
 * snapshot (`public:{uid}`, which carries the full profile and which
 * handleVisit has just refreshed on a cache miss), so a visit doesn't wake the
 * owner's Durable Object a second time; the DO is asked only when that copy
 * is missing.
 */
async function isAnalyticsEnabled(env: Env, uid: string): Promise<boolean> {
  const snapshot = await env.DESKTOP_KV.get<{ profile?: { analyticsEnabled?: boolean } | null }>(
    `public:${uid}`,
    'json'
  );
  if (snapshot) return snapshot.profile?.analyticsEnabled === true;

  const stub = env.USER_DESKTOP.get(env.USER_DESKTOP.idFromName(uid));
  const profileRes = await stub.fetch(new Request('http://internal/profile'));
  if (!profileRes.ok) return false;
  const { profile } = await profileRes.json() as { profile?: { analyticsEnabled?: boolean } };
  return profile?.analyticsEnabled === true;
}

/** Client IP for dedup: CF-Connecting-IP first, then the first X-Forwarded-For hop. */
function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
}

/**
 * Track a visit to a user's desktop.
 * Deduplicates by hashed IP + date so refreshes don't inflate counts.
 * Called via ctx.waitUntil() (non-blocking).
 */
export async function trackVisitAnalytics(
  request: Request,
  env: Env,
  uid: string
): Promise<void> {
  try {
    if (!(await isAnalyticsEnabled(env, uid))) return;
    // The visit itself 404s for a soft-deleted account; don't count it.
    if (await isAccountSoftDeleted(env, uid)) return;

    const ip = clientIp(request);
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    // Create a hash of IP + date for dedup (privacy: we don't store raw IP)
    const encoder = new TextEncoder();
    const data = encoder.encode(`${ip}:${today}:${uid}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

    // Check if already counted today
    const dedupeKey = `viewlog:${uid}:${hash}`;
    const existing = await env.DESKTOP_KV.get(dedupeKey);
    if (existing) return; // Already counted

    // Mark as counted (24h TTL)
    await env.DESKTOP_KV.put(dedupeKey, '1', { expirationTtl: 86400 });

    // The hash is uniform, so it doubles as the shard picker.
    const shard = parseInt(hash.slice(0, 2), 16) % VIEW_SHARDS;
    await Promise.all([
      incrementKey(env, `views:${uid}:total:s${shard}`),
      incrementKey(env, `views:${uid}:daily:${today}:s${shard}`, { expirationTtl: DAILY_TTL_SECONDS }),
    ]);
  } catch (error) {
    // Analytics should never break the visit flow
    console.error('Analytics tracking error:', error);
  }
}

/**
 * GET /api/analytics
 * Returns view counts for the authenticated user's desktop:
 * `{ totalViews, dailyViews: [{ date, count }] }`, newest day first.
 */
export async function handleGetAnalytics(
  request: Request,
  env: Env,
  auth: AuthContext
): Promise<Response> {
  try {
    const now = new Date();
    const dates: string[] = [];
    for (let i = 0; i < 30; i++) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() - i);
      dates.push(date.toISOString().slice(0, 10));
    }

    // Every key (5 per counter x 31 counters) is read concurrently.
    const [totalViews, ...dailyCounts] = await Promise.all([
      readShardedCount(env, `views:${auth.uid}:total`),
      ...dates.map((date) => readShardedCount(env, `views:${auth.uid}:daily:${date}`)),
    ]);

    const dailyViews = dates.map((date, i) => ({ date, count: dailyCounts[i] }));
    return Response.json({ totalViews, dailyViews });
  } catch (error) {
    console.error('Analytics fetch error:', error);
    return Response.json(
      { error: 'Failed to fetch analytics' },
      { status: 500 }
    );
  }
}
