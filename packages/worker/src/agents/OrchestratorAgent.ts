/**
 * OrchestratorAgent — Unified AI agent for EternalOS.
 *
 * Replaces DesktopChatAgent and AppBuilderAgent with a single agent that:
 * - Queries and mutates the desktop via direct AI SDK tools
 * - Creates and manages apps via direct app tools and server-side generation
 * - Runs apps as Dynamic Workers in sandboxed V8 isolates
 */

import { AIChatAgent } from '@cloudflare/ai-chat';
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText,
  UI_MESSAGE_STREAM_HEADERS,
} from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../index';
import type { OrchestratorState } from './state';
import { createDesktopTools } from './tools/desktopTools';
import { createAppTools, initAppRegistry } from './tools/appTools';
import { createMemoryTools } from './tools/memoryTools';
import {
  deriveThreadTitleFromMessage,
  extractOwnerUid,
  normalizeThreadId,
  shouldReplaceThreadTitle,
  upsertThread,
} from './threadRegistry';

type ChatRoute = 'chat' | 'desktop-read' | 'desktop-write' | 'app-read' | 'app-build' | 'app-install-preview';

const BASE_PROMPT = `You are Eternal, the assistant for EternalOS.

Core behavior:
- Act like a normal high-quality chatbot unless the user is clearly asking you to inspect or change something in EternalOS
- Never print tool-call JSON, pseudo function calls, or codemode parameters to the user
- Never put tool arguments inside code fences unless the user explicitly asked for source code
- Respond naturally and concisely after tool results instead of dumping raw JSON
- If a mutation needs approval, explain the pending action briefly
- Do not claim the app can access the user's desktop, files, or network unless the runtime actually supports it
- You have durable memory tools. Use them for stable user preferences, identity details, ongoing project context, and other facts likely to matter later.
- Do not save one-off transient requests as memory unless the user explicitly asks you to remember them`;

const CHAT_PROMPT = `${BASE_PROMPT}

Mode: General chat
- The user is chatting, brainstorming, or asking for advice/explanations
- Do not call desktop or app tools unless needed
- You may use memory tools when the user explicitly asks you to remember, forget, or review saved memories
- Reply like a capable general-purpose assistant`;

const DESKTOP_READ_PROMPT = `${BASE_PROMPT}

Mode: Desktop assistant (read-only)
- Use read-only desktop tools when needed:
  - getDesktopOverview
  - searchDesktop
- Use tools only if they materially improve the answer
- If the user just wants a conversational answer, respond without tools`;

const DESKTOP_WRITE_PROMPT = `${BASE_PROMPT}

Mode: Desktop assistant (mutating)
- You may use desktop tools to inspect or organize the user's desktop
- Available tools:
  - getDesktopOverview
  - searchDesktop
  - createFolder
  - moveItems
- Prefer search/read tools before mutations when context is missing`;

const APP_READ_PROMPT = `${BASE_PROMPT}

Mode: App assistant (read-only)
- The user wants to inspect existing apps or app source
- Available tools:
  - listApps
  - getAppSource
- Do not create, update, or delete apps in this mode`;

const APP_BUILD_PROMPT = `${BASE_PROMPT}

Mode: App builder

Apps are static HTML/CSS/JS bundles served from a Dynamic Worker into a
sandboxed iframe on the user's desktop. The platform auto-injects a
window.eternal bridge that exposes the user's desktop data to apps that
declare the right permissions.

Primary workflow
- For app requests where the user wants to inspect quality first, call
  previewAppFromPrompt({ prompt }) and then wait for the user to approve
  installing it.
- When the user approves a generated preview, call installAppPreview({ previewId }).
- If the user says "install preview", "install this preview", or gives a
  preview ID, call installAppPreview({ previewId }) directly instead of
  regenerating the app.
- For direct "build/install it now" requests, call buildAppFromPrompt({ prompt })
  where prompt is the user's natural-language request verbatim (or lightly
  clarified). The server handles spec generation, file generation, validation,
  and install; do not embed HTML/CSS/JS in tool arguments.
- Only use createApp({ files, ... }) when the user handed you exact final
  source files to use.
- To update an existing app: getAppSource({ appId }) then
  updateApp({ appId, files: <modified files> }).
- To list/delete: listApps(), deleteApp({ appId }).

What apps can do
- Read the user's desktop via window.eternal.fs.list(), fs.read(), fs.readText(),
  fs.readJson(), fs.urlFor(id) — each Item carries { id, name, type, path,
  mimeType, caption, tags, dominantColors, updatedAt, ... }.
- Read the user's profile via window.eternal.profile.get() (fields the app
  was granted).
- Control the window via window.eternal.window.setTitle/close/requestFocus.
- They CANNOT make arbitrary network calls, write files (this milestone),
  or talk to other apps (this milestone).

What to tell buildAppFromPrompt
- Pass the user's intent in full. If they said "a gallery of my photos", say
  exactly that — the generator has access to a desktop summary and decides
  the right permission scopes.
- If the user's intent implies desktop data ("my photos", "my notes", "my
  audio", "things tagged X"), that's a signal to let the generator request
  fs.mimeTypes or fs.read scopes. Don't hand-craft permissions in the tool
  call — let the generator do it.

Conversation style
- After a preview: one short sentence that the preview is ready and ask whether
  to install it.
- After a successful install: one short sentence confirming the app appeared on
  the desktop plus any permissions it uses. Do not dump generated source.
- If the generator errors, surface a short human explanation and suggest one
  concrete next step, not a retry-loop explanation.`;

