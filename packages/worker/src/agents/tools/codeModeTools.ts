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

Write ONE async arrow function in plain JavaScript (no TypeScript syntax) and return a JSON-serializable result. console.log output is returned too. There is no fetch/network, DOM, or npm packages — only the namespaces above plus standard JS (Math, Date, JSON, Array, Map, Intl...).

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

export function createCodeModeTool(options: CodeModeOptions): AnyTool {
  const providers: ToolProvider[] = [];
  if (options.desktop && Object.keys(options.desktop).length) {
    providers.push({ name: 'desktop', tools: stripApproval(options.desktop) as never });
  }
  if (options.apps && Object.keys(options.apps).length) {
    providers.push({ name: 'apps', tools: stripApproval(options.apps) as never });
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
  }) as AnyTool;

  return options.mutating ? ({ ...codeTool, needsApproval: true } as AnyTool) : codeTool;
}
