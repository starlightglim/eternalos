/**
 * Unit tests for the OrchestratorAgent tools (appTools, desktopTools,
 * memoryTools) and the mutation approval flow.
 *
 * These run under plain `node --test` (same script as the integration suite,
 * see package.json) by importing the real TypeScript sources through
 * test/tsModuleHooks.mjs — no wrangler boot, and the fake Workers AI binding
 * is stubbed locally per harness.
 *
 * What is covered, per the acceptance criteria:
 *
 * 1. Each tool's happy path and its main failure paths (missing item,
 *    permission denied, bad input) produce a clear result. At the tool level
 *    a failure rejects with a specific Error; the pipeline tests prove those
 *    throws never kill the stream — the AI SDK converts them into
 *    `tool-output-error` chunks and the model keeps responding.
 * 2. Approval rejection never half-applies a mutation: the tool's execute
 *    never runs, nothing is written, and the persisted thread records the
 *    denial (tool part state `output-denied`, `approval.approved: false`).
 * 3. Approval acceptance applies exactly once, even if the approval frame is
 *    delivered twice — the real `AIChatAgent#_applyToolApproval` no-ops the
 *    duplicate (state no longer matches), and even a duplicated continuation
 *    is idempotent (the recorded tool result suppresses re-execution).
 * 4. A tool error mid-turn leaves the thread consistent: the turn completes,
 *    the error is recorded on the tool part, and the next turn still works.
 *
 * The turn harness mirrors what @cloudflare/ai-chat actually does between
 * turns (see its dist/index.js): `_applyToolApproval` rewrites the persisted
 * tool part, and `_streamSSEReply` reconciles orphan tool-output chunks (for
 * a toolCallId owned by an earlier message) back onto that message.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

register(new URL('./tsModuleHooks.mjs', import.meta.url));

const { OrchestratorAgent } = await import('../src/agents/OrchestratorAgent.ts');
const { createDesktopTools } = await import('../src/agents/tools/desktopTools.ts');
const { createMemoryTools } = await import('../src/agents/tools/memoryTools.ts');
const { createAppTools, initAppRegistry, generatedAppFilesSchema, parseFileBlocks, noReasoningInputsFor } = await import('../src/agents/tools/appTools.ts');
const {
  listAppRevisionManifests,
  readAppRevision,
} = await import('../src/routes/appRevisions.ts');
const {
  appSpecSchema,
  derivePermissionsFromSpec,
  validateAppSpec,
} = await import('../src/agents/tools/appSpec.ts');
const {
  AppValidationError,
  collectAppBundleIssues,
} = await import('../src/utils/appBundleValidation.ts');
const {
  handleAppPermissions,
  handleAppRollback,
} = await import('../src/routes/apps.ts');
const { AIChatAgent } = await import('@cloudflare/ai-chat');
const { z } = await import('zod');

const UID = 'user-abc123';
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_ROOT = path.join(TEST_ROOT, 'test', 'fixtures', 'apps');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function createFakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    keys() {
      return [...store.keys()];
    },
  };
}

function createFakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) {
      objects.set(key, String(value));
    },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        key,
        text: async () => value,
        json: async () => JSON.parse(value),
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key })), truncated: false, cursor: undefined };
    },
    keys(prefix = '') {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
  };
}

/**
 * In-memory UserDesktop Durable Object stub that mirrors the internal
 * `http://internal/items` API used by the tools (GET snapshot, POST create,
 * PATCH batch update). `state.fail.{get,post,patch}` injects failures.
 */
function createFakeDesktop({ items = [], profile = null } = {}) {
  const state = {
    items: new Map(items.map((item) => [item.id, { ...item }])),
    profile,
    fail: { get: null, post: null, patch: null },
  };
  const requests = [];

  const stub = {
    async fetch(request) {
      const url = new URL(request.url);
      const method = request.method;
      requests.push({ method, path: url.pathname });

      // `state.fail.{get,post,patch}` injects failures: a number fails
      // every matching request; a function is consulted per request and
      // fails only while it returns a status (lets a test fail one PATCH —
      // e.g. the createFolder move — but not the cleanup that follows).
      if (url.pathname === '/items') {
        const injected = state.fail[method.toLowerCase()];
        const status = typeof injected === 'function' ? injected() : injected;
        if (status) {
          return new Response('injected failure', { status });
        }
      }

      if (url.pathname === '/items' && method === 'GET') {
        return Response.json({ items: [...state.items.values()], profile: state.profile, windows: [] });
      }
      if (url.pathname === '/items' && method === 'POST') {
        const body = await request.json();
        const item = {
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          ...body,
        };
        state.items.set(item.id, item);
        return Response.json(item);
      }
      if (url.pathname === '/items' && method === 'PATCH') {
        const patches = await request.json();
        const updated = [];
        for (const { id, updates } of patches) {
          const item = state.items.get(id);
          if (!item) continue;
          const next = { ...item, ...updates, updatedAt: Date.now() };
          state.items.set(id, next);
          updated.push(next);
        }
        return Response.json(updated);
      }
      return new Response('not found', { status: 404 });
    },
  };

  const mutations = () => requests.filter((r) => r.method !== 'GET');
  const itemsOf = (type) => [...state.items.values()].filter((i) => i.type === type && !i.isTrashed);

  return {
    stub,
    state,
    requests,
    mutations,
    itemsOf,
    get: (id) => state.items.get(id),
  };
}

/** Failure injector for the fake desktop: fails only the first matching request. */
const failOnce = (status) => {
  let pending = true;
  return () => {
    if (!pending) return 0;
    pending = false;
    return status;
  };
};

/** Workers AI binding stub: scripted model responses, recording every call. */
function createFakeAiBinding() {
  const calls = [];
  const script = [];
  return {
    calls,
    script,
    async run(model, inputs) {
      calls.push({ model, inputs });
      const next = script.shift();
      if (next === undefined) {
        throw new Error('fake AI binding ran out of scripted responses');
      }
      return typeof next === 'function' ? next(inputs) : next;
    },
  };
}

const modelText = (text) => ({
  choices: [{ message: { content: text }, finish_reason: 'stop' }],
});

const modelToolCall = (id, name, args) => ({
  choices: [{
    message: {
      content: '',
      tool_calls: [{
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
    finish_reason: 'tool_calls',
  }],
});

const fakeSql = () => {
  const statements = [];
  return {
    statements,
    exec(query, ...params) {
      statements.push({ query: String(query), params });
      return [];
    },
  };
};

/**
 * Source files of an app fixture directory (manifest.json/expect.json are
 * fixture metadata, not app files).
 */
function readFixtureFiles(name) {
  const dir = path.join(FIXTURES_ROOT, name);
  const files = {};
  for (const entry of fs.readdirSync(dir)) {
    if (entry === 'manifest.json' || entry === 'expect.json') continue;
    files[entry] = fs.readFileSync(path.join(dir, entry), 'utf8');
  }
  return files;
}

// ---------------------------------------------------------------------------
// Turn harness — drives the real OrchestratorAgent.onChatMessage pipeline
// ---------------------------------------------------------------------------

/**
 * Reconstructs an assistant UIMessage from a turn's UI stream chunks,
 * tolerantly — mirroring @cloudflare/ai-chat's message-builder: tool-output
 * chunks for a toolCallId that lives in an earlier message are returned as
 * orphans for the caller to reconcile onto the owning message (exactly what
 * AIChatAgent#_streamSSEReply does).
 */
function buildMessageFromChunks(chunks) {
  const message = { id: 'assistant', role: 'assistant', parts: [] };
  const orphanToolOutputs = [];
  const errors = [];
  const dataParts = [];
  const findToolPart = (id) => message.parts.find((p) => p.toolCallId === id);

  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'start':
        if (chunk.messageId) message.id = chunk.messageId;
        break;
      case 'start-step':
        message.parts.push({ type: 'step-start' });
        break;
      case 'text-start':
        message.parts.push({ type: 'text', text: '', state: 'streaming' });
        break;
      case 'text-delta': {
        const last = [...message.parts].reverse().find((p) => p.type === 'text');
        if (last) last.text += chunk.delta ?? '';
        else message.parts.push({ type: 'text', text: chunk.delta ?? '', state: 'streaming' });
        break;
      }
      case 'text-end': {
        const last = [...message.parts].reverse().find((p) => p.type === 'text');
        if (last) last.state = 'done';
        break;
      }
      case 'tool-input-available': {
        const existing = findToolPart(chunk.toolCallId);
        if (existing) {
          existing.state = 'input-available';
          existing.input = chunk.input;
        } else {
          message.parts.push({
            type: `tool-${chunk.toolName}`,
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            state: 'input-available',
            input: chunk.input,
          });
        }
        break;
      }
      case 'tool-input-error': {
        const existing = findToolPart(chunk.toolCallId);
        if (existing) {
          existing.state = 'output-error';
          existing.errorText = chunk.errorText;
        } else {
          message.parts.push({
            type: `tool-${chunk.toolName}`,
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            state: 'output-error',
            input: chunk.input,
            errorText: chunk.errorText,
          });
        }
        break;
      }
      case 'tool-approval-request': {
        const part = findToolPart(chunk.toolCallId);
        if (part) {
          part.state = 'approval-requested';
          part.approval = { id: chunk.approvalId };
        }
        break;
      }
      case 'tool-output-denied':
      case 'tool-output-available':
      case 'tool-output-error': {
        const part = findToolPart(chunk.toolCallId);
        if (part) {
          if (chunk.type === 'tool-output-denied') part.state = 'output-denied';
          else if (chunk.type === 'tool-output-error') {
            part.state = 'output-error';
            part.errorText = chunk.errorText;
          } else {
            part.state = 'output-available';
            part.output = chunk.output;
            if (chunk.preliminary !== undefined) part.preliminary = chunk.preliminary;
          }
        } else {
          orphanToolOutputs.push(chunk);
        }
        break;
      }
      case 'error':
        errors.push(chunk.errorText);
        break;
      default:
        if (chunk.type.startsWith('data-')) {
          dataParts.push(chunk);
        }
        break;
    }
  }
  return { message, orphanToolOutputs, errors, dataParts };
}

/** Mirrors AIChatAgent#_streamSSEReply's orphan tool-output reconciliation. */
function reconcileOrphanToolOutputs(threadMessages, orphanToolOutputs) {
  for (const chunk of orphanToolOutputs) {
    const part = threadMessages
      .flatMap((m) => m.parts ?? [])
      .find((p) => p.toolCallId === chunk.toolCallId);
    if (!part) continue;
    if (!['input-available', 'input-streaming', 'approval-responded', 'approval-requested'].includes(part.state)) {
      continue;
    }
    if (chunk.type === 'tool-output-available') {
      part.state = 'output-available';
      part.output = chunk.output;
    } else if (chunk.type === 'tool-output-error') {
      part.state = 'output-error';
      part.errorText = chunk.errorText;
    }
  }
}

async function parseSseChunks(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const body = await response.text();
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)));
}

/**
 * In-memory stand-in for the per-account AI usage guard Durable Object
 * (RateLimiter's /ai/* endpoints, see src/middleware/aiUsage.ts). The real
 * onChatMessage acquires a turn slot before streaming and releases it when
 * the turn settles; the harness fake admits every request and tracks
 * held/released slots so the lifecycle is observable if a test needs it.
 */
