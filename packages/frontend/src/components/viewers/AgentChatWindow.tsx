import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import { getAuthToken, isApiConfigured } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { getTextFileContentType, type DesktopItem } from '../../types';
import styles from './AgentChatWindow.module.css';

const STARTER_PROMPTS = [
  'What is on my desktop right now?',
  'Find images related to roads.',
  'Build me a pomodoro timer app',
  'Create a pixel art canvas',
];

type MessagePart = {
  type: string;
  text?: unknown;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: unknown;
  toolCallId?: string;
  approval?: { id: string };
};

type SearchResultItem = {
  id: string;
  name: string;
  type: DesktopItem['type'];
  location: string;
  summary: string;
  matchedIn: string[];
};

type SearchDesktopOutput = {
  query: string;
  totalMatches: number;
  items: SearchResultItem[];
};

type DesktopOverviewOutput = {
  username: string;
  wallpaper: string;
  totalActiveItems: number;
  analyzedImages: number;
  totalImages: number;
  counts: Record<string, number>;
  recentItems: Array<{
    id: string;
    name: string;
    type: DesktopItem['type'];
    location: string;
  }>;
};

type CreateFolderOutput = {
  folder: {
    id: string;
    name: string;
    type: DesktopItem['type'];
  };
  movedCount: number;
  movedItems: Array<{
    id: string;
    name: string;
    type: DesktopItem['type'];
    location: string;
  }>;
};

type OpenWindowFn = ReturnType<typeof useWindowStore.getState>['openWindow'];

function getUserMessageText(message: { parts?: MessagePart[] }): string {
  if (!message.parts) return '';

  return message.parts
    .flatMap((part) => (part.type === 'text' ? [String(part.text ?? '')] : []))
    .join('')
    .trim();
}

