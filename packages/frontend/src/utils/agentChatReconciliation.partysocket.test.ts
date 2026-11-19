import { afterEach, expect, test, vi } from 'vitest';
import { MessageType } from '@cloudflare/ai-chat/types';
import { PartySocket } from 'partysocket';
import {
  abortChatRequestLocally,
  stripQueuedCancelFramesInPlace,
} from './agentChatReconciliation';

/**
 * Integration guard for the drop-fix in agentChatReconciliation.ts.
 *
 * The disconnect recovery strips the cancel frame that the chat transport's
 * abort path queues in partysocket's private `_messageQueue` (see
 * abortChatRequestLocally / stripQueuedCancelFramesInPlace, wired from the
 * socket-close handler in AgentChatWindow.tsx). That field is an
 * implementation detail of the installed partysocket: if an upgrade renames
 * or reshapes it — or send() stops enqueuing there while the socket is down
 * — the strip silently no-ops and a dropped connection goes back to
 * truncating the resumed reply (the cancel frame flushes to the server on
 * reconnect and aborts the replayed generation server-side).
 *
 * So these tests exercise the REAL installed partysocket — not a fake —
 * with a never-opened socket and a stubbed WebSocket constructor so nothing
 * can touch the network, and fail loudly (pointing at
 * agentChatReconciliation.ts) the moment that internal changes.
 */

/** Loud failure message for "the queue field/partysocket internals changed". */
const QUEUE_CONTRACT_BROKEN =
  "partysocket's internals changed: frames sent while the socket is not open " +
  "no longer land in a '_messageQueue' array on the socket (the field was " +
  "renamed, reshaped, or send() no longer enqueues there). The disconnect " +
  'recovery in packages/frontend/src/utils/agentChatReconciliation.ts ' +
  '(abortChatRequestLocally -> stripQueuedCancelFramesInPlace, wired from ' +
  'the socket-close handler in AgentChatWindow.tsx) strips the queued cancel ' +
  'frame from that field. If it silently no-ops, the cancel flushes to the ' +
  'server on reconnect and truncates the reply the resume path is replaying ' +
  '— the pre-fix bug. Re-point the strip (and the field read in ' +
  "AgentChatWindow.tsx) at partysocket's new outbound-queue internals.";

/** Loud failure message for "the strip no longer clears the real frame". */
const STRIP_BROKEN =
  'the cancel-strip in packages/frontend/src/utils/agentChatReconciliation.ts ' +
  '(stripQueuedCancelFramesInPlace / abortChatRequestLocally) failed to clear ' +
  "the real transport's cancel frame from a live partysocket outbound queue — " +
  'on reconnect partysocket would flush it to the server and truncate the ' +
  'resumed reply. Update the strip logic (or the cancel-frame literal it ' +
  'matches) to handle what the installed partysocket/@cloudflare/ai-chat ' +
  'actually queue.';

/** Loud failure message for "the offline premise of this file broke". */
const NOT_REALLY_OFFLINE =
  'a frame left the process through the stubbed WebSocket while the socket ' +
  'was down. The offline premise of this guard (and of the strip in ' +
  'packages/frontend/src/utils/agentChatReconciliation.ts) is wrong — frames ' +
  'must be queued, not transmitted, while the socket is not open.';

/**
 * A WebSocket stand-in that can never reach the network. It never reports
 * itself open, and it records every construction and attempted transmission
 * so the tests can prove nothing left the process.
 */
class StubWebSocket extends EventTarget {
  static instances: StubWebSocket[] = [];
  static transmissions: unknown[] = [];
  readonly readyState = 3; // WebSocket.CLOSED — a stub never opens
  binaryType: BinaryType = 'blob';
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    StubWebSocket.instances.push(this);
  }
  send(data: unknown): void {
    StubWebSocket.transmissions.push(data);
  }
  close(): void {}
}

/**
 * Build the chat socket the way agents/react does in production: useAgent
 * (AgentChatWindow.tsx) -> usePartySocket -> useStableSocket, which
 * constructs `new PartySocket(options)` with startClosed: true — a
 * never-opened socket. That is the same state the disconnect recovery runs
 * against after a drop: there is no live underlying WebSocket, so send()
 * must enqueue instead of transmitting. The WebSocket constructor is
 * replaced (both as a partysocket option and as the global) so nothing can
 * touch the network even if the socket tried to connect.
 */
