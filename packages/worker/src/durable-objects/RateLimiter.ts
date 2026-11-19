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

interface RateLimitState {
  requests: number[];
}

interface RateLimitCheck {
  maxRequests: number;
  windowMs: number;
  now: number;
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

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
    // other path keeps the legacy per-IP rate-limit check, unchanged.
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
      const windowStart = check.now - check.windowMs;
      const stored = await transaction.get<RateLimitState>('state');
      const validRequests = (stored?.requests ?? []).filter((timestamp) => timestamp > windowStart);

      if (validRequests.length >= check.maxRequests) {
        const oldestInWindow = Math.min(...validRequests);
        const resetAt = oldestInWindow + check.windowMs;
        return {
          allowed: false,
          remaining: 0,
          resetAt,
          retryAfter: Math.max(1, Math.ceil((resetAt - check.now) / 1000)),
        };
      }

      validRequests.push(check.now);
      await transaction.put('state', { requests: validRequests });

      return {
        allowed: true,
        remaining: check.maxRequests - validRequests.length,
        resetAt: Math.min(...validRequests) + check.windowMs,
      };
    });

    if (result.allowed) {
      await this.state.storage.setAlarm(check.now + check.windowMs + 60_000);
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
    // Legacy per-IP rate-limit cleanup (unchanged): the whole state is
    // dropped; the next allowed request re-creates it.
    await this.state.storage.delete('state');

    // AI usage cleanup: reclaim expired slots; once the day has rolled and
    // nothing is in flight, drop the state entirely (the next acquire
    // re-creates it).
    const ai = await this.state.storage.get<AiUsageAccountState>('ai-usage');
    if (!ai) {
      return;
    }
    const now = Date.now();
    const slots = pruneExpiredSlots(ai.slots, now);
    const dayRolled = ai.day !== utcDayOf(now);

    if (slots.length === 0 && dayRolled) {
      await this.state.storage.delete('ai-usage');
      return;
    }

    const next = normalizeAiUsageState({ ...ai, slots }, now);
    await this.state.storage.put('ai-usage', next);
    await this.state.storage.setAlarm(aiUsageCleanupAt(next, now));
  }
}
