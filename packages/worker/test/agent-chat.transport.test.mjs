/**
 * Agent chat transport integration tests (Workstream 4, item 1).
 *
 * Drives the real OrchestratorAgent durable object over its actual WebSocket
 * protocol (the same frames useAgentChat sends) against the local dev server,
 * plus the /api/agent/chat/get-messages history route the client reloads
 * after a reconnect.
 *
 * The test config (wrangler.test.toml) has no [ai] binding, so every chat
 * request exercises the provider-failure path end to end: the reply must
 * terminate with a clear error frame + done (never a silent hang) and must
 * leave the persisted history free of orphaned or duplicated rows.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { unstable_dev } from 'wrangler';
import WebSocket from 'ws';

const BASE_URL = 'http://127.0.0.1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123';

let worker;
let testStateDir;

function createTestIdentity() {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
  const username = `chat${suffix}`.slice(0, 20);

  return {
    email: `${username}@example.com`,
    username,
    password: PASSWORD,
  };
}

function authHeaders(token, headers = {}) {
  return {
    ...headers,
    Authorization: `Bearer ${token}`,
  };
}

async function signupUser() {
  const identity = createTestIdentity();
  const response = await worker.fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      // Unique client IP so the per-IP auth rate limit can't interfere.
      'CF-Connecting-IP': `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify(identity),
  });
  const body = await response.json();
  assert.equal(response.status, 200, `signup failed: ${JSON.stringify(body)}`);
  return { ...identity, ...body };
}

function threadIdFor(name) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `chat-${name}-${suffix}`.slice(0, 64);
}

/** Open a raw WebSocket to the agent chat route, authenticated like the app. */
function openChatSocket(token, threadId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${worker.port}/api/agent/chat?threadId=${encodeURIComponent(threadId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const timeoutId = setTimeout(() => {
      socket.terminate();
      reject(new Error('timed out opening the agent chat socket'));
    }, 15_000);
    socket.once('open', () => {
      clearTimeout(timeoutId);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

/** Collect parsed JSON frames and await them by predicate. */
function collectFrames(socket) {
  const frames = [];
  const waiters = [];

  socket.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    frames.push(parsed);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.predicate(parsed)) {
        waiters.splice(i, 1);
        clearTimeout(waiter.timeoutId);
        waiter.resolve(parsed);
      }
    }
  });

  return {
    frames,
    waitFor(predicate, { timeoutMs = 15_000 } = {}) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(
            `timed out waiting for a chat frame; frame types so far: ${JSON.stringify(frames.map((f) => f.type))}`
          ));
        }, timeoutMs);
        const waiter = { predicate, resolve, timeoutId };
        waiters.push(waiter);
      });
    },
  };
}

/** Send the exact frame useAgentChat's transport sends for a chat request. */
function sendChatRequest(socket, requestId, userText, threadId) {
  socket.send(JSON.stringify({
    id: requestId,
    init: {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ id: `user-${requestId}`, role: 'user', parts: [{ type: 'text', text: userText }] }],
        trigger: 'submit-message',
        threadId,
      }),
    },
    type: 'cf_agent_use_chat_request',
  }));
}

async function getThreadHistory(token, threadId) {
  const response = await worker.fetch(
    `${BASE_URL}/api/agent/chat/get-messages?threadId=${encodeURIComponent(threadId)}`,
    { headers: authHeaders(token) },
  );
  assert.equal(response.status, 200, 'get-messages should be reachable with a session token');
  const text = await response.text();
  if (!text.trim()) return [];
  const parsed = JSON.parse(text);
  assert.ok(Array.isArray(parsed), 'get-messages should return an array');
  return parsed;
}

before(async () => {
  testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eternalos-test-state-'));
  worker = await unstable_dev('src/index.ts', {
    config: process.env.WRANGLER_CONFIG ?? 'wrangler.test.toml',
    envFiles: ['test/worker.env'],
    persistTo: testStateDir,
    logLevel: 'error',
    experimental: {
      disableExperimentalWarning: true,
      testMode: true,
    },
  });
});