function openDesktopItem(openWindow: OpenWindowFn, item: DesktopItem) {
  if (item.type === 'folder') {
    openWindow({
      id: `folder-${item.id}`,
      title: item.name,
      position: { x: 120, y: 96 },
      size: { width: 430, height: 320 },
      minimized: false,
      maximized: false,
      contentType: 'folder',
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'text') {
    openWindow({
      id: `text-${item.id}`,
      title: item.name,
      position: { x: 120, y: 96 },
      size: { width: 520, height: 420 },
      minimized: false,
      maximized: false,
      contentType: getTextFileContentType(item.name),
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'image') {
    openWindow({
      id: `image-${item.id}`,
      title: item.name,
      position: { x: 120, y: 96 },
      size: { width: 520, height: 420 },
      minimized: false,
      maximized: false,
      contentType: 'image',
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'video') {
    openWindow({
      id: `video-${item.id}`,
      title: item.name,
      position: { x: 120, y: 96 },
      size: { width: 680, height: 480 },
      minimized: false,
      maximized: false,
      contentType: 'video',
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'audio') {
    openWindow({
      id: `audio-${item.id}`,
      title: item.name,
      position: { x: 120, y: 96 },
      size: { width: 360, height: 240 },
      minimized: false,
      maximized: false,
      contentType: 'audio',
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'pdf') {
    openWindow({
      id: `pdf-${item.id}`,
      title: item.name,
      position: { x: 100, y: 72 },
      size: { width: 620, height: 720 },
      minimized: false,
      maximized: false,
      contentType: 'pdf',
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'link') {
    openWindow({
      id: `link-${item.id}`,
      title: item.name,
      position: { x: 100, y: 72 },
      size: { width: 820, height: 620 },
      minimized: false,
      maximized: false,
      contentType: 'link',
      contentId: item.id,
    });
    return;
  }

  if (item.type === 'widget') {
    openWindow({
      id: `widget-${item.id}`,
      title: item.name,
      position: { x: 120, y: 96 },
      size: { width: 300, height: 260 },
      minimized: false,
      maximized: false,
      contentType: 'widget',
      contentId: item.id,
    });
  }
}

export function AgentChatWindow() {
  const user = useAuthStore((state) => state.user);
  const items = useDesktopStore((state) => state.items);
  const loadDesktop = useDesktopStore((state) => state.loadDesktop);
  const openWindow = useWindowStore((state) => state.openWindow);
  const inputRef = useRef<HTMLInputElement>(null);
  const refreshedToolCalls = useRef(new Set<string>());
  const [draft, setDraft] = useState('');

  const apiBaseUrl = useMemo(() => {
    const configured = import.meta.env.VITE_API_URL || window.location.origin;
    return new URL(configured);
  }, []);

  const agent = useAgent({
    agent: 'OrchestratorAgent',
    basePath: 'api/agent/chat',
    host: apiBaseUrl.host,
    protocol: apiBaseUrl.protocol === 'https:' ? 'wss' : 'ws',
    query: async () => {
      const token = getAuthToken();
      return {
        token: token || null,
      };
    },
    queryDeps: [user?.uid, user?.username],
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    status,
    error,
    addToolApprovalResponse,
  } = useAgentChat({
    agent,
    headers: (() => {
      const token = getAuthToken();
      return token ? { Authorization: `Bearer ${token}` } : undefined;
    })(),
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const refreshToolTypes = ['tool-createFolder', 'tool-moveItems', 'tool-codemode'];
    for (const message of messages) {
      for (const part of (message.parts as MessagePart[] | undefined) ?? []) {
        if (
          refreshToolTypes.includes(part.type) &&
          part.state === 'output-available' &&
          part.toolCallId &&
          !refreshedToolCalls.current.has(part.toolCallId)
        ) {
          refreshedToolCalls.current.add(part.toolCallId);
          void loadDesktop();
        }
      }
    }
  }, [messages, loadDesktop]);

  if (!isApiConfigured) {
    return (
      <div className={styles.unavailable}>
        <h3>Chat Unavailable</h3>
        <p>The Cloudflare agent chat only runs when the API worker is configured.</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className={styles.unavailable}>
        <h3>Sign In Required</h3>
        <p>Log in to ask questions about your desktop and uploaded images.</p>
      </div>
    );
  }

  const submitPrompt = (prompt: string) => {
    void sendMessage({
      text: prompt,
    });
  };

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;

    void sendMessage({ text: trimmed });
    setDraft('');
  };

  const openItemById = (itemId: string) => {
    const item = items.find((candidate) => candidate.id === itemId);
    if (item) {
      openDesktopItem(openWindow, item);
    }
  };

  const renderItemButton = (item: { id: string; name: string; type: DesktopItem['type'] }) => {
    const isAvailable = items.some((candidate) => candidate.id === item.id);

    return (
      <button
        key={item.id}
        type="button"
        className={styles.itemLink}
        disabled={!isAvailable}
        onClick={() => openItemById(item.id)}
      >
        {item.name}
      </button>
    );
  };

  const renderAssistantPart = (part: MessagePart, index: number): ReactNode => {
    if (part.type === 'text') {
      const text = String(part.text ?? '').trim();
      if (!text) return null;
      return <div key={`text-${index}`} className={styles.messageText}>{text}</div>;
    }

    if (part.type === 'tool-getDesktopOverview') {
      if (part.state !== 'output-available') {
        return (
          <div key={`overview-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Desktop overview</div>
            <div className={styles.toolBody}>Checking your desktop...</div>
          </div>
        );
      }

      const output = part.output as DesktopOverviewOutput;
      const summaryParts = [
        output.counts.image ? `${output.counts.image} images` : null,
        output.counts.video ? `${output.counts.video} videos` : null,
        output.counts.text ? `${output.counts.text} text files` : null,
        output.counts.folder ? `${output.counts.folder} folders` : null,
        output.counts.widget ? `${output.counts.widget} widgets` : null,
      ].filter(Boolean);

      return (
        <div key={`overview-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Desktop overview</div>
          <div className={styles.toolBody}>
            <div>{output.totalActiveItems} active items on the desktop.</div>
            <div>{summaryParts.length > 0 ? summaryParts.join(', ') : 'No active items.'}</div>
            <div>Wallpaper: {output.wallpaper}</div>
            <div>Analyzed images: {output.analyzedImages}/{output.totalImages}</div>
          </div>
          {output.recentItems.length > 0 ? (
            <div className={styles.resultList}>
              {output.recentItems.map((item) => (
                <div key={item.id} className={styles.resultRow}>
                  <div className={styles.resultHeading}>
                    {renderItemButton(item)} <span className={styles.resultType}>({item.type})</span>
                  </div>
                  <div className={styles.resultMeta}>In {item.location}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    if (part.type === 'tool-searchDesktop') {
      if (part.state !== 'output-available') {
        const input = (part.input as { query?: string } | undefined)?.query;
        return (
          <div key={`search-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Searching desktop</div>
            <div className={styles.toolBody}>{input ? `Looking for "${input}"...` : 'Searching...'}</div>
          </div>
        );
      }

      const output = part.output as SearchDesktopOutput;
      return (
        <div key={`search-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Search results</div>
          <div className={styles.toolBody}>
            {output.totalMatches === 0
              ? `No matches for "${output.query}".`
              : `${output.totalMatches} match${output.totalMatches === 1 ? '' : 'es'} for "${output.query}".`}
          </div>
          {output.items.length > 0 ? (
            <div className={styles.resultList}>
              {output.items.map((item) => (
                <div key={item.id} className={styles.resultRow}>
                  <div className={styles.resultHeading}>
                    {renderItemButton(item)} <span className={styles.resultType}>({item.type})</span>
                  </div>
                  <div className={styles.resultMeta}>In {item.location}</div>
                  <div className={styles.resultSummary}>{item.summary}</div>
                  {item.matchedIn.length > 0 ? (
                    <div className={styles.matchPills}>
                      {item.matchedIn.map((match) => (
                        <span key={`${item.id}-${match}`} className={styles.matchPill}>{match}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    if (part.type === 'tool-createFolder' || part.type === 'tool-moveItems') {
      const input = (part.input as { folderName?: string } | undefined) ?? {};
      const label = part.type === 'tool-createFolder' ? 'Create folder' : 'Move items';

      if (part.state === 'approval-requested') {
        return (
          <div key={`folder-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Approval required</div>
            <div className={styles.toolBody}>
              {label}: <strong>{input.folderName || ''}</strong>
            </div>
            <div className={styles.approvalRow}>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  if (part.approval?.id) {
                    void addToolApprovalResponse({ id: part.approval.id, approved: true });
                  }
                }}
              >
                Approve
              </button>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  if (part.approval?.id) {
                    void addToolApprovalResponse({ id: part.approval.id, approved: false });
                  }
                }}
              >
                Deny
              </button>
            </div>
          </div>
        );
      }

      if (part.state === 'output-denied') {
        return (
          <div key={`folder-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{label} cancelled</div>
          </div>
        );
      }

      if (part.state === 'output-error') {
        return (
          <div key={`folder-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{label} failed</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }

      if (part.state === 'output-available') {
        const output = part.output as CreateFolderOutput;
        return (
          <div key={`folder-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{label} complete</div>
            <div className={styles.toolBody}>
              {output.folder ? (
                <>{renderItemButton(output.folder)} now contains {output.movedCount} item{output.movedCount === 1 ? '' : 's'}.</>
              ) : (
                <>Moved {output.movedCount} item{output.movedCount === 1 ? '' : 's'}.</>
              )}
            </div>
          </div>
        );
      }

      return null;
    }

    // Codemode tool — app building via generated TypeScript
    if (part.type === 'tool-codemode') {
      if (part.state === 'output-error') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App build failed</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }

      if (part.state !== 'output-available') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Building app...</div>
            <div className={styles.toolBody}>Generating and compiling your app...</div>
          </div>
        );
      }

      const output = part.output as { result?: unknown; logs?: string[] } | undefined;
      const result = output?.result as { appId?: string; name?: string; status?: string; version?: number } | undefined;

      if (result?.status === 'created') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App created</div>
            <div className={styles.toolBody}>
              <strong>{result.name}</strong> has been added to your desktop.
            </div>
          </div>
        );
      }

      if (result?.status === 'updated') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App updated</div>
            <div className={styles.toolBody}>
              App updated to version {result.version}. Reload the app window to see changes.
            </div>
          </div>
        );
      }

      if (result?.status === 'deleted') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App deleted</div>
            <div className={styles.toolBody}>The app has been removed from your desktop.</div>
          </div>
        );
      }

      // Generic codemode output
      return (
        <div key={`codemode-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Code executed</div>
          <div className={styles.toolBody}>
            {output?.logs && output.logs.length > 0 ? (
              <pre style={{ fontSize: '10px', whiteSpace: 'pre-wrap', margin: 0 }}>{output.logs.join('\n')}</pre>
            ) : (
              <span>Done.</span>
            )}
          </div>
        </div>
      );
    }

    return null;
  };

  const hasPendingApproval = messages.some((message) =>
    ((message.parts as MessagePart[] | undefined) ?? []).some((part) => part.state === 'approval-requested')
  );

  return (
    <div className={styles.chatWindow}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Ask Eternal</div>
          <div className={styles.subtitle}>Search your desktop, build apps, and organize files.</div>
        </div>
        <button className={styles.clearButton} type="button" onClick={clearHistory}>
          Clear History
        </button>
      </div>

      {messages.length === 0 ? (
        <div className={styles.emptyState}>
          <p>Try one of these:</p>
          <div className={styles.promptGrid}>
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                className={styles.promptButton}
                onClick={() => submitPrompt(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.messages}>
          {messages.map((message) => {
            const parts = (message.parts as MessagePart[] | undefined) ?? [];

            if (message.role === 'user') {
              const text = getUserMessageText(message);
              if (!text) return null;

              return (
                <div key={message.id} className={styles.userMessage}>
                  <div className={styles.messageLabel}>You</div>
                  <div className={styles.messageBody}>{text}</div>
                </div>
              );
            }

            const renderedParts = parts
              .map((part, index) => renderAssistantPart(part, index))
              .filter((part): part is ReactNode => part !== null);

            if (renderedParts.length === 0) {
              return null;
            }

            return (
              <div key={message.id} className={styles.assistantMessage}>
                <div className={styles.messageLabel}>Eternal</div>
                <div className={styles.messageParts}>{renderedParts}</div>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.footer}>
        <div className={styles.statusRow}>
          <span className={styles.statusLabel}>
            {hasPendingApproval
              ? 'Approval needed'
              : status === 'submitted' || status === 'streaming'
                ? 'Working through your desktop...'
                : 'Ready'}
          </span>
          {error ? <span className={styles.errorText}>{error.message}</span> : null}
        </div>

        <form className={styles.form} onSubmit={handleSend}>
          <input
            ref={inputRef}
            className={styles.input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Ask about files, images, tags, OCR text, or recent uploads..."
          />
          <button
            className={styles.sendButton}
            type="submit"
            disabled={status === 'submitted' || status === 'streaming' || !draft.trim()}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
