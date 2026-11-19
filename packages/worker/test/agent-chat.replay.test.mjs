/**
 * Agent chat drop-and-replay integration tests (Workstream 4, item 1).
 *
 * After R6 (agents 0.8.x / @cloudflare/ai-chat 0.2.6), reconnect recovery
 * for a mid-reply drop relies on three coordinated behaviors that were
 * previously verified only by reading library sources:
 *
 *   1. the frontend strips the queued cancel frame so the server-side
 *      generation is never aborted (agentChatReconciliation.ts
 *      abortChatRequestLocally),
 *   2. the reconnecting client runs the 0.2.x resume handshake
 *      (resumeStream → RESUME_REQUEST, then ACK on RESUMING),
 *   3. the server replays the still-running generation's buffered chunks
 *      and continues it live (ResumableStream.replayChunks), then persists
 *      the completed assistant message exactly once.
 *
 * This suite drives all of that live. The dev-server transport suite
 * (agent-chat.transport.test.mjs) runs against unstable_dev and CAN drive
 * two real sockets, but it cannot stream a generation: wrangler's [ai]
 * binding requires a logged-in Cloudflare account even for local dev (see
 * AGENTS.md), so wrangler.test.toml deliberately omits it and every chat
 * request there exercises the provider-failure path. What is missing for a
 * slow observable stream is exactly the AI binding — so this file supplies
 * the smallest test-only support: it constructs the REAL OrchestratorAgent
 * in-process (same mechanism as agentTools.test.mjs) and drives the REAL
 * ai-chat WebSocket protocol through the same entry points workerd uses
 * (onConnect / webSocketMessage / webSocketClose, plus the real
 * get-messages fetch route), with:
 *
 *   - a fake DurableObjectState whose storage.sql is node:sqlite (the
 *     ResumableStream chunk/metadata tables and the persisted thread are
 *     therefore real SQL, not canned responses),
 *   - fake hibernated WebSockets wired through the same partyserver
 *     attachment protocol (serializeAttachment/deserializeAttachment on
 *     WebSocket.prototype, backed by a WeakMap — the methods workerd
 *     provides natively),
 *   - a scripted Workers AI binding that streams several SSE chunks with
 *     delays (the exact interface workers-ai-provider calls:
 *     binding.run(model, {stream: true, ...}) → ReadableStream of
 *     `data: {"response": "..."}\n\n` frames, cf. the SSE shapes parsed in
 *     workers-ai-provider dist/index.js getMappedStream).
 *
 * Naming: since agents 0.8.7, partyserver's getServerByName names the DO by
 * calling the stub's setName(name) RPC method directly (older releases sent
 * a /cdn-cgi/partyserver/set-name/ fetch request); the harness calls the
 * same real method on the in-process instance (see buildAgent).
 *
 * The wire frames mirror @cloudflare/ai-chat@0.2.6 exactly (file:line
 * citations below are from node_modules/@cloudflare/ai-chat/dist):
 *   - chat request:            dist/react.js:129-136 `{id, init: {method:
 *                              'POST', body}, type: 'cf_agent_use_chat_request'}`
 *                              (server-side parse: dist/index.js:478-491)
 *   - on-connect resuming notify: dist/index.js:457-460 → _notifyStreamResuming
 *                              dist/index.js:684-691 `{type:
 *                              'cf_agent_stream_resuming', id}`
 *   - client resume request:   dist/react.js:167 `{type:
 *                              'cf_agent_stream_resume_request'}` (no id)
 *   - client resume ack:       dist/react.js:157-164 `{type:
 *                              'cf_agent_stream_resume_ack', id}` — the id
 *                              comes from the RESUMING frame; the server
 *                              requires it to match the active request
 *                              (dist/index.js:567-573) before replaying
 *   - replayed chunks:         dist/index.js:199-205 `{body, done: false,
 *                              id, type: 'cf_agent_use_chat_response',
 *                              replay: true}`; a live stream's replay ends
 *                              with `{..., replay: true, replayComplete:
 *                              true}` (dist/index.js:227-234)
 *   - resume-none:             dist/index.js:564 `{type:
 *                              'cf_agent_stream_resume_none'}`
 *   - cancel:                  `{id, type: 'cf_agent_chat_request_cancel'}`
 *                              (server: dist/index.js:555-558 →
 *                              _cancelChatRequest dist/index.js:1946-1948)
 *
 * Scenario map:
 *   1. mid-stream drop → reconnect + handshake → replay + live remainder →
 *      complete persisted message exactly once (and a stale cancel for an
 *      unknown request is tolerated mid-replay).
 *   2. the server finished while the client was offline → RESUME_NONE and
 *      a history reload shows the one complete message.
 *   3. a pre-fix client flushes its queued cancel for the still-active
 *      request on reconnect → the generation truncates; this is the live
 *      evidence that abortChatRequestLocally's strip is load-bearing
 *      (OrchestratorAgent passes options.abortSignal to streamText, so a
 *      delivered cancel really does abort the upstream call).
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { describe, it } from 'node:test';

// --- workerd WebSocket surface patches (test-only, before any imports) -------
// workerd's WebSocket has hibernation attachment methods and READY_STATE_*
// statics; Node's undici WebSocket has neither. partyserver calls them
// through WebSocket.prototype, so patching the prototype makes plain fake
// socket objects work as hibernated WebSockets.
const ATTACHMENTS = new WeakMap();
WebSocket.prototype.serializeAttachment = function serializeAttachment(attachment) {
  ATTACHMENTS.set(this, attachment);
};
WebSocket.prototype.deserializeAttachment = function deserializeAttachment() {
  return ATTACHMENTS.get(this);
};
for (const [name, value] of [
  ['READY_STATE_CONNECTING', 0],
  ['READY_STATE_OPEN', 1],
  ['READY_STATE_CLOSING', 2],
  ['READY_STATE_CLOSED', 3],
]) {
  Object.defineProperty(WebSocket, name, { value, configurable: true, writable: true });
}

register(new URL('./tsModuleHooks.mjs', import.meta.url));

const { DatabaseSync } = await import('node:sqlite');
const { OrchestratorAgent } = await import('../src/agents/OrchestratorAgent.ts');

// ---------------------------------------------------------------------------
// The scripted slow generation
// ---------------------------------------------------------------------------

const MODEL_TEXT_PARTS = [
  'Chunk one drifts in. ',
  'Chunk two follows slowly. ',
  'Chunk three keeps going. ',
  'Chunk four is still streaming. ',
  'Chunk five arrives after the drop. ',
  'Chunk six continues live. ',
  'Chunk seven nearly there. ',
  'Chunk eight completes the reply.',
];
const FULL_TEXT = MODEL_TEXT_PARTS.join('');
const CHUNK_DELAY_MS = 200;

/**
 * Scripted Workers AI binding. Records every call and answers a streaming
 * request with a ReadableStream of SSE `data:` frames, one per chunk with
 * CHUNK_DELAY_MS between pulls, then a usage frame and [DONE] — the shapes
 * workers-ai-provider's SSE decoder consumes (dist/index.js getMappedStream:
 * `data: {"response": "..."}` text chunks, optional `data: {"usage": ...}`,
 * `data: [DONE]` terminator). `drained` flips when the last frame is
 * enqueued, so a test can tell a completed generation from an aborted one.
 */
