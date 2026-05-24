export type MemoryKind = 'preference' | 'identity' | 'project' | 'context' | 'other';

export interface OrchestratorMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestratorState {
  lastMatchedItemIds: string[];
  lastQuery: string | null;
  memories: OrchestratorMemory[];
}
