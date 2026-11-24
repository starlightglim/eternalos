/**
 * Code Mode approval gate (src/agents/tools/codeModeTools.ts): a run is
 * approval-gated only when its code names a state-changing tool, and
 * state-changing tools refuse to run inside an unapproved run.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { createCodeModeTool, codeNeedsApproval } = await import('../src/agents/tools/codeModeTools.ts');
const { tool } = await import('ai');
const { z } = await import('zod');

const readTool = tool({ description: 'read', inputSchema: z.object({}), execute: async () => ({ apps: [] }) });
const writeTool = tool({
  description: 'write',
  inputSchema: z.object({ method: z.string().optional() }),
  needsApproval: async (input) => (input.method ?? 'GET') !== 'GET',
  execute: async () => ({ ok: true }),
});

describe('codemode approval gate', () => {
  it('flags only code that names a state-changing tool', () => {
    const mutating = ['callAppApi', 'createFolder'];
    assert.equal(codeNeedsApproval('async () => (await apps.listApps()).apps.length', mutating), false);
    assert.equal(codeNeedsApproval('async () => apps.readAppApi({ appId: "a", path: "/api/x" })', mutating), false);
    assert.equal(codeNeedsApproval('async () => apps.callAppApi({ appId: "a", method: "POST", path: "/api/x" })', mutating), true);
    assert.equal(codeNeedsApproval(undefined, mutating), false);
  });

  it('asks for approval per run, not for every run (live: a read-only lookup cost an approval and the turn stalled)', async () => {
    const code = createCodeModeTool({
      loader: /** @type {any} */ ({}),
      apps: { listApps: readTool, callAppApi: writeTool },
      mutating: true,
    });
    assert.equal(typeof code.needsApproval, 'function');
    assert.equal(await code.needsApproval({ code: 'async () => apps.listApps()' }), false);
    assert.equal(await code.needsApproval({ code: 'async () => apps.callAppApi({ appId: "x", method: "POST", path: "/api/e" })' }), true);
  });

  it('never gates a read-only route', () => {
    const code = createCodeModeTool({ loader: /** @type {any} */ ({}), apps: { listApps: readTool }, mutating: false });
    assert.equal(code.needsApproval, undefined);
  });
});
