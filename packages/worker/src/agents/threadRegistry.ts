import type { Env } from '../index';

export interface AgentThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const THREADS_KV_PREFIX = 'agent_threads:';
const DEFAULT_THREAD_TITLE = 'New Thread';
const MAX_THREADS = 100;

function threadsKey(uid: string): string {
  return `${THREADS_KV_PREFIX}${uid}`;
}

export function normalizeThreadId(input: string | null | undefined): string {
  const value = String(input ?? '').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    return 'default';
  }
  return value;
}

export function extractOwnerUid(agentName: string): string {
  const separatorIndex = agentName.indexOf(':');
  return separatorIndex >= 0 ? agentName.slice(0, separatorIndex) : agentName;
}

export function buildThreadAgentName(uid: string, threadId: string): string {
  return `${uid}:${normalizeThreadId(threadId)}`;
}

export async function listThreads(env: Env, uid: string): Promise<AgentThreadSummary[]> {
  const threads = await env.DESKTOP_KV.get<AgentThreadSummary[]>(threadsKey(uid), 'json');
  return (threads ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function saveThreads(env: Env, uid: string, threads: AgentThreadSummary[]): Promise<void> {
  await env.DESKTOP_KV.put(
    threadsKey(uid),
    JSON.stringify(
      threads
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_THREADS),
    ),
  );
}

export async function createThread(
  env: Env,
  uid: string,
  title?: string,
): Promise<AgentThreadSummary> {
  const threads = await listThreads(env, uid);
  const now = Date.now();
  const thread: AgentThreadSummary = {
    id: crypto.randomUUID(),
    title: title?.trim() || DEFAULT_THREAD_TITLE,
    createdAt: now,
    updatedAt: now,
  };
  await saveThreads(env, uid, [thread, ...threads.filter((existing) => existing.id !== thread.id)]);
  return thread;
}

export async function upsertThread(
  env: Env,
  uid: string,
  threadId: string,
  updates: Partial<Pick<AgentThreadSummary, 'title' | 'updatedAt'>>,
): Promise<AgentThreadSummary> {
  const normalizedId = normalizeThreadId(threadId);
  const threads = await listThreads(env, uid);
  const existing = threads.find((thread) => thread.id === normalizedId);
  const now = updates.updatedAt ?? Date.now();

  const next: AgentThreadSummary = existing
    ? {
      ...existing,
      title: updates.title?.trim() || existing.title,
      updatedAt: now,
    }
    : {
      id: normalizedId,
      title: updates.title?.trim() || DEFAULT_THREAD_TITLE,
      createdAt: now,
      updatedAt: now,
    };

  await saveThreads(env, uid, [next, ...threads.filter((thread) => thread.id !== normalizedId)]);
  return next;
}

export async function renameThread(
  env: Env,
  uid: string,
  threadId: string,
  title: string,
): Promise<AgentThreadSummary | null> {
  const normalizedId = normalizeThreadId(threadId);
  const threads = await listThreads(env, uid);
  const existing = threads.find((thread) => thread.id === normalizedId);
  if (!existing) return null;

  const updated: AgentThreadSummary = {
    ...existing,
    title: title.trim() || existing.title,
    updatedAt: Date.now(),
  };
  await saveThreads(env, uid, [updated, ...threads.filter((thread) => thread.id !== normalizedId)]);
  return updated;
}

export async function deleteThread(env: Env, uid: string, threadId: string): Promise<boolean> {
  const normalizedId = normalizeThreadId(threadId);
  const threads = await listThreads(env, uid);
  const remaining = threads.filter((thread) => thread.id !== normalizedId);
  if (remaining.length === threads.length) {
    return false;
  }
  await saveThreads(env, uid, remaining);
  return true;
}

export function deriveThreadTitleFromMessage(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return DEFAULT_THREAD_TITLE;
  return normalized.length > 60 ? `${normalized.slice(0, 57)}...` : normalized;
}

export function shouldReplaceThreadTitle(existingTitle: string | undefined): boolean {
  const current = (existingTitle ?? '').trim().toLowerCase();
  return current.length === 0 || current === DEFAULT_THREAD_TITLE.toLowerCase();
}