const APP_INSTALL_PREVIEW_PROMPT = `${BASE_PROMPT}

Mode: App preview install

- The user is asking to install an already-generated app preview.
- Call installAppPreview({ previewId }) as the first action.
- Do not regenerate the app, and do not call build or preview tools unless the
  install fails because the preview is missing or expired.
- After a successful install: confirm briefly that the app is now on the
  desktop.`;

function formatMemoryContext(state: OrchestratorState): string {
  if (!state.memories.length) {
    return 'Saved memories: none.';
  }

  const lines = state.memories
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)
    .map((memory) => `- [${memory.kind}] ${memory.content}`);

  return `Saved memories:\n${lines.join('\n')}`;
}

function extractMessageText(message: { parts?: Array<{ type?: string; text?: unknown }> } | undefined): string {
  if (!message?.parts) return '';

  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join(' ')
    .trim();
}

function classifyRoute(text: string): ChatRoute {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return 'chat';

  const greetingPattern = /^(hi|hello|hey|yo|sup|hiya|good morning|good afternoon|good evening|howdy)([!. ]+.*)?$/i;
  if (normalized.length <= 40 && greetingPattern.test(normalized)) {
    return 'chat';
  }

  const appNouns = /\b(app|application|widget|game|timer|calculator|kanban|pomodoro|paint|canvas|editor|tracker|todo|to-do|to do list|sticky note|whiteboard|notepad)\b/i;
  const appReadPattern = /\b(list|show|which|what|inspect|review|open|read)\b.*\bapp(s)?\b|\bapp source\b|\bsource code\b.*\bapp\b/i;
  const previewInstallPattern = /\binstall\b.*\bpreview\b|\bpreview\b.*\binstall\b|\binstall app preview\b/i;
  if (previewInstallPattern.test(normalized)) {
    return 'app-install-preview';
  }
  const appBuildPattern = /\b(build|create|make|generate|code|ship|implement|update|modify|edit|fix|delete|remove|install)\b.*\b(app|application|widget|preview|game|timer|calculator|kanban|pomodoro|paint|canvas|editor|tracker|todo|to-do|to do list|sticky note|whiteboard|notepad)\b|\b(update|modify|edit|fix|delete|remove|install)\b.*\bmy app\b/i;
  if (appBuildPattern.test(normalized)) {
    return 'app-build';
  }
  if (appReadPattern.test(normalized) || (appNouns.test(normalized) && /\bwhat|which|show|list|inspect|review|source\b/i.test(normalized))) {
    return 'app-read';
  }

  const desktopWritePattern = /\b(organize|group|move|sort|tidy|clean up|create folder|put .* into|file away)\b|\b(folder|folders)\b.*\b(create|make|new)\b/i;
  if (desktopWritePattern.test(normalized)) {
    return 'desktop-write';
  }

  const desktopReadPattern = /\b(desktop|file|files|folder|folders|image|images|photo|photos|video|videos|audio|pdf|search|find|tag|tags|ocr|upload|overview|recent|what's on my desktop|what is on my desktop)\b/i;
  if (desktopReadPattern.test(normalized)) {
    return 'desktop-read';
  }

  return 'chat';
}

function getSystemPrompt(route: ChatRoute): string {
  const prompt = (() => {
  switch (route) {
    case 'desktop-read':
      return DESKTOP_READ_PROMPT;
    case 'desktop-write':
      return DESKTOP_WRITE_PROMPT;
    case 'app-read':
      return APP_READ_PROMPT;
    case 'app-build':
      return APP_BUILD_PROMPT;
    case 'app-install-preview':
      return APP_INSTALL_PREVIEW_PROMPT;
    case 'chat':
    default:
      return CHAT_PROMPT;
  }
  })();

  return prompt;
}

export class OrchestratorAgent extends AIChatAgent<Env, OrchestratorState> {
  maxPersistedMessages = 100;
  initialState: OrchestratorState = {
    lastMatchedItemIds: [],
    lastQuery: null,
    memories: [],
  };

  async onStart() {
    initAppRegistry(this.ctx.storage.sql);
  }

  private getModel() {
    const workersAI = createWorkersAI({ binding: this.env.AI });
    const modelId = this.env.AGENT_CHAT_MODEL?.startsWith('@cf/')
      ? this.env.AGENT_CHAT_MODEL
      : '@cf/meta/llama-3.1-8b-instruct';
    return workersAI(modelId as Parameters<typeof workersAI>[0]);
  }


  private getUserDesktopStub(): DurableObjectStub {
    const doId = this.env.USER_DESKTOP.idFromName(this.getOwnerUid());
    return this.env.USER_DESKTOP.get(doId);
  }

  private getOwnerUid(): string {
    return extractOwnerUid(this.name);
  }

  async onChatMessage(_onFinish?: Parameters<AIChatAgent<Env, OrchestratorState>['onChatMessage']>[0], options?: { body?: Record<string, unknown> }) {
    const lastUserMessage = [...this.messages].reverse().find((message) => message.role === 'user');
    const lastUserText = extractMessageText(lastUserMessage);
    const ownerUid = this.getOwnerUid();
    const threadId = normalizeThreadId(
      typeof options?.body?.threadId === 'string' ? options.body.threadId : this.name.split(':')[1],
    );
    const existingThread = await upsertThread(this.env, ownerUid, threadId, { updatedAt: Date.now() });
    if (lastUserText && shouldReplaceThreadTitle(existingThread.title)) {
      await upsertThread(this.env, ownerUid, threadId, {
        title: deriveThreadTitleFromMessage(lastUserText),
        updatedAt: Date.now(),
      });
    }

    const route = classifyRoute(lastUserText);
    const memoryTools = createMemoryTools({
      setState: (state) => this.setState(state),
      getState: () => this.state,
    });

    // Direct desktop tools (fast path, no sandbox)
    const allDesktopTools = createDesktopTools({
      getUserDesktopStub: () => this.getUserDesktopStub(),
      setState: (state) => this.setState(state),
      getState: () => this.state,
    });
    const desktopReadTools = {
      getDesktopOverview: allDesktopTools.getDesktopOverview,
      searchDesktop: allDesktopTools.searchDesktop,
    };
    const desktopWriteTools = {
      ...desktopReadTools,
      createFolder: allDesktopTools.createFolder,
      moveItems: allDesktopTools.moveItems,
    };

    // Stage emitter: set inside createUIMessageStream.execute before any tool runs.
    const stageEmitter: { write: ((chunk: object) => void) | null } = { write: null };

    const appTools = createAppTools({
      env: this.env,
      sql: this.ctx.storage.sql,
      agentName: ownerUid,
      onBuildStage: (toolCallId, stage, label) => {
        stageEmitter.write?.({
          type: 'data-build-stage',
          id: toolCallId,
          data: { stage, label },
        });
      },
    });
    const appReadTools = {
      listApps: appTools.listApps,
      getAppSource: appTools.getAppSource,
    };
    const appBuildTools = {
      previewAppFromPrompt: appTools.previewAppFromPrompt,
      installAppPreview: appTools.installAppPreview,
      buildAppFromPrompt: appTools.buildAppFromPrompt,
      createApp: appTools.createApp,
      updateApp: appTools.updateApp,
      deleteApp: appTools.deleteApp,
      ...appReadTools,
    };
    const sharedTools = {
      rememberMemory: memoryTools.rememberMemory,
      listMemories: memoryTools.listMemories,
      forgetMemory: memoryTools.forgetMemory,
    };

    const routeTools = {
      chat: sharedTools,
      'desktop-read': { ...desktopReadTools, ...sharedTools },
      'desktop-write': { ...desktopWriteTools, ...sharedTools },
      'app-read': { ...appReadTools, ...sharedTools },
      'app-install-preview': { installAppPreview: appTools.installAppPreview, ...sharedTools },
      'app-build': { ...appBuildTools, ...sharedTools },
    } as const;
    const activeRouteTools = routeTools[route];
    const activeToolNames = Object.keys(activeRouteTools) as string[];
    const shouldForceFirstToolCall = route === 'app-build';

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        stageEmitter.write = (chunk) => writer.write(chunk as any);
        const result = streamText({
          model: this.getModel(),
          system: `${getSystemPrompt(route)}\n\n${formatMemoryContext(this.state)}`,
          messages: pruneMessages({
            messages: await convertToModelMessages(this.messages),
            toolCalls: 'before-last-10-messages',
          }),
          tools: activeRouteTools as any,
          prepareStep: async ({ stepNumber }) => {
            if (activeToolNames.length === 0) {
              return {
                activeTools: [],
                toolChoice: 'auto' as const,
              };
            }

            return {
              activeTools: activeToolNames,
              toolChoice: shouldForceFirstToolCall && stepNumber === 0 ? 'required' as const : 'auto' as const,
            };
          },
          stopWhen: stepCountIs(10),
        });
        writer.merge(result.toUIMessageStream() as any);
      },
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });

    return createUIMessageStreamResponse({ stream, headers: UI_MESSAGE_STREAM_HEADERS });
  }
}
