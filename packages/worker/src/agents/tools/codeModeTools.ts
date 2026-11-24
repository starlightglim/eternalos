/**
 * Code Mode for the OrchestratorAgent.
 *
 * Instead of one model round trip per tool call, the model writes a single
 * async JavaScript function that calls the platform's tools as typed
 * namespaces (`desktop.*`, `apps.*`). @cloudflare/codemode generates the type
 * definitions from the tools' zod schemas, and DynamicWorkerExecutor runs the
 * code in a fresh Dynamic Worker (env.LOADER) with NO network — the only way
 * out of the sandbox is RPC back into these tool functions, which keep their
 * own ownership/permission checks.
 *
 * Good for: batch work over many items (tag/move/summarize every PDF), loops
 * and aggregation, chaining lookups, reading/writing a full-stack app's data
 * through apps.callAppApi, and plain computation.
 *
 * Approval: createCodeTool drops tools marked `needsApproval`, so the
 * mutating variant strips that flag from the inner tools and instead gates
 * the whole code tool behind one approval.
 *
 * Runs are legible and reversible (helpers in codeModeRuns.ts):
 *  - Preview: before asking, the code runs once as a practice ("dry") run —
 *    reads are real, writes are recorded and answered with stand-in results.
 *    The approval card lists the writes in plain language. A practice run
 *    that writes nothing needs no approval at all.
 *  - Steps: a real run streams one line per tool call to the chat as it
 *    happens (data part `data-codemode-steps`, id = tool call id).
 *  - Undo: every successful write records how to reverse it (state read just
 *    before the write); the plan is saved per run and the result card offers
 *    Undo (data part `data-codemode-undo`).
 */

import { createCodeTool } from '@cloudflare/codemode/ai';
import { DynamicWorkerExecutor, type Executor, type ToolProvider } from '@cloudflare/codemode';
import type { Tool } from 'ai';
import { z } from 'zod';
import {
  appPreReadPaths,
  describeAction,
  describeStepResult,
  describeStepStart,
  dryRunResult,
  findRecord,
  planAppInverse,
  planDesktopInverse,
  type DescribeContext,
  type DesktopItemLike,
  type InverseOp,
  type PlannedAction,
  type RunStep,
} from './codeModeRuns';

const CODE_TIMEOUT_MS = 30_000;

type AnyTool = Tool<any, any>;

export interface CodeModeOptions {
  loader: WorkerLoader;
  /** Tools exposed as `desktop.*` in the sandbox. */
  desktop?: Record<string, AnyTool>;
  /** Tools exposed as `apps.*` in the sandbox. */
  apps?: Record<string, AnyTool>;
  /** True when any exposed tool mutates state — gates the code tool behind approval. */
  mutating: boolean;
  /** Writes a UI data part (previews, live steps, undo availability). */
  emit?: (chunk: { type: string; id: string; data: unknown }) => void;
  /** The owner's desktop items: names in previews, and state to undo moves. */
  loadDesktopItems?: () => Promise<DesktopItemLike[]>;
  /** Stores a run's undo plan so the Undo button can apply it later. */
  saveUndo?: (runId: string, plan: UndoRecord) => Promise<void> | void;
  /** Saved routines: the user approved the code when saving it. */
  preApproved?: boolean;
  /** Test seam; defaults to a no-network DynamicWorkerExecutor. */
  executor?: Executor;
}

export interface UndoRecord {
  ops: InverseOp[];
  skipped: string[];
  writes: number;
}

export interface CodePreview {
  ok: boolean;
  actions: PlannedAction[];
  error?: string;
}

const MAX_STEPS_SHOWN = 40;

const DESCRIPTION = `Run JavaScript in an isolated sandbox to get something done in one step.

Use this when a task needs several tool calls, loops over many items, filtering/aggregation, or computation. For a single simple lookup, call the regular tool directly instead.

Available in the sandbox (every call returns a Promise — always await):
{{types}}

Write ONE async arrow function in plain JavaScript (no TypeScript syntax) and return a JSON-serializable result. Never declare a variable named "desktop" or "apps" — that shadows the namespace and crashes the run (write: const list = await apps.listApps(); not: const { apps } = await apps.listApps()). console.log output is returned too. There is no fetch/network, DOM, or npm packages — only the namespaces above plus standard JS (Math, Date, JSON, Array, Map, Intl...).

Examples (results are objects — read the declared Output types above):
async () => {
  const { items } = await desktop.searchDesktop({ query: "invoice" });
  return { count: items.length, names: items.map((i) => i.name) };
}
async () => {
  const list = await apps.listApps();
  const app = list.apps.find((a) => a.name === "Evalog");
  const res = await apps.readAppApi({ appId: app.id, path: "/api/entries" });
  return res.ok ? res.data.length : res;
}`;

