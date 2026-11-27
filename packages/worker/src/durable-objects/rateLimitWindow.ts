/**
 * Fixed-window rate-limit counter (pure; persisted by the RateLimiter DO).
 *
 * Each bucket stores one small record — when its current window started and
 * how many requests it admitted — instead of a log of timestamps. A window
 * opens at the first request after the previous one ended and lasts
 * `windowMs`; within it at most `maxRequests` are admitted.
 */

export interface RateLimitCheck {
  maxRequests: number;
  windowMs: number;
  now: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export interface RateLimitWindow {
  /** Epoch ms the window opened. */
  start: number;
  /** Window length it was opened with (a config change starts a new one). */
  windowMs: number;
  /** Requests admitted in this window. */
  count: number;
}

/** How long after a window ends the DO alarm drops its counter. */
export const RATE_LIMIT_CLEANUP_GRACE_MS = 60_000;

export function rateLimitWindowExpired(window: RateLimitWindow, now: number): boolean {
  return now >= window.start + window.windowMs;
}

/**
 * Apply one check. Returns the window to persist (only meaningful when the
 * request was admitted; a rejection never changes the counter) and the
 * public result.
 */
export function applyRateLimitCheck(
  stored: RateLimitWindow | null,
  check: RateLimitCheck
): { window: RateLimitWindow; result: RateLimitResult } {
  const current: RateLimitWindow =
    stored
    && stored.windowMs === check.windowMs
    && Number.isFinite(stored.start)
    && Number.isFinite(stored.count)
    && !rateLimitWindowExpired(stored, check.now)
      ? stored
      : { start: check.now, windowMs: check.windowMs, count: 0 };

  const resetAt = current.start + current.windowMs;

  if (current.count >= check.maxRequests) {
    return {
      window: current,
      result: {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.max(1, Math.ceil((resetAt - check.now) / 1000)),
      },
    };
  }

  const window = { ...current, count: current.count + 1 };
  return {
    window,
    result: {
      allowed: true,
      remaining: Math.max(0, check.maxRequests - window.count),
      resetAt,
    },
  };
}
