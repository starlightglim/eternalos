interface RefreshClaim {
  familyId: string;
  accessToken: string;
  now: number;
}

interface RefreshClaimState extends RefreshClaim {
  claimedAt: number;
}

interface LockClaim {
  token: string;
  now: number;
  ttlMs: number;
}

interface LockState extends LockClaim {
  claimedAt: number;
}

export class AuthCoordinator {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }

    const pathname = new URL(request.url).pathname;
    if (pathname === '/claim-lock' || pathname === '/release-lock') {
      return this.handleLockRequest(request, pathname);
    }
    if (pathname !== '/claim-refresh') {
      return new Response('Not found', { status: 404 });
    }

    let claim: RefreshClaim;
    try {
      claim = await request.json() as RefreshClaim;
    } catch {
      return Response.json({ error: 'Invalid refresh claim' }, { status: 400 });
    }

    if (!claim.familyId || !claim.accessToken || !Number.isFinite(claim.now)) {
      return Response.json({ error: 'Invalid refresh claim' }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async (transaction) => {
      const previous = await transaction.get<RefreshClaimState>('refresh-claim');
      if (previous && claim.now - previous.claimedAt < 60_000) {
        return { claimed: false };
      }

      await transaction.put('refresh-claim', {
        ...claim,
        claimedAt: claim.now,
      });
      return { claimed: true };
    });

    if (result.claimed) {
      await this.state.storage.setAlarm(claim.now + 60_000);
    }

    return Response.json(result);
  }

  private async handleLockRequest(request: Request, pathname: string): Promise<Response> {
    let lock: LockClaim;
    try {
      lock = await request.json() as LockClaim;
    } catch {
      return Response.json({ error: 'Invalid lock claim' }, { status: 400 });
    }

    if (!lock.token || !Number.isFinite(lock.now) || !Number.isFinite(lock.ttlMs) || lock.ttlMs < 1) {
      return Response.json({ error: 'Invalid lock claim' }, { status: 400 });
    }

    const result = await this.state.storage.transaction(async (transaction) => {
      const existing = await transaction.get<LockState>('lock');
      if (pathname === '/release-lock') {
        if (existing?.token === lock.token) {
          await transaction.delete('lock');
          return { released: true };
        }
        return { released: false };
      }

      if (existing && lock.now - existing.claimedAt < existing.ttlMs) {
        return { claimed: false };
      }

      await transaction.put('lock', {
        ...lock,
        claimedAt: lock.now,
      });
      return { claimed: true };
    });

    if (pathname === '/claim-lock' && 'claimed' in result && result.claimed) {
      await this.state.storage.setAlarm(lock.now + lock.ttlMs);
    }

    return Response.json(result);
  }

  async alarm(): Promise<void> {
    await this.state.storage.delete('refresh-claim');
  }
}
