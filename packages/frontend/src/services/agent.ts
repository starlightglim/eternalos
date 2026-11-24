/**
 * Agent domain client — Ask Eternal chat capability tokens and thread CRUD.
 * (Live chat runs over WebSocket via useAgent/useAgentChat, not this client.)
 */

import { apiRequest } from './transport';

interface AgentChatWebSocketTokenResponse {
  token: string;
  expiresAt: number;
}

export interface AgentThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ListAgentThreadsResponse {
  threads: AgentThreadSummary[];
}

interface AgentThreadResponse {
  thread: AgentThreadSummary;
}

interface DeleteAgentThreadResponse {
  deleted: boolean;
  threadId: string;
}

export async function mintAgentChatWebSocketToken(): Promise<string> {
  const response = await apiRequest<AgentChatWebSocketTokenResponse>('/api/agent/chat/ws-token', {
    method: 'POST',
  });
  return response.token;
}

export async function listAgentThreads(): Promise<AgentThreadSummary[]> {
  const response = await apiRequest<ListAgentThreadsResponse>('/api/agent/threads', {
    method: 'GET',
  });
  return response.threads;
}

export async function createAgentThread(title?: string): Promise<AgentThreadSummary> {
  const response = await apiRequest<AgentThreadResponse>('/api/agent/threads', {
    method: 'POST',
    body: JSON.stringify(title ? { title } : {}),
  });
  return response.thread;
}

export async function renameAgentThread(threadId: string, title: string): Promise<AgentThreadSummary> {
  const response = await apiRequest<AgentThreadResponse>(`/api/agent/threads/${encodeURIComponent(threadId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
  return response.thread;
}

export async function deleteAgentThread(threadId: string): Promise<DeleteAgentThreadResponse> {
  return apiRequest<DeleteAgentThreadResponse>(`/api/agent/threads/${encodeURIComponent(threadId)}`, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Code Mode undo and routines (per thread; the server derives the agent from
// the signed-in user, so threadId only picks which of their threads).
// ---------------------------------------------------------------------------

export interface UndoRunResult {
  status: 'undone' | 'partial' | 'missing' | 'already-undone';
  done: string[];
  failed: Array<{ summary: string; error: string }>;
  changedApps: string[];
  /** The undo restored the desktop's look. */
  appearanceChanged?: boolean;
}

export interface RoutineSummary {
  id: string;
  name: string;
  schedule: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastSummary: string | null;
  code: string;
}

export interface RoutineRunResult {
  status: 'ok' | 'error' | 'missing';
  summary?: string;
  runId?: string;
  changedApps?: string[];
}

const threadQuery = (threadId: string) => `threadId=${encodeURIComponent(threadId)}`;

function httpStatusOf(error: unknown): number | null {
  const match = error instanceof Error ? /^(\d{3})\b/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
}

export async function undoAgentRun(threadId: string, runId: string): Promise<UndoRunResult> {
  try {
    return await apiRequest<UndoRunResult>(
      `/api/agent/runs/${encodeURIComponent(runId)}/undo?${threadQuery(threadId)}`,
      { method: 'POST' },
    );
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 409) return { status: 'already-undone', done: [], failed: [], changedApps: [] };
    if (status === 404) return { status: 'missing', done: [], failed: [], changedApps: [] };
    throw error;
  }
}

export async function listAgentRoutines(threadId: string): Promise<RoutineSummary[]> {
  const response = await apiRequest<{ routines: RoutineSummary[] }>(`/api/agent/routines?${threadQuery(threadId)}`, { method: 'GET' });
  return response.routines;
}

export async function runAgentRoutineNow(threadId: string, routineId: string): Promise<RoutineRunResult> {
  return apiRequest<RoutineRunResult>(
    `/api/agent/routines/${encodeURIComponent(routineId)}/run?${threadQuery(threadId)}`,
    { method: 'POST' },
  );
}

export async function deleteAgentRoutine(threadId: string, routineId: string): Promise<{ deleted: boolean }> {
  return apiRequest<{ deleted: boolean }>(
    `/api/agent/routines/${encodeURIComponent(routineId)}?${threadQuery(threadId)}`,
    { method: 'DELETE' },
  );
}
