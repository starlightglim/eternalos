import {
  applyAiAcquire,
  applyAiSlotRelease,
  applyAiTokenRecord,
  nextUtcMidnight,
  normalizeAiUsageState,
  pruneExpiredSlots,
  utcDayOf,
  type AiUsageAccountState,
  type AiUsageAcquireInput,
  type AiUsageDecision,
} from './aiUsageState';

import {
  RATE_LIMIT_CLEANUP_GRACE_MS,
  applyRateLimitCheck,
  rateLimitWindowExpired,
  type RateLimitCheck,
  type RateLimitResult,
  type RateLimitWindow,
} from './rateLimitWindow';

/** Fixed-window counter for the per-IP / per-user rate-limit buckets. */
const RATE_LIMIT_WINDOW_KEY = 'window';
/**
 * Key of the old sliding-log state (an array of up to maxRequests
 * timestamps). No longer written; dropped by alarm() for buckets created
 * before the fixed-window counter.
 */
const LEGACY_RATE_LIMIT_KEY = 'state';

interface AiTokenRecordRequest {
  now: number;
  tokens: number;
}

interface AiSlotReleaseRequest {
  now: number;
  slotId: string;
}

/**
 * When to wake up and clean the `ai-usage` state: just past the earliest
 * live slot's lease (reclaim crashed-turn slots), or just past the budget
 * day's end (drop the rolled state once nothing is in flight).
 */
function aiUsageCleanupAt(state: AiUsageAccountState, now: number): number {
  if (state.slots.length > 0) {
    return Math.min(...state.slots.map((slot) => slot.expiresAt)) + 60_000;
  }
  return nextUtcMidnight(now) + 60_000;
}