function createSlowAiBinding() {
  const calls = [];
  const state = { drained: false };
  return {
    calls,
    state,
    async run(model, inputs) {
      calls.push({ model, stream: inputs?.stream === true });
      const nonStreamRecord = () => ({
        choices: [{ message: { content: FULL_TEXT }, finish_reason: 'stop' }],
      });
      if (inputs?.stream !== true) return nonStreamRecord();
      const lines = [
        ...MODEL_TEXT_PARTS.map((part) => `data: ${JSON.stringify({ response: part })}\n\n`),
        `data: ${JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 34 } })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const encoder = new TextEncoder();
      return new ReadableStream({
        async pull(controller) {
          if (lines.length === 0) {
            state.drained = true;
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(lines.shift()));
          if (lines.length === 0) state.drained = true;
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DELAY_MS));
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Fakes: DurableObjectState, hibernated sockets, env
// ---------------------------------------------------------------------------

/**
 * Fake DurableObjectState. storage.sql is a real (in-memory) SQLite
 * database, so the ai-chat ResumableStream tables, the persisted thread
 * rows, and the agents state tables all behave exactly as under workerd —
 * including the exec(...).toArray() cursor shape the agent SDK relies on.
 * acceptWebSocket/getWebSockets implement the hibernation tracking the
 * partyserver connection manager iterates for broadcasts.
 */
function createFakeCtx() {
  const db = new DatabaseSync(':memory:');
  const sockets = [];
  const kv = new Map();
  class Rows extends Array {
    toArray() { return this; }
  }
  return {
    db,
    sockets,
    storage: {
      sql: {
        exec(query, ...params) {
          return Rows.from(db.prepare(query).all(...params));
        },
      },
      async get(key) { return kv.get(key); },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { kv.delete(key); },
      async setAlarm() {},
      async deleteAlarm() {},
    },
    waitUntil(promise) { Promise.resolve(promise).catch(() => {}); },
    async blockConcurrencyWhile(fn) { return fn(); },
    acceptWebSocket(ws, tags) {
      ws.tags = tags;
      sockets.push(ws);
    },
    getWebSockets(tag) {
      return sockets.filter(
        (s) => s.readyState === WebSocket.READY_STATE_OPEN
          && (tag === undefined || (s.tags ?? []).includes(tag)),
      );
    },
    dropSocket(ws) {
      ws.readyState = WebSocket.READY_STATE_CLOSED;
      const index = sockets.indexOf(ws);
      if (index >= 0) sockets.splice(index, 1);
    },
    id: { toString: () => 'do-id-test' },
  };
}

let socketCounter = 0;

/** A hibernated server-side WebSocket stand-in that records every send. */
function createFakeSocket() {
  return {
    id: `test-socket-${++socketCounter}`,
    readyState: WebSocket.READY_STATE_OPEN,
    sent: [],
    send(message) { this.sent.push(String(message)); },
    close() { this.readyState = WebSocket.READY_STATE_CLOSED; },
  };
}

/**
 * Mirror partyserver's HibernatingConnectionManager.accept
 * (partyserver/dist/index.js:235-247): register with the fake ctx, then
 * store the __pk attachment through the patched prototype method the
 * AttachmentCache reads back.
 */
function acceptConnection(ctx, socket) {
  const tags = [socket.id];
  ctx.acceptWebSocket(socket, tags);
  WebSocket.prototype.serializeAttachment.call(
    socket,
    { __pk: { id: socket.id, tags, uri: undefined }, __user: null },
  );
}

function createFakeEnv(ai) {
  const kv = new Map();
  const usageStub = {
    async fetch(input, init) {
      const request = typeof input === 'string' ? new Request(input, init) : input;
      const url = new URL(request.url);
      if (url.pathname === '/ai/acquire') {
        return Response.json({
          allowed: true,
          slotId: `slot-${Date.now()}`,
          remainingRequests: 100,
          remainingTokens: 1_000_000,
          resetAt: Date.now() + 86_400_000,
        });
      }
      if (url.pathname === '/ai/record') return Response.json({ ok: true });
      if (url.pathname === '/ai/release') return Response.json({ ok: true });
      return new Response('not found', { status: 404 });
    },
  };
  return {
    AI: ai,
    USER_DESKTOP: {
      idFromName: () => 'desktop-do-id',
      get: () => ({ fetch: async () => new Response('{}') }),
    },
    DESKTOP_KV: {
      async get(key, type) {
        const raw = kv.get(key);
        return raw === undefined ? null : type === 'json' ? JSON.parse(raw) : raw;
      },
      async put(key, value) { kv.set(key, String(value)); },
      async delete(key) { kv.delete(key); },
    },
    ETERNALOS_FILES: { async put() {}, async get() { return null; }, async delete() {} },
    RATE_LIMITER: { idFromName: () => 'rate-limiter-do-id', get: () => usageStub },
    AGENT_CHAT_MODEL: '@cf/fake-chat-model',
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 15_000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    assert.ok(Date.now() <= deadline, 'timed out waiting for a transport condition');
    await sleep(pollMs);
  }
}

/**
 * Build a real OrchestratorAgent over a fresh fake state + scripted AI.
 * The agent is named exactly the way production does it:
 * buildThreadAgentName → getAgentByName → partyserver getServerByName —
 * which, since partyserver 0.8.7 (agents 0.8.7), calls the stub's
 * setName(name) RPC method directly instead of the old
 * /cdn-cgi/partyserver/set-name/ fetch request, so the harness calls the
 * same real method on the in-process instance.
 */
async function buildAgent(threadId) {
  const uid = 'user-replay';
  const ctx = createFakeCtx();
  const ai = createSlowAiBinding();
  const agent = new OrchestratorAgent(ctx, createFakeEnv(ai));
  await agent.setName(`${uid}:${threadId}`);
  assert.equal(agent.name, `${uid}:${threadId}`);
  const connectRequest = () => new Request(`ws://test/api/agent/chat?threadId=${encodeURIComponent(threadId)}`);
  return { agent, ctx, ai, connectRequest };
}

/** Open a connection like the DO runtime does after a 101 upgrade. */
async function connect(ctx, agent, connectRequest) {
  const socket = createFakeSocket();
  acceptConnection(ctx, socket);
  await agent.onConnect(socket, { request: connectRequest() });
  return socket;
}

/** Deliver a frame like workerd does — without awaiting the turn's promise. */
function sendFrame(agent, socket, frame) {
  void agent.webSocketMessage(socket, JSON.stringify(frame))
    .catch((error) => console.error('webSocketMessage failed:', error));
}

/** The exact cf_agent_use_chat_request frame useAgentChat's transport sends. */
function sendChatRequest(agent, socket, requestId, userText, threadId) {
  sendFrame(agent, socket, {
    id: requestId,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [{
          id: `user-${requestId}`,
          role: 'user',
          parts: [{ type: 'text', text: userText }],
        }],
        trigger: 'submit-message',
        threadId,
      }),
    },
    type: 'cf_agent_use_chat_request',
  });
}

