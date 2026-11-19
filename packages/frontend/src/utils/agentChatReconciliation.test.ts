import { expect, test } from 'vitest';
import {
  abortChatRequestLocally,
  isAgentChatCancelFrame,
  mergeChatHistory,
  resolveDisconnectAction,
  shouldReloadHistoryAfterReconnect,
  stripQueuedCancelFramesInPlace,
  type ChatHistoryMessage,
} from './agentChatReconciliation';

function user(id: string, text: string): ChatHistoryMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] };
}

function assistant(id: string, text: string): ChatHistoryMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] };
}

// ── Dropped socket mid-stream ────────────────────────────────────────
// A request that was in flight when the socket dropped must be aborted
// locally, or the chat is stuck on "Working..." forever and the reconnecting
// connection stays excluded from the server's stream broadcasts.

test('aborts a chat request that was in flight when the socket dropped', () => {
  expect(resolveDisconnectAction('streaming')).toBe('stop-request');
  expect(resolveDisconnectAction('submitted')).toBe('stop-request');
});

test('leaves the request state alone when nothing is in flight', () => {
  expect(resolveDisconnectAction('ready')).toBe('none');
  expect(resolveDisconnectAction('error')).toBe('none');
});

test('reloads history after a reconnect only when a drop was seen and the chat is idle', () => {
  expect(shouldReloadHistoryAfterReconnect(true, 'ready')).toBe(true);
  expect(shouldReloadHistoryAfterReconnect(false, 'ready')).toBe(false);
  // Mid-flight recovery is owned by the stream-resume replay, not a reload.
  expect(shouldReloadHistoryAfterReconnect(true, 'streaming')).toBe(false);
  expect(shouldReloadHistoryAfterReconnect(true, 'submitted')).toBe(false);
  expect(shouldReloadHistoryAfterReconnect(false, 'streaming')).toBe(false);
});

// ── Drop-triggered abort must not cancel server-side ─────────────────
// The transport's only local request cleanup is the abort path, and it
// unconditionally sends a cancel frame (@cloudflare/ai-chat dist/react.js,
// sendMessages → onAbort). Through a closed partysocket that frame is not
// transmitted but queued for the next open — where it would cancel the very
// generation the resume path is supposed to replay. The disconnect recovery
// therefore aborts locally and strips the queued cancel frame.

test('identifies cancel frames and only cancel frames', () => {
  expect(isAgentChatCancelFrame('{"id":"r1","type":"cf_agent_chat_request_cancel"}')).toBe(true);
  expect(isAgentChatCancelFrame('{"id":"r1","type":"cf_agent_use_chat_request"}')).toBe(false);
  expect(isAgentChatCancelFrame('cf_agent_chat_request_cancel (not json)')).toBe(false);
  expect(isAgentChatCancelFrame(42)).toBe(false);
  expect(isAgentChatCancelFrame(undefined)).toBe(false);
});

test('strips only cancel frames from the outbound queue, in place', () => {
  const queuedRequest = '{"id":"r2","type":"cf_agent_use_chat_request"}';
  const queuedCancel = '{"id":"r1","type":"cf_agent_chat_request_cancel"}';
  const queue = [queuedRequest, queuedCancel, queuedRequest];

  const removed = stripQueuedCancelFramesInPlace(queue);

  expect(removed).toBe(1);
  expect(queue).toEqual([queuedRequest, queuedRequest]);
});

test('ignores a non-array queue, so partysocket internals changing degrades instead of crashing', () => {
  expect(stripQueuedCancelFramesInPlace(undefined)).toBe(0);
  expect(stripQueuedCancelFramesInPlace('not a queue')).toBe(0);
});

