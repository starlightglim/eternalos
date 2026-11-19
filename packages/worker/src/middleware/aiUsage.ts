/**
 * Per-account AI usage controls (Workstream 4, item 3).
 *
 * Every AI-backed surface an account can drive checks a per-account guard
 * before calling the provider:
 *
 *   - agent chat turns (OrchestratorAgent.onChatMessage) — app builds ride
 *     inside a turn (they execute as tools within it), so the turn-level
 *     cap covers builds too;
 *   - image metadata analysis (POST /api/desktop/items/:id/analyze).
 *
 * The guard state lives in the existing RATE_LIMITER Durable Object — one
 * DO instance per account under the key `ai-usage:{uid}` (the same
 * binding/pattern the per-IP limiter uses; no new wrangler.toml bindings) —
 * and enforces:
 *
 *   1. a daily usage budget: N requests per UTC day, plus tokens when the
 *      provider reports usage (Workers AI models expose prompt/completion
 *      token counts via the AI SDK's finish events);
 *   2. a concurrency cap: at most N in-flight agent turns per account, each
 *      holding a lease-backed slot that is released when the turn settles
 *      and reclaimed by lease expiry if the turn crashes hard.
 *
 * Enforcement degrades legibly. The WS chat transport has no HTTP status,
 * so refusals are written into the chat stream as a clear error part (with
 * the underlying Response carrying the matching 429); the analyze route
 * answers a plain HTTP 429 with a friendly JSON message. Provider failures
 * (binding errors, timeouts) map to a legible message via
 * {@link legibleAiErrorMessage} so the client never sees raw internals.
 *
 * Limits are constants with sensible defaults, overridable through env
 * vars (see {@link resolveAiUsageLimits}); the integration suite sets
 * AI_REQUESTS_PER_DAY low to exercise exhaustion quickly.
 */

import type { AiUsageDecision, AiUsageGrant } from '../durable-objects/aiUsageState';
import type { Env } from '../index';

/** Durable Object key prefix for per-account AI usage state. */
const AI_USAGE_KEY_PREFIX = 'ai-usage';

// ---------------------------------------------------------------------------
// Configurable limits
// ---------------------------------------------------------------------------

/**
 * Default per-account AI limits. Deliberately generous for a human user but
 * bounded: an account scripting the chat surface cannot exhaust the AI
 * budget or pin the OrchestratorAgent Durable Object with parallel turns.
 */
export const AI_USAGE_DEFAULTS = {
  /** AI requests (chat turns + image analyses) per account per UTC day. */
  requestsPerDay: 200,
  /** Total tokens per account per UTC day, when the provider reports them. */
  tokensPerDay: 2_000_000,
  /** Simultaneous in-flight agent turns per account. */
  concurrentTurns: 2,
  /**
   * Turn-slot lease. A slot is released when the turn settles; if the
   * Durable Object dies mid-turn (no release call), the slot is reclaimed
   * when this lease expires. Must comfortably exceed a legitimate turn
   * (multi-step tool runs included).
   */
  turnLeaseMs: 10 * 60_000,
} as const;