function parseFrames(socket) {
  return socket.sent.flatMap((raw) => {
    try { return [JSON.parse(raw)]; } catch { return []; }
  });
}

function responseFrames(socket, requestId) {
  return parseFrames(socket).filter(
    (frame) => frame.type === 'cf_agent_use_chat_response' && frame.id === requestId,
  );
}

/** Concatenate text-delta bodies from response frames (replay and live). */
function textFromFrames(frames) {
  let text = '';
  for (const frame of frames) {
    if (typeof frame.body !== 'string' || frame.done) continue;
    let chunk;
    try { chunk = JSON.parse(frame.body); } catch { continue; }
    if (chunk.type === 'text-delta') text += chunk.delta ?? '';
  }
  return text;
}

async function getHistory(agent) {
  // The same route handleAgentChatForward hands to the DO; the chat pane's
  // reloadThreadHistory reads its response after a reconnect.
  const response = await agent.fetch(new Request('http://test/get-messages'));
  assert.equal(response.status, 200);
  return response.json();
}

async function firstTextDeltaSeen(socket, requestId) {
  return waitFor(() => responseFrames(socket, requestId).some((frame) => {
    if (typeof frame.body !== 'string' || frame.done) return false;
    try { return JSON.parse(frame.body).type === 'text-delta'; } catch { return false; }
  }));
}

