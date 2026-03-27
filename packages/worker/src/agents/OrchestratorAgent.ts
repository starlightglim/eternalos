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
import { createAnthropic } from '@ai-sdk/anthropic';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../index';
import { createDesktopTools } from './tools/desktopTools';
import { createAppTools, initAppRegistry } from './tools/appTools';

interface OrchestratorState {
  lastMatchedItemIds: string[];
  lastQuery: string | null;
}

const SYSTEM_PROMPT = `You are Eternal, the AI assistant for EternalOS — a personal desktop environment running on Cloudflare.

You have two capabilities:

DESKTOP MODE — Use the direct tools to answer questions about the user's files, images, folders, tags, OCR text, and desktop state:
- getDesktopOverview: Get item counts, recent items, analyzed image stats
- searchDesktop: Search by name, tags, captions, OCR text, colors, or URLs
- createFolder: Create a folder and group items into it (requires approval)
- moveItems: Move items between folders (requires approval)

APP BUILDER MODE — Use the codemode tool to create or modify apps:
- Write TypeScript that calls codemode.createApp(), codemode.updateApp(), codemode.listApps(), codemode.getAppSource(), or codemode.deleteApp()
- Apps are HTML/CSS/JS that run in a sandboxed iframe on the user's desktop
- When creating apps, write clean, polished HTML/CSS/JS with good styling
- Use a dark-friendly color palette by default
- For games: smooth animations, score tracking, keyboard/mouse controls
- For tools: clean forms, labels, feedback
- For creative apps: use canvas/SVG, requestAnimationFrame
- To update an app, first call codemode.getAppSource() to read the existing code, then call codemode.updateApp() with the modified files

Guidelines:
- Use the appropriate mode based on the user's request
- For "build me", "create", "make an app" → use codemode
- For desktop questions, search, organize → use direct tools
- After tool results, respond concisely — don't dump raw JSON
- If a mutation needs approval, explain the pending action briefly`;

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
    if (this.env.ANTHROPIC_API_KEY) {
      const anthropic = createAnthropic({
        apiKey: this.env.ANTHROPIC_API_KEY,
      });
      return anthropic('claude-sonnet-4-20250514');
    }

    const workersAI = createWorkersAI({ binding: this.env.AI });
    return workersAI('@cf/moonshotai/kimi-k2.5');
  }

  private getUserDesktopStub(): DurableObjectStub {
    const doId = this.env.USER_DESKTOP.idFromName(this.name);
    return this.env.USER_DESKTOP.get(doId);
  }

  async onChatMessage() {
    // Direct desktop tools (fast path, no sandbox)
    const desktopTools = createDesktopTools({
      getUserDesktopStub: () => this.getUserDesktopStub(),
      setState: (state) => this.setState(state),
      getState: () => this.state,
    });

    // Codemode tool for app building (LLM writes TypeScript)
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const appTools = createAppTools({
      env: this.env,
      sql: this.ctx.storage.sql,
      agentName: this.name,
    });
    const codemode = createCodeTool({
      tools: appTools,
      executor,
    });

    const result = streamText({
      model: this.getModel(),
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        maxTokens: 16000,
      }),
      tools: {
        ...desktopTools,
        codemode,
      },
      prepareStep: async ({ stepNumber }) => {
        if (stepNumber === 0) {
          return { toolChoice: 'required' as const };
        }
        return { toolChoice: 'auto' as const };
      },
      stopWhen: stepCountIs(10),
    });

    return result.toUIMessageStreamResponse();
  }
}