export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Per-account AI usage guard endpoints (see middleware/aiUsage.ts). Any
    // other path is the fixed-window rate-limit check (per IP or per user).
    const pathname = new URL(request.url).pathname;
    if (pathname === '/ai/acquire') {
      return this.handleAiAcquire(request);
    }
    if (pathname === '/ai/record') {
      return this.handleAiRecord(request);
    }
    if (pathname === '/ai/release') {
      return this.handleAiRelease(request);
    }
    return this.handleRateLimitCheck(request);
  }

  private async handleRateLimitCheck(request: Request): Promise<Response> {
    let check: RateLimitCheck;
    try {
      check = await request.json() as RateLimitCheck;
    } catch {
      return Response.json({ error: 'Invalid rate limit request' }, { status: 400 });
    }

    if (
      !Number.isFinite(check.maxRequests) || check.maxRequests < 1
      || !Number.isFinite(check.windowMs) || check.windowMs < 1
      || !Number.isFinite(check.now)
    ) {
      return Response.json({ error: 'Invalid rate limit configuration' }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async (transaction): Promise<RateLimitResult> => {
      const stored = await transaction.get<RateLimitWindow>(RATE_LIMIT_WINDOW_KEY);
      const { window, result } = applyRateLimitCheck(stored ?? null, check);
      // Rejections leave the counter untouched: only admitted requests count.
      if (result.allowed) {
        await transaction.put(RATE_LIMIT_WINDOW_KEY, window);
      }
      return result;
    });

    // Schedule cleanup only when nothing is pending: one alarm per idle
    // bucket instead of a storage write on every request. alarm() re-arms
    // itself while a window is still live.
    if (result.allowed && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(result.resetAt + RATE_LIMIT_CLEANUP_GRACE_MS);
    }

    return Response.json(result);
  }

  /**
   * POST /ai/acquire — atomically check the per-account daily AI budget
   * (and, when `slot` is true, the concurrency cap) and, if admitted,
   * charge one request and hold a lease-backed turn slot.
   */
  private async handleAiAcquire(request: Request): Promise<Response> {
    let input: AiUsageAcquireInput;
    try {
      input = await request.json() as AiUsageAcquireInput;
    } catch {
      return Response.json({ error: 'Invalid AI usage request' }, { status: 400 });
    }

    if (
      !Number.isFinite(input.now)
      || !Number.isFinite(input.requestsPerDay) || input.requestsPerDay < 1
      || !Number.isFinite(input.tokensPerDay) || input.tokensPerDay < 1
      || !Number.isFinite(input.concurrentTurns) || input.concurrentTurns < 1
      || !Number.isFinite(input.turnLeaseMs) || input.turnLeaseMs < 1
      || typeof input.slot !== 'boolean'
    ) {
      return Response.json({ error: 'Invalid AI usage configuration' }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<AiUsageAccountState>('ai-usage');
      const { state, decision } = applyAiAcquire(stored ?? null, input);
      // Persist even on rejection so stale-slot pruning and day rolls land.
      await transaction.put('ai-usage', state);
      return { state, decision };
    });

    // Rejections carry the (possibly stale-pruned) state so the alarm keeps
    // eventual cleanup scheduled.
    await this.state.storage.setAlarm(aiUsageCleanupAt(result.state, input.now));
    const decision: AiUsageDecision = result.decision;
    return Response.json(decision);
  }

  /** POST /ai/record — add provider-reported tokens to today's budget. */
  private async handleAiRecord(request: Request): Promise<Response> {
    let body: AiTokenRecordRequest;
    try {
      body = await request.json() as AiTokenRecordRequest;
    } catch {
      return Response.json({ error: 'Invalid AI usage request' }, { status: 400 });
    }
    if (!Number.isFinite(body.now) || !Number.isFinite(body.tokens)) {
      return Response.json({ error: 'Invalid AI usage request' }, { status: 400 });
    }

    const state = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<AiUsageAccountState>('ai-usage');
      const next = applyAiTokenRecord(stored ?? null, body.now, body.tokens);
      await transaction.put('ai-usage', next);
      return next;
    });

    await this.state.storage.setAlarm(aiUsageCleanupAt(state, body.now));
    return Response.json({ ok: true });
  }

  /** POST /ai/release — release a turn slot (idempotent on unknown ids). */
  private async handleAiRelease(request: Request): Promise<Response> {
    let body: AiSlotReleaseRequest;
    try {
      body = await request.json() as AiSlotReleaseRequest;
    } catch {
      return Response.json({ error: 'Invalid AI usage request' }, { status: 400 });
    }
    if (!Number.isFinite(body.now) || typeof body.slotId !== 'string' || !body.slotId) {
      return Response.json({ error: 'Invalid AI usage request' }, { status: 400 });
    }

    const state = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<AiUsageAccountState>('ai-usage');
      const next = applyAiSlotRelease(stored ?? null, body.now, body.slotId);
      await transaction.put('ai-usage', next);
      return next;
    });

    await this.state.storage.setAlarm(aiUsageCleanupAt(state, body.now));
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    let nextAlarm: number | null = null;

    // Rate-limit cleanup: drop the counter once its window is over (the next
    // request starts a fresh one). If the window is still live — e.g. the
    // alarm was scheduled for an earlier window, or by the AI-usage path —
    // re-arm for just past its end.
    await this.state.storage.delete(LEGACY_RATE_LIMIT_KEY);
    const window = await this.state.storage.get<RateLimitWindow>(RATE_LIMIT_WINDOW_KEY);
    if (window) {
      if (rateLimitWindowExpired(window, now)) {
        await this.state.storage.delete(RATE_LIMIT_WINDOW_KEY);
      } else {
        nextAlarm = window.start + window.windowMs + RATE_LIMIT_CLEANUP_GRACE_MS;
      }
    }

    // AI usage cleanup: reclaim expired slots; once the day has rolled and
    // nothing is in flight, drop the state entirely (the next acquire
    // re-creates it).
    const ai = await this.state.storage.get<AiUsageAccountState>('ai-usage');
    if (ai) {
      const slots = pruneExpiredSlots(ai.slots, now);
      const dayRolled = ai.day !== utcDayOf(now);

      if (slots.length === 0 && dayRolled) {
        await this.state.storage.delete('ai-usage');
      } else {
        const next = normalizeAiUsageState({ ...ai, slots }, now);
        await this.state.storage.put('ai-usage', next);
        const aiAt = aiUsageCleanupAt(next, now);
        nextAlarm = nextAlarm === null ? aiAt : Math.min(nextAlarm, aiAt);
      }
    }

    if (nextAlarm !== null) {
      await this.state.storage.setAlarm(nextAlarm);
    }
  }
}
