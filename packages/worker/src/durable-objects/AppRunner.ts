/**
 * AppRunner — supervisor Durable Object for full-stack app backends.
 *
 * One instance per installed app (`app:{appId}`) or preview
 * (`preview:{previewId}`). It loads the app's compiled bundle into a Dynamic
 * Worker and runs the bundle's `AppBackend` class as a Durable Object Facet:
 *
 *   host route ──RPC──▶ AppRunner (this DO, platform-owned SQLite)
 *                          └─ ctx.facets.get('app') ─▶ AppBackend facet
 *                                                      (app's server.js,
 *                                                       its OWN SQLite)
 *
 * The facet's database is isolated from ours; the app code never sees the
 * supervisor's storage, any DO namespace, or the network beyond its granted
 * outbound hosts (AppOutbound). Desktop access goes through the same
 * grant-enforcing EternalService loopback the iframe bridge uses.
 *
 * Code updates: the facet is keyed to a code id (`app@vN-grantsHash`). When a
 * request arrives for a different code id, the running facet is aborted and
 * restarted on the new class — its SQLite data survives the upgrade.
 *
 * Logs: every backend invocation is tailed (AppLogTail) back into a small
 * ring buffer here so the agent and the owner can see console output and
 * uncaught exceptions from server.js.
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../index';
import type { AppGrantedPermissions } from '../utils/jwt';

export const APP_BACKEND_FACET = 'app';
const APP_BACKEND_CLASS = 'AppBackend';
const BACKEND_COMPAT_DATE = '2026-04-15';
const BACKEND_CPU_MS = 5_000;
const BACKEND_SUBREQUESTS = 50;
const MAX_LOG_ENTRIES = 100;
const MAX_LOG_LINE = 2_000;

export interface AppBackendConfig {
  /** Stable id of the code + grants being served; a change restarts the facet. */
  codeId: string;
  /** R2 prefix holding bundle.json for this release. */
  r2Prefix: string;
  uid: string;
  appId: string;
  granted: AppGrantedPermissions;
  requiresCapability: boolean;
}

export interface AppBackendProbeRequest {
  method: string;
  path: string;
}

export interface AppBackendProbeResult extends AppBackendProbeRequest {
  status: number;
  /** Error text: the backend's { error } body, a crash message, or a timeout. */
  error?: string;
  /** The failure came from the probe sandbox having no network, not the code. */
  networkBlocked?: boolean;
}

const PROBE_FACET = 'probe';
const PROBE_REQUEST_TIMEOUT_MS = 5_000;

export interface AppBackendLogEntry {
  at: number;
  level: string;
  message: string;
}

interface StoredBundle {
  mainModule: string;
  modules: Record<string, string | { js?: string }>;
}

/** A bundle is full-stack when its entry re-exports the AppBackend facet class. */
export function bundleHasBackend(bundle: StoredBundle): boolean {
  const entry = bundle.modules[bundle.mainModule];
  const code = typeof entry === 'string' ? entry : (entry?.js ?? '');
  return /\bexport\s*\{[^}]*\bAppBackend\b[^}]*\}/.test(code) || /\bexport\s+class\s+AppBackend\b/.test(code);
}

type LoopbackExports = {
  EternalService: (init: { props: Record<string, unknown> }) => Fetcher;
  AppOutbound: (init: { props: Record<string, unknown> }) => Fetcher;
  AppLogTail: (init: { props: Record<string, unknown> }) => Fetcher;
};

/** Header the backend wrapper sets with the release (codeId) that served the request. */
const CODE_ID_HEADER = 'x-eternal-code-id';

function stripCodeIdHeader(response: Response): Response {
  if (!response.headers.has(CODE_ID_HEADER)) return response;
  const copy = new Response(response.body, response);
  copy.headers.delete(CODE_ID_HEADER);
  return copy;
}

export class AppRunner extends DurableObject<Env> {
  #loadedCodeId: string | null = null;
  #bundles = new Map<string, StoredBundle | null>();
  #logs: AppBackendLogEntry[] | null = null;

  private get loopback(): LoopbackExports {
    return (this.ctx as unknown as { exports: LoopbackExports }).exports;
  }

