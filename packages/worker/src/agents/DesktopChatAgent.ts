import { AIChatAgent } from '@cloudflare/ai-chat';
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText, tool } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { z } from 'zod';
import type { Env } from '../index';
import type { DesktopItem, UserProfile } from '../types';

interface DesktopSnapshot {
  items: DesktopItem[];
  profile: UserProfile | null;
}

interface DesktopChatState {
  lastMatchedItemIds: string[];
  lastQuery: string | null;
}

interface SearchHit {
  id: string;
  name: string;
  type: DesktopItem['type'];
  location: string;
  summary: string;
  score: number;
  matchedIn: string[];
}

interface SearchToolItem {
  id: string;
  name: string;
  type: DesktopItem['type'];
  location: string;
  summary: string;
  matchedIn: string[];
}

const SEARCH_SYNONYMS: Record<string, string[]> = {
  road: ['street', 'highway', 'lane', 'path', 'route'],
  street: ['road', 'avenue', 'boulevard', 'lane'],
  car: ['vehicle', 'automobile', 'sedan', 'truck'],
  vehicle: ['car', 'truck', 'van', 'automobile'],
  portrait: ['person', 'face', 'selfie', 'headshot'],
  person: ['portrait', 'face', 'human', 'people'],
  city: ['urban', 'downtown', 'street', 'buildings'],
  urban: ['city', 'street', 'downtown'],
  ocean: ['sea', 'water', 'beach', 'coast'],
  beach: ['shore', 'coast', 'ocean', 'sand'],
  forest: ['woods', 'trees', 'nature'],
  mountain: ['peak', 'hill', 'range'],
  flower: ['plant', 'blossom', 'petal'],
  house: ['home', 'building', 'residence'],
  room: ['interior', 'indoors', 'bedroom', 'living room'],
  sign: ['text', 'poster', 'billboard', 'logo'],
  night: ['dark', 'evening', 'nighttime'],
  sunset: ['dusk', 'sunrise', 'sky'],
  dog: ['puppy', 'canine', 'pet'],
  cat: ['kitten', 'feline', 'pet'],
};

const SEARCH_STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'be',
  'can',
  'contain',
  'contains',
  'create',
  'do',
  'does',
  'file',
  'files',
  'folder',
  'folders',
  'for',
  'found',
  'group',
  'have',
  'hello',
  'how',
  'i',
  'if',
  'image',
  'images',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'metadata',
  'move',
  'my',
  'named',
  'now',
  'of',
  'on',
  'please',
  'put',
  'recent',
  'related',
  'show',
  'some',
  'stuff',
  'tell',
  'that',
  'the',
  'them',
  'there',
  'these',
  'this',
  'to',
  'u',
  'uploads',
  'what',
  'which',
  'with',
  'yes',
  'you',
  'your',
]);

const ITEM_KIND_LABELS: Record<DesktopItem['type'], string> = {
  folder: 'folder',
  image: 'image',
  text: 'text file',
  link: 'link',
  audio: 'audio file',
  video: 'video',
  pdf: 'PDF',
  widget: 'widget',
  sticker: 'sticker',
};

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9#\s-]/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function extractSearchTerms(query: string): string[] {
  const filtered = tokenizeQuery(query).filter((term) => !SEARCH_STOPWORDS.has(term) && term.length > 1);
  return filtered.length > 0 ? Array.from(new Set(filtered)) : tokenizeQuery(query).slice(0, 4);
}

function expandQueryTerms(query: string): Array<{ exact: string; variants: string[] }> {
  return extractSearchTerms(query).map((term) => ({
    exact: term,
    variants: [term, ...(SEARCH_SYNONYMS[term] || [])],
  }));
}

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function isGreetingQuery(query: string): boolean {
  const normalized = normalizeQuery(query).replace(/[!?.,]/g, '');
  return [
    'hi',
    'hello',
    'hey',
    'yo',
    'sup',
    'how are you',
    'how r u',
    'how are u',
    'hello how are you',
    'hello how are u',
    'hi how are you',
    'hi how are u',
  ].includes(normalized);
}

