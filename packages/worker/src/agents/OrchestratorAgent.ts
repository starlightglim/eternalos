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
  type LanguageModelUsage,
} from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import type { Env } from '../index';
import {
  acquireAiRequest,
  aiGuardUnavailableMessage,
  legibleAiErrorMessage,
  recordAiUsageTokens,
  releaseAiTurnSlot,
  type AiTurnGrant,
} from '../middleware/aiUsage';
import { classifyRoute } from './intent';
import type { ChatRoute } from './intent';
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
  - readTextFile
- Use tools only if they materially improve the answer
- If the user just wants a conversational answer, respond without tools`;

const DESKTOP_WRITE_PROMPT = `${BASE_PROMPT}

Mode: Desktop assistant (mutating)
- You may use desktop tools to inspect or organize the user's desktop
- Available tools:
  - getDesktopOverview
  - searchDesktop
  - readTextFile
  - createFolder
  - moveItems
  - createTextNote
- Prefer search/read tools before mutations when context is missing
- For createTextNote, write the full note content yourself based on the
  conversation — do not ask the user to dictate it verbatim unless unclear`;

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
- fs.urlFor(id) is asynchronous: apps must await it
  (const url = await window.eternal.fs.urlFor(id)) before assigning the
  result to <img src>/<audio src>. It resolves to a blob object URL in
  installed apps and a plain loopback URL in previews; using it without
  awaiting yields "[object Promise]", not a URL.
- Read the user's profile via window.eternal.profile.get() (fields the app
  was granted).
- Use window.eternal.fetch() only through a domain allowlist declared in the
  app manifest and approved by the user.
- Control the window via window.eternal.window.setTitle/close/requestFocus.
- They cannot make direct browser network calls. Desktop writes/deletes,
  network proxy calls, storage, and IPC are permission-gated.

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

// Intent routing (chat vs. desktop vs. app read/build/preview-install) lives in
// ./intent — a pure, table-driven module covered by test/intent.test.mjs.

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

  /**
   * Account hard-deletion hook for a single chat thread's agent DO. Clears the
   * persisted chat history, resets agent state (including memories), and wipes
   * remaining DO storage. Called by utils/accountPurge.purgeAccount for each
   * thread in a purged account's registry. Idempotent and best-effort: each
   * step is isolated so a partial failure still removes what it can.
   */
  async purgeThreadData(): Promise<{ purged: true }> {
    try {
      // Removes all rows from cf_ai_chat_agent_messages.
      await this.persistMessages([]);
    } catch { /* already empty or table absent */ }
    try {
      this.setState(this.initialState);
    } catch { /* no state */ }
    try {
      await this.ctx.storage.deleteAll();
    } catch { /* nothing to clear */ }
    return { purged: true };
  }

  private getModel() {
    const workersAI = createWorkersAI({ binding: this.env.AI });
    const modelId = this.env.AGENT_CHAT_MODEL?.startsWith('@cf/')
      ? this.env.AGENT_CHAT_MODEL
      : '@cf/zai-org/glm-4.7-flash';
    return workersAI(modelId as Parameters<typeof workersAI>[0]);
  }


  private getUserDesktopStub(): DurableObjectStub {
    const doId = this.env.USER_DESKTOP.idFromName(this.getOwnerUid());
    return this.env.USER_DESKTOP.get(doId);
  }

  private getOwnerUid(): string {
    return extractOwnerUid(this.name);
  }

  /**
   * Settle a finished turn: record any provider-reported tokens against the
   * account's daily budget and release the in-flight slot. Safe to call more
   * than once per turn (token recording only happens with a usage value,
   * slot release is idempotent), and never throws — a settlement failure
   * must not corrupt the chat stream.
   */
  private async settleTurnUsage(
    ownerUid: string,
    grant: AiTurnGrant,
    usage: LanguageModelUsage | null,
  ): Promise<void> {
    if (usage) {
      const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (tokens > 0) {
        try {
          await recordAiUsageTokens(this.env, ownerUid, tokens);
        } catch (error) {
          console.error('AI usage: failed to record turn tokens:', error);
        }
      }
    }
    if (grant.slotId) {
      try {
        await releaseAiTurnSlot(this.env, ownerUid, grant.slotId);
      } catch (error) {
        console.error('AI usage: failed to release turn slot:', error);
      }
    }
  }

  /**
   * A stream that carries exactly one legible error part — how every
   * degraded turn (refusal, provider failure) reaches the client. The chat
   * transport is a WebSocket, so the HTTP status never surfaces to the UI;
   * the error part closes the stream cleanly (no stuck spinner) and the
   * message renders in the composer's error slot. The Response status is
   * still set correctly for direct HTTP callers: 429 for usage refusals.
   */
  private degradedTurnResponse(message: string, status: number): Response {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: 'error', errorText: message });
      },
    });
    return createUIMessageStreamResponse({ stream, status, headers: UI_MESSAGE_STREAM_HEADERS });
  }

  async onChatMessage(
    _onFinish?: Parameters<AIChatAgent<Env, OrchestratorState>['onChatMessage']>[0],
    options?: Parameters<AIChatAgent<Env, OrchestratorState>['onChatMessage']>[1],
  ) {
    const ownerUid = this.getOwnerUid();

    // --- Per-account guard, before any other work: the daily AI budget and
    // the in-flight turn cap. Deliberately the first await in the turn so
    // pipelined turns contend on the guard deterministically, and so a
    // refusal costs no bookkeeping. App builds ride inside turns (they run
    // as tools within the turn), so the turn cap covers them.
    let grant: AiTurnGrant;
    try {
      const decision = await acquireAiRequest(this.env, ownerUid, { slot: true });
      if (!decision.allowed) {
        // Clear 429 + friendly message when the budget (or cap) is hit.
        return this.degradedTurnResponse(decision.message, 429);
      }
      grant = decision;
    } catch (error) {
      // Fail closed, like the per-IP limiter — but degrade legibly rather
      // than leaving the client waiting on a stream that never arrives.
      console.error('AI usage guard unavailable:', error);
      return this.degradedTurnResponse(aiGuardUnavailableMessage(), 503);
    }

    try {
      const lastUserMessage = [...this.messages].reverse().find((message) => message.role === 'user');
      const lastUserText = extractMessageText(lastUserMessage);
      const threadId = normalizeThreadId(
        typeof options?.body?.threadId === 'string' ? options.body.threadId : this.name.split(':')[1],
      );
      // The thread registry is bookkeeping, not a precondition for the reply:
      // a transient KV failure here used to reject the whole WebSocket request
      // handler, leaving the client with no response frame at all — a stuck
      // "Working..." spinner. Log and continue; the chat itself still works and
      // the title/updatedAt bump lands on the next successful message.
      try {
        const existingThread = await upsertThread(this.env, ownerUid, threadId, { updatedAt: Date.now() });
        if (lastUserText && shouldReplaceThreadTitle(existingThread.title)) {
          await upsertThread(this.env, ownerUid, threadId, {
            title: deriveThreadTitleFromMessage(lastUserText),
            updatedAt: Date.now(),
          });
        }
      } catch (registryError) {
        console.error('Failed to update agent thread registry entry:', registryError);
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
        readTextFile: allDesktopTools.readTextFile,
      };
      const desktopWriteTools = {
        ...desktopReadTools,
        createFolder: allDesktopTools.createFolder,
        moveItems: allDesktopTools.moveItems,
        createTextNote: allDesktopTools.createTextNote,
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
          let usage: LanguageModelUsage | null = null;
          try {
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
              // Cancel the upstream model call when the client stops or the
              // request is cancelled — otherwise the DO keeps generating and
              // paying for tokens nobody will see (the response reader is torn
              // down on abort either way).
              abortSignal: options?.abortSignal,
            });
            // Map ONLY the provider-level error part to the legible message —
            // it flows through toUIMessageStream's default onError as raw
            // text and is what the user sees when the AI binding fails.
            // Tool errors (tool-output-error chunks) keep their specific,
            // actionable text; the AI SDK keeps the turn alive after them.
            const uiStream = result.toUIMessageStream() as ReadableStream<Record<string, unknown>>;
            const legibleProviderErrors = uiStream.pipeThrough(
              new TransformStream({
                transform(chunk, controller) {
                  if (chunk.type === 'error') {
                    console.error('Agent chat provider error:', chunk.errorText);
                    controller.enqueue({
                      ...chunk,
                      errorText: legibleAiErrorMessage(chunk.errorText),
                    });
                    return;
                  }
                  controller.enqueue(chunk);
                },
              }),
            );
            writer.merge(legibleProviderErrors as any);
            // Await the turn's completion — success, provider error, or
            // abort all settle this promise — so the slot is held for
            // exactly the turn's lifetime.
            usage = await Promise.resolve(result.usage).catch(() => null);
          } finally {
            // Always settle: record reported tokens, then release the slot.
            // A hard crash before this runs (the DO evicted mid-turn) is
            // backstopped by the slot's lease expiring in the guard.
            await this.settleTurnUsage(ownerUid, grant, usage);
          }
        },
        onError: (error) => {
          // Provider failure (AI binding error/timeout) reaching this
          // callback means the stream itself rejected — same legible
          // mapping as the in-band error part above.
          console.error('Agent chat turn error:', error);
          return legibleAiErrorMessage(error);
        },
      });

      return createUIMessageStreamResponse({ stream, headers: UI_MESSAGE_STREAM_HEADERS });
    } catch (error) {
      // The turn failed before any stream existed. Settle (release the
      // slot; no tokens were produced) and degrade to the same legible
      // in-stream error so the client never waits on nothing.
      console.error('Agent chat turn failed before streaming:', error);
      await this.settleTurnUsage(ownerUid, grant, null);
      return this.degradedTurnResponse(legibleAiErrorMessage(error), 503);
    }
  }
}