export interface AiUsageLimits {
  requestsPerDay: number;
  tokensPerDay: number;
  concurrentTurns: number;
  turnLeaseMs: number;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

/**
 * Resolve the per-account AI limits from env overrides
 * (AI_REQUESTS_PER_DAY / AI_TOKENS_PER_DAY / AI_CONCURRENT_TURNS /
 * AI_TURN_LEASE_MS), falling back to {@link AI_USAGE_DEFAULTS} for unset or
 * invalid values.
 */
export function resolveAiUsageLimits(env: Env): AiUsageLimits {
  return {
    requestsPerDay: parsePositiveInt(env.AI_REQUESTS_PER_DAY, AI_USAGE_DEFAULTS.requestsPerDay),
    tokensPerDay: parsePositiveInt(env.AI_TOKENS_PER_DAY, AI_USAGE_DEFAULTS.tokensPerDay),
    concurrentTurns: parsePositiveInt(env.AI_CONCURRENT_TURNS, AI_USAGE_DEFAULTS.concurrentTurns),
    turnLeaseMs: parsePositiveInt(env.AI_TURN_LEASE_MS, AI_USAGE_DEFAULTS.turnLeaseMs),
  };
}

// ---------------------------------------------------------------------------
// Guard client
// ---------------------------------------------------------------------------

export interface AiTurnGrant extends AiUsageGrant {
  allowed: true;
}

export interface AiTurnRejection {
  allowed: false;
  reason: 'budget' | 'concurrency';
  resetAt: number;
  retryAfterSeconds: number;
  /** Legible, user-facing refusal text (see the module comment). */
  message: string;
}

export type AiTurnDecision = AiTurnGrant | AiTurnRejection;

async function callAiGuard<T>(
  env: Env,
  uid: string,
  path: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const guardId = env.RATE_LIMITER.idFromName(`${AI_USAGE_KEY_PREFIX}:${uid}`);
  const guard = env.RATE_LIMITER.get(guardId);
  const response = await guard.fetch(`https://rate-limit${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`AI usage guard returned ${response.status}`);
  }
  return response.json<T>();
}

/**
 * Charge one AI request against the account's daily budget and, when
 * `options.slot` is not false, acquire an in-flight turn slot. Rejections
 * carry a friendly message; a guard outage throws (fail closed, like the
 * per-IP limiter) so callers can degrade legibly instead of running unbounded.
 */
export async function acquireAiRequest(
  env: Env,
  uid: string,
  options: { slot?: boolean } = {},
): Promise<AiTurnDecision> {
  const limits = resolveAiUsageLimits(env);
  const decision = await callAiGuard<AiUsageDecision>(env, uid, '/ai/acquire', {
    now: Date.now(),
    requestsPerDay: limits.requestsPerDay,
    tokensPerDay: limits.tokensPerDay,
    concurrentTurns: limits.concurrentTurns,
    turnLeaseMs: limits.turnLeaseMs,
    slot: options.slot !== false,
  });

  if (decision.allowed) {
    return decision;
  }
  return {
    ...decision,
    message: decision.reason === 'budget'
      ? budgetExhaustedMessage(limits, decision)
      : concurrencyCapMessage(limits),
  };
}

/**
 * Add provider-reported tokens to the account's daily budget. Callers pass
 * the summed prompt + completion tokens from the AI SDK finish event; only
 * positive values are recorded.
 */
export async function recordAiUsageTokens(env: Env, uid: string, tokens: number): Promise<void> {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return;
  }
  await callAiGuard(env, uid, '/ai/record', { now: Date.now(), tokens: Math.floor(tokens) });
}

/** Release an in-flight turn slot (idempotent on unknown slot ids). */
export async function releaseAiTurnSlot(env: Env, uid: string, slotId: string): Promise<void> {
  await callAiGuard(env, uid, '/ai/release', { now: Date.now(), slotId });
}

// ---------------------------------------------------------------------------
// Legible degradation
// ---------------------------------------------------------------------------

function formatDuration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0
    ? `about ${hours}h ${rest}m`
    : `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

function budgetExhaustedMessage(
  limits: AiUsageLimits,
  rejection: { resetAt: number; retryAfterSeconds: number },
): string {
  const resetTime = new Date(rejection.resetAt).toISOString().slice(11, 16);
  return (
    `Daily AI limit reached — you've used all ${limits.requestsPerDay} AI requests available `
    + `to your account today. The budget resets automatically in ${formatDuration(rejection.retryAfterSeconds)} `
    + `(at ${resetTime} UTC), so please try again then.`
  );
}

function concurrencyCapMessage(limits: AiUsageLimits): string {
  return (
    `You can run up to ${limits.concurrentTurns} Eternal request${limits.concurrentTurns === 1 ? '' : 's'} `
    + `at once, and one is still finishing. Please wait for it to complete and try again — if the running `
    + `one crashed, its slot clears automatically within a few minutes.`
  );
}

/**
 * Map a provider failure (AI binding error, timeout, abort) to a clear,
 * legible chat message. Never surfaces raw internals: the user always gets
 * a sentence explaining what happened and what to do next. The underlying
 * error is logged by the caller (server-side observability), not leaked
 * into the chat stream.
 */
export function legibleAiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);

  if (error instanceof Error && error.name === 'AbortError' || /\babort(ed)?\b/i.test(raw)) {
    return "The response was stopped before it finished — nothing was saved from this attempt. You can send the message again.";
  }
  if (/timed?[- ]?out|timeout|deadline|exceeded the time|duration.*exceeded/i.test(raw)) {
    return "Eternal's AI service took too long to answer. Please try again in a moment.";
  }
  // Covers missing/misconfigured bindings, unreachable model endpoints, and
  // every other unexpected provider fault with one honest, actionable line.
  return "Eternal's AI service is unavailable right now. Please try again shortly.";
}

/** Guard-control-plane failure: distinct from a provider failure. */
export function aiGuardUnavailableMessage(): string {
  return (
    "Eternal's usage monitor is momentarily unavailable, so new AI requests are paused "
    + 'to avoid runaway usage. Please try again shortly.'
  );
}