function isDesktopQuery(query: string): boolean {
  const normalized = normalizeQuery(query);
  const desktopKeywords = [
    'desktop',
    'file',
    'files',
    'folder',
    'folders',
    'image',
    'images',
    'photo',
    'photos',
    'picture',
    'pictures',
    'ocr',
    'text',
    'tag',
    'tags',
    'color',
    'colors',
    'recent',
    'upload',
    'uploads',
    'find',
    'search',
    'contains',
    'caption',
    'metadata',
    'how many',
    'show me',
    'what is on',
    "what's on",
    'group',
    'create folder',
    'move them',
  ];

  return desktopKeywords.some((keyword) => normalized.includes(keyword));
}

function getRequestedTypeFilter(query: string): DesktopItem['type'] | null {
  const normalized = normalizeQuery(query);
  if (/(image|images|photo|photos|picture|pictures|wallpaper)/.test(normalized)) return 'image';
  if (/(video|videos|movie|movies|clip|clips)/.test(normalized)) return 'video';
  if (/(text|notes|note|document|documents|txt|markdown|code)/.test(normalized)) return 'text';
  if (/(folder|folders|directory|directories)/.test(normalized)) return 'folder';
  if (/(link|links|url|urls|website|websites)/.test(normalized)) return 'link';
  if (/(audio|song|songs|music|track|tracks)/.test(normalized)) return 'audio';
  if (/(pdf|pdfs)/.test(normalized)) return 'pdf';
  if (/(widget|widgets)/.test(normalized)) return 'widget';
  return null;
}

function getItemTags(item: DesktopItem): string[] {
  if (item.userTags !== undefined) {
    return item.userTags;
  }

  return item.imageAnalysis?.tags ?? [];
}

function getItemLocation(item: DesktopItem, items: DesktopItem[]): string {
  if (!item.parentId) {
    return 'Desktop';
  }

  return items.find((candidate) => candidate.id === item.parentId)?.name || 'Desktop';
}

function getItemSummary(item: DesktopItem): string {
  const caption = item.imageAnalysis?.caption;
  if (caption) return caption;

  if (item.url) return item.url;
  if (item.textContent) return item.textContent.replace(/\s+/g, ' ').trim().slice(0, 160);

  const tags = getItemTags(item);
  if (tags.length > 0) return `Tags: ${tags.join(', ')}`;

  return item.mimeType || ITEM_KIND_LABELS[item.type];
}

function createStaticResponse(text: string) {
  const textId = crypto.randomUUID();
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: 'text-start', id: textId });
        writer.write({ type: 'text-delta', id: textId, delta: text });
        writer.write({ type: 'text-end', id: textId });
      },
    }),
  });
}

function buildSearchHit(item: DesktopItem, items: DesktopItem[], query: string): SearchHit | null {
  const terms = expandQueryTerms(query);
  const tags = getItemTags(item);
  const haystacks = [
    { label: 'tags', value: tags.join(' '), weight: 12 },
    { label: 'caption', value: item.imageAnalysis?.caption, weight: 10 },
    { label: 'detected text', value: item.imageAnalysis?.detectedText?.join(' '), weight: 9 },
    { label: 'name', value: item.name, weight: 4 },
    { label: 'text content', value: item.textContent, weight: 6 },
    { label: 'url', value: item.url, weight: 5 },
    { label: 'colors', value: item.imageAnalysis?.dominantColors?.join(' '), weight: 4 },
    { label: 'type', value: item.type, weight: 2 },
    { label: 'location', value: getItemLocation(item, items), weight: 3 },
  ];

  let score = 0;
  let matchedTerms = 0;
  const matchedIn = new Set<string>();

  for (const term of terms) {
    let matched = false;

    for (const haystack of haystacks) {
      if (!haystack.value) continue;
      const value = haystack.value.toLowerCase();
      const matchedVariant = term.variants.find((variant) => value.includes(variant));
      if (!matchedVariant) continue;

      const exact = matchedVariant === term.exact;
      score += exact ? haystack.weight : Math.max(1, haystack.weight - 3);
      matchedIn.add(exact ? haystack.label : `${haystack.label} (related)`);
      matched = true;

      if (value.startsWith(matchedVariant)) {
        score += exact ? 2 : 1;
      }
    }

    if (matched) {
      matchedTerms += 1;
    }
  }

  if (matchedTerms === 0) {
    return null;
  }

  score += matchedTerms * 3;
  if (matchedTerms === terms.length && terms.length > 1) {
    score += 6;
  }

  return {
    id: item.id,
    name: item.name,
    type: item.type,
    location: getItemLocation(item, items),
    summary: getItemSummary(item),
    score,
    matchedIn: Array.from(matchedIn),
  };
}

