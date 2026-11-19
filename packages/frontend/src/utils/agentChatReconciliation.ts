/**
 * Pure reconciliation logic for the Ask Eternal chat transport.
 *
 * The chat pane (AgentChatWindow) runs `useAgent`/`useAgentChat` over a
 * partysocket WebSocket to the OrchestratorAgent durable object. The
 * transport's per-request stream has no socket-close handling of its own, so
 * disconnect/reconnect/history-reload outcomes depend on decisions made here.
 * They are extracted as pure functions so they can be tested directly
 * (agentChatReconciliation.test.ts) instead of through React.
 */

/**
 * The `status` values exposed by `useAgentChat` (from @ai-sdk/react).
 * `'submitted' | 'streaming'` mean a chat request is in flight.
 */
export type ChatRequestStatus = 'submitted' | 'streaming' | 'ready' | 'error';

/**
 * The minimal shape of a chat UIMessage that reconciliation relies on.
 * Structurally compatible with the `UIMessage` values `useAgentChat`
 * produces and the rows `get-messages` returns.
 */
export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: unknown[];
}

/**
 * What to do about an in-flight chat request when the agent socket drops.
 *
 * - `'stop-request'`: the request must be aborted locally (`stop()` on the
 *   chat). Without this, the request's local stream stays pending forever
 *   (the transport never hears a close), leaving the UI stuck on
 *   "Working..." with the composer disabled, and the server keeps the
 *   reconnecting connection excluded from stream broadcasts until a resume
 *   handshake completes. Aborting unsticks the local request; the cancel
 *   frame that the abort path queues is stripped locally (see
 *   abortChatRequestLocally) so the server never truncates that
 *   generation. Since @cloudflare/ai-chat 0.2.x the abort KEEPS the
 *   request id in the transport's active-request set, so re-attaching to
 *   the still-running server stream on reconnect is no longer automatic —
 *   the caller must record that a request was dropped mid-flight and
 *   drive `resumeStream()` on reconnect (see
 *   shouldResumeStreamAfterReconnect, which replays the generation into
 *   the same message — replaced by id, no duplicate, no orphan).
 * - `'none'`: nothing is in flight; leave the request state alone.
 *
 * In the chat pane this rule is enforced by abortChatRequestLocally on a
 * non-intentional socket close: `stop()` no-ops unless its own authoritative
 * status is `submitted`/`streaming` — exactly this predicate, read without
 * any render-staleness window. Intentional closes (unmount / thread switch /
 * socket recreation — where partysocket reports `shouldReconnect === false`)
 * are filtered out by the caller before deciding.
 */
export function resolveDisconnectAction(status: ChatRequestStatus): 'stop-request' | 'none' {
  return status === 'submitted' || status === 'streaming' ? 'stop-request' : 'none';
}

/**
 * The wire type of the cancel frame @cloudflare/ai-chat's transport sends when
 * a chat request is aborted (dist/react.js, sendMessages → onAbort →
 * agent.send(CF_AGENT_CHAT_REQUEST_CANCEL)). Knowing the literal here lets
 * the disconnect recovery strip that frame from partysocket's outbound queue.
 */
const AGENT_CHAT_CANCEL_FRAME_TYPE = 'cf_agent_chat_request_cancel';

/**
 * Whether a partysocket outbound frame is an agent-chat cancel. Tolerates
 * non-JSON and non-string entries (the queue can hold blobs/array buffers);
 * a cheap substring pre-filter avoids parsing every frame.
 */
export function isAgentChatCancelFrame(frame: unknown): boolean {
  if (typeof frame !== 'string') return false;
  if (!frame.includes(`"${AGENT_CHAT_CANCEL_FRAME_TYPE}"`)) return false;
  try {
    const parsed = JSON.parse(frame) as { type?: unknown };
    return parsed?.type === AGENT_CHAT_CANCEL_FRAME_TYPE;
  } catch {
    return false;
  }
}

/**
 * Remove cancel frames from a partysocket outbound queue, in place. Returns
 * the number removed; a non-array (e.g. a future partysocket rename of
 * `_messageQueue`) is ignored, degrading to the frame being delivered — the
 * pre-fix truncated-reply behavior, never a crash.
 */