/**
 * Output shapes for the sandbox's type declarations. Without them codemode
 * declares every result as `unknown` and the model guesses (seen live:
 * `(await apps.listApps()).find(...)` → "Cannot read properties of undefined
 * (reading 'find')" — listApps returns { apps: [...] }). Attached only to the
 * sandbox copies: the AI SDK re-validates stored chat messages against a real
 * tool's outputSchema, so the chat tools themselves stay schema-free.
 */
const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const backendResult = loose({ status: z.number(), ok: z.boolean(), data: z.unknown().describe('Parsed JSON body (arrays for list routes)') });
const OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  listApps: loose({
    apps: z.array(loose({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      version: z.number(),
      apiRoutes: z.array(z.string()).optional().describe("e.g. 'GET /api/entries'"),
      apiBodyFields: z.array(z.string()).optional(),
    })),
  }),
  getAppSource: loose({
    appId: z.string(),
    name: z.string(),
    files: z.record(z.string(), z.string()),
    syntaxErrors: z.array(loose({ file: z.string(), error: z.string(), line: z.string().optional() })).optional(),
  }),
  readAppApi: backendResult,
  callAppApi: backendResult,
  getAppBackendLogs: loose({ appId: z.string(), logs: z.array(loose({ at: z.number(), level: z.string(), message: z.string() })) }),
  getDesktopOverview: loose({
    totalActiveItems: z.number(),
    counts: z.record(z.string(), z.number()),
    recentItems: z.array(loose({ id: z.string(), name: z.string(), type: z.string(), location: z.string() })),
  }),
  searchDesktop: loose({
    query: z.string(),
    totalMatches: z.number(),
    items: z.array(loose({ id: z.string(), name: z.string(), type: z.string(), location: z.string(), summary: z.string(), matchedIn: z.array(z.string()) })),
  }),
  readTextFile: loose({
    found: z.boolean(),
    id: z.string().optional(),
    name: z.string().optional(),
    content: z.string().optional(),
    message: z.string().optional(),
  }),
};

function prepareForSandbox(tools: Record<string, AnyTool>): Record<string, AnyTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const { needsApproval: _needsApproval, ...rest } = t as AnyTool & { needsApproval?: unknown };
      const outputSchema = OUTPUT_SCHEMAS[name];
      return [name, (outputSchema ? { ...rest, outputSchema } : rest) as AnyTool];
    }),
  );
}

/**
 * Names of tools that change state: every tool that carries needsApproval in
 * its chat form. A run must be approved before it may call any of them.
 */
function mutatingToolNames(...groups: Array<Record<string, AnyTool> | undefined>): string[] {
  return groups.flatMap((group) => Object.entries(group ?? {})
    .filter(([, t]) => Boolean((t as AnyTool & { needsApproval?: unknown }).needsApproval))
    .map(([name]) => name));
}

/** True when the code names a state-changing tool — then the run is approval-gated. */
export function codeNeedsApproval(code: unknown, mutating: readonly string[]): boolean {
  const text = typeof code === 'string' ? code : '';
  return mutating.some((name) => text.includes(name));
}

/** Whether one call changes state (callAppApi only when it is not a GET). */
function isWriteCall(name: string, input: unknown, mutating: readonly string[]): boolean {
  if (!mutating.includes(name)) return false;
  if (name === 'callAppApi') return String((input as { method?: unknown } | undefined)?.method ?? 'GET').toUpperCase() !== 'GET';
  return true;
}

type ExecFn = (input: any, options?: any) => Promise<any>;