export class DesktopChatAgent extends AIChatAgent<Env, DesktopChatState> {
  maxPersistedMessages = 80;
  initialState: DesktopChatState = {
    lastMatchedItemIds: [],
    lastQuery: null,
  };

  private async loadDesktopSnapshot(): Promise<DesktopSnapshot> {
    const doId = this.env.USER_DESKTOP.idFromName(this.name);
    const stub = this.env.USER_DESKTOP.get(doId);
    const response = await stub.fetch(new Request('http://internal/items'));

    if (!response.ok) {
      throw new Error(`Failed to load desktop state (${response.status})`);
    }

    return response.json<DesktopSnapshot>();
  }

  private getLatestUserText(): string {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message.role !== 'user') continue;

      const text = message.parts
        .flatMap((part) => (part.type === 'text' ? [String(part.text ?? '')] : []))
        .join(' ')
        .trim();

      if (text) {
        return text;
      }
    }

    return '';
  }

  private searchSnapshot(snapshot: DesktopSnapshot, query: string): SearchHit[] {
    const typeFilter = getRequestedTypeFilter(query);

    return snapshot.items
      .filter((item) => !item.isTrashed)
      .filter((item) => (typeFilter ? item.type === typeFilter : true))
      .map((item) => buildSearchHit(item, snapshot.items, query))
      .filter((hit): hit is SearchHit => hit !== null)
      .sort((a, b) => b.score - a.score);
  }

  private buildSearchOutput(query: string, hits: SearchHit[]) {
    const preferredHits = hits.filter((hit) =>
      hit.matchedIn.some((source) =>
        source.startsWith('tags') || source.startsWith('caption') || source.startsWith('detected text')
      )
    );
    const items = (preferredHits.length > 0 ? preferredHits : hits).slice(0, 8);

    return {
      query,
      totalMatches: hits.length,
      items: items.map((hit): SearchToolItem => ({
        id: hit.id,
        name: hit.name,
        type: hit.type,
        location: hit.location,
        summary: hit.summary,
        matchedIn: hit.matchedIn,
      })),
    };
  }

  private buildOverviewOutput(snapshot: DesktopSnapshot) {
    const activeItems = snapshot.items.filter((item) => !item.isTrashed);
    const imageItems = activeItems.filter((item) => item.type === 'image');
    const analyzedImages = imageItems.filter((item) => item.imageAnalysis?.status === 'complete');
    const counts = activeItems.reduce<Record<string, number>>((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {});

    return {
      username: snapshot.profile?.username ?? this.name,
      wallpaper: snapshot.profile?.wallpaper ?? 'default',
      totalActiveItems: activeItems.length,
      analyzedImages: analyzedImages.length,
      totalImages: imageItems.length,
      counts,
      recentItems: activeItems
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6)
        .map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
          location: getItemLocation(item, snapshot.items),
        })),
    };
  }

  private async createFolderWithItems(folderName: string, itemIds: string[]) {
    const snapshot = await this.loadDesktopSnapshot();
    const rootItems = snapshot.items.filter((item) => item.parentId === null && !item.isTrashed);
    const nextRootY = rootItems.length > 0 ? Math.max(...rootItems.map((item) => item.position.y)) + 1 : 0;

    const doId = this.env.USER_DESKTOP.idFromName(this.name);
    const stub = this.env.USER_DESKTOP.get(doId);

    const createResponse = await stub.fetch(new Request('http://internal/items', {
      method: 'POST',
      body: JSON.stringify({
        type: 'folder',
        name: folderName,
        parentId: null,
        position: { x: 0, y: nextRootY },
        isPublic: true,
      }),
    }));

    if (!createResponse.ok) {
      throw new Error(`Failed to create folder (${createResponse.status})`);
    }

    const folder = await createResponse.json<DesktopItem>();

    const movePatches = itemIds.map((id) => ({
      id,
      updates: { parentId: folder.id },
    }));

    const moveResponse = await stub.fetch(new Request('http://internal/items', {
      method: 'PATCH',
      body: JSON.stringify(movePatches),
    }));

    if (!moveResponse.ok) {
      throw new Error(`Failed to move items into folder (${moveResponse.status})`);
    }

    const movedItems = await moveResponse.json<DesktopItem[]>();
    return { folder, movedItems };
  }

  async onChatMessage() {
    const latestUserText = this.getLatestUserText();

    if (!latestUserText) {
      return createStaticResponse('Ask me about your desktop, files, images, tags, OCR text, or recent uploads.');
    }

    if (isGreetingQuery(latestUserText)) {
      return createStaticResponse('Hi. Ask me about your desktop, files, images, tags, OCR text, or recent uploads.');
    }

    if (!isDesktopQuery(latestUserText)) {
      return createStaticResponse('I can help with your desktop, files, images, tags, OCR text, and recent uploads. Ask me something in that scope.');
    }

    const workersAI = createWorkersAI({ binding: this.env.AI });
    const model = workersAI(this.env.AGENT_CHAT_MODEL ?? '@cf/zai-org/glm-4.7-flash');

    const result = streamText({
      model,
      system: [
        'You are Ask Eternal, a grounded assistant for a user desktop running on Cloudflare.',
        'Use the server tools to inspect or mutate the desktop. Do not invent files, tags, captions, colors, OCR text, or search results.',
        'For desktop inventory questions, call getDesktopOverview before answering.',
        'For search, count, or matching requests, call searchDesktop with the user request.',
        'For requests to group, collect, organize, or create a folder from matching items, call createFolderFromMatches.',
        'If the user refers to "them", "these", or "those", use the existing match context via createFolderFromMatches without repeating the query.',
        'After tool results are available, answer in one or two concise sentences.',
        'Do not dump raw JSON or list every filename in plain text if the tool result already shows them in the UI.',
        'If a mutation tool is waiting for approval, explain the pending action briefly.',
      ].join(' '),
      messages: await convertToModelMessages(this.messages),
      tools: {
        getDesktopOverview: tool({
          description: 'Get a concise summary of the current desktop, including counts and recent items.',
          inputSchema: z.object({}),
          execute: async () => {
            const snapshot = await this.loadDesktopSnapshot();
            return this.buildOverviewOutput(snapshot);
          },
        }),
        searchDesktop: tool({
          description: 'Search the current desktop using names, tags, captions, OCR text, colors, URLs, and text content.',
          inputSchema: z.object({
            query: z.string().min(1).describe('The user search request in plain language.'),
          }),
          execute: async ({ query }) => {
            const snapshot = await this.loadDesktopSnapshot();
            const hits = this.searchSnapshot(snapshot, query);
            const matchedIds = hits.slice(0, 24).map((hit) => hit.id);
            this.setState({
              lastMatchedItemIds: matchedIds,
              lastQuery: query,
            });
            return this.buildSearchOutput(query, hits);
          },
        }),
        createFolderFromMatches: tool({
          description: 'Create a folder from the current search matches or from a fresh query.',
          inputSchema: z.object({
            folderName: z.string().min(1).max(80).describe('The name of the folder to create.'),
            query: z.string().optional().describe('Optional search query to use for selecting items. Omit this to use the current matches.'),
            itemIds: z.array(z.string()).optional().describe('Optional explicit item IDs to group.'),
          }),
          needsApproval: true,
          execute: async ({ folderName, query, itemIds }) => {
            let sourceItemIds = itemIds?.filter(Boolean) ?? [];

            if (sourceItemIds.length === 0 && query) {
              const snapshot = await this.loadDesktopSnapshot();
              const hits = this.searchSnapshot(snapshot, query);
              sourceItemIds = hits.slice(0, 24).map((hit) => hit.id);
              this.setState({
                lastMatchedItemIds: sourceItemIds,
                lastQuery: query,
              });
            }

            if (sourceItemIds.length === 0) {
              sourceItemIds = this.state.lastMatchedItemIds;
            }

            if (sourceItemIds.length === 0) {
              throw new Error('No matched items are available to group yet. Search for files or images first.');
            }

            const { folder, movedItems } = await this.createFolderWithItems(folderName.trim(), sourceItemIds);
            return {
              folder: {
                id: folder.id,
                name: folder.name,
                type: folder.type,
              },
              movedCount: movedItems.length,
              movedItems: movedItems.map((item) => ({
                id: item.id,
                name: item.name,
                type: item.type,
                location: folder.name,
              })),
            };
          },
        }),
      },
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber === 0) {
          return { toolChoice: 'required' as const };
        }

        return { toolChoice: 'auto' as const };
      },
      stopWhen: stepCountIs(4),
    });

    return result.toUIMessageStreamResponse();
  }
}
