/**
 * Desktop tools for the OrchestratorAgent.
 *
 * Direct AI SDK tools for querying and mutating the user's desktop.
 * These run inline (no Dynamic Worker sandbox) for speed.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { DesktopItem, UserProfile } from '../../types';
import type { OrchestratorState } from '../state';

interface DesktopSnapshot {
  items: DesktopItem[];
  profile: UserProfile | null;
}

interface DesktopToolsContext {
  getUserDesktopStub: () => DurableObjectStub;
  setState: (state: OrchestratorState) => void;
  getState: () => OrchestratorState;
}

async function loadSnapshot(ctx: DesktopToolsContext): Promise<DesktopSnapshot> {
  const stub = ctx.getUserDesktopStub();
  const response = await stub.fetch(new Request('http://internal/items'));
  if (!response.ok) {
    throw new Error(`Failed to load desktop state (${response.status})`);
  }
  return response.json<DesktopSnapshot>();
}

function getItemLocation(item: DesktopItem, items: DesktopItem[]): string {
  if (!item.parentId) return 'Desktop';
  return items.find((i) => i.id === item.parentId)?.name || 'Desktop';
}

function getItemSummary(item: DesktopItem): string {
  if (item.imageAnalysis?.caption) return item.imageAnalysis.caption;
  if (item.url) return item.url;
  if (item.textContent) return item.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);
  const tags = item.userTags ?? item.imageAnalysis?.tags ?? [];
  if (tags.length > 0) return `Tags: ${tags.join(', ')}`;
  return item.mimeType || item.type;
}

function searchItems(items: DesktopItem[], query: string): Array<{
  id: string;
  name: string;
  type: DesktopItem['type'];
  location: string;
  summary: string;
  matchedIn: string[];
}> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) return [];

  const results: Array<{
    id: string;
    name: string;
    type: DesktopItem['type'];
    location: string;
    summary: string;
    matchedIn: string[];
    score: number;
  }> = [];

  for (const item of items) {
    if (item.isTrashed) continue;

    const fields: Array<{ label: string; value: string | undefined; weight: number }> = [
      { label: 'name', value: item.name, weight: 5 },
      { label: 'tags', value: (item.userTags ?? item.imageAnalysis?.tags ?? []).join(' '), weight: 10 },
      { label: 'caption', value: item.imageAnalysis?.caption, weight: 8 },
      { label: 'detected text', value: item.imageAnalysis?.detectedText?.join(' '), weight: 7 },
      { label: 'text content', value: item.textContent, weight: 6 },
      { label: 'url', value: item.url, weight: 4 },
      { label: 'colors', value: item.imageAnalysis?.dominantColors?.join(' '), weight: 3 },
      { label: 'type', value: item.type, weight: 2 },
    ];

    let score = 0;
    const matchedIn = new Set<string>();

    for (const term of terms) {
      for (const field of fields) {
        if (!field.value) continue;
        if (field.value.toLowerCase().includes(term)) {
          score += field.weight;
          matchedIn.add(field.label);
        }
      }
    }

    if (score > 0) {
      results.push({
        id: item.id,
        name: item.name,
        type: item.type,
        location: getItemLocation(item, items),
        summary: getItemSummary(item),
        matchedIn: Array.from(matchedIn),
        score,
      });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ score: _score, ...rest }) => rest);
}

export function createDesktopTools(ctx: DesktopToolsContext) {
  return {
    getDesktopOverview: tool({
      description: 'Get a concise summary of the current desktop: item counts by type, recent items, and analyzed image stats.',
      inputSchema: z.object({}),
      execute: async () => {
        const snapshot = await loadSnapshot(ctx);
        const active = snapshot.items.filter((i) => !i.isTrashed);
        const images = active.filter((i) => i.type === 'image');
        const analyzed = images.filter((i) => i.imageAnalysis?.status === 'complete');
        const counts = active.reduce<Record<string, number>>((acc, i) => {
          acc[i.type] = (acc[i.type] || 0) + 1;
          return acc;
        }, {});

        return {
          username: snapshot.profile?.username ?? 'unknown',
          totalActiveItems: active.length,
          analyzedImages: analyzed.length,
          totalImages: images.length,
          counts,
          recentItems: active
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 8)
            .map((i) => ({
              id: i.id,
              name: i.name,
              type: i.type,
              location: getItemLocation(i, snapshot.items),
            })),
        };
      },
    }),

    searchDesktop: tool({
      description: 'Search the desktop by name, tags, captions, OCR text, colors, URLs, or text content. Returns matching items with where they matched.',
      inputSchema: z.object({
        query: z.string().min(1).describe('The search query in plain language.'),
      }),
      execute: async (input) => {
        const snapshot = await loadSnapshot(ctx);
        const results = searchItems(snapshot.items, input.query);
        const matchedIds = results.map((r) => r.id);
        ctx.setState({
          ...ctx.getState(),
          lastMatchedItemIds: matchedIds,
          lastQuery: input.query,
        });

        return {
          query: input.query,
          totalMatches: results.length,
          items: results.slice(0, 10),
        };
      },
    }),

    createFolder: tool({
      description: 'Create a folder on the desktop and optionally move items into it. Use after searching to group matches.',
      inputSchema: z.object({
        folderName: z.string().min(1).max(80).describe('Name for the new folder.'),
        itemIds: z.array(z.string()).optional().describe('Item IDs to move into the folder. Omit to use the last search results.'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const sourceIds = input.itemIds?.filter(Boolean) ?? ctx.getState().lastMatchedItemIds;
        if (sourceIds.length === 0) {
          throw new Error('No items to group. Search for files first, or provide item IDs.');
        }

        const stub = ctx.getUserDesktopStub();

        // Create the folder
        // SECURITY: Default to private. The server's `createItemInternal` also
        // defaults to private, and the approval UI shown to the user only
        // surfaces the folder's name — not its visibility. Creating an
        // agent-proposed "Tax Documents" / "Medical" folder as public would
        // silently publish the folder name on the user's /@username profile
        // without consent. The user can toggle "Visible to visitors" via Get
        // Info after creation if they actually want it public.
        const createRes = await stub.fetch(new Request('http://internal/items', {
          method: 'POST',
          body: JSON.stringify({
            type: 'folder',
            name: input.folderName.trim(),
            parentId: null,
            position: { x: 60, y: 60 },
            isPublic: false,
          }),
        }));
        if (!createRes.ok) throw new Error(`Failed to create folder (${createRes.status})`);
        const folder = await createRes.json<DesktopItem>();

        // Move items into the folder
        const patches = sourceIds.map((id: string) => ({ id, updates: { parentId: folder.id } }));
        const moveRes = await stub.fetch(new Request('http://internal/items', {
          method: 'PATCH',
          body: JSON.stringify(patches),
        }));
        if (!moveRes.ok) throw new Error(`Failed to move items (${moveRes.status})`);
        const moved = await moveRes.json<DesktopItem[]>();

        return {
          folder: { id: folder.id, name: folder.name, type: folder.type },
          movedCount: moved.length,
          movedItems: moved.map((i) => ({ id: i.id, name: i.name, type: i.type })),
        };
      },
    }),

    moveItems: tool({
      description: 'Move desktop items into a folder or back to the root desktop.',
      inputSchema: z.object({
        itemIds: z.array(z.string()).min(1).describe('IDs of items to move.'),
        targetFolderId: z.string().nullable().describe('Target folder ID, or null for root desktop.'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const stub = ctx.getUserDesktopStub();
        const patches = input.itemIds.map((id: string) => ({ id, updates: { parentId: input.targetFolderId } }));
        const res = await stub.fetch(new Request('http://internal/items', {
          method: 'PATCH',
          body: JSON.stringify(patches),
        }));
        if (!res.ok) throw new Error(`Failed to move items (${res.status})`);
        const moved = await res.json<DesktopItem[]>();
        return { movedCount: moved.length };
      },
    }),
  };
}
