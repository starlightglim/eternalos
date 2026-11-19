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
 *   handshake completes. Aborting releases the request id, which lets the
 *   built-in resume machinery ACK the server's `cf_agent_stream_resuming`
 *   notification on reconnect and replay the stream into the same message
 *   (replaced by id — no duplicate, no orphan). The abort also queues a
 *   cancel to the server, which finalizes and persists the partial reply.
 * - `'none'`: nothing is in flight; leave the request state alone.
 *
 * In the chat pane this rule is enforced by calling the chat's `stop()` on a
 * non-intentional socket close: `stop()` no-ops unless its own authoritative
 * status is `submitted`/`streaming` — exactly this predicate, read without any
 * render-staleness window. Intentional closes (unmount / thread switch /
 * socket recreation — where partysocket reports `shouldReconnect === false`)
 * are filtered out by the caller before deciding.
 */
export function resolveDisconnectAction(status: ChatRequestStatus): 'stop-request' | 'none' {
  return status === 'submitted' || status === 'streaming' ? 'stop-request' : 'none';
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