/** Drop a socket abruptly — no close handshake, like a dead connection. */
async function dropConnection(ctx, agent, socket) {
  ctx.dropSocket(socket);
  await agent.webSocketClose(socket, 1006, '', false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Per-test timeout: the whole suite settles in ~4s (three scenarios, each a
 * bounded 8×200ms generation). If the transport ever stalls (a protocol
 * regression, an agents upgrade changing a handshake), the runner fails the
 * test at 30s instead of hanging the whole `npm run test:worker` run; every
 * timer the harness can leave behind is itself bounded (waitFor ≤15s, the
 * scripted generation ≤8×200ms), so the file's process always drains.
 */
const TEST_TIMEOUT_MS = 30_000;

describe('agent chat drop-and-replay transport', () => {
  it('replays a still-running generation to a reconnecting client, exactly once, without cancelling it', { timeout: TEST_TIMEOUT_MS }, async () => {
    const threadId = 'replay-mid-stream';
    const requestId = 'req-replay-1';
    const { agent, ctx, ai, connectRequest } = await buildAgent(threadId);

    // Connection A: start a chat request and watch the stream begin.
    const socketA = await connect(ctx, agent, connectRequest);
    sendChatRequest(agent, socketA, requestId, 'Tell me a slow story, please.', threadId);
    await firstTextDeltaSeen(socketA, requestId);

    // Drop A abruptly — no cancel frame is delivered (the fixed client
    // strips its queued cancel: agentChatReconciliation.abortChatRequestLocally).
    const aTextAtDrop = textFromFrames(responseFrames(socketA, requestId));
    await dropConnection(ctx, agent, socketA);
    assert.ok(
      FULL_TEXT.startsWith(aTextAtDrop) && aTextAtDrop.length < FULL_TEXT.length,
      `connection A should drop mid-stream with a strict prefix, saw: ${JSON.stringify(aTextAtDrop)}`,
    );

    // Connection B (same user/thread) connects while the generation runs.
    // The server announces the active stream on connect (ai-chat wraps
    // onConnect: dist/index.js:457-460).
    const socketB = await connect(ctx, agent, connectRequest);
    const bConnectFrames = parseFrames(socketB);
    const onConnectResuming = bConnectFrames.find((f) => f.type === 'cf_agent_stream_resuming');
    assert.ok(onConnectResuming, 'B must be told about the active stream on connect');
    assert.equal(onConnectResuming.id, requestId, 'the resuming frame must name the active request id');

    // The 0.2.x client's reconnect handshake (react.js reconnectToStream):
    // send RESUME_REQUEST, then ACK the RESUMING notification carrying its id.
    sendFrame(agent, socketB, { type: 'cf_agent_stream_resume_request' });
    const resuming = await waitFor(() => parseFrames(socketB).find(
      (f) => f.type === 'cf_agent_stream_resuming' && f !== onConnectResuming,
    ));
    assert.equal(resuming.id, requestId);

    // A stale cancel for an unknown request id is tolerated mid-replay
    // (server: _cancelChatRequest no-ops on unknown ids).
    sendFrame(agent, socketB, { id: 'req-never-existed', type: 'cf_agent_chat_request_cancel' });

    sendFrame(agent, socketB, { type: 'cf_agent_stream_resume_ack', id: resuming.id });

    // The ACK replays every stored chunk, marked replay: true, and a live
    // stream ends the replay with replayComplete: true (index.js:199-234).
    await waitFor(() => responseFrames(socketB, requestId).some((f) => f.replay));
    const replayCompleteFrame = await waitFor(() => responseFrames(socketB, requestId).find(
      (f) => f.replay && f.replayComplete,
    ));
    assert.equal(replayCompleteFrame.done, false);

    const bReplayFrames = responseFrames(socketB, requestId).filter((f) => f.replay && !f.replayComplete);
    const bReplayText = textFromFrames(bReplayFrames);
    assert.ok(
      bReplayText.length > 0 && FULL_TEXT.startsWith(bReplayText) && bReplayText.length < FULL_TEXT.length,
      `the replay must cover a strict prefix of the generation, saw: ${JSON.stringify(bReplayText)}`,
    );

    // B then receives the remaining chunks live and the stream's done.
    await waitFor(() => responseFrames(socketB, requestId).some((f) => f.done));
    const bLiveFrames = responseFrames(socketB, requestId).filter((f) => !f.replay);
    const bLiveText = textFromFrames(bLiveFrames);
    assert.ok(
      bLiveText.length > 0 && FULL_TEXT.startsWith(bReplayText + bLiveText),
      'B must receive the remainder of the generation live after the replay',
    );
    const bFullText = textFromFrames(responseFrames(socketB, requestId));
    assert.equal(
      bFullText,
      FULL_TEXT,
      'B must end up with the complete generation exactly once — no gap, no duplicated segment',
    );

    // The generation was NOT cancelled: one model call, fully drained.
    assert.equal(ai.calls.length, 1);
    assert.equal(ai.calls[0].stream, true);
    assert.ok(ai.state.drained, 'the scripted generation must have run to completion');

    // The final persisted-list broadcast reached B exactly once, carrying
    // both messages with no duplicate ids (the cross-tab sync path).
    const chatMessagesFrames = parseFrames(socketB).filter((f) => f.type === 'cf_agent_chat_messages');
    assert.equal(chatMessagesFrames.length, 1, 'the persisted-list broadcast must reach B exactly once');
    const broadcastIds = chatMessagesFrames[0].messages.map((m) => m.id);
    assert.equal(broadcastIds.length, 2);
    assert.ok(broadcastIds.includes(`user-${requestId}`));
    assert.equal(new Set(broadcastIds).size, broadcastIds.length, 'the broadcast list must not contain duplicate ids');

    // History: the user message and ONE complete assistant message —
    // no duplicate, no orphan.
    const history = await getHistory(agent);
    assert.deepEqual(
      history.map((m) => m.role),
      ['user', 'assistant'],
    );
    const assistants = history.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].parts.find((p) => p.type === 'text').text, FULL_TEXT);
  });

  it('answers resume-none when the generation finished while the client was offline', { timeout: TEST_TIMEOUT_MS }, async () => {
    const threadId = 'replay-finished-offline';
    const requestId = 'req-replay-2';
    const { agent, ctx, connectRequest } = await buildAgent(threadId);

    // Connection A starts the request, sees the stream begin, then drops.
    const socketA = await connect(ctx, agent, connectRequest);
    sendChatRequest(agent, socketA, requestId, 'Another slow story, thank you.', threadId);
    await firstTextDeltaSeen(socketA, requestId);
    await dropConnection(ctx, agent, socketA);

    // The generation runs to completion with nobody connected — the
    // completion signal is the assistant row appearing in history.
    await waitFor(async () => {
      const rows = await getHistory(agent);
      return rows.some((m) => m.role === 'assistant');
    }, { pollMs: 100 });

    // Connection B reconnects: no active stream, so on-connect sends no
    // resuming frame, and the client's RESUME_REQUEST is answered with
    // cf_agent_stream_resume_none (index.js:564).
    const socketB = await connect(ctx, agent, connectRequest);
    const bConnectFrames = parseFrames(socketB);
    assert.equal(
      bConnectFrames.filter((f) => f.type === 'cf_agent_stream_resuming').length,
      0,
      'a finished stream must not be announced on connect',
    );

    sendFrame(agent, socketB, { type: 'cf_agent_stream_resume_request' });
    await waitFor(() => parseFrames(socketB).some((f) => f.type === 'cf_agent_stream_resume_none'));
    assert.equal(
      responseFrames(socketB, requestId).length,
      0,
      'no replay frames may be sent when there is nothing to resume',
    );

    // The history reload the pane performs shows the one complete message.
    const history = await getHistory(agent);
    assert.deepEqual(
      history.map((m) => m.role),
      ['user', 'assistant'],
    );
    const assistants = history.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0].parts.find((p) => p.type === 'text').text, FULL_TEXT);
  });

  it('truncates when a stale cancel for the live request reaches the server (why the client strips it)', { timeout: TEST_TIMEOUT_MS }, async () => {
    const threadId = 'replay-stale-cancel';
    const requestId = 'req-replay-3';
    const { agent, ctx, ai, connectRequest } = await buildAgent(threadId);

    const socketA = await connect(ctx, agent, connectRequest);
    sendChatRequest(agent, socketA, requestId, 'A story that will be cut short.', threadId);
    await firstTextDeltaSeen(socketA, requestId);
    await dropConnection(ctx, agent, socketA);

    // A pre-fix client aborts at the drop, partysocket queues the cancel,
    // and the next socket flushes its queue on open — delivering the cancel
    // for the STILL-ACTIVE request id to the server before the resume
    // handshake runs.
    const socketB = await connect(ctx, agent, connectRequest);
    sendFrame(agent, socketB, { id: requestId, type: 'cf_agent_chat_request_cancel' });
    sendFrame(agent, socketB, { type: 'cf_agent_stream_resume_request' });

    // The cancel aborts the upstream call (OrchestratorAgent wires
    // options.abortSignal into streamText), so the stream ends early and
    // the turn settles with a truncated reply.
    await waitFor(async () => {
      const rows = await getHistory(agent);
      return rows.some((m) => m.role === 'assistant');
    }, { pollMs: 100 });

    const history = await getHistory(agent);
    const assistants = history.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 1, 'the truncated (partial) reply is still persisted, exactly once');
    const persistedText = assistants[0].parts.find((p) => p.type === 'text').text;
    assert.ok(
      persistedText.length > 0 && FULL_TEXT.startsWith(persistedText) && persistedText.length < FULL_TEXT.length,
      `the cancel must truncate the generation to a strict prefix, saw: ${JSON.stringify(persistedText)}`,
    );
    assert.equal(ai.state.drained, false, 'the upstream generation must have been aborted, not completed');

    // And B — which never completed the resume handshake — never sees the
    // full generation either.
    assert.notEqual(textFromFrames(responseFrames(socketB, requestId)), FULL_TEXT);
  });
});
