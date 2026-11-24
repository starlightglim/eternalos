/**
 * Agent (Ask Eternal) routes
 *
 *   POST   /api/agent/chat/ws-token      mint a short-lived chat WS token
 *   GET    /api/agent/threads           list the caller's chat threads
 *   POST   /api/agent/threads           create a thread
 *   PATCH  /api/agent/threads/:id       rename a thread
 *   DELETE /api/agent/threads/:id       delete a thread
 *   ANY    /api/agent/chat[/...]        forward to the per-thread agent DO
 *   POST   /api/agent/runs/:runId/undo  undo a Code Mode run (?threadId=)
 *   GET    /api/agent/routines          list a thread's routines (?threadId=)
 *   POST   /api/agent/routines/:id/run  run a routine now (?threadId=)
 *   DELETE /api/agent/routines/:id      delete a routine (?threadId=)
 *
 * Auth policy: 'required' for the thread/token routes, 'agent-chat' for the
 * forwarded chat transport (Bearer or one-time wsToken on WebSocket upgrades).
 * Rate-limit policy: see routeTable.ts.
 */

import { getAgentByName } from 'agents';
import type { OrchestratorAgent } from '../agents/OrchestratorAgent';
import {
  buildThreadAgentName,
  createThread,
  deleteThread,
  listThreads,
  normalizeThreadId,
  renameThread,
} from '../agents/threadRegistry';
import type { Env } from '../index';
import { signChatWebSocketToken } from '../utils/jwt';
import type { RouteContext } from './router';
import { requireAuthContext } from './router';

/** POST /api/agent/chat/ws-token — mint a one-minute chat WebSocket token. */
export async function handleAgentChatWsToken(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const token = await signChatWebSocketToken(auth.uid, c.env.JWT_SECRET);
  return Response.json({
    token,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  });
}

/** GET /api/agent/threads — list the caller's threads. */
export async function handleListAgentThreads(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const threads = await listThreads(c.env, auth.uid);
  return Response.json({ threads });
}

/** POST /api/agent/threads — create a thread (optional title). */
export async function handleCreateAgentThread(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const body = await c.request.json().catch(() => ({})) as { title?: unknown };
  const title = typeof body.title === 'string' ? body.title : undefined;
  const thread = await createThread(c.env, auth.uid, title);
  return Response.json({ thread }, { status: 201 });
}

/** PATCH /api/agent/threads/:id — rename a thread. */
export async function handleRenameAgentThread(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const [threadId] = c.params;
  const body = await c.request.json().catch(() => ({})) as { title?: unknown };
  if (typeof body.title !== 'string' || body.title.trim().length === 0) {
    return Response.json({ error: 'Thread title is required' }, { status: 400 });
  }

  const thread = await renameThread(c.env, auth.uid, threadId, body.title);
  if (!thread) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  return Response.json({ thread });
}

/** DELETE /api/agent/threads/:id — delete a thread. */
export async function handleDeleteAgentThread(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const [threadId] = c.params;
  const deleted = await deleteThread(c.env, auth.uid, threadId);
  if (!deleted) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  return Response.json({ deleted: true, threadId: normalizeThreadId(threadId) });
}

/**
 * /api/agent/chat[/...] — forward to the per-thread OrchestratorAgent DO.
 * Any method; WebSocket upgrades carry the streamed chat. The agent instance
 * name is derived from the authenticated uid plus the active thread id.
 */
export async function handleAgentChatForward(c: RouteContext): Promise<Response> {
  const auth = requireAuthContext(c);
  const threadId = normalizeThreadId(c.url.searchParams.get('threadId'));
  const agentName = buildThreadAgentName(auth.uid, threadId);
  const agentStub = await getAgentByName<Env, OrchestratorAgent>(c.env.OrchestratorAgent, agentName);

  const forwardUrl = new URL(c.request.url);
  const remainder = c.url.pathname.slice('/api/agent/chat'.length);
  forwardUrl.pathname = remainder || '/';

  return agentStub.fetch(new Request(forwardUrl.toString(), c.request));
}

/** The caller's own per-thread agent: the name is built from the authenticated uid. */
async function threadAgent(c: RouteContext) {
  const auth = requireAuthContext(c);
  const threadId = normalizeThreadId(c.url.searchParams.get('threadId'));
  return getAgentByName<Env, OrchestratorAgent>(c.env.OrchestratorAgent, buildThreadAgentName(auth.uid, threadId));
}

const ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;

/** POST /api/agent/runs/:runId/undo — reverse a Code Mode run. */
export async function handleUndoCodeRun(c: RouteContext): Promise<Response> {
  const [runId] = c.params;
  if (!runId || !ID_RE.test(runId)) return Response.json({ error: 'Invalid run id' }, { status: 400 });
  const agent = await threadAgent(c);
  const result = await agent.undoCodeRun(runId);
  const status = result.status === 'missing' ? 404 : result.status === 'already-undone' ? 409 : 200;
  return Response.json(result, { status });
}

/** GET /api/agent/routines — list routines. */
export async function handleListRoutines(c: RouteContext): Promise<Response> {
  const agent = await threadAgent(c);
  return Response.json({ routines: await agent.listRoutines() });
}

/** POST /api/agent/routines/:id/run — run a routine now. */
export async function handleRunRoutineNow(c: RouteContext): Promise<Response> {
  const [routineId] = c.params;
  if (!routineId || !ID_RE.test(routineId)) return Response.json({ error: 'Invalid routine id' }, { status: 400 });
  const agent = await threadAgent(c);
  const result = await agent.runRoutineNow(routineId);
  return Response.json(result, { status: result.status === 'missing' ? 404 : 200 });
}

/** DELETE /api/agent/routines/:id — delete a routine. */
export async function handleDeleteRoutine(c: RouteContext): Promise<Response> {
  const [routineId] = c.params;
  if (!routineId || !ID_RE.test(routineId)) return Response.json({ error: 'Invalid routine id' }, { status: 400 });
  const agent = await threadAgent(c);
  const result = await agent.deleteRoutine(routineId);
  return Response.json(result, { status: result.deleted ? 200 : 404 });
}
