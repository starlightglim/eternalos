/**
 * Pure state machine for per-account AI usage limits.
 *
 * The RateLimiter Durable Object (reused — no new bindings) keeps one
 * `ai-usage` state per account under the DO key `ai-usage:{uid}`; see
 * middleware/aiUsage.ts for the limits, the friendly refusal messages, and
 * the callers. The accounting rules live here so they are unit-testable
 * without a running worker:
 *
 * - Daily budget: `requestsPerDay` requests + `tokensPerDay` tokens per UTC
 *   day. Requests are charged when a turn/analysis is admitted — attempts
 *   count, so provider failures are never silently free — and tokens are
 *   added when the provider reports them.
 * - Concurrency cap: at most `concurrentTurns` in-flight agent turns,
 *   tracked as lease-backed slots. A slot is released when the turn settles
 *   (success, error, or abort). If a turn crashes hard (the agent Durable
 *   Object is evicted mid-stream, so no release call ever happens), the
 *   slot's lease expires and the next acquire reclaims the stale slot.
 *
 * State is normalized on every operation: the UTC day rolls (resetting the
 * budget counters while keeping in-flight slots alive across midnight) and
 * expired slots are pruned.
 */

export interface AiUsageSlot {
  id: string;
  /** Lease expiry (epoch ms). A slot still present past this is stale. */
  expiresAt: number;
}

export interface AiUsageAccountState {
  /** UTC calendar day ('YYYY-MM-DD') the budget counters belong to. */
  day: string;
  requests: number;
  tokens: number;
  slots: AiUsageSlot[];
}

export interface AiUsageAcquireInput {
  now: number;
  requestsPerDay: number;
  tokensPerDay: number;
  concurrentTurns: number;
  turnLeaseMs: number;
  /** Also acquire a concurrency slot (agent turns: true; image analysis: false). */
  slot: boolean;
}

export interface AiUsageGrant {
  allowed: true;
  slotId: string | null;
  remainingRequests: number;
  remainingTokens: number;
  /** When the daily budget resets (next UTC midnight, epoch ms). */
  resetAt: number;
}

export interface AiUsageRejection {
  allowed: false;
  reason: 'budget' | 'concurrency';
  resetAt: number;
  retryAfterSeconds: number;
}

export type AiUsageDecision = AiUsageGrant | AiUsageRejection;

/** UTC calendar day of an epoch-ms timestamp, as 'YYYY-MM-DD'. */
export function utcDayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Next UTC midnight after `now`, as epoch ms. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function emptyAiUsageState(now: number): AiUsageAccountState {
  return { day: utcDayOf(now), requests: 0, tokens: 0, slots: [] };
}

/** Drop slots whose lease has expired (stale cleanup for crashed turns). */
export function pruneExpiredSlots(slots: AiUsageSlot[], now: number): AiUsageSlot[] {
  return slots.filter((slot) => slot.expiresAt > now);
}

/**
 * Normalize stored state for `now`: roll the UTC day (budget counters reset,
 * in-flight slots survive midnight) and prune expired slots.
 */
export function normalizeAiUsageState(
  state: AiUsageAccountState | null,
  now: number,
): AiUsageAccountState {
  const base = state ?? emptyAiUsageState(now);
  const slots = pruneExpiredSlots(base.slots, now);
  if (base.day === utcDayOf(now)) {
    return slots.length === base.slots.length ? base : { ...base, slots };
  }
  return { day: utcDayOf(now), requests: 0, tokens: 0, slots };
}

/**
 * Check the daily budget + concurrency cap against normalized state and, if
 * admitted, charge one request and (optionally) hold a lease-backed slot.
 * Rejections never mutate the budget counters — a refused turn is not an
 * attempt. Returns both the (possibly updated) state and the decision so the
 * caller can persist the normalization even on rejection.
 */
export function applyAiAcquire(
  stored: AiUsageAccountState | null,
  input: AiUsageAcquireInput,
  randomId: () => string = () => crypto.randomUUID(),
): { state: AiUsageAccountState; decision: AiUsageDecision } {
  const state = normalizeAiUsageState(stored, input.now);

  if (state.requests >= input.requestsPerDay || state.tokens >= input.tokensPerDay) {
    const resetAt = nextUtcMidnight(input.now);
    return {
      state,
      decision: {
        allowed: false,
        reason: 'budget',
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - input.now) / 1000)),
      },
    };
  }

  if (input.slot && state.slots.length >= input.concurrentTurns) {
    const resetAt = Math.min(...state.slots.map((slot) => slot.expiresAt));
    return {
      state,
      decision: {
        allowed: false,
        reason: 'concurrency',
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - input.now) / 1000)),
      },
    };
  }

  const slotId = input.slot ? randomId() : null;
  const next: AiUsageAccountState = {
    ...state,
    requests: state.requests + 1,
    slots: input.slot
      ? [...state.slots, { id: slotId as string, expiresAt: input.now + input.turnLeaseMs }]
      : state.slots,
  };

  return {
    state: next,
    decision: {
      allowed: true,
      slotId,
      remainingRequests: Math.max(0, input.requestsPerDay - next.requests),
      remainingTokens: Math.max(0, input.tokensPerDay - next.tokens),
      resetAt: nextUtcMidnight(input.now),
    },
  };
}

/**
 * Add tokens reported by the provider to the current UTC day's budget. A
 * turn that spans midnight lands its tokens in the new day (never
 * under-counts). No-ops on non-positive input.
 */
export function applyAiTokenRecord(
  stored: AiUsageAccountState | null,
  now: number,
  tokens: number,
): AiUsageAccountState {
  const state = normalizeAiUsageState(stored, now);
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return state;
  }
  return { ...state, tokens: state.tokens + Math.floor(tokens) };
}

/**
 * Release a concurrency slot by id. Unknown ids are a no-op, so double
 * release (e.g. the settle path racing a post-crash lease expiry) is safe.
 */
export function applyAiSlotRelease(
  stored: AiUsageAccountState | null,
  now: number,
  slotId: string,
): AiUsageAccountState {
  const state = normalizeAiUsageState(stored, now);
  return { ...state, slots: state.slots.filter((slot) => slot.id !== slotId) };
}
