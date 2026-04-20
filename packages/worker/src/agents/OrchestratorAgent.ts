/**
 * OrchestratorAgent — Unified AI agent for EternalOS.
 *
 * Replaces DesktopChatAgent and AppBuilderAgent with a single agent that:
 * - Queries and mutates the desktop via direct AI SDK tools
 * - Creates and manages apps via codemode (LLM writes TypeScript)
 * - Runs apps as Dynamic Workers in sandboxed V8 isolates
 */

import { AIChatAgent } from '@cloudflare/ai-chat';
import { createCodeTool } from '@cloudflare/codemode/ai';
import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
} from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../index';
import { createDesktopTools } from './tools/desktopTools';
import { createAppTools, initAppRegistry } from './tools/appTools';

interface OrchestratorState {
  lastMatchedItemIds: string[];
  lastQuery: string | null;
}

type ChatRoute = 'chat' | 'desktop-read' | 'desktop-write' | 'app-read' | 'app-build';

const BASE_PROMPT = `You are Eternal, the assistant for EternalOS.

Core behavior:
- Act like a normal high-quality chatbot unless the user is clearly asking you to inspect or change something in EternalOS
- Never print tool-call JSON, pseudo function calls, or codemode parameters to the user
- Never put tool arguments inside code fences unless the user explicitly asked for source code
- Respond naturally and concisely after tool results instead of dumping raw JSON
- If a mutation needs approval, explain the pending action briefly
- Do not claim the app can access the user's desktop, files, or network unless the runtime actually supports it`;

const CHAT_PROMPT = `${BASE_PROMPT}

Mode: General chat
- The user is chatting, brainstorming, or asking for advice/explanations
- Do not call tools
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
- Use the codemode tool to create or modify apps when the user clearly wants an app artifact
- Inside codemode, write TypeScript that calls codemode.buildAppFromPrompt(), codemode.createApp(), codemode.updateApp(), codemode.listApps(), codemode.getAppSource(), or codemode.deleteApp()
- For most new app creation requests, prefer codemode.buildAppFromPrompt({ prompt: <user request> })
- Do not inline large HTML/CSS/JS blobs into the top-level codemode call unless the user explicitly provided exact source code to use
- Use codemode.createApp() only when you already have the exact final source files and need low-level control
- For updates to an existing app, first call codemode.getAppSource(), then modify it with codemode.updateApp()
- Apps are static HTML/CSS/JS assets served from a Dynamic Worker into a sandboxed iframe on the user's desktop
- The app runtime is hermetic: no arbitrary network access, no desktop bridge, no file access, no persistent app backend
- Favor self-contained apps that work with bundled assets and browser APIs only
- Create polished, shippable apps rather than toy snippets
- Reference local assets with relative paths such as ./styles.css, ./app.js, ./data.json, or ./icon.svg
- Do not answer with raw code unless the user explicitly asked to see code`;

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
  const appBuildPattern = /\b(build|create|make|generate|code|ship|implement|update|modify|edit|fix|delete|remove)\b.*\b(app|application|widget|game|timer|calculator|kanban|pomodoro|paint|canvas|editor|tracker|todo|to-do|to do list|sticky note|whiteboard|notepad)\b|\b(update|modify|edit|fix|delete|remove)\b.*\bmy app\b/i;
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
  switch (route) {
    case 'desktop-read':
      return DESKTOP_READ_PROMPT;
    case 'desktop-write':
      return DESKTOP_WRITE_PROMPT;
    case 'app-read':
      return APP_READ_PROMPT;
    case 'app-build':
      return APP_BUILD_PROMPT;
    case 'chat':
    default:
      return CHAT_PROMPT;
  }
}

export class OrchestratorAgent extends AIChatAgent<Env, OrchestratorState> {
  maxPersistedMessages = 100;
  initialState: OrchestratorState = {
    lastMatchedItemIds: [],
    lastQuery: null,
  };

  async onStart() {
    initAppRegistry(this.ctx.storage.sql);
  }

  private getModel() {
    const workersAI = createWorkersAI({ binding: this.env.AI });
    const modelId = this.env.AGENT_CHAT_MODEL?.startsWith('@cf/')
      ? this.env.AGENT_CHAT_MODEL
      : '@cf/moonshotai/kimi-k2.6';
    return workersAI(modelId as Parameters<typeof workersAI>[0]);
  }

  private getUserDesktopStub(): DurableObjectStub {
    const doId = this.env.USER_DESKTOP.idFromName(this.name);
    return this.env.USER_DESKTOP.get(doId);
  }

  async onChatMessage() {
    const lastUserMessage = [...this.messages].reverse().find((message) => message.role === 'user');
    const lastUserText = extractMessageText(lastUserMessage);
    const route = classifyRoute(lastUserText);

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

    // Codemode tool for app building (LLM writes TypeScript)
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const appTools = createAppTools({
      env: this.env,
      sql: this.ctx.storage.sql,
      agentName: this.name,
    });
    const rawCodemode = createCodeTool({
      tools: appTools as any,
      executor,
    });
    const codemode = {
      ...rawCodemode,
      needsApproval: true,
    };
    const appReadTools = {
      listApps: appTools.listApps,
      getAppSource: appTools.getAppSource,
    };

    const routeTools = {
      chat: {},
      'desktop-read': desktopReadTools,
      'desktop-write': desktopWriteTools,
      'app-read': appReadTools,
      'app-build': { codemode },
    } as const;
    const activeRouteTools = routeTools[route];
    const activeToolNames = Object.keys(activeRouteTools) as string[];
    const shouldForceFirstToolCall = route === 'app-build';

    const result = streamText({
      model: this.getModel(),
      system: getSystemPrompt(route),
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

    return result.toUIMessageStreamResponse();
  }
}
