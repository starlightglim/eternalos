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
