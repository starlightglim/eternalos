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

export class RateLimiter {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

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

  async alarm(): Promise<void> {
    await this.state.storage.delete('state');
  }
}