interface RunState {
  mode: 'dry' | 'real';
  runId: string;
  approved: boolean;
  steps: RunStep[];
  actions: PlannedAction[];
  undo: UndoRecord;
  changedApps: Set<string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCodeModeTool(options: CodeModeOptions): AnyTool {
  const mutating = options.mutating ? mutatingToolNames(options.desktop, options.apps) : [];
  const rawExec = (group: Record<string, AnyTool> | undefined, name: string): ExecFn | undefined =>
    (group?.[name] as (AnyTool & { execute?: ExecFn }) | undefined)?.execute;

  // Names learned during runs, for plain-language labels.
  const appNames = new Map<string, string>();
  const itemNames = new Map<string, string>();
  const describeCtx: DescribeContext = {
    appName: (id) => appNames.get(id),
    itemName: (id) => itemNames.get(id),
  };
  const learn = (name: string, result: any) => {
    if (name === 'listApps' && Array.isArray(result?.apps)) {
      for (const app of result.apps) if (app?.id && app?.name) appNames.set(app.id, app.name);
    }
    const items = name === 'searchDesktop' ? result?.items : name === 'getDesktopOverview' ? result?.recentItems : null;
    if (Array.isArray(items)) for (const item of items) if (item?.id && item?.name) itemNames.set(item.id, item.name);
  };
  const ensureNames = async (name: string, input: any) => {
    if (typeof input?.appId === 'string' && input.appId && !appNames.has(input.appId)) {
      const listApps = rawExec(options.apps, 'listApps');
      if (listApps) learn('listApps', await listApps({}).catch(() => null));
    }
    if (['moveItems', 'createTextNote', 'createFolder'].includes(name) && options.loadDesktopItems) {
      const ids = [...(Array.isArray(input?.itemIds) ? input.itemIds : []), input?.targetFolderId, input?.folderId]
        .filter((id): id is string => typeof id === 'string');
      if (ids.some((id) => !itemNames.has(id))) {
        const items = await options.loadDesktopItems().catch(() => [] as DesktopItemLike[]);
        for (const item of items) itemNames.set(item.id, item.name);
      }
    }
  };

  // ---- the current run (runs are serialized: one at a time per tool) ----
  let current: RunState | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  };

  const emitSteps = (run: RunState) => {
    if (!options.emit || run.mode !== 'real') return;
    options.emit({
      type: 'data-codemode-steps',
      id: run.runId,
      data: {
        steps: run.steps.slice(-MAX_STEPS_SHOWN),
        total: run.steps.length,
        done: run.steps.filter((s) => s.status === 'done').length,
        failed: run.steps.filter((s) => s.status === 'error').length,
      },
    });
  };

  /** State read just before a write, so the write can be undone. */
  const captureBefore = async (name: string, input: any): Promise<unknown> => {
    if (name === 'callAppApi') {
      const target = appPreReadPaths(String(input?.method ?? 'GET'), String(input?.path ?? '/'));
      const read = rawExec(options.apps, 'readAppApi') ?? rawExec(options.apps, 'callAppApi');
      if (!target || !read) return null;
      const get = (path: string) => read({ appId: input.appId, path, method: 'GET' }).catch(() => null);
      const single = await get(target.itemPath);
      const fromSingle = single?.ok ? findRecord(single.data, target.id) : null;
      if (fromSingle) return fromSingle;
      if (target.collection === target.itemPath) return null;
      const list = await get(target.collection);
      return list?.ok ? findRecord(list.data, target.id) : null;
    }
    if ((name === 'moveItems' || name === 'createFolder') && options.loadDesktopItems) {
      return options.loadDesktopItems().catch(() => null);
    }
    return null;
  };

  const instrument = (group: Record<string, AnyTool>): Record<string, AnyTool> =>
    Object.fromEntries(Object.entries(group).map(([name, t]) => {
      const execute = (t as AnyTool & { execute?: ExecFn }).execute;
      if (!execute) return [name, t];
      const wrapped: ExecFn = async (input, toolOptions) => {
        const run = current;
        const write = isWriteCall(name, input, mutating);
        if (!run) return execute(input, toolOptions);

        if (run.mode === 'dry') {
          if (!write) {
            const result = await execute(input, toolOptions);
            learn(name, result);
            return result;
          }
          await ensureNames(name, input);
          run.actions.push(describeAction(name, input, describeCtx));
          return dryRunResult(name, input);
        }

        if (write && !run.approved) {
          throw new Error(`${name} changes data, so it needs the user's approval: call it in a run whose code names ${name} directly.`);
        }
        await ensureNames(name, input);
        const step: RunStep = {
          id: run.steps.length + 1,
          tool: name,
          label: describeStepStart(name, input, write, describeCtx),
          status: 'running',
          write,
        };
        run.steps.push(step);
        emitSteps(run);
        try {
          const before = write ? await captureBefore(name, input) : null;
          const result = await execute(input, toolOptions);
          learn(name, result);
          if (write) {
            const failed = (result as { ok?: unknown } | undefined)?.ok === false;
            if (name === 'callAppApi' && !failed) run.changedApps.add(input.appId);
            if (!failed) run.undo.writes += 1;
            const plan = name === 'callAppApi'
              ? planAppInverse(input, result, before as Record<string, unknown> | null, describeCtx)
              : planDesktopInverse(name, input, result, before as DesktopItemLike[] | null);
            if (plan && 'op' in plan) run.undo.ops.push(plan.op);
            else if (plan) run.undo.skipped.push(plan.skipped);
          }
          step.status = (result as { ok?: unknown } | undefined)?.ok === false ? 'error' : 'done';
          step.detail = describeStepResult(name, result);
          emitSteps(run);
          return result;
        } catch (error) {
          step.status = 'error';
          step.detail = errorMessage(error).slice(0, 200);
          emitSteps(run);
          throw error;
        }
      };
      return [name, { ...t, execute: wrapped } as AnyTool];
    }));