  /** Serve one backend request. `request` is already rewritten to the app-relative URL. */
  async handle(request: Request, config: AppBackendConfig): Promise<Response> {
    const bundle = await this.#loadBundle(config);
    if (!bundle) {
      return Response.json({ error: 'App bundle not found' }, { status: 404 });
    }
    if (!bundleHasBackend(bundle)) {
      return Response.json(
        { error: 'This app has no server.js backend — /api/* is reserved for app backends' },
        { status: 404 },
      );
    }

    if (this.#loadedCodeId !== null && this.#loadedCodeId !== config.codeId) {
      // New release or new grants: restart the facet on the new class. Its
      // SQLite database is preserved across the restart.
      this.ctx.facets.abort(APP_BACKEND_FACET, new Error('App backend updated'));
    }
    this.#loadedCodeId = config.codeId;

    const getFacet = () => this.ctx.facets.get(APP_BACKEND_FACET, () => {
      const worker = this.#loadWorker(config, bundle);
      return {
        class: worker.getDurableObjectClass(APP_BACKEND_CLASS, {
          limits: { cpuMs: BACKEND_CPU_MS, subRequests: BACKEND_SUBREQUESTS },
        }),
      };
    });

    try {
      // Keep a copy: if the wrong release answers, the request is replayed.
      const retry = request.clone();
      let response = await getFacet().fetch(request);
      const answeredBy = response.headers.get(CODE_ID_HEADER);
      if (answeredBy && answeredBy !== config.codeId) {
        // abort() + get() can hand back the still-running old instance, and
        // with #loadedCodeId already updated nothing would ever restart it —
        // seen live: an edited server.js kept serving the old code. Restart
        // and replay once on the new release.
        this.ctx.facets.abort(APP_BACKEND_FACET, new Error('Stale app backend release'));
        response = await getFacet().fetch(retry);
      }
      return stripCodeIdHeader(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordLogs([{ at: Date.now(), level: 'error', message: `Backend crashed: ${message}` }]);
      // A crashed facet must not wedge every later request on a dead stub.
      this.ctx.facets.abort(APP_BACKEND_FACET, error);
      this.#loadedCodeId = null;
      return Response.json({ error: `App backend error: ${message}` }, { status: 500 });
    }
  }

  /**
   * Build-time smoke test. Runs a compiled bundle's AppBackend in a fresh
   * facet (empty SQLite, NO network, no desktop grants) and replays the
   * given requests in order, so a backend that crashes on load or on its
   * main routes is caught before install. Call it on a throwaway instance
   * (`probe:{uuid}`); the facet and its database are deleted afterwards.
   */
  async probe(input: {
    bundle: StoredBundle;
    uid: string;
    appId: string;
    requests: AppBackendProbeRequest[];
  }): Promise<AppBackendProbeResult[]> {
    const loopback = this.loopback;
    const worker = this.env.LOADER.load({
      compatibilityDate: BACKEND_COMPAT_DATE,
      mainModule: input.bundle.mainModule,
      modules: input.bundle.modules as Record<string, string>,
      globalOutbound: null,
      env: {
        APP_ID: input.appId,
        ETERNAL: loopback.EternalService({
          props: { uid: input.uid, appId: input.appId, granted: {}, requiresCapability: false },
        }),
      },
    });
    const results: AppBackendProbeResult[] = [];
    try {
      const facet = this.ctx.facets.get(PROBE_FACET, () => ({
        class: worker.getDurableObjectClass(APP_BACKEND_CLASS, {
          limits: { cpuMs: BACKEND_CPU_MS, subRequests: BACKEND_SUBREQUESTS },
        }),
      }));
      for (const probe of input.requests) {
        results.push(await probeOnce(facet, probe));
        // A crashed facet would poison every later request; stop there.
        if (results[results.length - 1].status === 0) break;
      }
    } finally {
      try { this.ctx.facets.delete(PROBE_FACET); } catch { /* never started */ }
    }
    return results;
  }

  /** Recent console output / exceptions from the backend, newest last. */
  async getLogs(limit = 50): Promise<AppBackendLogEntry[]> {
    const logs = await this.#readLogs();
    return logs.slice(-Math.max(1, Math.min(MAX_LOG_ENTRIES, limit)));
  }

  /** Called by AppLogTail after each backend invocation. */
  async recordLogs(entries: AppBackendLogEntry[]): Promise<void> {
    if (!entries.length) return;
    const logs = await this.#readLogs();
    for (const entry of entries) {
      logs.push({
        at: entry.at,
        level: entry.level,
        message: String(entry.message).slice(0, MAX_LOG_LINE),
      });
    }
    const trimmed = logs.slice(-MAX_LOG_ENTRIES);
    this.#logs = trimmed;
    await this.ctx.storage.put('logs', trimmed);
  }

  /** Delete the backend's database and logs (app deleted / account purged). */
  async purge(): Promise<{ purged: true }> {
    // Drops the facet's SQLite database (the app's data).
    this.ctx.facets.delete(APP_BACKEND_FACET);
    this.#loadedCodeId = null;
    this.#bundles.clear();
    this.#logs = [];
    // The supervisor's own storage is just the log buffer. (storage.deleteAll()
    // is avoided: it fails on a supervisor that has hosted facets.)
    await this.ctx.storage.delete('logs');
    return { purged: true };
  }

  async #readLogs(): Promise<AppBackendLogEntry[]> {
    if (!this.#logs) {
      this.#logs = (await this.ctx.storage.get<AppBackendLogEntry[]>('logs')) ?? [];
    }
    return this.#logs;
  }