export function stripQueuedCancelFramesInPlace(queue: unknown): number {
  if (!Array.isArray(queue)) return 0;
  let removed = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (isAgentChatCancelFrame(queue[i])) {
      queue.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/**
 * Abort an in-flight chat request after a non-intentional socket drop —
 * without letting the cancel frame reach the server.
 *
 * `stop()` (from useAgentChat) is the only way to clear the stuck request
 * locally: it synchronously aborts the transport's stream (abortController
 * abort listeners fire synchronously), which unblocks the pending request
 * and resets the status. (@cloudflare/ai-chat 0.2.x keeps the aborted
 * request id in the transport's active set, so re-attaching to the
 * still-running server stream on reconnect is the caller's job — see
 * shouldResumeStreamAfterReconnect.) But that abort path unconditionally
 * sends a cancel frame, and since the socket is down partysocket enqueues
 * it and flushes it on the next open — where it would cancel the very
 * generation the resume path is meant to replay (with abortSignal wired
 * server-side, a truncated reply).
 *
 * So: run the stop, then strip the cancel it just queued. A user-pressed
 * Stop is unaffected — on a live socket its cancel is sent immediately and
 * the queue is empty, so nothing is stripped.
 *
 * @param stop The chat's stop() (synchronous through the abort dispatch).
 * @param outboundQueue partysocket's `_messageQueue` (private field, read
 *   defensively — see stripQueuedCancelFramesInPlace).
 */
export function abortChatRequestLocally(stop: () => unknown, outboundQueue: unknown): void {
  void stop();
  stripQueuedCancelFramesInPlace(outboundQueue);
}

/**
 * Whether a reconnect should reload the thread history from the server.
 *
 * Only after an actual disconnect (not on first connect), and only when no
 * request is in flight: mid-flight recovery is owned by the stream-resume
 * replay, and reloading under it could clobber the message being rebuilt.
 */
export function shouldReloadHistoryAfterReconnect(
  hadDisconnect: boolean,
  status: ChatRequestStatus,
): boolean {
  return hadDisconnect && resolveDisconnectAction(status) === 'none';
}

/**
 * Whether a reconnect should attach to the server stream that was running
 * when the socket dropped, via the chat's `resumeStream()`.
 *
 * Since @cloudflare/ai-chat 0.2.x, the abort that the disconnect recovery
 * performs no longer releases the request id locally: `finish(action,
 * keepId)` keeps aborted ids in the transport's active-request set
 * (dist/react.js:78-86, onAbort passes keepId=true at :97). That set is the
 * same `localRequestIdsRef` the reconnect handler consults, so the server's
 * spontaneous `cf_agent_stream_resuming` notification for our own aborted
 * request now falls through to the local-id skip and is never ACKed
 * (dist/react.js:699) — the automatic replay-on-reconnect that 0.1.x
 * performed (it deleted the id on abort) is gone. The 0.2.x-native way to
 * re-attach is the resume handshake: `resumeStream()` ->
 * `reconnectToStream` (dist/react.js:139-171) sends
 * `cf_agent_stream_resume_request`, the server re-announces the active
 * stream (worker dist/index.js:560-563), and the replay replaces the
 * partial assistant message in place. The AI SDK only resumes by itself on
 * MOUNT (@ai-sdk/react dist/index.js resume effect), so a mid-session
 * reconnect must trigger it here.
 *
 * Preconditions mirror the close-handler side: only after a real drop,
 * only when a request actually was in flight at the drop (recorded then —
 * see resolveDisconnectAction), and only when nothing new is in flight at
 * reconnect (a request sent while offline owns the pane; the server's
 * resuming notice for the old stream is skipped locally for it anyway).
 */
export function shouldResumeStreamAfterReconnect(
  hadDisconnect: boolean,
  requestAbortedAtDrop: boolean,
  status: ChatRequestStatus,
): boolean {
  return hadDisconnect
    && requestAbortedAtDrop
    && resolveDisconnectAction(status) === 'none';
}

/**
 * Collapse duplicate ids inside one message list, first occurrence winning,
 * order preserved. Messages are keyed by id everywhere in the chat stack (the
 * server persists by id and the replay flush replaces by id), so an id can
 * never legitimately appear twice.
 */
function uniqueById<T extends ChatHistoryMessage>(messages: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }
  return result;
}

/**
 * Merge the messages currently shown in the pane with a reloaded thread
 * history, matching by id so nothing already on screen is duplicated.
 *
 * Reload happens while the chat is idle (see shouldReloadHistoryAfterReconnect),
 * at which point the server history is the settled truth: for an id present
 * in both, the history version wins (it is equal to or further along than the
 * local copy — e.g. a reply that finished server-side after the drop).
 * Messages that exist only locally — typically a partial assistant reply the
 * server has not persisted yet — are kept and appended in local order so the
 * user never loses content that is visibly on screen. Messages that exist
 * only in the history — e.g. sent from another device while this one was
 * disconnected — appear exactly once, in history order.
 */
export function mergeChatHistory<T extends ChatHistoryMessage>(local: T[], history: T[]): T[] {
  const localUnique = uniqueById(local);
  const historyUnique = uniqueById(history);
  const historyIds = new Set(historyUnique.map((message) => message.id));
  const localOnly = localUnique.filter((message) => !historyIds.has(message.id));
  return [...historyUnique, ...localOnly];
}
