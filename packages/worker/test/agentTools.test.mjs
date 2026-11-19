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
import { register } from 'node:module';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));

const { OrchestratorAgent } = await import('../src/agents/OrchestratorAgent.ts');
const { createDesktopTools } = await import('../src/agents/tools/desktopTools.ts');
const { createMemoryTools } = await import('../src/agents/tools/memoryTools.ts');
const { createAppTools, initAppRegistry } = await import('../src/agents/tools/appTools.ts');
const {
  appSpecSchema,
  derivePermissionsFromSpec,
  validateAppSpec,
} = await import('../src/agents/tools/appSpec.ts');
const { AIChatAgent } = await import('@cloudflare/ai-chat');

const UID = 'user-abc123';

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

  it('createFolder uses the last search results when itemIds is omitted', async () => {
    const desktop = createFakeDesktop({
      items: [{ id: 'i1', type: 'image', name: 'a.png', parentId: null, isPublic: false, updatedAt: 1 }],
    });
    const state = { lastMatchedItemIds: ['i1'], lastQuery: 'a', memories: [] };
    const tools = createDesktopTools({
      getUserDesktopStub: () => desktop.stub,
      setState: (next) => Object.assign(state, next),
      getState: () => state,
    });

    const result = await tools.createFolder.execute({ folderName: 'Group' }, { toolCallId: 'tc', messages: [] });
    assert.equal(result.movedCount, 1);
    assert.equal(desktop.get('i1').parentId, result.folder.id);
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

    // Nothing to group and no previous search.
    await assert.rejects(
      tools.createFolder.execute({ folderName: 'X' }, { toolCallId: 'tc', messages: [] }),
      /No items to group/,
    );

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

describe('appSpec', () => {
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
// appTools — happy paths, bad input, permission boundaries, rollback
// ---------------------------------------------------------------------------

const MINIMAL_APP_FILES = {
  'index.html': '<!DOCTYPE html><html><head><link rel="stylesheet" href="./styles.css"></head><body><h1>Hi</h1><script type="module" src="./app.js"></script></body></html>',
  'styles.css': 'h1 { color: red; }',
  'app.js': 'console.log("hello");',
};

function createAppToolsHarness() {
  const desktop = createFakeDesktop({ profile: { username: 'jane' } });
  const kv = createFakeKV();
  const r2 = createFakeR2();
  const ai = createFakeAiBinding();
  const sql = fakeSql();
  const env = {
    AI: ai,
    USER_DESKTOP: { idFromName: () => 'desktop-do-id', get: () => desktop.stub },
    DESKTOP_KV: kv,
    ETERNALOS_FILES: r2,
  };
  initAppRegistry(sql);
  const tools = createAppTools({ env, sql, agentName: UID, onBuildStage: () => {} });
  return { desktop, kv, r2, ai, sql, tools };
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

    await assert.rejects(
      h.tools.deleteApp.execute({ appId: 'no-such-app' }, { toolCallId: 'tc', messages: [] }),
      /App no-such-app not found/,
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