  async #loadBundle(config: AppBackendConfig): Promise<StoredBundle | null> {
    if (this.#bundles.has(config.codeId)) return this.#bundles.get(config.codeId) ?? null;
    const object = await this.env.ETERNALOS_FILES.get(`${config.r2Prefix}/bundle.json`);
    const bundle = object ? await object.json<StoredBundle>() : null;
    this.#bundles.clear();
    this.#bundles.set(config.codeId, bundle);
    return bundle;
  }

  #loadWorker(config: AppBackendConfig, bundle: StoredBundle): WorkerStub {
    const outbound = config.granted.network?.outbound ?? [];
    const loopback = this.loopback;
    return this.env.LOADER.get(`app-backend:${config.codeId}`, async () => ({
      compatibilityDate: BACKEND_COMPAT_DATE,
      mainModule: bundle.mainModule,
      modules: bundle.modules as Record<string, string>,
      // No outbound grant → no network at all. Otherwise every fetch() is
      // filtered against the granted host list.
      globalOutbound: outbound.length
        ? loopback.AppOutbound({ props: { appId: config.appId, outbound } })
        : null,
      env: {
        APP_ID: config.appId,
        CODE_ID: config.codeId,
        ETERNAL: loopback.EternalService({
          props: {
            uid: config.uid,
            appId: config.appId,
            granted: config.granted,
            requiresCapability: config.requiresCapability,
          },
        }),
      },
      tails: [loopback.AppLogTail({ props: { runner: this.ctx.id.toString() } })],
    }));
  }
}

/**
 * Tail Worker attached to every backend isolate: forwards console output and
 * uncaught exceptions into the owning AppRunner's log ring buffer.
 */
export class AppLogTail extends WorkerEntrypoint<Env> {
  async tail(events: TraceItem[]): Promise<void> {
    const { runner } = (this.ctx as unknown as { props: { runner: string } }).props;
    const entries: AppBackendLogEntry[] = [];
    for (const event of events) {
      for (const log of event.logs ?? []) {
        const parts = Array.isArray(log.message) ? log.message : [log.message];
        entries.push({
          at: log.timestamp,
          level: log.level,
          message: parts.map((part) => (typeof part === 'string' ? part : safeJson(part))).join(' '),
        });
      }
      for (const exception of event.exceptions ?? []) {
        entries.push({ at: exception.timestamp, level: 'error', message: `${exception.name}: ${exception.message}` });
      }
      if (event.outcome && event.outcome !== 'ok' && !(event.exceptions ?? []).length) {
        entries.push({ at: event.eventTimestamp ?? Date.now(), level: 'error', message: `Invocation outcome: ${event.outcome}` });
      }
    }
    if (!entries.length) return;
    const stub = this.env.APP_RUNNER.get(this.env.APP_RUNNER.idFromString(runner));
    await stub.recordLogs(entries);
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Name of the AppRunner instance that serves an installed app or a preview. */
export function appRunnerName(kind: 'app' | 'preview', id: string): string {
  return `${kind}:${id}`;
}

const NETWORK_BLOCKED_PATTERN = /not permitted to access the internet|globalOutbound|network access/i;

async function probeOnce(facet: Fetcher, probe: AppBackendProbeRequest): Promise<AppBackendProbeResult> {
  const request = new Request(`https://app.internal${probe.path}`, { method: probe.method });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      facet.fetch(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${PROBE_REQUEST_TIMEOUT_MS / 1000}s`)), PROBE_REQUEST_TIMEOUT_MS);
      }),
    ]);
    const text = await response.text();
    if (response.status < 500) return { ...probe, status: response.status };
    let error = text.slice(0, 600);
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (body && typeof body.error === 'string') error = body.error;
    } catch { /* plain-text error body */ }
    return { ...probe, status: response.status, error, networkBlocked: NETWORK_BLOCKED_PATTERN.test(error) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ...probe, status: 0, error, networkBlocked: NETWORK_BLOCKED_PATTERN.test(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
