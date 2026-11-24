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
 * the whole code tool behind one approval (the UI shows the code).
 */

import { createCodeTool } from '@cloudflare/codemode/ai';
import { DynamicWorkerExecutor, type ToolProvider } from '@cloudflare/codemode';
import type { Tool } from 'ai';
import { z } from 'zod';

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
}

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
 * Wrap apps.callAppApi so a run can report which apps' data it changed —
 * the chat uses `changedApps` to refresh those apps' open windows. App ids
 * are usually discovered at runtime (listApps), so the code text alone
 * cannot tell.
 */
function trackAppWrites(apps: Record<string, AnyTool>, changed: Set<string>): Record<string, AnyTool> {
  const callAppApi = apps.callAppApi as (AnyTool & { execute?: (...args: any[]) => Promise<any> }) | undefined;
  if (!callAppApi?.execute) return apps;
  const execute = callAppApi.execute;
  return {
    ...apps,
    callAppApi: {
      ...callAppApi,
      execute: async (input: { appId: string; method?: string }, toolOptions: unknown) => {
        const result = await execute(input, toolOptions);
        if ((input.method ?? 'GET').toUpperCase() !== 'GET' && result?.ok !== false) changed.add(input.appId);
        return result;
      },
    } as AnyTool,
  };
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

/**
 * Runtime half of the gate: in a run that was not approved, state-changing
 * tools refuse to run. The static check above decides whether to ask; this
 * guarantees an unapproved run can never mutate, even if the code reaches a
 * tool without spelling its name (e.g. apps["call" + "AppApi"]).
 */
function guardMutations(
  tools: Record<string, AnyTool>,
  mutating: readonly string[],
  isApproved: () => boolean,
): Record<string, AnyTool> {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => {
    const execute = (t as AnyTool & { execute?: (...args: any[]) => Promise<any> }).execute;
    if (!mutating.includes(name) || !execute) return [name, t];
    return [name, {
      ...t,
      execute: async (...args: any[]) => {
        if (!isApproved()) {
          throw new Error(`${name} changes data, so it needs the user's approval: call it in a run whose code names ${name} directly.`);
        }
        return execute(...args);
      },
    } as AnyTool];
  }));
}

export function createCodeModeTool(options: CodeModeOptions): AnyTool {
  const providers: ToolProvider[] = [];
  const changedApps = new Set<string>();
  const mutating = options.mutating ? mutatingToolNames(options.desktop, options.apps) : [];
  let runApproved = false;
  const isApproved = () => runApproved;
  if (options.desktop && Object.keys(options.desktop).length) {
    providers.push({ name: 'desktop', tools: prepareForSandbox(guardMutations(options.desktop, mutating, isApproved)) as never });
  }
  if (options.apps && Object.keys(options.apps).length) {
    providers.push({
      name: 'apps',
      tools: prepareForSandbox(guardMutations(trackAppWrites(options.apps, changedApps), mutating, isApproved)) as never,
    });
  }

  const executor = new DynamicWorkerExecutor({
    loader: options.loader,
    timeout: CODE_TIMEOUT_MS,
    globalOutbound: null,
  });

  const codeTool = createCodeTool({
    tools: providers,
    executor,
    description: DESCRIPTION,
  }) as AnyTool & { execute: (...args: any[]) => Promise<Record<string, unknown>> };

  const innerExecute = codeTool.execute;
  const trackedTool = {
    ...codeTool,
    execute: async (...args: any[]) => {
      changedApps.clear();
      // The SDK only reaches execute for a gated run after the user approved
      // it, so "needed approval" here means "was approved".
      runApproved = codeNeedsApproval((args[0] as { code?: unknown } | undefined)?.code, mutating);
      try {
        const output = await innerExecute(...args);
        return changedApps.size ? { ...output, changedApps: [...changedApps] } : output;
      } finally {
        runApproved = false;
      }
    },
  } as AnyTool;

  if (!mutating.length) return trackedTool;
  // Read-only runs (lookups, counting, reading app data) no longer cost an
  // approval card: before, every codemode run in the app-build route asked,
  // and a turn that spent its approval on a lookup could end without acting.
  return {
    ...trackedTool,
    needsApproval: async (input: { code?: unknown }) => codeNeedsApproval(input?.code, mutating),
  } as AnyTool;
}
