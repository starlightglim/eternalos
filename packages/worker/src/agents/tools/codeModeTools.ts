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

Example:
async () => {
  const { items } = await desktop.searchDesktop({ query: "invoice", limit: 50 });
  const pdfs = items.filter((i) => i.mimeType === "application/pdf");
  return { count: pdfs.length, names: pdfs.map((i) => i.name) };
}`;

function stripApproval(tools: Record<string, AnyTool>): Record<string, AnyTool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const { needsApproval: _needsApproval, ...rest } = t as AnyTool & { needsApproval?: unknown };
      return [name, rest as AnyTool];
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

export function createCodeModeTool(options: CodeModeOptions): AnyTool {
  const providers: ToolProvider[] = [];
  const changedApps = new Set<string>();
  if (options.desktop && Object.keys(options.desktop).length) {
    providers.push({ name: 'desktop', tools: stripApproval(options.desktop) as never });
  }
  if (options.apps && Object.keys(options.apps).length) {
    providers.push({ name: 'apps', tools: stripApproval(trackAppWrites(options.apps, changedApps)) as never });
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
      const output = await innerExecute(...args);
      return changedApps.size ? { ...output, changedApps: [...changedApps] } : output;
    },
  } as AnyTool;

  return options.mutating ? ({ ...trackedTool, needsApproval: true } as AnyTool) : trackedTool;
}