test('a non-intentional close aborts locally without leaving a cancel frame queued', () => {
  // stop() runs synchronously through the abort dispatch; through a closed
  // partysocket its cancel frame is enqueued rather than sent (traced in
  // partysocket dist/ws.js send/_handleOpen). After the recovery runs, the
  // queue must be empty — nothing may flush to the server on reconnect.
  const queue: unknown[] = [];
  const stop = () => {
    queue.push('{"id":"req-drop","type":"cf_agent_chat_request_cancel"}');
  };

  abortChatRequestLocally(stop, queue);

  expect(queue).toEqual([]);
});

test('keeps unrelated queued frames when clearing the drop artifact', () => {
  const queue: unknown[] = [];
  const stop = () => {
    queue.push('{"id":"r0","type":"cf_agent_use_chat_request"}');
    queue.push('{"id":"req-drop","type":"cf_agent_chat_request_cancel"}');
  };

  abortChatRequestLocally(stop, queue);

  expect(queue).toEqual(['{"id":"r0","type":"cf_agent_use_chat_request"}']);
});

test('a drop while no request is in flight leaves the queue untouched', () => {
  const queue: unknown[] = [];
  const stop = () => {}; // stop() no-ops when the chat is idle

  abortChatRequestLocally(stop, queue);

  expect(queue).toEqual([]);
});

// ── Thread-history reload after a reconnect ─────────────────────────
// Reloading history must not duplicate messages already shown.

test('matches already-shown messages by id instead of re-appending them', () => {
  const local = [user('u1', 'What is on my desktop?'), assistant('a1', 'You have 3 items.')];
  const history = [
    user('u1', 'What is on my desktop?'),
    assistant('a1', 'You have 3 items.'),
    user('u2', 'And my photos?'),
  ];

  const merged = mergeChatHistory(local, history);

  expect(merged.map((message) => message.id)).toEqual(['u1', 'a1', 'u2']);
  const ids = merged.map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('prefers the reloaded history version when an id is present in both', () => {
  const local = [user('u1', 'hi'), assistant('a1', 'You have 3 item')]; // stale partial
  const history = [user('u1', 'hi'), assistant('a1', 'You have 3 items and 2 folders.')];

  const merged = mergeChatHistory(local, history);

  expect(merged).toHaveLength(2);
  expect(merged.find((message) => message.id === 'a1')).toBe(history[1]);
});

test('keeps a local-only partial reply the server has not persisted yet', () => {
  const local = [user('u1', 'hello'), assistant('a1', 'Hello, I was jus')];
  const history = [user('u1', 'hello')];

  const merged = mergeChatHistory(local, history);

  expect(merged.map((message) => message.id)).toEqual(['u1', 'a1']);
});

test('shows messages sent from elsewhere during the disconnect exactly once', () => {
  const local = [user('u1', 'hi'), assistant('a1', 'Hello!')];
  const history = [
    user('u1', 'hi'),
    assistant('a1', 'Hello!'),
    user('u2', 'from another device'),
    assistant('a2', 'Welcome back.'),
  ];

  const merged = mergeChatHistory(local, history);

  expect(merged.map((message) => message.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  const ids = merged.map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test('preserves history order and appends local-only messages in local order', () => {
  const local = [user('u0', 'old local note'), assistant('a3', 'partial tail')];
  const history = [user('u1', 'srv1'), user('u2', 'srv2')];

  const merged = mergeChatHistory(local, history);

  expect(merged.map((message) => message.id)).toEqual(['u1', 'u2', 'u0', 'a3']);
});

test('handles empty inputs without inventing or dropping messages', () => {
  const local = [user('u1', 'hi')];
  const history = [user('h1', 'srv')];
  expect(mergeChatHistory([], [])).toEqual([]);
  expect(mergeChatHistory(local, [])).toEqual([local[0]]);
  expect(mergeChatHistory([], history)).toEqual([history[0]]);
});

test('collapses duplicate ids within a single list, first occurrence winning', () => {
  const first = user('u1', 'first');
  const dup = user('u1', 'second');

  expect(mergeChatHistory([first, dup], [])).toEqual([first]);
  expect(mergeChatHistory([], [first, dup])).toEqual([first]);
});