after(async () => {
  if (worker) {
    await worker.stop();
  }
  if (testStateDir) {
    try {
      fs.rmSync(testStateDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; OS temp is reclaimed anyway.
    }
  }
});

describe('agent chat transport', () => {
  it('answers a provider/AI failure with a clear error frame instead of hanging', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('provider-failure');
    const socket = await openChatSocket(user.token, threadId);
    const collector = collectFrames(socket);

    sendChatRequest(socket, 'req-provider-failure', 'Hello there, what is on my desktop?', threadId);

    const errorFrame = await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.error === true,
    );
    assert.equal(errorFrame.id, 'req-provider-failure');
    assert.ok(
      typeof errorFrame.body === 'string' && errorFrame.body.trim().length > 0,
      'the error frame must carry a human-readable message',
    );

    // The exchange must terminate: a done frame for the request, not a hang.
    const doneFrame = await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-provider-failure',
    );
    assert.notEqual(doneFrame.error, true);

    socket.close();

    // The user message persisted exactly once and the failed stream left no
    // orphaned (empty) assistant row behind.
    const history = await getThreadHistory(user.token, threadId);
    assert.deepEqual(
      history.map((message) => ({ id: message.id, role: message.role })),
      [{ id: 'user-req-provider-failure', role: 'user' }],
    );
  });

  it('registers the thread and derives its title from the first message', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('first-message');
    const socket = await openChatSocket(user.token, threadId);
    const collector = collectFrames(socket);

    const firstMessageText = 'Organize my files into folders please';
    sendChatRequest(socket, 'req-first-message', firstMessageText, threadId);
    await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-first-message',
    );
    socket.close();

    const listResponse = await worker.fetch(`${BASE_URL}/api/agent/threads`, {
      headers: authHeaders(user.token),
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    const thread = (listBody.threads ?? []).find((entry) => entry.id === threadId);
    assert.ok(thread, 'the chat request should have registered the thread');
    assert.equal(thread.title, firstMessageText);
  });

  it('ignores a stop/cancel for an unknown request and stays usable', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('cancel-unknown');
    const socket = await openChatSocket(user.token, threadId);
    const collector = collectFrames(socket);

    // The client aborts mid-stream by sending a cancel for the request id.
    // An unknown (or already-finished) id must be a harmless no-op...
    socket.send(JSON.stringify({ id: 'req-never-started', type: 'cf_agent_chat_request_cancel' }));

    // ...and the connection must keep working for the next exchange.
    sendChatRequest(socket, 'req-after-cancel', 'What is on my desktop?', threadId);
    const errorFrame = await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.error === true && frame.id === 'req-after-cancel',
    );
    assert.ok(typeof errorFrame.body === 'string' && errorFrame.body.trim().length > 0);
    await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-after-cancel',
    );
    socket.close();

    const history = await getThreadHistory(user.token, threadId);
    assert.deepEqual(
      history.map((message) => message.id),
      ['user-req-after-cancel'],
    );
  });

  it('tolerates a stale cancel delivered on a fresh connection after a drop', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('stale-cancel');
    const firstSocket = await openChatSocket(user.token, threadId);
    const collector = collectFrames(firstSocket);

    sendChatRequest(firstSocket, 'req-stale-1', 'What is on my desktop?', threadId);
    await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-stale-1',
    );
    // Dropped socket — no close handshake.
    firstSocket.terminate();

    // A client that aborted its in-flight request at the drop (pre-strip
    // behavior, or any foreign client) flushes its queued cancel frame on
    // the NEXT connection. Asserting that such a cancel leaves a live
    // in-flight stream alone needs a Workers AI binding the local harness
    // does not have; what this pins is the sequence the server must
    // tolerate: the stale cancel arrives on a fresh connection and neither
    // breaks the DO nor the reconnecting client's next exchange.
    const secondSocket = await openChatSocket(user.token, threadId);
    secondSocket.send(JSON.stringify({ id: 'req-stale-1', type: 'cf_agent_chat_request_cancel' }));

    const secondCollector = collectFrames(secondSocket);
    sendChatRequest(secondSocket, 'req-stale-2', 'And my folders?', threadId);
    const errorFrame = await secondCollector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.error === true && frame.id === 'req-stale-2',
    );
    assert.ok(typeof errorFrame.body === 'string' && errorFrame.body.trim().length > 0);
    await secondCollector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-stale-2',
    );
    secondSocket.close();

    const history = await getThreadHistory(user.token, threadId);
    assert.deepEqual(
      history.map((message) => message.id),
      ['user-req-stale-1', 'user-req-stale-2'],
    );
  });

  it('answers a resume handshake with resume-none when no stream is active', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('resume-none');
    const socket = await openChatSocket(user.token, threadId);
    const collector = collectFrames(socket);

    // This is the frame the transport sends after a socket drop reconnects.
    socket.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
    const resumeNone = await collector.waitFor(
      (frame) => frame.type === 'cf_agent_stream_resume_none',
    );
    assert.ok(resumeNone, 'an idle thread must report that there is nothing to resume');
    socket.close();
  });

  it('reconnects after an abrupt drop without duplicating or orphaning history', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('reconnect');
    const firstSocket = await openChatSocket(user.token, threadId);
    const collector = collectFrames(firstSocket);

    sendChatRequest(firstSocket, 'req-reconnect', 'What is on my desktop right now?', threadId);
    await collector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-reconnect',
    );

    // Simulate a dropped socket (no close handshake).
    firstSocket.terminate();

    // Reconnect like the client does, and reload history like the pane does.
    const secondSocket = await openChatSocket(user.token, threadId);
    const secondCollector = collectFrames(secondSocket);
    await secondCollector.waitFor((frame) => frame.type === 'cf_agent_identity');

    secondSocket.send(JSON.stringify({ type: 'cf_agent_stream_resume_request' }));
    await secondCollector.waitFor((frame) => frame.type === 'cf_agent_stream_resume_none');

    const history = await getThreadHistory(user.token, threadId);
    assert.deepEqual(
      history.map((message) => ({ id: message.id, role: message.role })),
      [{ id: 'user-req-reconnect', role: 'user' }],
      'history after reconnect must match what was already shown — no duplicates, no orphaned assistant rows',
    );

    // A follow-up request on the reconnected socket still works.
    sendChatRequest(secondSocket, 'req-reconnect-2', 'And my images?', threadId);
    await secondCollector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-reconnect-2',
    );
    secondSocket.close();

    const historyAfter = await getThreadHistory(user.token, threadId);
    assert.deepEqual(
      historyAfter.map((message) => message.id),
      ['user-req-reconnect', 'user-req-reconnect-2'],
    );
  });

  it('broadcasts the persisted list to other connections on a request', async () => {
    const user = await signupUser();
    const threadId = threadIdFor('cross-tab');
    const senderSocket = await openChatSocket(user.token, threadId);
    const peerSocket = await openChatSocket(user.token, threadId);
    const senderCollector = collectFrames(senderSocket);
    const peerCollector = collectFrames(peerSocket);

    sendChatRequest(senderSocket, 'req-cross-tab', 'Show me my notes', threadId);
    await senderCollector.waitFor(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.done === true && frame.id === 'req-cross-tab',
    );

    // The other connection is told about the persisted list exactly once for
    // the request, containing the new user message — the cross-tab path that
    // keeps a second open pane in sync.
    const broadcast = await peerCollector.waitFor(
      (frame) => frame.type === 'cf_agent_chat_messages' && Array.isArray(frame.messages),
    );
    const broadcastIds = broadcast.messages.map((message) => message.id);
    assert.ok(broadcastIds.includes('user-req-cross-tab'));
    assert.equal(new Set(broadcastIds).size, broadcastIds.length, 'the broadcast list must not contain duplicate ids');

    senderSocket.close();
    peerSocket.close();
  });
});