function createFakeAiUsageGuard() {
  const heldSlots = new Set();
  const releasedSlots = [];
  const stub = {
    // The real DurableObjectStub accepts either a Request or a (url, init)
    // pair — the production middleware sends (url, init), so normalize both.
    async fetch(input, init) {
      const request = typeof input === 'string' ? new Request(input, init) : input;
      const url = new URL(request.url);
      if (url.pathname === '/ai/acquire') {
        const slotId = `slot-${heldSlots.size + 1}`;
        heldSlots.add(slotId);
        return Response.json({
          allowed: true,
          slotId,
          remainingRequests: 100,
          remainingTokens: 1_000_000,
          resetAt: Date.now() + 86_400_000,
        });
      }
      if (url.pathname === '/ai/record') {
        return Response.json({ ok: true });
      }
      if (url.pathname === '/ai/release') {
        const body = await request.json().catch(() => ({}));
        heldSlots.delete(body.slotId);
        releasedSlots.push(body.slotId);
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    },
  };
  return {
    stub,
    heldSlots,
    releasedSlots,
    binding: { idFromName: () => 'rate-limiter-do-id', get: () => stub },
  };
}

function createAgentHarness({ items = [], profile = null } = {}) {
  const desktop = createFakeDesktop({ items, profile });
  const kv = createFakeKV();
  const r2 = createFakeR2();
  const ai = createFakeAiBinding();
  const sql = fakeSql();
  const usageGuard = createFakeAiUsageGuard();
  const env = {
    AI: ai,
    USER_DESKTOP: { idFromName: () => 'desktop-do-id', get: () => desktop.stub },
    DESKTOP_KV: kv,
    ETERNALOS_FILES: r2,
    RATE_LIMITER: usageGuard.binding,
    APP_RUNNER: createFakeAppRunner().binding,
  };
  const threadMessages = [];
  const agent = {
    messages: threadMessages,
    state: { lastMatchedItemIds: [], lastQuery: null, memories: [] },
    setState(next) {
      agent.state = next;
    },
    name: `${UID}:thread-1`,
    env,
    ctx: { storage: { sql } },
    // TS-private methods live on the prototype; borrow the real ones.
    getOwnerUid: OrchestratorAgent.prototype.getOwnerUid,
    getUserDesktopStub: OrchestratorAgent.prototype.getUserDesktopStub,
    listInstalledAppRoutingTerms: OrchestratorAgent.prototype.listInstalledAppRoutingTerms,
    buildCodeMode: OrchestratorAgent.prototype.buildCodeMode,
    createRoutineTools: OrchestratorAgent.prototype.createRoutineTools,
    loadDesktopItemsForRuns: OrchestratorAgent.prototype.loadDesktopItemsForRuns,
    executeInverse: OrchestratorAgent.prototype.executeInverse,
    undoCodeRun: OrchestratorAgent.prototype.undoCodeRun,
    markRunUndoneInThread: OrchestratorAgent.prototype.markRunUndoneInThread,
    routineView: OrchestratorAgent.prototype.routineView,
    listRoutines: OrchestratorAgent.prototype.listRoutines,
    scheduleRoutine: OrchestratorAgent.prototype.scheduleRoutine,
    deleteRoutine: OrchestratorAgent.prototype.deleteRoutine,
    executeRoutine: OrchestratorAgent.prototype.executeRoutine,
    runRoutine: OrchestratorAgent.prototype.runRoutine,
    runRoutineNow: OrchestratorAgent.prototype.runRoutineNow,
    getModel: OrchestratorAgent.prototype.getModel,
    settleTurnUsage: OrchestratorAgent.prototype.settleTurnUsage,
    degradedTurnResponse: OrchestratorAgent.prototype.degradedTurnResponse,
  };

  /**
   * Runs one chat turn. Pushes the user message (when given), queues the
   * scripted model responses, calls the real onChatMessage, and persists the
   * resulting assistant message into the thread exactly like AIChatAgent.
   */
  async function runTurn(userText, responses = []) {
    if (userText !== null) {
      threadMessages.push({
        id: `user-${threadMessages.length}`,
        role: 'user',
        parts: [{ type: 'text', text: userText }],
      });
    }
    ai.script.push(...responses);
    const response = await OrchestratorAgent.prototype.onChatMessage.call(
      agent,
      undefined,
      { body: { threadId: 'thread-1' } },
    );
    const chunks = await parseSseChunks(response);
    const { message, orphanToolOutputs, errors, dataParts } = buildMessageFromChunks(chunks);
    reconcileOrphanToolOutputs(threadMessages, orphanToolOutputs);
    threadMessages.push(message);
    return { message, chunks, errors, dataParts };
  }

  /**
   * Delivers a CF_AGENT_TOOL_APPROVAL frame through the REAL
   * AIChatAgent#_applyToolApproval (stubbed persistence), returning whether
   * it was applied — a duplicate delivery of an already-handled approval
   * returns false, which is what stops ai-chat from running a second
   * continuation (and thus a second tool execution).
   */
  async function deliverApproval(toolCallId, approved) {
    const chatAgent = Object.create(AIChatAgent.prototype);
    chatAgent._streamingMessage = null;
    chatAgent._findMessageByToolCallId = (id) =>
      threadMessages.find((m) => (m.parts ?? []).some((p) => p.toolCallId === id));
    chatAgent._sanitizeMessageForPersistence = (m) => m;
    chatAgent._enforceRowSizeLimit = (m) => m;
    chatAgent._persistedMessageCache = new Map();
    chatAgent._loadMessagesFromDb = () => threadMessages;
    chatAgent._broadcastChatMessage = () => {};
    chatAgent.sql = (strings, ...values) => {
      const query = strings.join('?');
      // NOTE: the real query begins with a newline/indent, so match by
      // inclusion — startsWith would silently skip the persistence write.
      if (query.includes('update cf_ai_chat_agent_messages')) {
        const [json, id] = values;
        const index = threadMessages.findIndex((m) => m.id === id);
        if (index >= 0) threadMessages[index] = JSON.parse(json);
      }
      return { rows: [] };
    };
    return AIChatAgent.prototype._applyToolApproval.call(chatAgent, toolCallId, approved);
  }

  const findToolPart = (toolCallId) =>
    threadMessages.flatMap((m) => (m.parts ?? [])).find((p) => p.toolCallId === toolCallId);

  return { agent, desktop, kv, r2, ai, sql, env, threadMessages, runTurn, deliverApproval, findToolPart };
}

function toolPartOf(message, toolCallId) {
  return (message.parts ?? []).find((p) => p.toolCallId === toolCallId);
}

function textOf(message) {
  return (message.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

// ---------------------------------------------------------------------------
// desktopTools — happy paths and failure paths
// ---------------------------------------------------------------------------

describe('agent-created desktop items land in a visible grid cell', () => {
  it('picks the first free cell, column by column (positions are grid cells, not pixels)', async () => {
    const { nextFreeDesktopCell } = await import('../src/agents/tools/desktopTools.ts');
    assert.deepEqual(nextFreeDesktopCell([]), { x: 0, y: 0 });
    const items = [
      { id: 'a', parentId: null, position: { x: 0, y: 0 } },
      { id: 'b', parentId: null, position: { x: 0, y: 1 } },
      { id: 'c', parentId: null, position: { x: 0, y: 2 }, isTrashed: true },
      { id: 'd', parentId: 'f', position: { x: 0, y: 2 } },
    ];
    assert.deepEqual(nextFreeDesktopCell(items), { x: 0, y: 2 }, 'trashed items and items in folders do not block');
    assert.deepEqual(nextFreeDesktopCell(items, 'f'), { x: 0, y: 0 });
  });
});

describe('desktopTools', () => {
  it('getDesktopOverview summarizes the desktop', async () => {
    const desktop = createFakeDesktop({
      profile: { username: 'jane' },
      items: [
        { id: 'i1', type: 'folder', name: 'Photos', parentId: null, isPublic: false, updatedAt: 5 },
        { id: 'i2', type: 'image', name: 'cat.png', parentId: 'i1', isPublic: false, updatedAt: 10 },
        { id: 'i3', type: 'text', name: 'note.txt', parentId: null, isPublic: false, textContent: 'hi', updatedAt: 1 },
        { id: 'i4', type: 'image', name: 'gone.png', parentId: null, isPublic: false, isTrashed: true, updatedAt: 99 },
      ],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    const result = await tools.getDesktopOverview.execute({}, { toolCallId: 'tc', messages: [] });
    assert.equal(result.username, 'jane');
    assert.equal(result.totalActiveItems, 3); // trashed item excluded
    assert.deepEqual(result.counts, { folder: 1, image: 1, text: 1 });
    assert.equal(result.recentItems[0].id, 'i2'); // most recently updated first
  });

  it('getDesktopOverview surfaces a clear error when the desktop is unreachable', async () => {
    const desktop = createFakeDesktop();
    desktop.state.fail.get = 503;
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    await assert.rejects(
      tools.getDesktopOverview.execute({}, { toolCallId: 'tc', messages: [] }),
      /Failed to load desktop state \(503\)/,
    );
  });

  it('searchDesktop matches items and records the last search in agent state', async () => {
    const desktop = createFakeDesktop({
      items: [
        { id: 'i1', type: 'image', name: 'beach-sunset.png', parentId: null, isPublic: false, userTags: ['vacation'], updatedAt: 1 },
        { id: 'i2', type: 'text', name: 'todo.txt', parentId: null, isPublic: false, textContent: 'buy milk', updatedAt: 2 },
        { id: 'i3', type: 'text', name: 'trashed-note.txt', parentId: null, isPublic: false, isTrashed: true, textContent: 'beach', updatedAt: 3 },
      ],
    });
    const state = { lastMatchedItemIds: [], lastQuery: null, memories: [] };
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: (next) => Object.assign(state, next),
      getState: () => state,
    });

    const result = await tools.searchDesktop.execute({ query: 'beach vacation' }, { toolCallId: 'tc', messages: [] });
    assert.equal(result.totalMatches, 1);
    assert.equal(result.items[0].id, 'i1');
    assert.deepEqual(state.lastMatchedItemIds, ['i1']);
    assert.equal(state.lastQuery, 'beach vacation');

    const none = await tools.searchDesktop.execute({ query: 'zebra' }, { toolCallId: 'tc', messages: [] });
    assert.equal(none.totalMatches, 0);
    assert.deepEqual(state.lastMatchedItemIds, []);
  });

  it('readTextFile reads by id and by unique name', async () => {
    const desktop = createFakeDesktop({
      items: [
        { id: 'i1', type: 'text', name: 'ideas.md', parentId: null, isPublic: false, textContent: '# Ideas\nShip it', updatedAt: 1 },
        { id: 'f1', type: 'folder', name: 'Docs', parentId: null, isPublic: false, updatedAt: 2 },
      ],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    const byId = await tools.readTextFile.execute({ itemId: 'i1' }, { toolCallId: 'tc', messages: [] });
    assert.equal(byId.found, true);
    assert.equal(byId.content, '# Ideas\nShip it');
    assert.equal(byId.location, 'Desktop');

    const byName = await tools.readTextFile.execute({ name: 'ideas' }, { toolCallId: 'tc', messages: [] });
    assert.equal(byId.found, true);
    assert.equal(byName.id, 'i1');
  });

  it('readTextFile failure paths return clear results', async () => {
    const desktop = createFakeDesktop({
      items: [
        { id: 't1', type: 'text', name: 'a-note.txt', parentId: null, isPublic: false, textContent: 'one', updatedAt: 1 },
        { id: 't2', type: 'text', name: 'b-note.txt', parentId: null, isPublic: false, textContent: 'two', updatedAt: 2 },
        { id: 'p1', type: 'image', name: 'photo.png', parentId: null, isPublic: false, updatedAt: 3 },
      ],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    // Ambiguous name -> a clear result with candidates, not a throw.
    const ambiguous = await tools.readTextFile.execute({ name: 'note' }, { toolCallId: 'tc', messages: [] });
    assert.equal(ambiguous.found, false);
    assert.equal(ambiguous.candidates.length, 2);

    // Missing item / non-text item / missing input -> specific errors.
    await assert.rejects(
      tools.readTextFile.execute({ itemId: 'nope' }, { toolCallId: 'tc', messages: [] }),
      /No item with ID nope/,
    );
    await assert.rejects(
      tools.readTextFile.execute({ itemId: 'p1' }, { toolCallId: 'tc', messages: [] }),
      /"photo.png" is a image item without readable text content/,
    );
    await assert.rejects(
      tools.readTextFile.execute({}, { toolCallId: 'tc', messages: [] }),
      /Provide an itemId or a name to read/,
    );
  });

  it('createTextNote creates a private note, in a folder when given one', async () => {
    const desktop = createFakeDesktop({
      items: [{ id: 'f1', type: 'folder', name: 'Docs', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    const inFolder = await tools.createTextNote.execute(
      { name: 'groceries.md', content: '- milk', folderId: 'f1' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(inFolder.note.name, 'groceries.md');
    assert.equal(inFolder.location, 'Docs');
    const created = desktop.get(inFolder.note.id);
    assert.equal(created.type, 'text');
    assert.equal(created.textContent, '- milk');
    assert.equal(created.isPublic, false, 'agent-created notes must default to private');
    assert.equal(created.parentId, 'f1');

    const atRoot = await tools.createTextNote.execute(
      { name: 'scratch.txt', content: 'x' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(atRoot.location, 'Desktop');
    assert.equal(desktop.get(atRoot.note.id).parentId, null);
  });

  it('createTextNote failure paths return clear errors', async () => {
    const desktop = createFakeDesktop({
      items: [{ id: 'i1', type: 'text', name: 'not-a-folder.txt', parentId: null, isPublic: false, textContent: 'x', updatedAt: 1 }],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    await assert.rejects(
      tools.createTextNote.execute({ name: 'n', content: 'c', folderId: 'missing' }, { toolCallId: 'tc', messages: [] }),
      /No folder with ID missing/,
    );
    await assert.rejects(
      tools.createTextNote.execute({ name: 'n', content: 'c', folderId: 'i1' }, { toolCallId: 'tc', messages: [] }),
      /"not-a-folder.txt" is not a folder/,
    );
    desktop.state.fail.post = 500;
    await assert.rejects(
      tools.createTextNote.execute({ name: 'n', content: 'c' }, { toolCallId: 'tc', messages: [] }),
      /Failed to create note \(500\)/,
    );
  });

  it('createFolder creates a folder and moves the given items', async () => {
    const desktop = createFakeDesktop({
      items: [
        { id: 'i1', type: 'image', name: 'a.png', parentId: null, isPublic: false, updatedAt: 1 },
        { id: 'i2', type: 'image', name: 'b.png', parentId: null, isPublic: false, updatedAt: 2 },
      ],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    const result = await tools.createFolder.execute(
      { folderName: 'Screenshots', itemIds: ['i1', 'i2'] },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.folder.name, 'Screenshots');
    assert.equal(result.movedCount, 2);
    const folder = desktop.get(result.folder.id);
    assert.equal(folder.type, 'folder');
    assert.equal(folder.isPublic, false, 'agent-created folders must default to private');
    assert.equal(desktop.get('i1').parentId, folder.id);
    assert.equal(desktop.get('i2').parentId, folder.id);
  });

  it('createFolder without itemIds makes an empty folder, even right after a search', async () => {
    // Users ask for "a folder to save my drawings in". The old fallback to
    // the last search's results made that impossible, and moved items the
    // approval card never showed.
    const desktop = createFakeDesktop({
      items: [{ id: 'i1', type: 'image', name: 'a.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    const state = { lastMatchedItemIds: ['i1'], lastQuery: 'a', memories: [] };
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: (next) => Object.assign(state, next),
      getState: () => state,
    });

    const result = await tools.createFolder.execute({ folderName: 'Drawings' }, { toolCallId: 'tc', messages: [] });
    assert.equal(result.movedCount, 0);
    assert.equal(desktop.get('i1').parentId, null, 'nothing moves unless named');
    const folder = desktop.get(result.folder.id);
    assert.equal(folder.type, 'folder');
    assert.equal(folder.name, 'Drawings');
    assert.equal(folder.parentId, null);
    assert.ok(folder.position.x < 14 && folder.position.y < 7, 'lands on a visible grid cell');

    const empty = await tools.createFolder.execute({ folderName: 'Empty', itemIds: [] }, { toolCallId: 'tc2', messages: [] });
    assert.equal(empty.movedCount, 0);
  });

  it('createFolder failure paths return clear errors', async () => {
    const desktop = createFakeDesktop({
      items: [{ id: 'i1', type: 'image', name: 'a.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    // Move fails after the folder was created: the tool reports the failure
    // as before (nothing is silently half-moved) AND no longer leaves the
    // empty folder behind — the folder it just created is trashed. Only
    // the move PATCH fails, so the cleanup can run.
    desktop.state.fail.patch = failOnce(500);
    await assert.rejects(
      tools.createFolder.execute({ folderName: 'Y', itemIds: ['i1'] }, { toolCallId: 'tc', messages: [] }),
      /Failed to move items \(500\)/,
    );
    assert.equal(desktop.get('i1').parentId, null, 'the failed move must not have moved anything');
    assert.equal(desktop.itemsOf('folder').length, 0, 'the created folder must not be left behind');
    const createdFolder = [...desktop.state.items.values()].find((i) => i.type === 'folder');
    assert.equal(
      createdFolder.isTrashed, true,
      'the folder is trashed — the reversible removal the tools use, not a hard delete',
    );
  });

  it('createFolder reports both errors when the move and the cleanup fail', async () => {
    const desktop = createFakeDesktop({
      items: [{ id: 'i1', type: 'image', name: 'a.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    // Every PATCH fails: the move fails AND the cleanup of the just-created
    // folder fails. Both errors must be reported in one clear message — the
    // folder remains on the desktop, but visibly so, never silently.
    desktop.state.fail.patch = 500;
    await assert.rejects(
      tools.createFolder.execute({ folderName: 'Y', itemIds: ['i1'] }, { toolCallId: 'tc', messages: [] }),
      (error) => {
        assert.match(error.message, /Failed to move items \(500\)/);
        assert.match(error.message, /failed to remove the created folder \(500\)/);
        return true;
      },
    );
    assert.equal(desktop.get('i1').parentId, null, 'nothing may be moved');
    assert.equal(desktop.itemsOf('folder').length, 1, 'the cleanup failed, so the folder remains — but the error says so');
  });

  it('moveItems moves items and reports clearly when the backend fails', async () => {
    const desktop = createFakeDesktop({
      items: [
        { id: 'f1', type: 'folder', name: 'Docs', parentId: null, isPublic: false, updatedAt: 1 },
        { id: 'i1', type: 'text', name: 'a.txt', parentId: null, isPublic: false, updatedAt: 2 },
      ],
    });
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: () => {},
      getState: () => ({ lastMatchedItemIds: [], lastQuery: null, memories: [] }),
    });

    const moved = await tools.moveItems.execute(
      { itemIds: ['i1'], targetFolderId: 'f1' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(moved.movedCount, 1);
    assert.equal(desktop.get('i1').parentId, 'f1');

    const toRoot = await tools.moveItems.execute(
      { itemIds: ['i1'], targetFolderId: null },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(toRoot.movedCount, 1);
    assert.equal(desktop.get('i1').parentId, null);

    // Unknown ids are skipped by the backend (movedCount reflects reality).
    const unknown = await tools.moveItems.execute(
      { itemIds: ['ghost'], targetFolderId: null },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(unknown.movedCount, 0);

    desktop.state.fail.patch = 500;
    await assert.rejects(
      tools.moveItems.execute({ itemIds: ['i1'], targetFolderId: 'f1' }, { toolCallId: 'tc', messages: [] }),
      /Failed to move items \(500\)/,
    );
    assert.equal(desktop.get('i1').parentId, null);
  });
});

// ---------------------------------------------------------------------------
// memoryTools — happy paths and failure paths
// ---------------------------------------------------------------------------

describe('memoryTools', () => {
  function createHarness() {
    let state = { lastMatchedItemIds: [], lastQuery: null, memories: [] };
    const tools = createMemoryTools({
      getState: () => state,
      setState: (next) => { state = next; },
    });
    return {
      tools,
      get state() { return state; },
    };
  }

  it('rememberMemory creates, dedupes, and caps memories', async () => {
    const h = createHarness();

    const created = await h.tools.rememberMemory.execute(
      { content: 'prefers  dark  mode', kind: 'preference' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(created.status, 'created');
    assert.equal(created.memory.content, 'prefers dark mode', 'whitespace is normalized');
    assert.equal(h.state.memories.length, 1);

    // Same content + kind is an update, not a duplicate.
    const updated = await h.tools.rememberMemory.execute(
      { content: 'prefers dark mode', kind: 'preference' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(updated.status, 'updated');
    assert.equal(updated.memory.id, created.memory.id);
    assert.equal(h.state.memories.length, 1);

    // Same content, different kind is a separate memory.
    const other = await h.tools.rememberMemory.execute(
      { content: 'prefers dark mode', kind: 'context' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(other.status, 'created');
    assert.equal(h.state.memories.length, 2);

    // The list is capped at 24, keeping the most recent.
    for (let i = 0; i < 30; i += 1) {
      await h.tools.rememberMemory.execute(
        { content: `memory number ${i}`, kind: 'other' },
        { toolCallId: 'tc', messages: [] },
      );
    }
    assert.equal(h.state.memories.length, 24);
    assert.ok(h.state.memories.some((m) => m.content === 'memory number 29'));
    assert.ok(!h.state.memories.some((m) => m.content === 'memory number 0'));
  });

  it('listMemories lists all or filters by kind', async () => {
    const h = createHarness();
    await h.tools.rememberMemory.execute({ content: 'likes tea', kind: 'preference' }, { toolCallId: 'tc', messages: [] });
    await h.tools.rememberMemory.execute({ content: 'building a synth', kind: 'project' }, { toolCallId: 'tc', messages: [] });

    const all = await h.tools.listMemories.execute({}, { toolCallId: 'tc', messages: [] });
    assert.equal(all.returnedCount, 2);
    assert.equal(all.totalMemories, 2);

    const prefs = await h.tools.listMemories.execute({ kind: 'preference' }, { toolCallId: 'tc', messages: [] });
    assert.equal(prefs.returnedCount, 1);
    assert.equal(prefs.memories[0].content, 'likes tea');
    assert.equal(prefs.totalMemories, 2, 'total is unfiltered');
  });

  it('forgetMemory deletes by id or query and reports not_found clearly', async () => {
    const h = createHarness();
    const created = await h.tools.rememberMemory.execute(
      { content: 'lives in Lisbon', kind: 'identity' },
      { toolCallId: 'tc', messages: [] },
    );

    const byId = await h.tools.forgetMemory.execute(
      { memoryId: created.memory.id },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(byId.status, 'deleted');
    assert.equal(h.state.memories.length, 0);

    await h.tools.rememberMemory.execute({ content: 'lives in Lisbon', kind: 'identity' }, { toolCallId: 'tc', messages: [] });
    const byQuery = await h.tools.forgetMemory.execute(
      { query: 'lisbon' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(byQuery.status, 'deleted');
    assert.equal(h.state.memories.length, 0);

    const missing = await h.tools.forgetMemory.execute(
      { query: 'nothing matches this' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(missing.status, 'not_found', 'a missing memory is a clear result, not a throw');
  });
});

// ---------------------------------------------------------------------------
// appSpec — deterministic spec validation and spec -> permission derivation
// ---------------------------------------------------------------------------

describe('generated source file blocks', () => {
  const block = (name, body) => `<<<FILE ${name}>>>\n${body}\n<<<END FILE>>>`;

  it('parses raw blocks without any escaping', () => {
    const js = "const s = \"quote\" + '\\n' + `tpl ${1}`; // \"tricky\" chars: \\ {} []";
    const files = parseFileBlocks([block('index.html', '<p>hi</p>'), block('app.js', js)].join('\n'));
    assert.deepEqual(files, { 'index.html': '<p>hi</p>', 'app.js': js });
  });

  it('drops a block truncated by the output limit instead of keeping half a file', () => {
    const text = `${block('index.html', '<p>ok</p>')}\n<<<FILE app.js>>>\nconst half = `;
    assert.deepEqual(parseFileBlocks(text), { 'index.html': '<p>ok</p>' });
  });

  it('unwraps a block that is entirely one markdown fence, and normalizes ./ names', () => {
    const files = parseFileBlocks(block('./styles.css', '```css\nbody{margin:0}\n```'));
    assert.deepEqual(files, { 'styles.css': 'body{margin:0}' });
  });

  it('ignores preamble text and keeps code that merely mentions the markers inline', () => {
    const body = "const marker = '<<<END FILE>>> is only special on its own line';";
    const files = parseFileBlocks(`Here is your app:\n${block('app.js', body)}\nEnjoy!`);
    assert.deepEqual(files, { 'app.js': body });
  });

  it('turns reasoning off only for models with a real off switch', () => {
    assert.deepEqual(noReasoningInputsFor('@cf/deepseek-ai/deepseek-v4.1-flash-1017'), { reasoning_effort: 'none' });
    assert.deepEqual(noReasoningInputsFor('@cf/zai-org/glm-4.7-flash'), { chat_template_kwargs: { enable_thinking: false } });
    // glm-5.3 maps "none" to MAX effort — it must get nothing.
    assert.equal(noReasoningInputsFor('@cf/zai-org/glm-5.3'), undefined);
  });

  it('builds an app from file blocks, with reasoning off for codegen but not for the spec', async () => {
    const h = createAppToolsHarness();
    h.env.APP_BUILDER_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Tasks',
          purpose: 'A focused task list with filters and quick keyboard actions.',
          screens: [{ name: 'Tasks', summary: 'The task list.', emptyState: 'Add the first task.' }],
          storageKeys: ['tasks.items'],
        }),
      },
      { response: Object.entries(MINIMAL_APP_FILES).map(([name, body]) => block(name, body)).join('\n') },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a todo list app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(h.ai.calls.length, 2, 'one spec call + ONE codegen call (no structured/fallback pair)');
    assert.equal(h.ai.calls[0].inputs.reasoning_effort, undefined, 'the spec keeps reasoning');
    assert.equal(h.ai.calls[1].inputs.reasoning_effort, 'none', 'codegen turns reasoning off');
    assert.match(h.ai.calls[1].inputs.messages[0].content, /<<<FILE /, 'codegen asks for file blocks');
  });
});

describe('structured output schemas', () => {
  // Workers AI's JSON grammar rejects some JSON Schema keywords outright
  // (seen live: "Grammar error: Unimplemented keys: [\"propertyNames\"]"),
  // which silently forces every generateObject call onto the text fallback.
  const UNSUPPORTED = ['propertyNames', 'patternProperties', 'if', 'then', 'else', 'dependentSchemas'];
  for (const [name, schema] of [['appSpecSchema', appSpecSchema], ['generatedAppFilesSchema', generatedAppFilesSchema]]) {
    it(`${name} uses only keywords Workers AI's grammar supports`, () => {
      const json = JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }));
      for (const key of UNSUPPORTED) assert.ok(!json.includes(`"${key}"`), `${name} emits unsupported "${key}"`);
    });
  }
});

describe('appSpec', () => {
  it('accepts ipcTopics given as a bare list (models often answer [])', () => {
    assert.equal(appSpecSchema.shape.ipcTopics.parse([]), undefined);
    assert.deepEqual(appSpecSchema.shape.ipcTopics.parse(['notes.*']), { emit: ['notes.*'], listen: ['notes.*'] });
    assert.deepEqual(appSpecSchema.shape.ipcTopics.parse({ listen: ['a'] }), { listen: ['a'] });
  });

  /** A minimal valid spec; overrides replace whole sections. */
  const spec = (overrides = {}) => appSpecSchema.parse({
    name: 'Photo Grid',
    purpose: "Shows the user's photos as a scrollable grid.",
    screens: [
      {
        name: 'Grid',
        summary: 'All photos, newest first.',
        emptyState: 'A hint to upload photos when none exist yet.',
      },
    ],
    dataReads: [{ kind: 'fs', mimeTypes: ['image/*'] }],
    ...overrides,
  });

  it('derivePermissionsFromSpec maps every declaration to its manifest permission', () => {
    const permissions = derivePermissionsFromSpec(spec({
      dataReads: [
        { kind: 'fs', mimeTypes: ['image/*'], paths: ['/Photos/**'] },
        { kind: 'fs', mimeTypes: ['image/*'] }, // duplicate — deduped
        { kind: 'fs', paths: ['*.jpg'] },
      ],
      storageKeys: ['photogrid.layout'],
      networkDomains: ['api.example.com', '*.cdn.example.net'],
      profileFields: ['displayName', 'displayName'],
      ipcTopics: { emit: ['photogrid.opened'], listen: ['music.now_playing'] },
    }));

    assert.deepEqual(permissions, {
      fs: { read: ['/Photos/**', '*.jpg'], mimeTypes: ['image/*'] },
      profile: { read: ['displayName'] },
      network: { outbound: ['api.example.com', '*.cdn.example.net'] },
      ipc: { emit: ['photogrid.opened'], listen: ['music.now_playing'] },
    });
    // eternal.storage is private per-app sandboxed state — it implies no
    // permission, so only the four permission kinds appear.
    assert.deepEqual(Object.keys(permissions), ['fs', 'profile', 'network', 'ipc']);
  });

  it('derivePermissionsFromSpec is hermetic for a spec without declarations', () => {
    assert.deepEqual(derivePermissionsFromSpec(spec({ dataReads: [] })), {});
  });

  it('derivePermissionsFromSpec skips unknown kinds (validateAppSpec rejects them first)', () => {
    const permissions = derivePermissionsFromSpec(spec({
      dataReads: [{ kind: 'camera' }],
    }));
    assert.deepEqual(permissions, {});
  });

  it('derivePermissionsFromSpec maps declared writes to the manifest fs write/delete shape', () => {
    const permissions = derivePermissionsFromSpec(spec({
      dataReads: [],
      dataWrites: [{
        kind: 'fs',
        paths: ['/Notes/**', '/Journal/*.md', '/Notes/**'], // duplicate — deduped
        deletePaths: ['/Notes/**'],
        mimeTypes: ['text/markdown'],
      }],
    }));

    assert.deepEqual(permissions, {
      fs: { write: ['/Notes/**', '/Journal/*.md'], delete: ['/Notes/**'] },
    });
    // The manifest's declared write shape is path globs only — write mime
    // types guide the file generator, they derive no permission.
    assert.ok(!permissions.fs.mimeTypes);
  });

  it('validateAppSpec accepts a well-formed spec', () => {
    assert.deepEqual(validateAppSpec(spec()), []);
  });

  it('validateAppSpec rejects an empty purpose and empty screens', () => {
    const issues = validateAppSpec(spec({ purpose: '   ', screens: [] }));
    assert.deepEqual(issues.map((issue) => issue.code), ['spec/missing-purpose', 'spec/empty-screens']);
  });

  it('validateAppSpec rejects unknown permission kinds with the supported list', () => {
    const issues = validateAppSpec(spec({
      dataReads: [{ kind: 'camera' }, { kind: 'fs', mimeTypes: ['image/*'] }],
    }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, 'spec/unknown-permission-kind');
    assert.match(issues[0].message, /camera/);
    assert.match(issues[0].hint, /fs/);
  });

  it('validateAppSpec rejects an fs read without scope', () => {
    const issues = validateAppSpec(spec({ dataReads: [{ kind: 'fs' }] }));
    assert.deepEqual(issues.map((issue) => issue.code), ['spec/data-read-without-scope']);
  });

  it('validateAppSpec rejects path globs and mime types the fs policy cannot honor', () => {
    const issues = validateAppSpec(spec({
      dataReads: [{
        kind: 'fs',
        paths: ['Photos/**', '*', '/Photos/../Secret/**'],
        mimeTypes: ['image', 'image/**'],
      }],
    }));
    assert.deepEqual(issues.map((issue) => issue.code), [
      'spec/invalid-fs-glob', 'spec/invalid-fs-glob', 'spec/invalid-fs-glob',
      'spec/invalid-mime-type', 'spec/invalid-mime-type',
    ]);
    // Every form the fs policy does honor passes.
    assert.deepEqual(validateAppSpec(spec({
      dataReads: [{
        kind: 'fs',
        paths: ['**', '/Photos/**', '/Notes/*.md', '*.jpg'],
        mimeTypes: ['image/*', 'application/pdf'],
      }],
    })), []);
  });

  it('validateAppSpec rejects network domains that are not hostnames', () => {
    const bad = ['https://api.example.com/x', 'api.example.com:8443', 'exa mple.com', 'example..com', 'example.*', '*.'];
    const issues = validateAppSpec(spec({ networkDomains: bad }));
    assert.equal(issues.length, bad.length);
    assert.ok(issues.every((issue) => issue.code === 'spec/invalid-network-domain'));
    // Valid host patterns pass, including the manifest's wildcard forms.
    assert.deepEqual(
      validateAppSpec(spec({ networkDomains: ['api.example.com', '*.example.com', '*', 'localhost'] })),
      [],
    );
  });

  it('validateAppSpec rejects storage keys the bridge storage would refuse', () => {
    const issues = validateAppSpec(spec({ storageKeys: ['fine', 'has:colon', 'bad\nkey'] }));
    assert.deepEqual(issues.map((issue) => issue.code), ['spec/invalid-storage-key', 'spec/invalid-storage-key']);
  });

  it('validateAppSpec requires an empty state on every screen of a data-reading app', () => {
    const issues = validateAppSpec(spec({
      dataReads: [{ kind: 'fs', mimeTypes: ['image/*'] }],
      screens: [
        { name: 'Grid', summary: 'All photos.', emptyState: 'An upload hint.' },
        { name: 'Viewer', summary: 'One photo.', emptyState: '' },
      ],
    }));
    assert.deepEqual(issues.map((issue) => issue.code), ['spec/screen-missing-empty-state']);
    assert.equal(issues[0].file, 'Viewer');
    // A hermetic app needs no empty states.
    assert.deepEqual(validateAppSpec(spec({
      dataReads: [],
      screens: [{ name: 'Timer', summary: 'A countdown.', emptyState: '' }],
    })), []);
  });

  it('validateAppSpec accepts folder-scoped writes and whole-desktop writes marked arbitrary', () => {
    assert.deepEqual(
      validateAppSpec(spec({ dataWrites: [{ kind: 'fs', paths: ['/Notes/**'] }] })),
      [],
    );
    assert.deepEqual(validateAppSpec(spec({
      dataWrites: [{ kind: 'fs', paths: ['**'], deletePaths: ['**'], arbitraryFiles: true }],
    })), []);
  });

  it('validateAppSpec rejects whole-desktop write scopes unless the spec marks them arbitrary', () => {
    const issues = validateAppSpec(spec({
      dataWrites: [{ kind: 'fs', paths: ['**'], deletePaths: ['/**'] }],
    }));
    assert.deepEqual(issues.map((issue) => issue.code), ['spec/broad-fs-write', 'spec/broad-fs-write']);
    assert.match(issues[0].hint, /arbitraryFiles/);
  });

  it('validateAppSpec rejects unknown write kinds, unscoped writes, and bad write globs', () => {
    const issues = validateAppSpec(spec({
      dataWrites: [
        { kind: 'disk' },
        { kind: 'fs' },
        { kind: 'fs', paths: ['Notes/**'] },
      ],
    }));
    assert.deepEqual(issues.map((issue) => issue.code), [
      'spec/unknown-permission-kind',
      'spec/data-write-without-scope',
      'spec/invalid-fs-glob',
    ]);
  });
});

// ---------------------------------------------------------------------------
// appBundleValidation — every issue code the repair prompt can act on
// ---------------------------------------------------------------------------

describe('appBundleValidation issue hints', () => {
  // The repair prompts (targeted and full) embed exactly these issues; a
  // code without a hint the model can act on burns an attempt blind. The
  // trigger table below has one deterministic input per issue code in
  // src/utils/appBundleValidation.ts, and the source scan pins the table's
  // completeness: adding a code to the module without a trigger (and a
  // hint) fails this test.
  const HTML = (body) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
  const SHELL = HTML('<script src="app.js"></script>');
  const appInput = (files, permissions, overrides = {}) => ({
    files,
    manifest: {
      entryHtml: 'index.html',
      sourceFiles: Object.keys(files).sort(),
      runtimeAsset: 'eternal-runtime.js',
      workerEntrypoint: '__eternal_worker__.js',
    },
    permissions,
    ...overrides,
  });
  const compiledBundle = (assets) => ({
    mainModule: 'bundle.js',
    modules: {
      'bundle.js': [
        `const ASSETS = ${JSON.stringify(assets)};`,
        'export default { async fetch(request, env) { return new Response("ok"); } };',
      ].join('\n'),
    },
  });

  it('backend network check ignores the handler definition but catches real fetch calls', () => {
    const run = (server, permissions) => collectAppBundleIssues(
      appInput({ 'index.html': SHELL, 'app.js': 'void 0;', 'server.js': server }, permissions),
    ).map((issue) => issue.code);
    const handlerOnly = 'export default {\n  async fetch(request, env) {\n    return Response.json([]);\n  },\n};';
    assert.deepEqual(run(handlerOnly), [], 'an offline backend must not need network permissions');
    assert.deepEqual(run('export default { fetch(req, env) { return new Response("x"); } };'), []);
    assert.deepEqual(run('const h = { async fetch(r) { return new Response(""); } };\nexport default { fetch: (r, e) => h.fetch(r) };'), []);
    assert.ok(run("export default { async fetch() { const r = await fetch('https://a.example/'); return r; } };").includes('backend/undeclared-network'));
    assert.ok(run("export default { async fetch() { return globalThis.fetch('https://a.example/'); } };").includes('backend/undeclared-network'));
    assert.deepEqual(
      run("export default { async fetch() { return fetch('https://a.example/'); } };", { network: { outbound: ['a.example'] } }),
      [],
    );
  });

  it('accepts the full eternal.api surface in apps that ship a backend', () => {
    const issues = collectAppBundleIssues(appInput({
      'index.html': SHELL,
      'app.js': "const load = () => window.eternal.api.get('/todos');\nwindow.eternal.api.onChange(load);\nwindow.eternal.api.post('/todos', {});\nload();",
      'server.js': 'export default { async fetch() { return Response.json([]); } };',
    }));
    assert.deepEqual(issues.map((issue) => issue.code), []);
  });

  it('every issue code carries a non-empty hint the repair prompt can act on', () => {
    const triggers = [
      ['entry/missing-html', appInput({ 'app.js': 'void 0;' })],
      ['permission/undeclared-fs-read', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.fs.list({});' })],
      ['permission/undeclared-fs-write', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.fs.write({ path: "/n.txt", content: "x" });' })],
      ['permission/undeclared-fs-delete', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.fs.delete("id");' })],
      ['permission/undeclared-profile', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.profile.get();' })],
      ['permission/undeclared-network', appInput({ 'index.html': SHELL, 'app.js': "window.eternal.fetch('https://api.example.com/x');" })],
      ['permission/undeclared-ipc-emit', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.ipc.emit("t", {});' })],
      ['permission/undeclared-ipc-listen', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.ipc.on("t", () => {});' })],
      ['bridge/unknown-namespace', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.ai.chat("hi");' })],
      ['bridge/unknown-method', appInput({ 'index.html': SHELL, 'app.js': 'window.eternal.fs.save("/notes.txt", "x");' })],
      ['permission/fs-read-uncovered', appInput(
        { 'index.html': SHELL, 'app.js': "window.eternal.fs.list({ path: '/Documents' });" },
        { fs: { read: ['/Photos/**'] } },
      )],
      ['permission/fs-write-uncovered', appInput(
        { 'index.html': SHELL, 'app.js': "window.eternal.fs.write({ path: '/Secret/new.md', content: 'x' });" },
        { fs: { write: ['/Notes/**'] } },
      )],
      ['permission/ipc-emit-uncovered', appInput(
        { 'index.html': SHELL, 'app.js': "window.eternal.ipc.emit('chat.message', {});" },
        { ipc: { emit: ['music.*'] } },
      )],
      ['permission/ipc-listen-uncovered', appInput(
        { 'index.html': SHELL, 'app.js': "window.eternal.ipc.on('chat.incoming', () => {});" },
        { ipc: { listen: ['music.*'] } },
      )],
      ['sandbox/blocked-storage', appInput({ 'index.html': SHELL, 'app.js': "localStorage.setItem('k', 'v');" })],
      ['sandbox/blocked-media', appInput({ 'index.html': SHELL, 'app.js': 'navigator.geolocation.getCurrentPosition(() => {});' })],
      ['sandbox/blocked-worker', appInput({ 'index.html': SHELL, 'app.js': 'const w = new Worker("./worker.js"); void w;' })],
      ['sandbox/external-network', appInput({ 'index.html': SHELL, 'app.js': "fetch('https://api.example.com/data');" })],
      ['asset/missing', appInput({ 'index.html': HTML('<img src="./missing-icon.png">') })],
      ['module/missing', appInput({ 'index.html': SHELL, 'app.js': "import { helper } from './utils.js'; void helper;" })],
      ['module/missing-export', appInput({
        'index.html': HTML('<script type="module" src="app.js"></script>'),
        'app.js': "import { init } from './boot.js'; void init;",
        'boot.js': 'export function start() {}',
      })],
      ['bundle/entrypoint-missing', appInput(
        { 'index.html': SHELL, 'app.js': 'void 0;' },
        undefined,
        { compiled: { mainModule: 'bundle.js', modules: {} } },
      )],
      ['bundle/entrypoint-export-missing', appInput(
        { 'index.html': SHELL, 'app.js': 'void 0;' },
        undefined,
        { compiled: { mainModule: 'bundle.js', modules: { 'bundle.js': 'const handler = { async fetch() {} };' } } },
      )],
      ['bundle/asset-not-packaged', appInput(
        { 'index.html': SHELL, 'app.js': 'void 0;' },
        undefined,
        { compiled: compiledBundle({ 'index.html': '<!doctype html>', 'eternal-runtime.js': 'window.eternal = {};' }) },
      )],
      // Full-stack apps (server.js runs as a Durable Object Facet).
      ['backend/entry-missing', appInput({ 'index.html': SHELL, 'app.js': 'void 0;', 'server/db.js': 'export const x = 1;' })],
      ['backend/default-export-missing', appInput({ 'index.html': SHELL, 'app.js': 'void 0;', 'server.js': 'export function handle() {}' })],
      ['backend/browser-global', appInput({
        'index.html': SHELL,
        'app.js': 'void 0;',
        'server.js': "export default { async fetch() { localStorage.setItem('k', 'v'); return new Response('x'); } };",
      })],
      ['backend/bare-import', appInput({
        'index.html': SHELL,
        'app.js': 'void 0;',
        'server.js': "import { Hono } from 'hono';\nexport default new Hono();",
      })],
      ['backend/undeclared-network', appInput({
        'index.html': SHELL,
        'app.js': 'void 0;',
        'server.js': "export default { async fetch() { return fetch('https://api.example.com/'); } };",
      })],
      ['backend/api-without-server', appInput({ 'index.html': SHELL, 'app.js': "window.eternal.api.get('/todos');" })],
      ['source/syntax-error', appInput({ 'index.html': SHELL, 'app.js': 'function render() {\n  const x = 1\n  save x;\n}' })],
      ['asset/reserved-api-path', appInput({ 'index.html': SHELL, 'app.js': 'void 0;', 'api/data.json': '{}' })],
      ['bundle/backend-export-missing', appInput(
        { 'index.html': SHELL, 'app.js': 'void 0;', 'server.js': 'export default { async fetch() { return new Response("x"); } };' },
        undefined,
        { compiled: compiledBundle({ 'index.html': '<!doctype html>', 'app.js': 'void 0;', 'eternal-runtime.js': 'window.eternal = {};' }) },
      )],
    ];

    const seen = new Set();
    for (const [code, input] of triggers) {
      const issues = collectAppBundleIssues(input);
      const match = issues.find((issue) => issue.code === code);
      assert.ok(
        match,
        `trigger for ${code} produced ${JSON.stringify(issues.map((issue) => issue.code))} instead`,
      );
      for (const issue of issues) {
        assert.ok(
          typeof issue.hint === 'string' && issue.hint.trim().length >= 16,
          `${issue.code} must carry a specific, non-empty hint the repair prompt can act on`,
        );
      }
      seen.add(code);
    }

    // validation/unknown is the defensive fallback for an issue-less
    // failure; it is constructed directly, and it must be actionable too.
    const fallback = new AppValidationError([]);
    assert.equal(fallback.issues[0].code, 'validation/unknown');
    assert.ok(
      typeof fallback.issues[0].hint === 'string' && fallback.issues[0].hint.trim().length >= 16,
      'validation/unknown must carry a hint the repair prompt can act on',
    );
    seen.add('validation/unknown');

    // Completeness: every code literal in the module has a trigger here.
    const moduleSource = fs.readFileSync(
      path.join(TEST_ROOT, 'src', 'utils', 'appBundleValidation.ts'),
      'utf8',
    );
    const moduleCodes = [...new Set([...moduleSource.matchAll(/code: '([^']+)'/g)].map((m) => m[1]))];
    assert.deepEqual(
      [...seen].sort(),
      [...moduleCodes].sort(),
      'every appBundleValidation issue code needs a trigger (and a hint) in this test',
    );
  });
});

// ---------------------------------------------------------------------------
// appTools — happy paths, bad input, permission boundaries, rollback
// ---------------------------------------------------------------------------

const MINIMAL_APP_FILES = {
  'index.html': '<!DOCTYPE html><html><head><link rel="stylesheet" href="./styles.css"></head><body><h1>Hi</h1><script type="module" src="./app.js"></script></body></html>',
  'styles.css': 'h1 { color: red; }',
  'app.js': 'console.log("hello");',
};

// AppRunner stand-in (full-stack app backends): records purges and serves
// handle() from a scripted responder so callAppApi can be exercised.
function createFakeAppRunner() {
  const purged = [];
  const calls = [];
  const probes = [];
  let probeResponder = async (input) => input.requests.map((request) => ({ ...request, status: 200 }));
  let responder = async () => Response.json({ ok: true });
  const binding = {
    getByName(name) {
      return {
        purge: async () => { purged.push(name); return { purged: true }; },
        probe: async (input) => {
          probes.push({ name, ...input });
          return probeResponder(input);
        },
        getLogs: async () => [{ at: 1, level: 'log', message: `logs for ${name}` }],
        handle: async (request, config) => {
          const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text();
          calls.push({ name, method: request.method, url: request.url, body, config });
          return responder(request, config);
        },
      };
    },
  };
  return {
    binding,
    purged,
    calls,
    probes,
    respond(fn) { responder = fn; },
    respondToProbe(fn) { probeResponder = fn; },
  };
}

function createAppToolsHarness() {
  const desktop = createFakeDesktop({ profile: { username: 'jane' } });
  const kv = createFakeKV();
  const r2 = createFakeR2();
  const ai = createFakeAiBinding();
  const sql = fakeSql();
  const appRunner = createFakeAppRunner();
  const env = {
    AI: ai,
    USER_DESKTOP: { idFromName: () => 'desktop-do-id', get: () => desktop.stub },
    DESKTOP_KV: kv,
    ETERNALOS_FILES: r2,
    APP_RUNNER: appRunner.binding,
  };
  initAppRegistry(sql);
  const tools = createAppTools({ env, sql, agentName: UID, onBuildStage: () => {} });
  return { desktop, kv, r2, ai, sql, env, tools, appRunner };
}

describe('appTools', () => {
  it('createApp installs a private app and registers it everywhere', async () => {
    const h = createAppToolsHarness();
    const result = await h.tools.createApp.execute(
      { name: 'Test App', description: 'a test', files: { ...MINIMAL_APP_FILES }, width: 400, height: 300 },
      { toolCallId: 'tc', messages: [] },
    );

    assert.equal(result.status, 'created');
    assert.ok(result.appId);
    assert.equal(result.build.currentStage, 'ready');

    // R2 artifacts under the user's prefix.
    const prefix = `apps/${UID}/${result.appId}/`;
    for (const file of ['bundle.json', 'source.json', 'workspace.json', 'metadata.json']) {
      assert.ok(h.r2.objects.has(prefix + file), `missing R2 artifact ${file}`);
    }

    // KV registry entry.
    const meta = await h.kv.get(`app:${result.appId}`, 'json');
    assert.equal(meta.uid, UID);
    assert.equal(meta.version, 1);
    assert.deepEqual(meta.granted, {});

    // Desktop item for the app, private by default.
    const appItems = h.desktop.itemsOf('app');
    assert.equal(appItems.length, 1);
    assert.equal(appItems[0].appManifest.appId, result.appId);
    assert.equal(appItems[0].isPublic, false);
    assert.equal(appItems[0].id, result.itemId);

    // SQLite registry row was inserted.
    assert.ok(h.sql.statements.some((s) => s.query.startsWith('INSERT INTO apps')));
  });

  it('createApp records an agent-authored revision and pins the registry pointers', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Revised', files: { ...MINIMAL_APP_FILES }, width: 420, height: 320 },
      { toolCallId: 'tc', messages: [] },
    );

    const manifests = await listAppRevisionManifests(h.env, UID, created.appId);
    assert.equal(manifests.length, 1, 'one revision per install');
    const [revision] = manifests;
    assert.equal(revision.kind, 'deploy');
    assert.equal(revision.author, 'agent');
    assert.equal(revision.valid, true);
    assert.equal(revision.appVersion, 1);
    assert.equal(revision.name, 'Revised');
    assert.equal(created.revision, revision.id, 'the tool result carries the revision id');

    // Both registry pointers move to the agent revision.
    const meta = await h.kv.get(`app:${created.appId}`, 'json');
    assert.equal(meta.current_revision, revision.id);
    assert.equal(meta.last_valid_revision, revision.id);

    // The revision snapshots exactly the deployed source and validates clean.
    const stored = await readAppRevision(h.env, UID, created.appId, revision.id);
    assert.deepEqual(stored.files, MINIMAL_APP_FILES);
    assert.deepEqual(stored.diagnostics, { valid: true, issues: [] });
    assert.equal(stored.manifest.windowConfig.defaultWidth, 420);
    assert.equal(stored.manifest.windowConfig.defaultHeight, 320);
  });

  it('createApp rejects bad bundles before writing anything', async () => {
    const h = createAppToolsHarness();
    const badBundles = [
      [{ 'styles.css': 'x', 'app.js': 'y' }, /at least one HTML/],
      [{ ...MINIMAL_APP_FILES, 'index.html': '<script src="https://evil.example/x.js"></script>' }, /External script URLs are not allowed/],
      [{ ...MINIMAL_APP_FILES, 'index.html': '<img src="./missing-icon.png">' }, /Missing local asset/],
      [{ ...MINIMAL_APP_FILES, 'eternal-runtime.js': 'window.eternal = {};' }, /reserved by the app runtime/],
      [{ ...MINIMAL_APP_FILES, 'app.js': 'await window.eternal.fs.list();' }, /did not declare fs read permissions/],
    ];
    for (const [files, pattern] of badBundles) {
      await assert.rejects(
        h.tools.createApp.execute({ name: 'Bad', files }, { toolCallId: 'tc', messages: [] }),
        pattern,
      );
    }
    assert.equal(h.r2.keys('apps/').length, 0, 'no artifacts may be written for rejected bundles');
    assert.equal(h.kv.keys().filter((k) => k.startsWith('app:')).length, 0);
    assert.equal(h.desktop.itemsOf('app').length, 0);
  });

  it('createApp rolls everything back when desktop installation fails', async () => {
    const h = createAppToolsHarness();
    h.desktop.state.fail.post = 500;

    await assert.rejects(
      h.tools.createApp.execute(
        { name: 'Doomed', files: { ...MINIMAL_APP_FILES } },
        { toolCallId: 'tc', messages: [] },
      ),
      /Build failed during .*Failed to create desktop item \(500\)/,
    );

    assert.equal(h.r2.keys('apps/').length, 0, 'R2 artifacts must be cleaned up');
    assert.equal(h.kv.keys().filter((k) => k.startsWith('app:')).length, 0, 'KV registry entry must be cleaned up');
    assert.ok(h.sql.statements.some((s) => s.query.startsWith('DELETE FROM apps')));
    assert.equal(h.desktop.itemsOf('app').length, 0, 'no app item may be left behind');
  });

  it('listApps lists installed apps and reports a backend failure clearly', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Listed', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    const list = await h.tools.listApps.execute({}, { toolCallId: 'tc', messages: [] });
    assert.equal(list.apps.length, 1);
    assert.equal(list.apps[0].id, created.appId);
    assert.equal(list.apps[0].name, 'Listed');
    assert.equal(list.apps[0].version, 1);

    h.desktop.state.fail.get = 500;
    await assert.rejects(
      h.tools.listApps.execute({}, { toolCallId: 'tc', messages: [] }),
      /Failed to load desktop apps/,
    );
  });

  it('getAppSource returns source, and denies foreign or unknown apps', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Readable', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    const source = await h.tools.getAppSource.execute({ appId: created.appId }, { toolCallId: 'tc', messages: [] });
    assert.equal(source.appId, created.appId);
    assert.equal(source.files['app.js'], MINIMAL_APP_FILES['app.js']);
    assert.ok(source.workspaceManifest);

    // Unknown id and a foreign app (metadata owned by another user) are both
    // a clear "not found" — no existence leak across users.
    await assert.rejects(
      h.tools.getAppSource.execute({ appId: 'no-such-app' }, { toolCallId: 'tc', messages: [] }),
      /App no-such-app not found/,
    );
    h.kv.store.set('app:foreign-app', JSON.stringify({ uid: 'someone-else', version: 1, granted: {} }));
    await assert.rejects(
      h.tools.getAppSource.execute({ appId: 'foreign-app' }, { toolCallId: 'tc', messages: [] }),
      /App foreign-app not found/,
    );

    // Registered in KV, but the desktop item was trashed -> clear error.
    const appItem = h.desktop.itemsOf('app')[0];
    h.desktop.get(appItem.id).isTrashed = true;
    await assert.rejects(
      h.tools.getAppSource.execute({ appId: created.appId }, { toolCallId: 'tc', messages: [] }),
      /App \S+ is not installed on the desktop/,
    );
  });

  it('updateApp writes a new version, and rolls back when installation fails', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Updatable', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    const updated = await h.tools.updateApp.execute(
      {
        appId: created.appId,
        files: { ...MINIMAL_APP_FILES, 'app.js': 'console.log("v2");' },
        name: 'Updatable v2',
      },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(updated.status, 'updated');
    assert.equal(updated.version, 2);

    const prefix = `apps/${UID}/${created.appId}/v2/`;
    assert.ok(h.r2.objects.has(`${prefix}source.json`));
    assert.equal((await h.kv.get(`app:${created.appId}`, 'json')).version, 2);

    const appItem = h.desktop.itemsOf('app')[0];
    assert.equal(appItem.appManifest.version, '2');
    assert.equal(appItem.name, 'Updatable v2');

    // A failed update leaves the previous release intact.
    h.desktop.state.fail.patch = 500;
    await assert.rejects(
      h.tools.updateApp.execute(
        { appId: created.appId, files: { ...MINIMAL_APP_FILES, 'app.js': 'v3' } },
        { toolCallId: 'tc', messages: [] },
      ),
      /Build failed during .*Failed to update desktop item \(500\)/,
    );
    assert.equal(h.r2.keys(`apps/${UID}/${created.appId}/v3/`).length, 0, 'the failed release must be cleaned up');
    assert.equal((await h.kv.get(`app:${created.appId}`, 'json')).version, 2, 'KV must keep the last good version');
    assert.equal(h.desktop.itemsOf('app')[0].appManifest.version, '2', 'desktop must keep the last good manifest');
  });

  it('updateApp patches: only the changed files are sent, the rest of the bundle is kept (live regression)', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Patchable', files: { ...MINIMAL_APP_FILES, 'extra.txt': 'remove me' } },
      { toolCallId: 'tc', messages: [] },
    );

    // Models send the map JSON-encoded as a string; the schema accepts it.
    const input = h.tools.updateApp.inputSchema.parse({
      appId: created.appId,
      files: JSON.stringify({ 'app.js': 'console.log("patched");' }),
      removeFiles: ['extra.txt'],
    });
    assert.deepEqual(input.files, { 'app.js': 'console.log("patched");' });

    const updated = await h.tools.updateApp.execute(input, { toolCallId: 'tc', messages: [] });
    assert.equal(updated.status, 'updated');

    const meta = await h.kv.get(`app:${created.appId}`, 'json');
    const source = JSON.parse(await (await h.r2.get(`${meta.r2Prefix}/source.json`)).text());
    assert.equal(source['app.js'], 'console.log("patched");');
    assert.equal(source['index.html'], MINIMAL_APP_FILES['index.html'], 'untouched files are kept');
    assert.equal(source['styles.css'], MINIMAL_APP_FILES['styles.css']);
    assert.equal('extra.txt' in source, false, 'removeFiles deletes');
  });

  it('updateApp rejects a JavaScript syntax error and keeps the working version (live regression)', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Guarded', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );
    await assert.rejects(
      h.tools.updateApp.execute(
        // The exact slip seen live: "a save = ..." instead of "var save = ...".
        { appId: created.appId, files: { 'app.js': "const view = document.body;\n  a save = view.querySelector('[data-action]');" } },
        { toolCallId: 'tc', messages: [] },
      ),
      /syntax error in app\.js/i,
    );
    assert.equal((await h.kv.get(`app:${created.appId}`, 'json')).version, 1, 'the broken update must not install');
  });

  it('editApp applies exact find/replace edits and keeps everything else (live regression)', async () => {
    const h = createAppToolsHarness();
    const appJs = "const view = document.body;\na save = view.querySelector('[data-action]');\nconsole.log(save);";
    const created = await h.tools.createApp.execute(
      { name: 'Editable', files: { ...MINIMAL_APP_FILES, 'app.js': 'void 0;' } },
      { toolCallId: 'tc', messages: [] },
    );
    // Seed the broken file through a direct source write, as a bad update would.
    const meta = await h.kv.get(`app:${created.appId}`, 'json');
    await h.r2.put(`${meta.r2Prefix}/source.json`, JSON.stringify({ ...MINIMAL_APP_FILES, 'app.js': appJs }));

    const edited = await h.tools.editApp.execute(
      { appId: created.appId, edits: [{ file: 'app.js', find: 'a save =', replace: 'var save =' }] },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(edited.status, 'updated');
    const next = await h.kv.get(`app:${created.appId}`, 'json');
    const source = JSON.parse(await (await h.r2.get(`${next.r2Prefix}/source.json`)).text());
    assert.equal(source['app.js'], appJs.replace('a save =', 'var save ='));
    assert.equal(source['index.html'], MINIMAL_APP_FILES['index.html']);
  });

  it('editApp tolerates indentation/whitespace differences when the match is still unique (live regression)', async () => {
    const h = createAppToolsHarness();
    const appJs = "function onKey(t) {\n      if (t) {\n        a save = 1;\n      }\n}";
    const created = await h.tools.createApp.execute(
      { name: 'Indented', files: { ...MINIMAL_APP_FILES, 'app.js': 'void 0;' } },
      { toolCallId: 'tc', messages: [] },
    );
    const meta = await h.kv.get(`app:${created.appId}`, 'json');
    await h.r2.put(`${meta.r2Prefix}/source.json`, JSON.stringify({ ...MINIMAL_APP_FILES, 'app.js': appJs }));
    // The model re-indented the snippet (2 spaces instead of 6/8).
    await h.tools.editApp.execute(
      { appId: created.appId, edits: [{ file: 'app.js', find: '  if (t) {\n    a save = 1;\n  }', replace: 'if (t) {\n        var save = 1;\n      }' }] },
      { toolCallId: 'tc', messages: [] },
    );
    const next = await h.kv.get(`app:${created.appId}`, 'json');
    const source = JSON.parse(await (await h.r2.get(`${next.r2Prefix}/source.json`)).text());
    assert.match(source['app.js'], /var save = 1;/);
    assert.doesNotMatch(source['app.js'], /a save/);
  });

  it('getAppSource reports exact syntax errors so fixes land on the right line (live regression)', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Diagnosed', files: { ...MINIMAL_APP_FILES, 'app.js': 'void 0;' } },
      { toolCallId: 'tc', messages: [] },
    );
    const meta = await h.kv.get(`app:${created.appId}`, 'json');
    await h.r2.put(`${meta.r2Prefix}/source.json`, JSON.stringify({
      ...MINIMAL_APP_FILES,
      'app.js': "const view = document.body;\n  a save = view.querySelector('x');",
    }));
    const source = await h.tools.getAppSource.execute({ appId: created.appId }, { toolCallId: 'tc', messages: [] });
    assert.equal(source.syntaxErrors.length, 1);
    assert.equal(source.syntaxErrors[0].file, 'app.js');
    assert.match(source.syntaxErrors[0].error, /\(2:4\)/);
    assert.equal(source.syntaxErrors[0].line, "a save = view.querySelector('x');");
  });

  it('editApp rejects missing, ambiguous, and syntax-breaking edits with actionable errors', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Strict', files: { ...MINIMAL_APP_FILES, 'app.js': 'let a = 1;\nlet b = 1;' } },
      { toolCallId: 'tc', messages: [] },
    );
    const run = (edits) => h.tools.editApp.execute({ appId: created.appId, edits }, { toolCallId: 'tc', messages: [] });
    await assert.rejects(run([{ file: 'app.js', find: 'let c', replace: 'x' }]), /not found in app\.js/);
    await assert.rejects(run([{ file: 'app.js', find: 'let   a', replace: 'x' }].map((e) => ({ ...e, find: '= 1;' }))), /more than once/);
    await assert.rejects(run([{ file: 'app.js', find: '= 1;', replace: '= 2;' }]), /more than once/);
    await assert.rejects(run([{ file: 'nope.js', find: 'x', replace: 'y' }]), /does not exist/);
    await assert.rejects(run([{ file: 'app.js', find: 'let a = 1;', replace: 'let a = ;' }]), /syntax error/i);
    assert.equal((await h.kv.get(`app:${created.appId}`, 'json')).version, 1, 'no failed edit may install');
  });

  it('createApp accepts files sent as a JSON string, including a wrapped { files } object', () => {
    const h = createAppToolsHarness();
    const flat = h.tools.createApp.inputSchema.parse({ name: 'A', files: JSON.stringify(MINIMAL_APP_FILES) });
    assert.deepEqual(flat.files, MINIMAL_APP_FILES);
    const wrapped = h.tools.createApp.inputSchema.parse({ name: 'A', files: JSON.stringify({ files: MINIMAL_APP_FILES }) });
    assert.deepEqual(wrapped.files, MINIMAL_APP_FILES);
  });

  it('updateApp appends agent revisions and records invalid ones without touching the installed bundle', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Revisions', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    // A successful update appends a valid agent revision and moves both
    // registry pointers to it.
    const updated = await h.tools.updateApp.execute(
      { appId: created.appId, files: { ...MINIMAL_APP_FILES, 'app.js': 'console.log("v2");' }, name: 'Revisions v2' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(updated.version, 2);
    let manifests = await listAppRevisionManifests(h.env, UID, created.appId);
    assert.equal(manifests.length, 2);
    assert.deepEqual(manifests.map((m) => m.author), ['agent', 'agent']);
    // Revision ids are Date.now()-based, so two saves inside one test can
    // share a millisecond; identify revisions by content, not list order.
    const updateRevision = manifests.find((m) => m.valid && m.appVersion === 2);
    assert.ok(updateRevision, 'the update appends a valid v2 revision');
    assert.equal(updated.revision, updateRevision.id, 'the tool result carries the revision id');
    let meta = await h.kv.get(`app:${created.appId}`, 'json');
    assert.equal(meta.current_revision, updateRevision.id);
    assert.equal(meta.last_valid_revision, updateRevision.id);

    // An update that fails deterministic validation records an INVALID
    // revision carrying the diagnostics, moves only current_revision, and
    // leaves the installed bundle (v2) untouched — the same contract as a
    // failed dev-deploy save.
    await assert.rejects(
      h.tools.updateApp.execute(
        {
          appId: created.appId,
          files: { ...MINIMAL_APP_FILES, 'index.html': '<script src="https://evil.example/x.js"></script>' },
        },
        { toolCallId: 'tc', messages: [] },
      ),
      /External script URLs are not allowed/,
    );

    manifests = await listAppRevisionManifests(h.env, UID, created.appId);
    assert.equal(manifests.length, 3, 'the rejected attempt is part of the history');
    const failedRevision = manifests.find((m) => !m.valid);
    assert.ok(failedRevision, 'the failed save records an invalid revision');
    assert.equal(failedRevision.author, 'agent');
    assert.equal(failedRevision.kind, 'deploy');

    meta = await h.kv.get(`app:${created.appId}`, 'json');
    assert.equal(meta.version, 2, 'the installed version did not move');
    assert.equal(meta.current_revision, failedRevision.id, 'current_revision follows the failed attempt');
    assert.equal(meta.last_valid_revision, updateRevision.id, 'the last valid pointer did not move');

    const stored = await readAppRevision(h.env, UID, created.appId, failedRevision.id);
    assert.match(stored.files['index.html'], /evil\.example/, 'the attempted source is recorded');
    assert.equal(stored.diagnostics.valid, false);
    assert.ok(stored.diagnostics.issues.some((issue) => issue.code === 'source/external-script'));

    // The installed bundle and the served source stay exactly v2.
    const installedSource = await (await h.r2.get(`apps/${UID}/${created.appId}/v2/source.json`)).json();
    assert.equal(installedSource['app.js'], 'console.log("v2");');
    const appItem = h.desktop.itemsOf('app')[0];
    assert.equal(appItem.appManifest.version, '2');
    assert.equal(appItem.name, 'Revisions v2');
    assert.equal(h.r2.keys(`apps/${UID}/${created.appId}/v3/`).length, 0, 'no v3 release may be written');
  });

  it('deleteApp removes the app from every store, trashing the icon before deleting data', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Deletable', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    // Record every destructive operation across the stores to pin the order:
    // the desktop icon must be trashed before any backing data is deleted.
    const ops = [];
    const desktopFetch = h.desktop.stub.fetch.bind(h.desktop.stub);
    h.desktop.stub.fetch = async (request) => {
      if (request.method === 'PATCH') ops.push('trash-icon');
      return desktopFetch(request);
    };
    const r2Delete = h.r2.delete.bind(h.r2);
    h.r2.delete = async (key) => {
      ops.push('r2-delete');
      return r2Delete(key);
    };
    const kvDelete = h.kv.delete.bind(h.kv);
    h.kv.delete = async (key) => {
      ops.push('kv-delete');
      return kvDelete(key);
    };
    const sqlExec = h.sql.exec.bind(h.sql);
    h.sql.exec = (query, ...params) => {
      ops.push('sql-exec');
      return sqlExec(query, ...params);
    };

    const result = await h.tools.deleteApp.execute({ appId: created.appId }, { toolCallId: 'tc', messages: [] });
    assert.equal(result.status, 'deleted');
    assert.equal(ops[0], 'trash-icon', 'the desktop icon must be trashed before any backing data is deleted');
    assert.equal(h.r2.keys(`apps/${UID}/${created.appId}/`).length, 0);
    assert.equal((await h.kv.get(`app:${created.appId}`, 'json')), null);
    assert.ok(h.sql.statements.some((s) => s.query.startsWith('DELETE FROM apps') && s.params[0] === created.appId));
    assert.deepEqual(h.appRunner.purged, [`app:${created.appId}`], 'the backend facet database must be purged');

    await assert.rejects(
      h.tools.deleteApp.execute({ appId: 'no-such-app' }, { toolCallId: 'tc', messages: [] }),
      /App no-such-app not found/,
    );
  });

  it('callAppApi reaches the owned app backend with a normalized /api path', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Backed', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );
    h.appRunner.respond(async (request) => Response.json({ echo: new URL(request.url).pathname }, { status: 201 }));

    const result = await h.tools.callAppApi.execute(
      { appId: created.appId, method: 'POST', path: 'todos', body: { title: 'milk' } },
      { toolCallId: 'tc', messages: [] },
    );
    assert.deepEqual(result, { status: 201, ok: true, data: { echo: '/api/todos' } });
    const [call] = h.appRunner.calls;
    assert.equal(call.name, `app:${created.appId}`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body), { title: 'milk' });
    assert.equal(call.config.uid, UID);
    assert.equal(call.config.requiresCapability, false);

    // Reads are free; writes ask first.
    assert.equal(await h.tools.callAppApi.needsApproval({ appId: created.appId, method: 'GET', path: '/api/todos' }), false);
    assert.equal(await h.tools.callAppApi.needsApproval({ appId: created.appId, method: 'DELETE', path: '/api/todos/1' }), true);

    const read = await h.tools.readAppApi.execute({ appId: created.appId, path: '/api/todos' }, { toolCallId: 'tc', messages: [] });
    assert.equal(h.appRunner.calls.at(-1).method, 'GET');
    assert.equal(read.status, 201);

    // Another user's (or a missing) app is not reachable.
    await h.kv.put('app:someone-else', JSON.stringify({ uid: 'other-user', version: 1 }));
    await assert.rejects(
      h.tools.callAppApi.execute({ appId: 'someone-else', method: 'GET', path: '/api/x' }, { toolCallId: 'tc', messages: [] }),
      /App someone-else not found/,
    );
  });

  it('deleteApp leaves every store intact when trashing the icon fails', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Stuck', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    // The desktop refuses to trash the icon. The tool must stop right there:
    // no data may be deleted, or the user is left with an inert icon
    // pointing at nothing.
    h.desktop.state.fail.patch = 500;
    await assert.rejects(
      h.tools.deleteApp.execute({ appId: created.appId }, { toolCallId: 'tc', messages: [] }),
      /Failed to remove app from desktop/,
    );
    assert.equal(h.desktop.itemsOf('app').length, 1, 'the icon must still be on the desktop');
    assert.ok(h.r2.keys(`apps/${UID}/${created.appId}/`).length > 0, 'R2 artifacts must not be deleted');
    assert.ok((await h.kv.get(`app:${created.appId}`, 'json')) !== null, 'the KV registry entry must not be deleted');
    assert.ok(
      !h.sql.statements.some((s) => s.query.startsWith('DELETE FROM apps') && s.params[0] === created.appId),
      'the SQL row must not be deleted',
    );
  });

  it('deleteApp reports a data-cleanup failure after the icon is already trashed', async () => {
    const h = createAppToolsHarness();
    const created = await h.tools.createApp.execute(
      { name: 'Messy', files: { ...MINIMAL_APP_FILES } },
      { toolCallId: 'tc', messages: [] },
    );

    // The icon trashes fine, but R2 refuses to list the app's files (the
    // failure mode that propagates out of deleteR2Prefix).
    const r2List = h.r2.list.bind(h.r2);
    h.r2.list = async (opts) => {
      if ((opts?.prefix ?? '').startsWith(`apps/${UID}/`)) throw new Error('R2 unavailable');
      return r2List(opts);
    };

    await assert.rejects(
      h.tools.deleteApp.execute({ appId: created.appId }, { toolCallId: 'tc', messages: [] }),
      (error) => {
        assert.match(error.message, /App removed from the desktop, but cleaning up its data failed/);
        assert.match(error.message, /app files \(R2 unavailable\)/);
        return true;
      },
    );
    // The icon is already trashed — the user cannot launch a broken app,
    // which is the safer failure.
    assert.equal(h.desktop.itemsOf('app').length, 0, 'the icon must be trashed even when data cleanup fails');
    // The cleanup is best-effort: the other stores are still deleted.
    assert.equal(await h.kv.get(`app:${created.appId}`, 'json'), null, 'KV cleanup must still run');
    assert.ok(
      h.sql.statements.some((s) => s.query.startsWith('DELETE FROM apps') && s.params[0] === created.appId),
      'SQL cleanup must still run',
    );
  });

  it('buildAppFromPrompt generates, validates and installs an app via the AI binding', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Pomodoro Timer',
          purpose: 'A focus timer that alternates work and break sessions.',
          screens: [
            { name: 'Timer', summary: 'The countdown with start/pause controls.' },
          ],
          width: 480,
          height: 420,
        }),
      },
      {
        response: JSON.stringify({
          files: {
            ...MINIMAL_APP_FILES,
            'app.js': 'console.log("pomodoro");',
          },
        }),
      },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a pomodoro timer app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(result.name, 'Pomodoro Timer');
    // A hermetic spec derives no permissions — the app runs with none.
    assert.deepEqual(result.permissions, {});
    assert.equal(h.desktop.itemsOf('app').length, 1);
    // The generator was called for the spec and for the files.
    assert.equal(h.ai.calls.length, 2);
    assert.match(h.ai.calls[0].inputs.messages.at(-1).content, /pomodoro timer app/);
  });

  it('buildAppFromPrompt runs the spec stage first and derives the manifest permissions from the spec', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      // 1st model call: the spec stage — declares an image read and profile use.
      {
        response: JSON.stringify({
          name: 'Photo Grid',
          purpose: "Shows the user's photos as a scrollable grid.",
          screens: [
            {
              name: 'Grid',
              summary: 'All photos, newest first.',
              emptyState: 'A hint to upload photos when none exist yet.',
            },
          ],
          dataReads: [{ kind: 'fs', mimeTypes: ['image/*'] }],
          profileFields: ['displayName'],
          rationale: 'Reads the photo library to build the grid.',
        }),
      },
      // 2nd model call: file generation — no permissions field at all, proving
      // the file generator cannot invent permissions; the manifest gets the
      // ones derived from the spec.
      {
        response: JSON.stringify({
          files: { ...MINIMAL_APP_FILES, 'app.js': 'console.log("grid");' },
        }),
      },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build a gallery app for my photos' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');

    // The spec stage ran first (its prompt carries the user request), file
    // generation second (its prompt carries the spec + derived permissions).
    assert.equal(h.ai.calls.length, 2);
    assert.match(h.ai.calls[0].inputs.messages.at(-1).content, /gallery app for my photos/);
    const filesPrompt = h.ai.calls[1].inputs.messages.at(-1).content;
    assert.match(filesPrompt, /Photo Grid/, 'the files stage receives the spec');
    assert.match(filesPrompt, /image\/\*/, 'the files stage receives the permissions derived from the spec');

    // The installed manifest carries the derived permissions even though the
    // file generator never declared any.
    const appItem = h.desktop.itemsOf('app')[0];
    assert.deepEqual(appItem.appManifest.permissions, {
      fs: { mimeTypes: ['image/*'] },
      profile: { read: ['displayName'] },
    });
    // The spec's one-line purpose is the manifest description.
    assert.equal(appItem.appManifest.description, "Shows the user's photos as a scrollable grid.");
    // And the persisted metadata declares the same permissions.
    const metadata = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/metadata.json`));
    assert.deepEqual(metadata.permissions, {
      fs: { mimeTypes: ['image/*'] },
      profile: { read: ['displayName'] },
    });
  });

  it('a todo-app request goes through the spec stage, not a curated template', async () => {
    // Regression (CORE-ROADMAP Workstream 3, Phase A): the curated-template
    // tool used to hand the todo template straight to createAndRegisterApp,
    // bypassing the spec stage entirely. Curated templates are demoted to
    // test fixtures (test/fixtures/apps/templates/) — the production tool
    // factory must no longer offer the tool at all, so a "build me a todo
    // app" request can only be served by buildAppFromPrompt, which runs
    // buildSpecFromPrompt first.
    const h = createAppToolsHarness();
    assert.equal(
      'createCuratedApp' in h.tools, false,
      'the curated-template tool must not exist on the production tool factory',
    );

    h.ai.script.push(
      // 1st model call: the spec stage — where the todo request now lands.
      {
        response: JSON.stringify({
          name: 'Tasks',
          purpose: 'A focused task list with filters and quick keyboard actions.',
          screens: [
            {
              name: 'Tasks',
              summary: 'The task list with filters and a composer.',
              emptyState: 'An invitation to add the first task.',
            },
          ],
          storageKeys: ['tasks.items'],
        }),
      },
      // 2nd model call: file generation, driven by the spec.
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a todo list app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(h.desktop.itemsOf('app').length, 1);

    // The request went through the spec stage first (its prompt carries the
    // user's todo request), then file generation (its prompt carries the spec).
    assert.equal(h.ai.calls.length, 2);
    assert.match(h.ai.calls[0].inputs.messages.at(-1).content, /todo list app/);
    const filesPrompt = h.ai.calls[1].inputs.messages.at(-1).content;
    assert.match(filesPrompt, /Tasks/, 'the files stage receives the spec');
    assert.match(filesPrompt, /tasks\.items/, 'the files stage receives the spec storage keys');

    // The spec drives the installed app.
    const appItem = h.desktop.itemsOf('app')[0];
    assert.equal(appItem.appManifest.name, 'Tasks');
    assert.equal(appItem.appManifest.description, 'A focused task list with filters and quick keyboard actions.');
  });

  it('buildAppFromPrompt repairs an invalid spec through the validation loop before any file is generated', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      // 1st spec attempt: rejected by deterministic spec validation (no
      // screens, a URL instead of a hostname, an unscoped read).
      {
        response: JSON.stringify({
          name: 'Weather',
          purpose: 'Shows the current weather.',
          screens: [],
          dataReads: [{ kind: 'fs' }],
          networkDomains: ['https://api.weather.example.com/forecast'],
        }),
      },
      // 2nd spec attempt: every issue fixed.
      {
        response: JSON.stringify({
          name: 'Weather',
          purpose: 'Shows the current weather.',
          screens: [
            { name: 'Today', summary: 'Current conditions.', emptyState: 'A prompt to pick a city.' },
          ],
          dataReads: [{ kind: 'fs', mimeTypes: ['text/*'] }],
          networkDomains: ['api.weather.example.com'],
        }),
      },
      // 3rd call: file generation, only after the spec validated.
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build a weather app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');

    // The rejected spec was fed back into the regeneration prompt by its
    // actual validation codes, and no files were generated before it passed.
    assert.equal(h.ai.calls.length, 3);
    const retryPrompt = h.ai.calls[1].inputs.messages.at(-1).content;
    assert.match(retryPrompt, /spec\/empty-screens/);
    assert.match(retryPrompt, /spec\/invalid-network-domain/);
    assert.match(retryPrompt, /spec\/data-read-without-scope/);

    const appItem = h.desktop.itemsOf('app')[0];
    assert.deepEqual(appItem.appManifest.permissions, {
      fs: { mimeTypes: ['text/*'] },
      network: { outbound: ['api.weather.example.com'] },
    });
  });

  it('buildAppFromPrompt derives fs write/delete permissions when the spec declares desktop-file writes', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      // Spec stage: the app saves notes as real desktop files (and lists
      // what it saved), keeping only its draft in private storage.
      {
        response: JSON.stringify({
          name: 'Note Saver',
          purpose: "Saves the user's quick notes as markdown files on their desktop.",
          screens: [
            {
              name: 'Notes',
              summary: 'Saved notes with a compose box.',
              emptyState: 'A prompt to write the first note.',
            },
          ],
          dataReads: [{ kind: 'fs', paths: ['/Notes/**'] }],
          dataWrites: [{ kind: 'fs', paths: ['/Notes/**'], deletePaths: ['/Notes/**'] }],
          storageKeys: ['notesaver.draft'],
        }),
      },
      // File generation: no permissions field — the manifest gets the
      // permissions derived from the spec.
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'save my notes as desktop files I can open anywhere' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(h.ai.calls.length, 2);

    // The manifest carries read + write + delete, all derived from the spec,
    // in the same path-glob shape chat-supplied apps declare.
    const expected = { fs: { read: ['/Notes/**'], write: ['/Notes/**'], delete: ['/Notes/**'] } };
    const appItem = h.desktop.itemsOf('app')[0];
    assert.deepEqual(appItem.appManifest.permissions, expected);
    const metadata = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/metadata.json`));
    assert.deepEqual(metadata.permissions, expected);
    // The private storage key still derives no permission.
    assert.deepEqual(Object.keys(expected.fs), ['read', 'write', 'delete']);
  });

  it('buildAppFromPrompt runs server.js before install and repairs a crashing route', async () => {
    const h = createAppToolsHarness();
    const html = '<!DOCTYPE html><html><head><link rel="stylesheet" href="./styles.css"></head><body><ul id="l"></ul><script type="module" src="./app.js"></script></body></html>';
    const appJs = "const l = document.getElementById('l');\nconst load = async () => { try { l.textContent = (await window.eternal.api.get('/todos')).length; } catch (e) { l.textContent = e.message; } };\nwindow.eternal.api.onChange(load);\nload();";
    const brokenServer = "export default {\n  async fetch(request, env) {\n    return Response.json(env.sql.exec('SELECT * FROM todos').toArray());\n  },\n};";
    const fixedServer = "export default {\n  async fetch(request, env) {\n    env.sql.exec('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, title TEXT)');\n    return Response.json(env.sql.exec('SELECT * FROM todos').toArray());\n  },\n};";

    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Todos',
          purpose: 'Tracks todos on the server.',
          screens: [{ name: 'List', summary: 'All todos.', emptyState: 'No todos yet.' }],
          backend: {
            routes: ['GET /api/todos', 'POST /api/todos', 'GET /api/todos/:id', 'GET /api/todos'],
            tables: ['todos(id INTEGER PRIMARY KEY, title TEXT)'],
          },
          width: 480,
          height: 520,
        }),
      },
      { response: JSON.stringify({ files: { 'index.html': html, 'styles.css': 'ul{margin:0}', 'app.js': appJs, 'server.js': brokenServer } }) },
      { response: JSON.stringify({ files: { 'server.js': fixedServer } }) },
    );

    // First probe: the cold start answers, the list route crashes on the
    // fresh database. Second probe (after repair): everything answers.
    let probeRound = 0;
    h.appRunner.respondToProbe(async (input) => {
      probeRound += 1;
      return input.requests.map((request) => (
        probeRound === 1 && request.path === '/api/todos'
          ? { ...request, status: 500, error: 'no such table: todos: SQLITE_ERROR' }
          : { ...request, status: request.path === '/api/todos' ? 200 : 404 }
      ));
    });

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a todo app that saves on the server' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');

    // Probed twice, each on a throwaway runner, with a cold-start request
    // plus only the parameter-free GET routes (deduplicated).
    assert.equal(h.appRunner.probes.length, 2);
    for (const probe of h.appRunner.probes) {
      assert.match(probe.name, /^probe:/);
      assert.deepEqual(probe.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/__eternal_probe', 'GET /api/todos']);
      assert.match(JSON.stringify(probe.bundle.modules), /AppBackend/);
    }
    assert.notEqual(h.appRunner.probes[0].name, h.appRunner.probes[1].name);

    // The repair targeted server.js with the failing route and the error.
    assert.equal(h.ai.calls.length, 3);
    const repairPrompt = h.ai.calls[2].inputs.messages.at(-1).content;
    assert.match(repairPrompt, /\[runtime\/backend-error\] — server\.js/);
    assert.match(repairPrompt, /GET \/api\/todos returned 500/);
    assert.match(repairPrompt, /no such table: todos/);
    assert.match(repairPrompt, /CREATE TABLE IF NOT EXISTS/);

    const storedSource = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/source.json`));
    assert.equal(storedSource['server.js'], fixedServer);
    assert.equal(storedSource['app.js'], appJs);
  });

  it('backend probe failures caused only by the no-network sandbox do not block install', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Weather',
          purpose: 'Shows the weather.',
          screens: [{ name: 'Now', summary: 'Current weather.', emptyState: 'Loading.' }],
          networkDomains: ['api.weather.example'],
          backend: { routes: ['GET /api/now'], tables: [] },
          width: 400,
          height: 400,
        }),
      },
      {
        response: JSON.stringify({
          files: {
            'index.html': '<!DOCTYPE html><html><body><p id="o"></p><script type="module" src="./app.js"></script></body></html>',
            'app.js': "window.eternal.api.get('/now').then((d) => { document.getElementById('o').textContent = d.temp; }).catch(() => {});",
            'server.js': "export default { async fetch() { const r = await fetch('https://api.weather.example/now'); return Response.json(await r.json()); } };",
          },
        }),
      },
    );
    h.appRunner.respondToProbe(async (input) => input.requests.map((request) => (
      request.path === '/api/now'
        ? { ...request, status: 500, error: 'This worker is not permitted to access the internet', networkBlocked: true }
        : { ...request, status: 404 }
    )));
    const result = await h.tools.buildAppFromPrompt.execute({ prompt: 'weather app' }, { toolCallId: 'tc', messages: [] });
    assert.equal(result.status, 'created');
    assert.equal(h.ai.calls.length, 2, 'no repair round for a sandbox-only network failure');
  });

  it('buildAppFromPrompt repairs a runtime-contract mismatch by patching only the failing file (Photo Grid regression)', async () => {
    // CORE-ROADMAP Workstream 3, Phase C. The first generation of the
    // reference Photo Grid app reaches for localStorage — a deterministic
    // SecurityError in the opaque-origin app iframe. The targeted repair
    // pass must feed back ONLY the failing file (app.js) plus the
    // structured issue, ask for a patched version of just that file, and
    // install the merged bundle. No blind full regeneration, no raised
    // attempt budget.
    const h = createAppToolsHarness();
    const reference = readFixtureFiles('photo-grid');
    // Swap the bridge-storage line the fixture uses for its tile-size
    // preference for the blocked browser API.
    const storageLine = "window.eternal.storage.set('photo-grid.tileSize', size).catch(() => {});";
    assert.ok(
      reference['app.js'].includes(storageLine),
      'the Photo Grid fixture must still contain the storage.set line this test swaps out',
    );
    const badAppJs = reference['app.js'].replace(
      storageLine,
      "localStorage.setItem('photo-grid.tileSize', size);",
    );
    const derivedPermissions = { fs: { mimeTypes: ['image/*'] } };

    // Precondition, pinned: the first generation is a valid Photo Grid
    // bundle whose ONLY problem is one unguarded localStorage use in
    // app.js — exactly the shape targeted repair exists for.
    const badIssues = collectAppBundleIssues({
      files: { ...reference, 'app.js': badAppJs },
      manifest: {
        entryHtml: 'index.html',
        sourceFiles: ['app.js', 'index.html', 'styles.css'],
        runtimeAsset: 'eternal-runtime.js',
        workerEntrypoint: '__eternal_worker__.js',
      },
      permissions: derivedPermissions,
    });
    assert.deepEqual(
      badIssues.map((issue) => [issue.code, issue.file]),
      [['sandbox/blocked-storage', 'app.js']],
    );

    h.ai.script.push(
      // 1st model call: the spec stage — Photo Grid reads images and keeps
      // its tile-size preference in private storage.
      {
        response: JSON.stringify({
          name: 'Photo Grid',
          purpose: "Shows the user's photos as a scrollable grid.",
          screens: [
            {
              name: 'Grid',
              summary: 'All photos, newest first.',
              emptyState: 'A hint to upload photos when none exist yet.',
            },
          ],
          dataReads: [{ kind: 'fs', mimeTypes: ['image/*'] }],
          storageKeys: ['photo-grid.tileSize'],
          width: 880,
          height: 620,
        }),
      },
      // 2nd model call: full file generation — the reference bundle except
      // app.js persists the tile size through localStorage.
      {
        response: JSON.stringify({
          files: { ...reference, 'app.js': badAppJs },
        }),
      },
      // 3rd model call: the targeted repair — a patched app.js only.
      {
        response: JSON.stringify({
          files: { 'app.js': reference['app.js'] },
        }),
      },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a gallery app for my photos' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(result.name, 'Photo Grid');
    assert.deepEqual(result.permissions, derivedPermissions);

    // Spec, full generation, targeted repair — nothing more.
    assert.equal(h.ai.calls.length, 3);

    // The repair prompt is targeted: the failing file's current content
    // plus the structured issue with its fix — and none of the files that
    // validated clean.
    const repairPrompt = h.ai.calls[2].inputs.messages.at(-1).content;
    assert.match(repairPrompt, /Files to patch/);
    assert.match(repairPrompt, /--- app\.js \(current content\) ---/);
    assert.match(repairPrompt, /localStorage\.setItem\('photo-grid\.tileSize', size\)/);
    assert.match(repairPrompt, /\[sandbox\/blocked-storage\] — app\.js/);
    assert.match(repairPrompt, /fix: Use window\.eternal\.storage/);
    assert.ok(!repairPrompt.includes(reference['index.html']), 'clean files must not be fed back');
    assert.ok(!repairPrompt.includes(reference['styles.css']), 'clean files must not be fed back');

    // The merged bundle installed: the patched app.js replaced the failing
    // one, everything else kept from the first generation.
    const appItem = h.desktop.itemsOf('app')[0];
    assert.equal(appItem.appManifest.name, 'Photo Grid');
    assert.deepEqual(appItem.appManifest.permissions, derivedPermissions);
    const storedSource = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/source.json`));
    assert.equal(storedSource['app.js'], reference['app.js']);
    assert.ok(!storedSource['app.js'].includes('localStorage'), 'the installed app.js must be the patched version');
    assert.equal(storedSource['index.html'], reference['index.html']);
    assert.equal(storedSource['styles.css'], reference['styles.css']);

    // The installed artifacts, re-validated, are clean.
    const storedWorkspace = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/workspace.json`));
    const storedMetadata = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/metadata.json`));
    assert.deepEqual(
      collectAppBundleIssues({
        files: storedSource,
        manifest: storedWorkspace,
        permissions: storedMetadata.permissions,
      }),
      [],
      'the installed bundle must pass the deterministic post-bundle validation',
    );
  });

  it('a targeted repair that does not converge falls back to a full regeneration within the same budget', async () => {
    const h = createAppToolsHarness();
    // First generation persists state through localStorage; the targeted
    // patch swaps it for sessionStorage — still blocked — so the repair
    // does not converge and the final attempt must be today's full
    // regeneration.
    const badAppJs = `${MINIMAL_APP_FILES['app.js']}\nlocalStorage.setItem('k', 'v');`;
    const stillBadAppJs = `${MINIMAL_APP_FILES['app.js']}\nsessionStorage.setItem('k', 'v');`;

    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Prefs',
          purpose: 'Keeps a small preference.',
          screens: [{ name: 'Main', summary: 'The preference.', emptyState: 'A hint.' }],
          storageKeys: ['prefs.k'],
        }),
      },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES, 'app.js': badAppJs } }) },
      { response: JSON.stringify({ files: { 'app.js': stillBadAppJs } }) },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a small preferences app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');

    // Spec + 3 attempts — the budget did not grow for the targeted pass.
    assert.equal(h.ai.calls.length, 4);

    // Attempt 1 was the targeted pass (only the failing file fed back)…
    const repairPrompt = h.ai.calls[2].inputs.messages.at(-1).content;
    assert.match(repairPrompt, /Files to patch/);
    assert.match(repairPrompt, /\[sandbox\/blocked-storage\]/);
    assert.ok(!repairPrompt.includes(MINIMAL_APP_FILES['index.html']));

    // …and attempt 2 fell back to today's full regeneration, carrying the
    // latest validation issues.
    const regenPrompt = h.ai.calls[3].inputs.messages.at(-1).content;
    assert.match(regenPrompt, /Build a desktop web app/);
    assert.match(regenPrompt, /Previous attempt failed deterministic app validation/);
    assert.match(regenPrompt, /\[sandbox\/blocked-storage\]/);
    assert.ok(!regenPrompt.includes('Files to patch'));

    // The installed app is the fully regenerated bundle.
    const storedSource = JSON.parse(h.r2.objects.get(`apps/${UID}/${result.appId}/source.json`));
    assert.equal(storedSource['app.js'], MINIMAL_APP_FILES['app.js']);
  });

  it('a targeted patch returning files outside the failing set is rejected and the loop regenerates in full', async () => {
    const h = createAppToolsHarness();
    const badAppJs = `${MINIMAL_APP_FILES['app.js']}\nlocalStorage.setItem('k', 'v');`;

    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Broken',
          purpose: 'An app that needs one repair.',
          screens: [{ name: 'Main', summary: 'One screen.', emptyState: 'A hint.' }],
          storageKeys: ['broken.k'],
        }),
      },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES, 'app.js': badAppJs } }) },
      // The repair ignores instructions and returns a brand-new file.
      { response: JSON.stringify({ files: { 'patched.js': 'console.log("x");' } }) },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me an app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(h.ai.calls.length, 4);

    // The final attempt was a FULL regeneration that still saw the original
    // bundle issues — a rejected patch must not erase them from the
    // repair context.
    const regenPrompt = h.ai.calls[3].inputs.messages.at(-1).content;
    assert.match(regenPrompt, /Previous attempt failed deterministic app validation/);
    assert.match(regenPrompt, /\[sandbox\/blocked-storage\]/);
    assert.ok(!regenPrompt.includes('repair/invalid-patch'));
  });

  it('issues that name no file skip the targeted pass and regenerate in full', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'NoHtml',
          purpose: 'An app that forgets its HTML entry.',
          screens: [{ name: 'Main', summary: 'One screen.', emptyState: 'A hint.' }],
        }),
      },
      // No HTML at all: entry/no-html carries no file to patch.
      { response: JSON.stringify({ files: { 'app.js': 'console.log("x");' } }) },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const result = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me an app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(result.status, 'created');
    assert.equal(h.ai.calls.length, 3);

    // The retry was a full regeneration, not a targeted patch.
    const retryPrompt = h.ai.calls[2].inputs.messages.at(-1).content;
    assert.match(retryPrompt, /Previous attempt failed deterministic app validation/);
    assert.match(retryPrompt, /\[entry\/no-html\]/);
    assert.ok(!retryPrompt.includes('Files to patch'));
  });

  it('buildAppFromPrompt reports a generation failure clearly and writes nothing', async () => {
    const h = createAppToolsHarness();
    // generateObject fails, and the generateText fallback fails too.
    h.ai.script.push(
      { response: 'not json at all' },
      { response: 'still not json' },
    );

    await assert.rejects(
      h.tools.buildAppFromPrompt.execute(
        { prompt: 'build me a pomodoro timer app' },
        { toolCallId: 'tc', messages: [] },
      ),
      /Generating app specification failed:.*fallback failed:/,
    );
    assert.equal(h.r2.keys('apps/').length, 0, 'a failed generation must not write artifacts');
    assert.equal(h.kv.keys().filter((k) => k.startsWith('app:')).length, 0);
    assert.equal(h.desktop.itemsOf('app').length, 0);
  });

  it('previewAppFromPrompt stages a preview and installAppPreview installs it once', async () => {
    const h = createAppToolsHarness();
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Preview App',
          purpose: 'A tiny app staged for preview.',
          screens: [{ name: 'Main', summary: 'One screen.' }],
          width: 400,
          height: 320,
        }),
      },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );

    const preview = await h.tools.previewAppFromPrompt.execute(
      { prompt: 'preview a tiny app' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(preview.status, 'preview-ready');
    assert.ok(preview.previewId);
    assert.ok(preview.expiresAt > Date.now());
    assert.equal(h.desktop.itemsOf('app').length, 0, 'a preview must not install anything');

    const previewKeys = h.r2.keys(`app-previews/${UID}/${preview.previewId}/`);
    assert.equal(previewKeys.length, 4);
    assert.ok(await h.kv.get(`app-preview:${preview.previewId}`, 'json'));

    const installed = await h.tools.installAppPreview.execute(
      { previewId: preview.previewId },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(installed.status, 'created');
    assert.equal(h.desktop.itemsOf('app').length, 1);
    // The preview is consumed on install.
    assert.equal(h.r2.keys(`app-previews/${UID}/${preview.previewId}/`).length, 0);
    assert.equal(await h.kv.get(`app-preview:${preview.previewId}`, 'json'), null);

    await assert.rejects(
      h.tools.installAppPreview.execute({ previewId: preview.previewId }, { toolCallId: 'tc', messages: [] }),
      /Preview \S+ not found/,
    );
  });

  it('installAppPreview rejects foreign and expired previews clearly', async () => {
    const h = createAppToolsHarness();
    await assert.rejects(
      h.tools.installAppPreview.execute({ previewId: 'ghost' }, { toolCallId: 'tc', messages: [] }),
      /Preview ghost not found/,
    );

    h.kv.store.set('app-preview:foreign', JSON.stringify({
      uid: 'someone-else', name: 'X', width: 400, height: 320, files: {},
    }));
    await assert.rejects(
      h.tools.installAppPreview.execute({ previewId: 'foreign' }, { toolCallId: 'tc', messages: [] }),
      /Preview foreign not found/,
    );

    h.kv.store.set('app-preview:expired', JSON.stringify({
      uid: UID, name: 'X', width: 400, height: 320, expiresAt: Date.now() - 1000,
    }));
    await assert.rejects(
      h.tools.installAppPreview.execute({ previewId: 'expired' }, { toolCallId: 'tc', messages: [] }),
      /App preview expired; generate a new preview/,
    );
  });

  it('one app survives build -> edit -> preview -> reinstall, and rollback returns to the pre-preview release', async () => {
    // CORE-ROADMAP "Open gaps" W3: the journey was only covered leg-by-leg
    // (updateApp, previewAppFromPrompt, installAppPreview each in
    // isolation). This drives ONE app through the whole sequence on the
    // Photo Grid fixture: build -> user-approved grants -> edit ->
    // app-written storage -> preview a change targeted at the installed
    // app -> reinstall -> grant the newly declared scope -> rollback.
    //
    // The contract under test: installing a preview that was staged FOR an
    // installed app reinstalls THAT app — the previewed bundle becomes the
    // app's next release on the SAME desktop item (no duplicate icon), the
    // appId is unchanged so eternal.storage keys survive, and grants are
    // untouched by the reinstall itself (the change may declare new scopes,
    // but only the permissions route — with the user's approval — can
    // grant them). The release rollback then returns the pre-preview
    // version, narrowing grants back to that release's declaration.
    const h = createAppToolsHarness();
    const reference = readFixtureFiles('photo-grid');
    const grantedRead = { fs: { read: ['/**'], mimeTypes: ['image/*'] } };
    const auth = { uid: UID, username: 'jane', kind: 'session' };

    // The previewed change: the grid greets the user by display name — a
    // DECLARED new permission (profile.read) the user has not granted.
    const changedAppJs = [
      reference['app.js'],
      'async function greetUser() {',
      '  try {',
      '    const profile = await window.eternal.profile.get();',
      '    if (profile && profile.displayName) {',
      '      elements.summary.textContent = `Hi ${profile.displayName}`;',
      '    }',
      '  } catch {',
      '    // Profile not granted — the greeting is optional.',
      '  }',
      '}',
      'greetUser();',
    ].join('\n');

    // --- Build: the scripted binding returns a Photo Grid spec, then files.
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Photo Grid',
          purpose: "Shows the user's photos as a scrollable grid.",
          screens: [
            {
              name: 'Grid',
              summary: 'All photos, newest first.',
              emptyState: 'A hint to upload photos when none exist yet.',
            },
          ],
          dataReads: [{ kind: 'fs', paths: ['/**'], mimeTypes: ['image/*'] }],
          storageKeys: ['photo-grid.tileSize'],
          width: 880,
          height: 620,
        }),
      },
      { response: JSON.stringify({ files: { ...reference } }) },
    );

    const built = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a gallery app for my photos' },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(built.status, 'created');
    const appId = built.appId;

    // The agentrevisions slice has landed on this base: the install froze a
    // valid agent revision and both registry pointers moved to it.
    const buildRevisions = await listAppRevisionManifests(h.env, UID, appId);
    assert.equal(buildRevisions.length, 1);
    assert.equal(buildRevisions[0].kind, 'deploy');
    assert.equal(buildRevisions[0].author, 'agent');
    assert.equal(buildRevisions[0].valid, true);
    const builtMeta = await h.kv.get(`app:${appId}`, 'json');
    assert.equal(builtMeta.current_revision, buildRevisions[0].id);
    assert.equal(builtMeta.last_valid_revision, buildRevisions[0].id);

    // The user approves the declared read through the REAL permissions
    // route — the only path that widens grants. `/**` is a broad fs glob,
    // so the request carries its explicit approval tick.
    const grantRes = await handleAppPermissions(
      new Request(`https://eternalos.test/api/apps/${appId}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify({ granted: grantedRead, broadApprovals: ['fs.read'] }),
      }),
      h.env,
      auth,
      appId,
    );
    assert.equal(grantRes.status, 200);
    const firstGrant = await grantRes.json();
    assert.deepEqual(firstGrant.granted, grantedRead);

    // --- Edit: updateApp writes v2. Grants are neither widened nor lost.
    const updated = await h.tools.updateApp.execute(
      {
        appId,
        files: { ...reference, 'app.js': `${reference['app.js']}\nconsole.log('v2');` },
      },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(updated.status, 'updated');
    assert.equal(updated.version, 2);
    assert.deepEqual((await h.kv.get(`app:${appId}`, 'json')).granted, grantedRead);
    assert.deepEqual(
      h.desktop.itemsOf('app')[0].grantedPermissions,
      grantedRead,
      'the edit must not widen (or drop) grants',
    );

    // The running app persists its tile-size preference through the storage
    // bridge — the exact key and serialization EternalService.storageSet
    // writes (app-storage:{uid}:{appId}:{key}, JSON.stringify'd value).
    await h.kv.put(`app-storage:${UID}:${appId}:photo-grid.tileSize`, JSON.stringify('large'));

    // --- Preview a change to the installed app, targeted at its appId.
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Photo Grid',
          purpose: "Shows the user's photos as a scrollable grid with a personal greeting.",
          screens: [
            {
              name: 'Grid',
              summary: 'All photos, newest first, greeted by name.',
              emptyState: 'A hint to upload photos when none exist yet.',
            },
          ],
          dataReads: [{ kind: 'fs', paths: ['/**'], mimeTypes: ['image/*'] }],
          profileFields: ['displayName'],
          storageKeys: ['photo-grid.tileSize'],
          width: 880,
          height: 620,
        }),
      },
      { response: JSON.stringify({ files: { ...reference, 'app.js': changedAppJs } }) },
    );

    const preview = await h.tools.previewAppFromPrompt.execute(
      { prompt: 'add a greeting with my display name to my Photo Grid app', appId },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(preview.status, 'preview-ready');
    assert.equal(h.desktop.itemsOf('app').length, 1, 'a preview must not touch the desktop');
    const previewMeta = await h.kv.get(`app-preview:${preview.previewId}`, 'json');
    assert.equal(previewMeta.targetAppId, appId, 'the staged preview is linked to the app it changes');

    // --- Reinstall: installing the targeted preview updates app A in place.
    const reinstalled = await h.tools.installAppPreview.execute(
      { previewId: preview.previewId },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(reinstalled.status, 'updated');
    assert.equal(reinstalled.appId, appId, 'the reinstall keeps the app id');
    assert.equal(reinstalled.itemId, built.itemId, 'the reinstall keeps the SAME desktop item — no duplicate icon');
    assert.equal(reinstalled.version, 3);

    // The installed bundle is the previewed one, and there is still exactly
    // one app on the desktop.
    const appItems = h.desktop.itemsOf('app');
    assert.equal(appItems.length, 1, 'no duplicate icon after the reinstall');
    const item = appItems[0];
    assert.equal(item.id, built.itemId);
    assert.equal(item.appManifest.version, '3');
    const v3Source = JSON.parse(h.r2.objects.get(`apps/${UID}/${appId}/v3/source.json`));
    assert.equal(v3Source['app.js'], changedAppJs, 'the installed bundle is the previewed one');

    // The change's new declaration travels with the release (the greeting
    // needs profile), but grants are unchanged: the reinstall itself never
    // grants anything, and the previously approved read survives with its
    // approval metadata intact (not re-dated by the reinstall).
    assert.deepEqual(item.appManifest.permissions, {
      fs: { read: ['/**'], mimeTypes: ['image/*'] },
      profile: { read: ['displayName'] },
    });
    assert.deepEqual(item.grantedPermissions, grantedRead, 'a reinstall must not widen grants');
    assert.equal(
      item.grantedPermissionApprovals['fs.read'].approvedAt,
      firstGrant.approvals['fs.read'].approvedAt,
      'the reinstall must not re-date the existing approval',
    );
    const reinstalledMeta = await h.kv.get(`app:${appId}`, 'json');
    assert.deepEqual(reinstalledMeta.granted, grantedRead);
    assert.equal(reinstalledMeta.version, 3);

    // The reinstall appends a valid agent revision, like any other release.
    const revisions = await listAppRevisionManifests(h.env, UID, appId);
    const reinstallRevision = revisions.find((m) => m.appVersion === 3 && m.valid);
    assert.ok(reinstallRevision, 'the reinstall is recorded as a valid v3 revision');
    assert.equal(reinstallRevision.kind, 'deploy');
    assert.equal(reinstallRevision.author, 'agent');

    // Storage the app wrote before the edit is still readable after the
    // reinstall — same appId, same keys (EternalService.storageGet's read).
    assert.deepEqual(
      JSON.parse(await h.kv.get(`app-storage:${UID}:${appId}:photo-grid.tileSize`)),
      'large',
    );

    // The "unless the change declared and was granted more" leg: the user
    // grants the newly declared profile scope through the same permissions
    // route — the only way grants ever widen.
    const widened = await handleAppPermissions(
      new Request(`https://eternalos.test/api/apps/${appId}/permissions`, {
        method: 'PATCH',
        body: JSON.stringify({
          granted: {
            fs: { read: ['/**'], mimeTypes: ['image/*'] },
            profile: { read: ['displayName'] },
          },
          broadApprovals: ['fs.read'],
        }),
      }),
      h.env,
      auth,
      appId,
    );
    assert.equal(widened.status, 200);
    assert.deepEqual((await widened.json()).granted, {
      fs: { read: ['/**'], mimeTypes: ['image/*'] },
      profile: { read: ['displayName'] },
    });

    // --- Rollback returns to the pre-preview release (v2).
    const rollbackRes = await handleAppRollback(
      new Request(`https://eternalos.test/api/apps/${appId}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ version: 2 }),
      }),
      h.env,
      auth,
      appId,
    );
    assert.equal(rollbackRes.status, 200);
    assert.deepEqual(await rollbackRes.json(), { success: true, version: 2, appId });

    const rolledBackItem = h.desktop.itemsOf('app')[0];
    assert.equal(rolledBackItem.id, built.itemId, 'rollback keeps the same icon too');
    assert.equal(rolledBackItem.appManifest.version, '2');
    const v2Source = JSON.parse(h.r2.objects.get(`apps/${UID}/${appId}/v2/source.json`));
    assert.match(v2Source['app.js'], /console\.log\('v2'\)/, 'the pre-preview release is what runs again');
    const rolledBackMeta = await h.kv.get(`app:${appId}`, 'json');
    assert.equal(rolledBackMeta.version, 2);

    // Grants only ever narrow on rollback: v2 declares no profile scope, so
    // the widened grant falls away and the approved read stays.
    assert.deepEqual(rolledBackItem.grantedPermissions, grantedRead);

    // And the app's storage survives the rollback as well.
    assert.deepEqual(
      JSON.parse(await h.kv.get(`app-storage:${UID}:${appId}:photo-grid.tileSize`)),
      'large',
    );
  });

  it('a failed preview reinstall keeps the previous release and leaves the preview retryable', async () => {
    // The failure point of the journey's reinstall leg: the desktop refuses
    // the update mid-reinstall. The previous release must stay installed,
    // the half-written release must be cleaned up, and the preview must NOT
    // be consumed — the user can fix the desktop and retry.
    const h = createAppToolsHarness();
    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Sturdy',
          purpose: 'An app that survives a failed reinstall.',
          screens: [{ name: 'Main', summary: 'One screen.', emptyState: 'A hint.' }],
        }),
      },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES } }) },
    );
    const built = await h.tools.buildAppFromPrompt.execute(
      { prompt: 'build me a sturdy app' },
      { toolCallId: 'tc', messages: [] },
    );

    h.ai.script.push(
      {
        response: JSON.stringify({
          name: 'Sturdy',
          purpose: 'An app that survives a failed reinstall.',
          screens: [{ name: 'Main', summary: 'One changed screen.', emptyState: 'A hint.' }],
        }),
      },
      { response: JSON.stringify({ files: { ...MINIMAL_APP_FILES, 'app.js': 'console.log("changed");' } }) },
    );
    const preview = await h.tools.previewAppFromPrompt.execute(
      { prompt: 'change the app', appId: built.appId },
      { toolCallId: 'tc', messages: [] },
    );

    h.desktop.state.fail.patch = 500;
    await assert.rejects(
      h.tools.installAppPreview.execute({ previewId: preview.previewId }, { toolCallId: 'tc', messages: [] }),
      /Build failed during .*Failed to update desktop item \(500\)/,
    );

    // The previous release is what remains: v1 still installed everywhere.
    assert.equal(h.desktop.itemsOf('app').length, 1);
    assert.equal(h.desktop.itemsOf('app')[0].appManifest.version, '1');
    assert.equal((await h.kv.get(`app:${built.appId}`, 'json')).version, 1);
    assert.equal(h.r2.keys(`apps/${UID}/${built.appId}/v2/`).length, 0, 'the failed release must be cleaned up');

    // The preview survives the failed install, so a retry is possible.
    assert.ok(await h.kv.get(`app-preview:${preview.previewId}`, 'json'), 'the preview must not be consumed on failure');
    h.desktop.state.fail.patch = null;
    const retried = await h.tools.installAppPreview.execute(
      { previewId: preview.previewId },
      { toolCallId: 'tc', messages: [] },
    );
    assert.equal(retried.status, 'updated');
    assert.equal(retried.version, 2);
    assert.equal(h.desktop.itemsOf('app').length, 1);
  });

  it('previewAppFromPrompt rejects an unknown or foreign target app before generating anything', async () => {
    const h = createAppToolsHarness();

    await assert.rejects(
      h.tools.previewAppFromPrompt.execute(
        { prompt: 'change it', appId: 'no-such-app' },
        { toolCallId: 'tc', messages: [] },
      ),
      /App no-such-app not found/,
    );
    h.kv.store.set('app:foreign-app', JSON.stringify({ uid: 'someone-else', version: 1, granted: {} }));
    await assert.rejects(
      h.tools.previewAppFromPrompt.execute(
        { prompt: 'change it', appId: 'foreign-app' },
        { toolCallId: 'tc', messages: [] },
      ),
      /App foreign-app not found/,
    );

    // The target check runs before any generation work: no model calls,
    // no staged preview artifacts.
    assert.equal(h.ai.calls.length, 0);
    assert.equal(h.r2.keys('app-previews/').length, 0);
    assert.equal(h.kv.keys().filter((k) => k.startsWith('app-preview:')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// The mutation approval flow, end to end through onChatMessage
// ---------------------------------------------------------------------------

describe('OrchestratorAgent approval flow', () => {
  it('a mutation tool call requests approval without executing anything', async () => {
    const h = createAgentHarness({
      items: [
        { id: 'i1', type: 'image', name: 'screenshot-1.png', parentId: null, isPublic: false, updatedAt: 1 },
        { id: 'i2', type: 'image', name: 'screenshot-2.png', parentId: null, isPublic: false, updatedAt: 2 },
      ],
    });

    const turn = await h.runTurn('organize my screenshots into a folder', [
      modelToolCall('call_1', 'createFolder', { folderName: 'Screenshots', itemIds: ['i1', 'i2'] }),
    ]);

    assert.deepEqual(turn.errors, []);
    const part = toolPartOf(turn.message, 'call_1');
    assert.ok(part, 'the tool call must be recorded in the assistant message');
    assert.equal(part.state, 'approval-requested', 'a needsApproval tool must pause for approval');
    assert.ok(part.approval?.id, 'the approval request must carry an approval id');
    assert.equal(part.input.folderName, 'Screenshots');
    assert.equal(
      turn.chunks.some((c) => c.type === 'tool-approval-request' && c.toolCallId === 'call_1'),
      true,
      'the stream must contain a tool-approval-request chunk',
    );

    // Nothing was executed: no writes to the desktop at all.
    assert.equal(h.desktop.mutations().length, 0, 'no mutation may run before approval');
    assert.equal(h.desktop.itemsOf('folder').length, 0);
    assert.equal(h.desktop.get('i1').parentId, null);
  });

  it('a rejected approval writes nothing and records the denial in the thread', async () => {
    const h = createAgentHarness({
      items: [{ id: 'i1', type: 'image', name: 'screenshot-1.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });

    await h.runTurn('organize my screenshots into a folder', [
      modelToolCall('call_1', 'createFolder', { folderName: 'Screenshots', itemIds: ['i1'] }),
    ]);

    // Deliver the user's rejection exactly like a CF_AGENT_TOOL_APPROVAL frame.
    assert.equal(await h.deliverApproval('call_1', false), true);
    const partBefore = h.findToolPart('call_1');
    assert.equal(partBefore.state, 'output-denied');
    assert.equal(partBefore.approval.approved, false);

    // The auto-continuation after the decision: the recorded denial is sent
    // to the model as a tool result (an error-text), and the model responds.
    // No tool-output-denied chunk is re-emitted here — the denial is already
    // materialized as output-denied + tool-result by _applyToolApproval.
    const continuation = await h.runTurn(null, [modelText('Understood, I will not create the folder.')]);
    assert.deepEqual(continuation.errors, []);

    // The tool never executed: nothing was written.
    assert.equal(h.desktop.mutations().length, 0, 'a rejected mutation must not write anything');
    assert.equal(h.desktop.itemsOf('folder').length, 0);
    assert.equal(h.desktop.get('i1').parentId, null);

    // The thread records the rejection.
    const part = h.findToolPart('call_1');
    assert.equal(part.state, 'output-denied');
    assert.equal(part.approval.approved, false);

    // And the model was told about the denial.
    const modelInputs = h.ai.calls.at(-1).inputs.messages;
    const denial = modelInputs.find((m) => m.role === 'tool' && m.tool_call_id === 'call10000');
    assert.ok(denial, 'the model must receive a tool result for the denied call');
    assert.match(denial.content, /Tool execution denied/);

    // The thread is coherent: user, tool-call message, follow-up message.
    assert.equal(h.threadMessages.length, 3);
    assert.equal(h.threadMessages[0].role, 'user');
    assert.equal(textOf(h.threadMessages[2]), 'Understood, I will not create the folder.');
  });

  it('an approved mutation applies exactly once, even if the approval is delivered twice', async () => {
    const h = createAgentHarness({
      items: [
        { id: 'i1', type: 'image', name: 'screenshot-1.png', parentId: null, isPublic: false, updatedAt: 1 },
        { id: 'i2', type: 'image', name: 'screenshot-2.png', parentId: null, isPublic: false, updatedAt: 2 },
      ],
    });

    await h.runTurn('organize my screenshots into a folder', [
      modelToolCall('call_1', 'createFolder', { folderName: 'Screenshots', itemIds: ['i1', 'i2'] }),
    ]);

    // First delivery applies; the duplicate frame (e.g. a retried WS message)
    // hits the real _applyToolApproval state check and no-ops.
    assert.equal(await h.deliverApproval('call_1', true), true);
    assert.equal(await h.deliverApproval('call_1', true), false, 'a duplicate approval must not re-apply');

    // The continuation the first delivery triggers runs the tool once.
    const continuation = await h.runTurn(null, [modelText('Done — folder created.')]);
    assert.deepEqual(continuation.errors, []);

    const part = h.findToolPart('call_1');
    assert.equal(part.state, 'output-available');
    assert.equal(part.approval.approved, true, 'the approval decision stays recorded');
    assert.equal(part.output.movedCount, 2);
    const folderId = part.output.folder.id;

    // Defense in depth: even if the continuation itself were duplicated (the
    // worst case the duplicate frame could have caused), the recorded tool
    // result suppresses re-execution.
    const duplicateContinuation = await h.runTurn(null, [modelText('Confirmed.')]);
    assert.deepEqual(duplicateContinuation.errors, []);

    // Exactly one folder was created and each item moved exactly once.
    assert.equal(h.desktop.requests.filter((r) => r.method === 'POST').length, 1);
    assert.equal(h.desktop.requests.filter((r) => r.method === 'PATCH').length, 1);
    const folders = h.desktop.itemsOf('folder');
    assert.equal(folders.length, 1);
    assert.equal(folders[0].id, folderId);
    assert.equal(folders[0].isPublic, false);
    assert.equal(h.desktop.get('i1').parentId, folderId);
    assert.equal(h.desktop.get('i2').parentId, folderId);
  });

  it('an approved app tool installs the app exactly once and writes a coherent thread', async () => {
    const h = createAgentHarness();

    await h.runTurn('install this app for me', [
      modelToolCall('call_1', 'createApp', { name: 'Approved App', files: { ...MINIMAL_APP_FILES } }),
    ]);
    assert.equal(h.findToolPart('call_1').state, 'approval-requested');
    assert.equal(h.desktop.itemsOf('app').length, 0);
    assert.equal(h.r2.keys('apps/').length, 0);

    assert.equal(await h.deliverApproval('call_1', true), true);
    const continuation = await h.runTurn(null, [modelText('Installed.')]);
    assert.deepEqual(continuation.errors, []);

    const part = h.findToolPart('call_1');
    assert.equal(part.state, 'output-available');
    assert.equal(part.output.status, 'created');

    const appItems = h.desktop.itemsOf('app');
    assert.equal(appItems.length, 1);
    assert.equal(appItems[0].appManifest.appId, part.output.appId);
    assert.ok(h.r2.keys(`apps/${UID}/${part.output.appId}/`).length >= 4);

    // A duplicate approval frame still no-ops, and nothing runs twice.
    assert.equal(await h.deliverApproval('call_1', true), false);
    assert.equal(h.desktop.itemsOf('app').length, 1);
  });

  it('a tool error mid-turn does not kill the stream and leaves the thread consistent', async () => {
    const h = createAgentHarness({
      items: [{ id: 't1', type: 'text', name: 'notes.txt', parentId: null, isPublic: false, textContent: 'hello', updatedAt: 1 }],
    });

    // The model calls a tool with bad input (no itemId, no name); the same
    // turn continues after the tool error and the model responds normally.
    const turn = await h.runTurn('what do my notes say', [
      modelToolCall('call_1', 'readTextFile', {}),
      modelText('Which note would you like me to read?'),
    ]);

    assert.deepEqual(turn.errors, [], 'a tool error must not become a stream error');
    assert.ok(
      turn.chunks.some((c) => c.type === 'tool-output-error' && c.toolCallId === 'call_1'),
      'the tool error must surface as a tool-output-error chunk',
    );

    const part = toolPartOf(turn.message, 'call_1');
    assert.equal(part.state, 'output-error');
    assert.match(part.errorText, /Provide an itemId or a name to read/);
    assert.equal(textOf(turn.message), 'Which note would you like me to read?');
    assert.equal(h.threadMessages.length, 2);

    // The thread still works: a follow-up turn succeeds.
    const followUp = await h.runTurn('the one named notes', [
      modelToolCall('call_2', 'readTextFile', { name: 'notes' }),
      modelText('It says "hello".'),
    ]);
    assert.deepEqual(followUp.errors, []);
    const part2 = toolPartOf(followUp.message, 'call_2');
    assert.equal(part2.state, 'output-available');
    assert.equal(part2.output.content, 'hello');
  });

  it('a mutation that fails after approval records the failure and keeps the thread consistent', async () => {
    const h = createAgentHarness({
      items: [{ id: 'i1', type: 'image', name: 'a.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });

    await h.runTurn('organize my screenshots into a folder', [
      modelToolCall('call_1', 'createFolder', { folderName: 'Screenshots', itemIds: ['i1'] }),
    ]);
    assert.equal(await h.deliverApproval('call_1', true), true);

    // The user approved, but the desktop fails the move step mid-mutation. The
    // continuation runs the approved tool, records the failure, and the model
    // responds to it in the same turn.
    h.desktop.state.fail.patch = 500;
    const continuation = await h.runTurn(null, [modelText('Sorry — the move failed, please try again.')]);
    assert.deepEqual(continuation.errors, []);

    const part = h.findToolPart('call_1');
    assert.equal(part.state, 'output-error', 'the failed mutation is recorded as a tool error');
    assert.match(part.errorText, /Failed to move items \(500\)/);
    // Every PATCH fails, so the cleanup of the just-created folder failed
    // too — the recorded error reports both.
    assert.match(part.errorText, /failed to remove the created folder \(500\)/);
    assert.equal(part.approval.approved, true, 'the approval decision stays recorded');

    // Nothing was moved, and the thread ends coherent.
    assert.equal(h.desktop.get('i1').parentId, null);
    assert.equal(h.threadMessages.length, 3);
    assert.equal(textOf(h.threadMessages[2]), 'Sorry — the move failed, please try again.');
  });

  it('a model tool call for a tool outside the active route returns a clear error, not a dead stream', async () => {
    const h = createAgentHarness();

    // "what is on my desktop" routes to desktop-read; the model wrongly tries
    // a mutating tool that is not active in that route.
    const turn = await h.runTurn('what is on my desktop right now', [
      modelToolCall('call_1', 'createFolder', { folderName: 'X', itemIds: ['i1'] }),
      modelText('Let me take a look at your desktop instead.'),
    ]);

    assert.deepEqual(turn.errors, []);
    const part = toolPartOf(turn.message, 'call_1');
    assert.equal(part.state, 'output-error');
    assert.match(
      part.errorText,
      /Model tried to call unavailable tool 'createFolder'/,
      'an out-of-route tool call must produce a clear error naming the tool',
    );
    assert.equal(textOf(turn.message), 'Let me take a look at your desktop instead.');
    assert.equal(h.desktop.mutations().length, 0);
  });

  it('a follow-up that names nothing keeps the previous turn\'s tools (not chat)', async () => {
    const h = createAgentHarness({
      items: [{ id: 'i1', type: 'image', name: 'beach.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    await h.runTurn('what is on my desktop right now', [modelText('You have one image, beach.png.')]);

    // "and which of them is newest?" has no desktop word: alone it is chat,
    // where searchDesktop does not exist. With context it stays desktop-read.
    const turn = await h.runTurn('and which of them is newest?', [
      modelToolCall('call_follow', 'searchDesktop', { query: 'beach' }),
      modelText('beach.png is the newest.'),
    ]);
    assert.deepEqual(turn.errors, []);
    const part = toolPartOf(turn.message, 'call_follow');
    assert.equal(part.state, 'output-available', `follow-up lost its tools: ${part.errorText ?? ''}`);
  });

  it('a model that goes silent ends the turn with a clear error instead of hanging (live regression)', async () => {
    const h = createAgentHarness();
    h.env.AGENT_STALL_TIMEOUT_MS = '200';
    const started = Date.now();
    const turn = await h.runTurn('hello there, how are you?', [() => new Promise(() => {})]);
    assert.ok(Date.now() - started < 5_000, 'the stalled turn must end promptly');
    const errorText = [...turn.errors, ...turn.chunks.filter((c) => c.type === 'error').map((c) => c.errorText)].join(' ');
    assert.match(errorText, /stopped responding/i);
  });

  it('a slow tool does not trip the stall watchdog', async () => {
    const h = createAgentHarness({
      items: [{ id: 'i1', type: 'image', name: 'beach.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    h.env.AGENT_STALL_TIMEOUT_MS = '150';
    // Slow the desktop read (the tool's own I/O) well past the stall timeout.
    const originalFetch = h.desktop.stub.fetch;
    h.desktop.stub.fetch = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return originalFetch.apply(h.desktop.stub, args);
    };
    const turn = await h.runTurn('what is on my desktop right now', [
      modelToolCall('call_slow', 'getDesktopOverview', {}),
      modelText('You have one image.'),
    ]);
    const part = toolPartOf(turn.message, 'call_slow');
    assert.equal(part.state, 'output-available', `slow tool was cut off: ${part.errorText ?? ''}`);
    assert.equal(textOf(turn.message), 'You have one image.');
  });

  it('memory tools run without approval, persist state, and feed later turns', async () => {
    const h = createAgentHarness();

    const turn = await h.runTurn('hello! remember that I prefer dark mode', [
      modelToolCall('call_1', 'rememberMemory', { content: 'User prefers dark mode', kind: 'preference' }),
      modelText('Noted — dark mode it is.'),
    ]);
    assert.deepEqual(turn.errors, []);

    const part = toolPartOf(turn.message, 'call_1');
    // Memory tools are not gated on approval.
    assert.notEqual(part.state, 'approval-requested');
    assert.equal(part.state, 'output-available');
    assert.equal(h.agent.state.memories.length, 1);
    assert.equal(h.agent.state.memories[0].content, 'User prefers dark mode');

    // The memory is injected into the next turn's system prompt.
    const next = await h.runTurn('what do you remember about me', [
      modelToolCall('call_2', 'listMemories', {}),
      modelText('You prefer dark mode.'),
    ]);
    assert.deepEqual(next.errors, []);
    const systemPrompt = h.ai.calls.at(-2).inputs.messages[0].content;
    assert.match(systemPrompt, /User prefers dark mode/);
    const listPart = toolPartOf(next.message, 'call_2');
    assert.equal(listPart.output.totalMemories, 1);

    // Forgetting is a clear result.
    const forget = await h.runTurn('forget that', [
      modelToolCall('call_3', 'forgetMemory', { query: 'dark mode' }),
      modelText('Forgotten.'),
    ]);
    assert.deepEqual(forget.errors, []);
    assert.equal(toolPartOf(forget.message, 'call_3').output.status, 'deleted');
    assert.equal(h.agent.state.memories.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Code Mode undo and routines (agent side)
// ---------------------------------------------------------------------------

/** Real in-memory SQLite shaped like a Durable Object's SqlStorage. */
async function realSqlStorage() {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...params) {
      const statement = db.prepare(String(query));
      if (/^\s*select/i.test(String(query))) {
        const rows = statement.all(...params);
        return { toArray: () => rows };
      }
      statement.run(...params);
      return { toArray: () => [] };
    },
  };
}

describe('Code Mode undo (OrchestratorAgent.undoCodeRun)', () => {
  it('puts moved items back and trashes a created note, exactly once', async () => {
    const h = createAgentHarness({
      items: [
        { id: 'a', type: 'text', name: 'a.txt', parentId: 'f1' },
        { id: 'b', type: 'text', name: 'b.txt', parentId: 'f1' },
        { id: 'n1', type: 'text', name: 'Digest', parentId: null },
        { id: 'f1', type: 'folder', name: 'Archive', parentId: null },
      ],
    });
    h.agent.ctx = { storage: { sql: await realSqlStorage() } };
    const { initCodeRunStore, saveUndoPlan } = await import('../src/agents/codeRunStore.ts');
    initCodeRunStore(h.agent.ctx.storage.sql);
    saveUndoPlan(h.agent.ctx.storage.sql, 'run-1', {
      writes: 2,
      skipped: [],
      ops: [
        { kind: 'desktop', patches: [{ id: 'a', updates: { parentId: null } }, { id: 'b', updates: { parentId: 'f0' } }], summary: 'Move 2 items back' },
        { kind: 'desktop', patches: [{ id: 'n1', updates: { isTrashed: true } }], summary: 'Trash the note' },
      ],
    });

    h.threadMessages.push({ id: 'a1', role: 'assistant', parts: [{ type: 'data-codemode-undo', id: 'run-1', data: { runId: 'run-1', available: true, writes: 2 } }] });
    h.agent.persistMessages = async (messages) => { h.threadMessages.splice(0, h.threadMessages.length, ...messages); };
    const result = await h.agent.undoCodeRun('run-1');
    assert.equal(result.status, 'undone');
    assert.equal(typeof h.threadMessages[0].parts[0].data.undoneAt, 'number', 'the card in the thread records the undo');
    assert.deepEqual(result.done, ['Trash the note', 'Move 2 items back'], 'newest change is undone first');
    assert.equal(h.desktop.get('a').parentId, null);
    assert.equal(h.desktop.get('b').parentId, 'f0');
    assert.equal(h.desktop.get('n1').isTrashed, true);
    assert.equal(typeof h.desktop.get('n1').trashedAt, 'number');

    assert.equal((await h.agent.undoCodeRun('run-1')).status, 'already-undone');
    assert.equal((await h.agent.undoCodeRun('nope')).status, 'missing');
  });
});

describe('routines (OrchestratorAgent)', () => {
  async function routineHarness() {
    const h = createAgentHarness({ items: [] });
    h.agent.ctx = { storage: { sql: await realSqlStorage() } };
    const scheduled = [];
    const cancelled = [];
    h.agent.schedule = async (when, callback, payload) => {
      scheduled.push({ when: new Date(when), callback, payload });
      return { id: `sch-${scheduled.length}` };
    };
    h.agent.cancelSchedule = async (id) => { cancelled.push(id); return true; };
    h.agent.persistMessages = async (messages) => { h.threadMessages.splice(0, h.threadMessages.length, ...messages); };
    h.agent.turnTimeZone = 'America/Toronto';
    // No Worker Loader in unit tests: running the code fails, which still
    // exercises recording the run and posting it into the thread.
    const tools = h.agent.createRoutineTools('user-1', () => {});
    return { h, scheduled, cancelled, tools };
  }

  it('saves, schedules, lists, runs on request (posting the result) and deletes', async () => {
    const { h, scheduled, cancelled, tools } = await routineHarness();
    const saved = await tools.saveRoutine.execute({
      name: 'Morning digest',
      code: 'async () => "3 unread books"',
      schedule: { every: 'day', at: '08:00' },
    }, { toolCallId: 'save-1', messages: [] });
    assert.equal(saved.routine.name, 'Morning digest');
    assert.equal(saved.routine.schedule, 'every day at 08:00 (America/Toronto)');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].callback, 'runRoutine');
    assert.equal(scheduled[0].payload.routineId, saved.routine.id);
    assert.ok(scheduled[0].when.getTime() > Date.now());

    const listed = await tools.listRoutines.execute({}, { toolCallId: 'l', messages: [] });
    assert.equal(listed.routines.length, 1);

    const run = await h.agent.runRoutineNow(saved.routine.id);
    assert.ok(['ok', 'error'].includes(run.status));
    const posted = h.threadMessages.at(-1);
    assert.equal(posted.role, 'assistant');
    const runPart = posted.parts.find((p) => p.type === 'data-routine-run');
    assert.equal(runPart.data.name, 'Morning digest');
    assert.match(posted.parts[0].text, /Routine “Morning digest”/);
    const after = (await h.agent.listRoutines())[0];
    assert.equal(after.lastStatus, run.status);
    assert.equal(typeof after.lastRunAt, 'number');

    assert.deepEqual(await h.agent.deleteRoutine(saved.routine.id), { deleted: true });
    assert.deepEqual(cancelled, ['sch-1']);
    assert.equal((await h.agent.listRoutines()).length, 0);
  });

  it('reschedules after a scheduled run and caps routines per thread', async () => {
    const { h, scheduled, tools } = await routineHarness();
    const saved = await tools.saveRoutine.execute({
      name: 'Hourly check', code: 'async () => 1', schedule: { every: 'hours', hours: 3 },
    }, { toolCallId: 's', messages: [] });
    await h.agent.runRoutine({ routineId: saved.routine.id });
    assert.equal(scheduled.length, 2, 'the next run is scheduled after each run');
    const gap = scheduled[1].when.getTime() - Date.now();
    assert.ok(gap > 2.9 * 3_600_000 && gap <= 3 * 3_600_000 + 1000);

    for (let i = 1; i < 10; i++) {
      await tools.saveRoutine.execute({ name: `r${i}`, code: 'async () => 1', schedule: { every: 'hours', hours: 1 } }, { toolCallId: `s${i}`, messages: [] });
    }
    await assert.rejects(
      tools.saveRoutine.execute({ name: 'one too many', code: 'async () => 1', schedule: { every: 'hours', hours: 1 } }, { toolCallId: 'sx', messages: [] }),
      /already has 10 routines/,
    );
  });
});