function createOfflineChatSocket(): PartySocket {
  StubWebSocket.instances = [];
  StubWebSocket.transmissions = [];
  vi.stubGlobal('WebSocket', StubWebSocket);
  return new PartySocket({
    // Mirrors the useAgent({ agent: 'OrchestratorAgent', basePath:
    // 'api/agent/chat', host, protocol, query }) call in AgentChatWindow.tsx.
    host: 'localhost:8787',
    basePath: 'api/agent/chat',
    protocol: 'ws',
    query: { token: 'offline-test-token' },
    startClosed: true,
    WebSocket: StubWebSocket,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Read the socket's outbound queue exactly the way the production close
 * handler does (AgentChatWindow.tsx): partysocket types the field private,
 * so it is read through a structural cast.
 */
function outboundQueueOf(socket: PartySocket): unknown {
  return (socket as unknown as { _messageQueue?: unknown })._messageQueue;
}

function chatRequestFrame(id: string): string {
  return JSON.stringify({ id, type: MessageType.CF_AGENT_USE_CHAT_REQUEST });
}

/**
 * The exact frame the transport's abort path puts on the wire
 * (@cloudflare/ai-chat dist/react.js, sendMessages -> onAbort ->
 * agent.send(JSON.stringify({ id, type: CF_AGENT_CHAT_REQUEST_CANCEL }))).
 * Built from the installed transport's own constant so this guard also
 * fails loudly if that wire type ever changes.
 */
function cancelFrame(id: string): string {
  return JSON.stringify({ id, type: MessageType.CF_AGENT_CHAT_REQUEST_CANCEL });
}

// ── The partysocket internal the drop-fix relies on ───────────────────
// send() on a socket that is not open must queue into an array field named
// `_messageQueue`, or the strip has nothing to strip from.

test('frames sent while the socket is down land in the real partysocket _messageQueue', () => {
  const socket = createOfflineChatSocket();

  // Precondition: the socket must not be open — the state the disconnect
  // recovery runs in.
  expect(
    socket.readyState !== socket.OPEN,
    'partysocket changed: a startClosed socket now reports itself open, so ' +
      'this test no longer reproduces the post-drop state the recovery in ' +
      'packages/frontend/src/utils/agentChatReconciliation.ts runs in — ' +
      'rework the offline setup so send() is exercised while down.',
  ).toBe(true);

  socket.send(chatRequestFrame('r1'));
  socket.send(cancelFrame('r1'));

  const queue = outboundQueueOf(socket);

  expect(Array.isArray(queue), QUEUE_CONTRACT_BROKEN).toBe(true);
  expect(queue, QUEUE_CONTRACT_BROKEN).toEqual([chatRequestFrame('r1'), cancelFrame('r1')]);

  // The frames were queued, never transmitted — nothing touched the network.
  expect(StubWebSocket.transmissions, NOT_REALLY_OFFLINE).toEqual([]);
});

// ── The strip against that real queue ─────────────────────────────────

test('the strip clears a queued cancel frame from the real partysocket queue, keeping other frames', () => {
  const socket = createOfflineChatSocket();
  socket.send(chatRequestFrame('r1'));
  socket.send(cancelFrame('r1'));
  socket.send(chatRequestFrame('r2'));

  const queue = outboundQueueOf(socket);
  const removed = stripQueuedCancelFramesInPlace(queue);

  expect(removed, STRIP_BROKEN).toBe(1);
  expect(queue, STRIP_BROKEN).toEqual([chatRequestFrame('r1'), chatRequestFrame('r2')]);
});

test('a non-intentional close leaves the real offline socket with no cancel frame to flush on reconnect', () => {
  const socket = createOfflineChatSocket();
  // Something unrelated was already queued when the socket dropped.
  socket.send(chatRequestFrame('r0'));

  // The exact production flow (AgentChatWindow.tsx close handler): the queue
  // reference is read before stop() runs, and stop() is the transport's
  // abort path, which sends the cancel frame over this same offline socket.
  const stop = () => socket.send(cancelFrame('r1'));
  abortChatRequestLocally(stop, outboundQueueOf(socket));

  // Read the queue fresh from the socket: whatever it holds at the next
  // open is exactly what partysocket flushes to the server.
  expect(outboundQueueOf(socket), STRIP_BROKEN).toEqual([chatRequestFrame('r0')]);
  expect(StubWebSocket.transmissions, NOT_REALLY_OFFLINE).toEqual([]);
});