  const providers: ToolProvider[] = [];
  if (options.desktop && Object.keys(options.desktop).length) {
    providers.push({ name: 'desktop', tools: prepareForSandbox(instrument(options.desktop)) as never });
  }
  if (options.apps && Object.keys(options.apps).length) {
    providers.push({ name: 'apps', tools: prepareForSandbox(instrument(options.apps)) as never });
  }

  const executor = options.executor ?? new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: CODE_TIMEOUT_MS,
    globalOutbound: null,
  });

  const codeTool = createCodeTool({
    tools: providers,
    executor,
    description: DESCRIPTION,
  }) as AnyTool & { execute: ExecFn };
  const innerExecute = codeTool.execute;

  const newRun = (mode: RunState['mode'], runId: string, approved: boolean): RunState => ({
    mode,
    runId,
    approved,
    steps: [],
    actions: [],
    undo: { ops: [], skipped: [], writes: 0 },
    changedApps: new Set(),
  });

  /** Practice run: real reads, recorded writes. Never changes anything. */
  const preview = (input: { code?: unknown }, runId: string): Promise<CodePreview> => serialize(async () => {
    const run = newRun('dry', runId, false);
    current = run;
    try {
      await innerExecute(input, { toolCallId: runId, messages: [] });
      return { ok: true, actions: run.actions };
    } catch (error) {
      return { ok: false, actions: run.actions, error: errorMessage(error).slice(0, 300) };
    } finally {
      current = null;
    }
  });

  // Runs whose practice run wrote nothing were not shown to the user, so
  // they stay unapproved: their writes are refused if the code diverges.
  const unapprovedRuns = new Set<string>();

  const trackedTool = {
    ...codeTool,
    execute: (input: { code?: unknown }, toolOptions?: { toolCallId?: string }) => serialize(async () => {
      const runId = toolOptions?.toolCallId ?? crypto.randomUUID();
      // The SDK only reaches execute for a gated run after the user approved
      // it (in a later request, so no state from needsApproval survives) —
      // "needed approval" here means "was approved".
      const approved = Boolean(options.preApproved)
        || (!unapprovedRuns.has(runId) && codeNeedsApproval(input?.code, mutating));
      const run = newRun('real', runId, approved);
      current = run;
      try {
        const output = await innerExecute(input, toolOptions);
        return {
          ...output,
          ...(run.changedApps.size ? { changedApps: [...run.changedApps] } : {}),
          ...(run.undo.ops.length ? { undoAvailable: true } : {}),
        };
      } finally {
        current = null;
        emitSteps(run);
        if (run.undo.writes > 0) {
          if (run.undo.ops.length) await options.saveUndo?.(runId, run.undo);
          options.emit?.({
            type: 'data-codemode-undo',
            id: runId,
            data: {
              runId,
              available: run.undo.ops.length > 0,
              writes: run.undo.writes,
              steps: run.undo.ops.map((op) => op.summary),
              skipped: run.undo.skipped,
              changedApps: [...run.changedApps],
            },
          });
        }
      }
    }),
  } as AnyTool;

  if (!mutating.length || options.preApproved) return trackedTool;
  return {
    ...trackedTool,
    // Read-only runs (lookups, counting, reading app data) cost no approval.
    // A run that names a state-changing tool first runs as a practice run;
    // the approval card then lists exactly what it would change.
    needsApproval: async (input: { code?: unknown }, approvalOptions?: { toolCallId?: string }) => {
      if (!codeNeedsApproval(input?.code, mutating)) return false;
      const runId = approvalOptions?.toolCallId ?? crypto.randomUUID();
      const result = await preview(input, runId);
      options.emit?.({ type: 'data-codemode-preview', id: runId, data: result });
      if (result.ok && result.actions.length === 0) {
        unapprovedRuns.add(runId);
        return false;
      }
      return true;
    },
  } as AnyTool;
}
