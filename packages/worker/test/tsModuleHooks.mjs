/**
 * Node module hooks that let the worker's TypeScript agent sources run under
 * plain `node --test` (no wrangler/miniflare), so the OrchestratorAgent tools
 * and the approval flow can be exercised as real code instead of through an
 * HTTP integration harness that has no AI binding.
 *
 * register() must be called before the first dynamic import of a .ts source;
 * hooks are per-process, so other test files are unaffected.
 *
 * - resolve: the agent sources use extensionless relative imports
 *   (`./tools/appTools`) which Node cannot resolve — map them to the sibling
 *   .ts file.
 * - resolve: `cloudflare:*` modules only exist inside workerd. The agent SDK
 *   imports a few unconditionally (DurableObject / env / WorkflowEntrypoint /
 *   EmailMessage); map them to inert stubs. Only class shapes are needed at
 *   module-evaluation time.
 * - load: `*.wasm` imports (esbuild-wasm) — Node tries to resolve the wasm
 *   module's Go ABI imports ('gojs') as JS packages, which fails outside
 *   workerd. Serve a module that compiles the bytes to a WebAssembly.Module
 *   (compiling never instantiates, so no imports are resolved).
 * - load: esbuild-wasm's browser build is CommonJS; in Node `import * as x`
 *   loses the named functions. Serve a thin ESM facade re-exporting them from
 *   the CJS default (fetched with a query suffix so it bypasses this hook),
 *   and polyfill the workers' `self` global that the main-thread fallback
 *   path dereferences.
 */
import { fileURLToPath } from 'node:url';

const CLOUDFLARE_MODULE_STUBS = {
  'cloudflare:workers': `
// The real workerd DurableObject base class exposes the state and env as
// instance properties; agent SDK subclasses (Agent extends Server extends
// DurableObject) read this.ctx from their constructors, so the stub must
// store them the same way for in-process construction to work.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WorkflowEntrypoint {}
// AppRunner/AppOutbound (full-stack app backends) and @cloudflare/codemode's
// ToolDispatcher extend these; only the class shapes matter here.
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class RpcTarget {}
export const env = new Proxy({}, { get: () => undefined });
`,
  'cloudflare:email': `
export class EmailMessage {}
`,
};

export async function resolve(specifier, context, nextResolve) {
  const stub = CLOUDFLARE_MODULE_STUBS[specifier];
  if (stub !== undefined) {
    return {
      url: `data:text/javascript;base64,${Buffer.from(stub, 'utf8').toString('base64')}`,
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if ((specifier.startsWith('.') || specifier.startsWith('/')) && !specifier.endsWith('.wasm')) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return await nextResolve(candidate, context);
        } catch {
          // keep trying
        }
      }
    }
    throw error;
  }
}

const ESBUILD_BROWSER_PATH = '/node_modules/esbuild-wasm/lib/browser.js';
const ESBUILD_CJS_EXPORTS = [
  'analyzeMetafile',
  'analyzeMetafileSync',
  'build',
  'buildSync',
  'context',
  'formatMessages',
  'formatMessagesSync',
  'initialize',
  'stop',
  'transform',
  'transformSync',
  'version',
];

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.endsWith('.wasm')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: [
        `import { readFileSync } from 'node:fs';`,
        `export default new WebAssembly.Module(readFileSync(${JSON.stringify(fileURLToPath(url))}));`,
      ].join('\n'),
    };
  }
  if (url.startsWith('file:') && url.includes(ESBUILD_BROWSER_PATH) && !url.includes('?')) {
    const names = ESBUILD_CJS_EXPORTS.join(', ');
    return {
      format: 'module',
      shortCircuit: true,
      source: [
        'globalThis.self ??= globalThis;',
        `import cjs from ${JSON.stringify(`${url}?cjs-facade`)};`,
        `const { ${names} } = cjs;`,
        `export default cjs;`,
        `export { ${names} };`,
      ].join('\n'),
    };
  }
  return nextLoad(url, context);
}
