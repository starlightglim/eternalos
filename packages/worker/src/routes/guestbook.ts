/**
 * Guestbook route
 *
 *   POST /api/guestbook/:ownerUid/:itemId — add a public guestbook entry
 *
 * Auth policy: 'none' (visitors sign). Rate-limit policy: the general API
 * bucket at dispatch, plus two guestbook-specific limits enforced atomically
 * by the RateLimiter Durable Object (one transaction per bucket, so
 * concurrent requests can't both slip through — unlike the KV read-then-write
 * cooldown this replaced):
 *
 *   1. Per visitor: one entry per hour per (owner, widget, client IP). The IP
 *      comes from CF-Connecting-IP (set by Cloudflare, not spoofable at the
 *      edge), falling back to the first X-Forwarded-For hop.
 *   2. Per guestbook: at most GUESTBOOK_MAX_PER_HOUR / GUESTBOOK_MAX_PER_DAY
 *      new entries across ALL visitors. The widget keeps only its newest 100
 *      entries, so without this a visitor rotating IPs could push every real
 *      entry out in minutes. With it, flushing the buffer takes days — time
 *      for the owner to notice. The cost is availability: a flood can make
 *      the guestbook temporarily refuse new (legitimate) entries, which is
 *      the right trade against silently losing existing ones.
 *
 * Both limits run only after the body validates, and the per-visitor limit
 * runs first, so a single client hammering the endpoint burns only its own
 * bucket, never the shared guestbook cap.
 *
 * Slots are taken before the owner's DO write and are not refunded if it
 * fails (missing/non-public widget, DO error): the RateLimiter has no release
 * endpoint, and taking the slot first is what makes the check atomic. A
 * rejected attempt therefore costs the visitor their hourly slot.
 */

import type { Env } from '../index';
import { checkRateLimit, type RateLimitConfig, type RateLimitResult } from '../middleware/rateLimit';
import type { RouteContext } from './router';
import { isAccountSoftDeleted } from './visit';

export const GUESTBOOK_NAME_MAX = 50;
export const GUESTBOOK_MESSAGE_MAX = 500;
export const GUESTBOOK_MAX_PER_HOUR = 10;
export const GUESTBOOK_MAX_PER_DAY = 30;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Route params become DO / rate-limit keys; keep them bounded. */
const MAX_PARAM_LENGTH = 256;

type ValidEntry = { name: string; message: string };

/**
 * Validate a guestbook body. Returns the trimmed entry, or an error message
 * for a 400. Anything that isn't `{ name: string, message: string }` (null,
 * arrays, numbers) is rejected here rather than reaching the DO.
 */
export function validateGuestbookEntry(body: unknown): ValidEntry | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Name and message are required' };
  }
  const { name, message } = body as Record<string, unknown>;
  if (typeof name !== 'string' || typeof message !== 'string') {
    return { error: 'Name and message are required' };
  }
  const trimmedName = name.trim();
  const trimmedMessage = message.trim();
  if (!trimmedName || !trimmedMessage) {
    return { error: 'Name and message are required' };
  }
  if (trimmedName.length > GUESTBOOK_NAME_MAX) {
    return { error: `Name must be ${GUESTBOOK_NAME_MAX} characters or less` };
  }
  if (trimmedMessage.length > GUESTBOOK_MESSAGE_MAX) {
    return { error: `Message must be ${GUESTBOOK_MESSAGE_MAX} characters or less` };
  }
  return { name: trimmedName, message: trimmedMessage };
}

/**
 * Atomic sliding-window check on a shared (non-IP) RateLimiter bucket. Same
 * protocol as `checkRateLimit`, which always keys by client IP; fails closed.
 */
async function checkSharedLimit(
  env: Env,
  key: string,
  maxRequests: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  try {
    const limiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
    const response = await limiter.fetch('https://rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRequests, windowMs, now }),
    });
    if (!response.ok) throw new Error(`Rate limiter returned ${response.status}`);
    return await response.json<RateLimitResult>();
  } catch (error) {
    console.error('Guestbook rate limit error:', error);
    return { allowed: false, remaining: 0, resetAt: now + windowMs, retryAfter: Math.ceil(windowMs / 1000) };
  }
}

function tooMany(error: string, result: RateLimitResult): Response {
  const retryAfter = result.retryAfter ?? Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return Response.json(
    { error, retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}

export async function handleGuestbookSign(c: RouteContext): Promise<Response> {
  const [ownerUid, itemId] = c.params;
  if (!ownerUid || !itemId || ownerUid.length > MAX_PARAM_LENGTH || itemId.length > MAX_PARAM_LENGTH) {
    return Response.json({ error: 'Widget not found' }, { status: 404 });
  }

  // A soft-deleted desktop is gone for visitors (see handleVisit): its
  // guestbook takes no entries, and no rate-limit slot is spent on it.
  if (await isAccountSoftDeleted(c.env, ownerUid)) {
    return Response.json({ error: 'Widget not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await c.request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const entry = validateGuestbookEntry(body);
  if ('error' in entry) {
    return Response.json({ error: entry.error }, { status: 400 });
  }

  const widgetKey = `guestbook:${ownerUid}:${itemId}`;

  // 1. Per visitor (keyed by CF-Connecting-IP inside checkRateLimit).
  const visitorLimit: RateLimitConfig = { maxRequests: 1, windowMs: HOUR_MS, keyPrefix: `${widgetKey}:ip` };
  const visitor = await checkRateLimit(c.request, c.env, visitorLimit);
  if (!visitor.allowed) {
    return tooMany('You can only sign once per hour. Please try again later.', visitor);
  }

  // 2. Per guestbook, across all visitors.
  const hourly = await checkSharedLimit(c.env, `${widgetKey}:all:hour`, GUESTBOOK_MAX_PER_HOUR, HOUR_MS);
  if (!hourly.allowed) {
    return tooMany('This guestbook is getting a lot of entries right now. Please try again later.', hourly);
  }
  const daily = await checkSharedLimit(c.env, `${widgetKey}:all:day`, GUESTBOOK_MAX_PER_DAY, DAY_MS);
  if (!daily.allowed) {
    return tooMany('This guestbook has reached its limit for today. Please try again tomorrow.', daily);
  }

  // Forward to the owner's Durable Object (which re-sanitizes on write).
  const stub = c.env.USER_DESKTOP.get(c.env.USER_DESKTOP.idFromName(ownerUid));
  return stub.fetch(
    new Request(`http://internal/guestbook/${itemId}`, {
      method: 'POST',
      body: JSON.stringify(entry),
    })
  );
}
