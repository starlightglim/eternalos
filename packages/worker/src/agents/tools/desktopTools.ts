/**
 * Desktop tools for the OrchestratorAgent.
 *
 * Direct AI SDK tools for querying and mutating the user's desktop.
 * These run inline (no Dynamic Worker sandbox) for speed.
 */

import {
  APPEARANCE_COLOR_FIELDS,
  APPEARANCE_TOOL_FIELDS,
  CUSTOM_THEME_FIELDS,
  FONT_IDS,
  WALLPAPER_IDS,
  describeAppearanceChanges,
} from '../../utils/appearanceOptions';
import { nextFreeDesktopCell } from '../../utils/desktopGrid';
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

const MAX_TEXT_FILE_CHARS = 8000;

export { nextFreeDesktopCell };

function formatTextFileResult(item: DesktopItem, items: DesktopItem[]) {
  const content = item.textContent ?? '';
  const truncated = content.length > MAX_TEXT_FILE_CHARS;
  return {
    found: true as const,
    id: item.id,
    name: item.name,
    location: getItemLocation(item, items),
    updatedAt: item.updatedAt,
    truncated,
    content: truncated ? content.slice(0, MAX_TEXT_FILE_CHARS) : content,
  };
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

    readTextFile: tool({
      description: 'Read the full contents of a text or markdown file on the desktop. Look up by item ID (from a previous search) or by name. Use when the user asks what a note or text file says.',
      inputSchema: z.object({
        itemId: z.string().optional().describe('Exact item ID, e.g. from a previous search result.'),
        name: z.string().optional().describe('File name to look up when the ID is unknown. Case-insensitive, partial match.'),
      }),
      execute: async (input) => {
        const needle = input.name?.trim().toLowerCase();
        if (!input.itemId && !needle) {
          throw new Error('Provide an itemId or a name to read.');
        }

        const snapshot = await loadSnapshot(ctx);
        const active = snapshot.items.filter((i) => !i.isTrashed);

        if (input.itemId) {
          const item = active.find((i) => i.id === input.itemId);
          if (!item) throw new Error(`No item with ID ${input.itemId}.`);
          if (typeof item.textContent !== 'string') {
            throw new Error(`"${item.name}" is a ${item.type} item without readable text content.`);
          }
          return formatTextFileResult(item, snapshot.items);
        }

        const matches = active.filter(
          (i) => typeof i.textContent === 'string' && i.name.toLowerCase().includes(needle!),
        );
        if (matches.length === 0) {
          return { found: false as const, message: `No text file matching "${input.name}". Try searchDesktop to locate it.` };
        }
        if (matches.length > 1) {
          return {
            found: false as const,
            message: `${matches.length} text files match "${input.name}". Ask the user which one, or read by ID.`,
            candidates: matches.slice(0, 10).map((i) => ({
              id: i.id,
              name: i.name,
              location: getItemLocation(i, snapshot.items),
            })),
          };
        }
        return formatTextFileResult(matches[0], snapshot.items);
      },
    }),

    createTextNote: tool({
      description: 'Create a text note on the desktop with a name and content. Use when the user asks to write, save, jot down, or draft a note or text file. A name ending in .md renders as markdown.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('File name for the note, e.g. "Grocery List" or "ideas.md".'),
        content: z.string().min(1).max(20000).describe('Plain text or markdown body of the note.'),
        folderId: z.string().optional().describe('ID of an existing folder to place the note in. Omit for the root desktop.'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const stub = ctx.getUserDesktopStub();

        let parentId: string | null = null;
        let locationName = 'Desktop';
        const snapshot = await loadSnapshot(ctx);
        if (input.folderId) {
          const folder = snapshot.items.find((i) => i.id === input.folderId && !i.isTrashed);
          if (!folder) throw new Error(`No folder with ID ${input.folderId}.`);
          if (folder.type !== 'folder') throw new Error(`"${folder.name}" is not a folder.`);
          parentId = folder.id;
          locationName = folder.name;
        }

        // SECURITY: Default to private, same as createFolder above — the
        // approval UI surfaces the note's name and a content preview, but not
        // visibility. The user can make it public via Get Info afterwards.
        const res = await stub.fetch(new Request('http://internal/items', {
          method: 'POST',
          body: JSON.stringify({
            type: 'text',
            name: input.name.trim(),
            textContent: input.content,
            parentId,
            position: nextFreeDesktopCell(snapshot.items, parentId),
            isPublic: false,
          }),
        }));
        if (!res.ok) throw new Error(`Failed to create note (${res.status})`);
        const item = await res.json<DesktopItem>();

        return {
          note: { id: item.id, name: item.name, type: item.type },
          location: locationName,
          characters: input.content.length,
        };
      },
    }),

    createFolder: tool({
      description: 'Create a folder on the desktop: empty (e.g. somewhere to save things), or with items moved into it (pass their ids from searchDesktop / getDesktopOverview).',
      inputSchema: z.object({
        folderName: z.string().min(1).max(80).describe('Name for the new folder.'),
        itemIds: z.array(z.string()).optional().describe('Ids of items to move into the folder. Omit (or pass []) for an empty folder.'),
      }),
      needsApproval: true,
      execute: async (input) => {
        // Only the ids the model names (and the approval card shows) move.
        // There used to be a fallback to the last search's results, which
        // the card never showed — and it made an empty folder impossible.
        const sourceIds = (input.itemIds ?? []).filter(Boolean);

        const stub = ctx.getUserDesktopStub();
        const snapshot = await loadSnapshot(ctx);

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
            position: nextFreeDesktopCell(snapshot.items, null),
            isPublic: false,
          }),
        }));
        if (!createRes.ok) throw new Error(`Failed to create folder (${createRes.status})`);
        const folder = await createRes.json<DesktopItem>();

        if (sourceIds.length === 0) {
          return { folder: { id: folder.id, name: folder.name, type: folder.type }, movedCount: 0, movedItems: [] };
        }

        // Move items into the folder
        const patches = sourceIds.map((id: string) => ({ id, updates: { parentId: folder.id } }));
        const moveRes = await stub.fetch(new Request('http://internal/items', {
          method: 'PATCH',
          body: JSON.stringify(patches),
        }));

        if (!moveRes.ok) {
          // This call just created the folder, so a failed move must not
          // leave the empty folder behind on the user's desktop. Trash it —
          // the same reversible removal the other agent tools use — then
          // report the move failure exactly as before. If the cleanup
          // itself fails, report both errors; the folder stays behind, but
          // the failure says so instead of silently half-applying.
          const moveMessage = `Failed to move items (${moveRes.status})`;
          try {
            const trashRes = await stub.fetch(new Request('http://internal/items', {
              method: 'PATCH',
              body: JSON.stringify([{
                id: folder.id,
                updates: { isTrashed: true, trashedAt: Date.now() },
              }]),
            }));
            if (!trashRes.ok) {
              throw new Error(`failed to remove the created folder (${trashRes.status})`);
            }
          } catch (cleanupError) {
            const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            throw new Error(`${moveMessage}; ${cleanupMessage}`);
          }
          throw new Error(moveMessage);
        }

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

    // ---- Editing what is already there. Each result carries the state from
    // just before the change, so a Code Mode run can undo it exactly. ----

    renameItem: tool({
      description: 'Rename a desktop item (file, note, folder, link, image...). Get its id from searchDesktop or getDesktopOverview.',
      inputSchema: z.object({
        itemId: z.string().min(1),
        newName: z.string().trim().min(1).max(120).describe('The new name (keep the extension for files, e.g. "notes.txt")'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const item = findLiveItem((await loadSnapshot(ctx)).items, input.itemId);
        await patchItems(ctx, [{ id: item.id, updates: { name: input.newName } }], 'rename');
        return { item: { id: item.id, name: input.newName, type: item.type }, previousName: item.name };
      },
    }),

    editTextNote: tool({
      description: 'Replace the full text of an existing text note/file on the desktop. Read it first with readTextFile, then send the complete new text.',
      inputSchema: z.object({
        itemId: z.string().min(1),
        content: z.string().max(100_000).describe('The complete new text of the note'),
      }),
      needsApproval: true,
      execute: async (input) => {
        const item = findLiveItem((await loadSnapshot(ctx)).items, input.itemId);
        if (item.type !== 'text') throw new Error(`“${item.name}” is not a text note`);
        await patchItems(ctx, [{ id: item.id, updates: { textContent: input.content } }], 'edit the note');
        return {
          note: { id: item.id, name: item.name },
          characters: input.content.length,
          previousContent: item.textContent ?? '',
        };
      },
    }),

    moveToTrash: tool({
      description: 'Move desktop items to the Trash (reversible: the user can restore them from the Trash). A folder takes its contents with it. Apps cannot be trashed here — use deleteApp.',
      inputSchema: z.object({
        itemIds: z.array(z.string().min(1)).min(1).max(50),
      }),
      needsApproval: true,
      execute: async (input) => {
        const { items } = await loadSnapshot(ctx);
        const targets = input.itemIds.map((id) => findLiveItem(items, id));
        const apps = targets.filter((item) => item.type === 'app');
        if (apps.length) throw new Error(`Apps are removed with deleteApp, not the Trash: ${apps.map((a) => a.name).join(', ')}`);
        // Same cascade as the desktop's own Trash: a folder's contents go with it.
        const all = new Map<string, DesktopItem>(targets.map((item) => [item.id, item]));
        const addChildren = (parentId: string) => {
          for (const child of items) {
            if (child.parentId === parentId && !child.isTrashed && !all.has(child.id)) {
              all.set(child.id, child);
              if (child.type === 'folder') addChildren(child.id);
            }
          }
        };
        for (const item of targets) if (item.type === 'folder') addChildren(item.id);
        const now = Date.now();
        await patchItems(ctx, [...all.values()].map((item) => ({
          id: item.id,
          updates: { isTrashed: true, trashedAt: now, originalParentId: item.parentId ?? null },
        })), 'move items to the Trash');
        return {
          trashedCount: targets.length,
          trashed: targets.map((item) => ({ id: item.id, name: item.name, type: item.type })),
          // Everything that moved, with where it was — for undo.
          previous: [...all.values()].map((item) => ({ id: item.id, parentId: item.parentId ?? null })),
        };
      },
    }),

    changeAppearance: tool({
      description: [
        "Change how the user's desktop looks: colors, fonts, window style, wallpaper pattern.",
        'Set only the fields you want to change. Colors take any CSS color; desktopColor may also be a CSS gradient.',
        `Fonts: ${FONT_IDS.join(', ')}. Wallpaper patterns: ${WALLPAPER_IDS.join(', ')}.`,
        'Pick colors that keep text readable (title text vs title bar, button text vs buttons).',
        'If the user has a custom theme its CSS can hide plain color changes: set clearCustomTheme for a whole new look.',
        'A wallpaper pattern covers desktopColor: leave wallpaper out unless the user wants a pattern (setting desktopColor alone switches to the plain wallpaper).',
      ].join(' '),
      inputSchema: z.object({
        name: z.string().max(60).optional().describe('A short name for the look, e.g. "Rainy café"'),
        ...Object.fromEntries(APPEARANCE_COLOR_FIELDS.map((field) => [field, z.string().trim().min(1).max(300).optional()])),
        systemFont: z.enum(FONT_IDS).optional().describe('Titles, menus, window chrome'),
        bodyFont: z.enum(FONT_IDS).optional().describe('Labels and content'),
        monoFont: z.enum(FONT_IDS).optional().describe('Code and fixed-width text'),
        fontSmoothing: z.boolean().optional(),
        windowBorderRadius: roundedInRange(0, 24).optional().describe('px, 0–24'),
        controlBorderRadius: roundedInRange(0, 24).optional().describe('px, 0–24'),
        windowShadow: roundedInRange(0, 32).optional().describe('0–32'),
        windowOpacity: roundedInRange(30, 100, { fractionIsPercent: true }).optional().describe('percent, 30–100'),
        wallpaper: z.enum(WALLPAPER_IDS).optional(),
        clearCustomTheme: z.boolean().optional().describe("Remove the current theme's custom CSS so the new colors show"),
      }),
      needsApproval: true,
      execute: async (rawInput) => {
        const input = rawInput as Record<string, unknown>;
        const updates: Record<string, unknown> = {};
        for (const field of APPEARANCE_TOOL_FIELDS) {
          if ((CUSTOM_THEME_FIELDS as readonly string[]).includes(field)) continue;
          if (input[field] !== undefined) updates[field] = input[field];
        }
        if (input.clearCustomTheme) for (const field of CUSTOM_THEME_FIELDS) updates[field] = null;
        // A wallpaper pattern is drawn over the desktop color: a new color
        // without a pattern choice means the plain wallpaper, so it shows.
        if (updates.desktopColor !== undefined && updates.wallpaper === undefined) updates.wallpaper = 'default';
        if (Object.keys(updates).length === 0) throw new Error('Nothing to change: set at least one appearance field');

        const stub = ctx.getUserDesktopStub();
        const profileRes = await stub.fetch(new Request('http://internal/profile'));
        if (!profileRes.ok) throw new Error(`Could not read the current look (${profileRes.status})`);
        const { profile } = await profileRes.json<{ profile: Record<string, unknown> | null }>();
        // What each touched field was, so undo can put it back. A field that
        // was never set is cleared again (null) — except the wallpaper, which
        // cannot be cleared and falls back to the default pattern.
        const previous: Record<string, unknown> = {};
        for (const field of Object.keys(updates)) {
          const value = profile?.[field];
          previous[field] = value === undefined ? (field === 'wallpaper' ? 'default' : null) : value;
        }
        const res = await stub.fetch(new Request('http://internal/profile', {
          method: 'PATCH',
          body: JSON.stringify(updates),
        }));
        if (!res.ok) throw new Error(`Failed to change the look: ${(await res.text().catch(() => '')).slice(0, 200) || res.status}`);
        return {
          appearanceChanged: true,
          name: typeof input.name === 'string' ? input.name : undefined,
          changed: updates,
          summary: describeAppearanceChanges(updates),
          previous,
        };
      },
    }),
  };
}

/**
 * A whole number in [min, max]. Models send 8.5 or an opacity of 0.95;
 * rejecting that failed whole look changes, so round and clamp instead
 * (and read a 0–1 opacity as a percentage).
 */
function roundedInRange(min: number, max: number, options: { fractionIsPercent?: boolean } = {}) {
  return z.number().finite().transform((value) => {
    const scaled = options.fractionIsPercent && value > 0 && value <= 1 ? value * 100 : value;
    return Math.min(max, Math.max(min, Math.round(scaled)));
  });
}

/** A desktop item that exists and is not in the Trash, or a clear error. */
function findLiveItem(items: DesktopItem[], id: string): DesktopItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item || item.isTrashed) throw new Error(`No desktop item with id ${id} (search the desktop for its id first)`);
  return item;
}

async function patchItems(ctx: DesktopToolsContext, patches: Array<{ id: string; updates: Record<string, unknown> }>, what: string): Promise<void> {
  const res = await ctx.getUserDesktopStub().fetch(new Request('http://internal/items', {
    method: 'PATCH',
    body: JSON.stringify(patches),
  }));
  if (!res.ok) throw new Error(`Failed to ${what} (${res.status})`);
}
