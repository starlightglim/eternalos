import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryKind, OrchestratorMemory, OrchestratorState } from '../state';

const MAX_MEMORIES = 24;

interface MemoryToolsContext {
  getState: () => OrchestratorState;
  setState: (state: OrchestratorState) => void;
}

function normalizeMemoryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function findMatchingMemory(
  memories: OrchestratorMemory[],
  content: string,
  kind: MemoryKind,
): OrchestratorMemory | undefined {
  const normalized = normalizeMemoryContent(content).toLowerCase();
  return memories.find((memory) => (
    memory.kind === kind && normalizeMemoryContent(memory.content).toLowerCase() === normalized
  ));
}

function summarizeMemories(memories: OrchestratorMemory[]) {
  return memories.map((memory) => ({
    id: memory.id,
    kind: memory.kind,
    content: memory.content,
    updatedAt: memory.updatedAt,
  }));
}

export function createMemoryTools(ctx: MemoryToolsContext) {
  return {
    rememberMemory: tool({
      description: 'Save a durable user memory such as a preference, identity detail, ongoing project fact, or other context that should persist across future conversations.',
      inputSchema: z.object({
        content: z.string().min(3).max(300).describe('The memory to store in concise natural language.'),
        kind: z.enum(['preference', 'identity', 'project', 'context', 'other']).default('context').describe('The type of memory being stored.'),
      }),
      execute: async (input) => {
        const state = ctx.getState();
        const content = normalizeMemoryContent(input.content);
        const now = Date.now();
        const existing = findMatchingMemory(state.memories, content, input.kind);

        let memories: OrchestratorMemory[];
        let saved: OrchestratorMemory;

        if (existing) {
          saved = {
            ...existing,
            content,
            updatedAt: now,
          };
          memories = state.memories
            .map((memory) => (memory.id === existing.id ? saved : memory))
            .sort((a, b) => b.updatedAt - a.updatedAt);
        } else {
          saved = {
            id: crypto.randomUUID(),
            kind: input.kind,
            content,
            createdAt: now,
            updatedAt: now,
          };
          memories = [saved, ...state.memories]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_MEMORIES);
        }

        ctx.setState({
          ...state,
          memories,
        });

        return {
          status: existing ? 'updated' : 'created',
          memory: {
            id: saved.id,
            kind: saved.kind,
            content: saved.content,
          },
          totalMemories: memories.length,
        };
      },
    }),

    listMemories: tool({
      description: 'List the durable memories currently saved for this user.',
      inputSchema: z.object({
        kind: z.enum(['preference', 'identity', 'project', 'context', 'other']).optional().describe('Optional memory type filter.'),
      }),
      execute: async (input) => {
        const state = ctx.getState();
        const filtered = input.kind
          ? state.memories.filter((memory) => memory.kind === input.kind)
          : state.memories;

        return {
          totalMemories: state.memories.length,
          returnedCount: filtered.length,
          memories: summarizeMemories(filtered),
        };
      },
    }),

    forgetMemory: tool({
      description: 'Delete a saved durable memory by ID or by matching text.',
      inputSchema: z.object({
        memoryId: z.string().optional().describe('Exact memory ID to remove.'),
        query: z.string().min(1).max(300).optional().describe('Text to match against a saved memory when the ID is not known.'),
      }).refine((value) => Boolean(value.memoryId || value.query), {
        message: 'Provide either memoryId or query',
      }),
      execute: async (input) => {
        const state = ctx.getState();

        const memoryToDelete = input.memoryId
          ? state.memories.find((memory) => memory.id === input.memoryId)
          : state.memories.find((memory) => normalizeMemoryContent(memory.content).toLowerCase().includes(
            normalizeMemoryContent(input.query ?? '').toLowerCase(),
          ));

        if (!memoryToDelete) {
          return {
            status: 'not_found',
            totalMemories: state.memories.length,
          };
        }

        const memories = state.memories.filter((memory) => memory.id !== memoryToDelete.id);
        ctx.setState({
          ...state,
          memories,
        });

        return {
          status: 'deleted',
          memory: {
            id: memoryToDelete.id,
            kind: memoryToDelete.kind,
            content: memoryToDelete.content,
          },
          totalMemories: memories.length,
        };
      },
    }),
  };
}
