import type { Env } from '../index';

interface InstallCounter {
  installs: number;
}

interface InstallRequest {
  packId: string;
}

export class BazaarCoordinator {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/increment-install') {
      return new Response('Not found', { status: 404 });
    }

    let payload: InstallRequest;
    try {
      payload = await request.json() as InstallRequest;
    } catch {
      return Response.json({ error: 'Invalid install request' }, { status: 400 });
    }

    if (!payload.packId) {
      return Response.json({ error: 'Invalid install request' }, { status: 400 });
    }

    const packKey = `bazaar:pack:${payload.packId}`;
    const initialPackJson = await this.env.DESKTOP_KV.get(packKey);
    if (!initialPackJson) {
      return Response.json({ error: 'Pack not found' }, { status: 404 });
    }

    let initialPack: { installs?: number };
    try {
      initialPack = JSON.parse(initialPackJson) as { installs?: number };
    } catch {
      return Response.json({ error: 'Pack metadata is invalid' }, { status: 500 });
    }

    const installs = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<InstallCounter>('install-counter');
      const base = stored?.installs ?? initialPack.installs ?? 0;
      const next = base + 1;
      await transaction.put('install-counter', { installs: next });
      return next;
    });

    const latestPackJson = await this.env.DESKTOP_KV.get(packKey);
    if (!latestPackJson) {
      return Response.json({ error: 'Pack not found' }, { status: 404 });
    }

    let pack: Record<string, unknown>;
    try {
      pack = JSON.parse(latestPackJson) as Record<string, unknown>;
    } catch {
      return Response.json({ error: 'Pack metadata is invalid' }, { status: 500 });
    }

    pack.installs = installs;
    pack.updatedAt = Date.now();
    await this.env.DESKTOP_KV.put(packKey, JSON.stringify(pack));

    return Response.json({ pack });
  }
}
