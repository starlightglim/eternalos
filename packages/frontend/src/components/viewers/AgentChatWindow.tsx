import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useAgent } from 'agents/react';
import { useAgentChat } from '@cloudflare/ai-chat/react';
import {
  createAgentThread,
  deleteAgentThread,
  getAuthToken,
  isApiConfigured,
  listAgentThreads,
  mintAgentChatWebSocketToken,
  renameAgentThread,
  type AgentThreadSummary,
} from '../../services/api';
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
  id?: string;
  data?: unknown;
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

type ListAppsOutput = {
  apps: Array<{
    id: string;
    name: string;
    description: string;
    version: number;
    created_at: number;
  }>;
};

type GetAppSourceOutput = {
  appId: string;
  name: string;
  files: Record<string, string>;
  workspaceManifest?: {
    version: 1;
    profile: 'static-html';
    entryHtml: string;
    sourceFiles: string[];
    runtimeAsset: string;
    workerEntrypoint: string;
  } | null;
};

type AppPermissions = {
  fs?: {
    read?: string[];
    mimeTypes?: string[];
  };
  profile?: {
    read?: Array<'username' | 'displayName' | 'bio' | 'avatar'>;
  };
};

type AppCreateOutput = {
  appId: string;
  itemId?: string;
  name: string;
  status: 'created';
  permissions?: AppPermissions;
  build?: AppBuildSummary;
};

type AppPreviewOutput = {
  previewId: string;
  name: string;
  status: 'preview-ready';
  previewUrl: string;
  expiresAt: number;
  permissions?: AppPermissions;
  build?: AppBuildSummary;
};

type AppUpdateOutput = {
  appId: string;
  version: number;
  status: 'updated';
  build?: AppBuildSummary;
};

type AppDeleteOutput = {
  appId: string;
  status: 'deleted';
};

type MemorySummary = {
  id: string;
  kind: 'preference' | 'identity' | 'project' | 'context' | 'other';
  content: string;
  updatedAt?: number;
};

type RememberMemoryOutput = {
  status: 'created' | 'updated';
  memory: MemorySummary;
  totalMemories: number;
};

type ListMemoriesOutput = {
  totalMemories: number;
  returnedCount: number;
  memories: MemorySummary[];
};

type ForgetMemoryOutput = {
  status: 'deleted' | 'not_found';
  memory?: MemorySummary;
  totalMemories: number;
};

type AppBuildStageSummary = {
  key: 'prepare-workspace' | 'bundle-worker' | 'write-storage' | 'install-desktop';
  label: string;
  status: 'completed' | 'current' | 'pending';
};

type AppBuildSummary = {
  currentStage: AppBuildStageSummary['key'] | 'ready';
  stages: AppBuildStageSummary[];
  startedAt: number;
  completedAt: number;
  durationMs: number;
};

type OpenWindowFn = ReturnType<typeof useWindowStore.getState>['openWindow'];

const REAL_BUILD_STAGE_ORDER = ['spec', 'codegen', 'bundle', 'storage', 'install'] as const;

const REAL_BUILD_STAGE_LABELS: Record<string, string> = {
  spec: 'Generating specification',
  codegen: 'Writing source files',
  bundle: 'Bundling app',
  storage: 'Saving files',
  install: 'Installing on desktop',
};

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
    return;
  }

  if (item.type === 'app') {
    openWindow({
      id: `app-${item.id}`,
      title: item.appManifest?.name || item.name,
      position: { x: 120, y: 96 },
      size: {
        width: item.appManifest?.windowConfig?.defaultWidth || 600,
        height: item.appManifest?.windowConfig?.defaultHeight || 500,
      },
      minimized: false,
      maximized: false,
      contentType: 'app',
      contentId: item.id,
    });
  }
}


function summarizePermissions(permissions: AppPermissions | undefined): string[] {
  if (!permissions) return [];

  const parts: string[] = [];

  if (permissions.fs?.mimeTypes?.length) {
    parts.push(`desktop files: ${permissions.fs.mimeTypes.join(', ')}`);
  }
  if (permissions.fs?.read?.length) {
    parts.push(`desktop paths: ${permissions.fs.read.join(', ')}`);
  }
  if (permissions.profile?.read?.length) {
    parts.push(`profile: ${permissions.profile.read.join(', ')}`);
  }

  return parts;
}

function BuildStageSummary({ build }: { build: AppBuildSummary | undefined }) {
  if (!build?.stages?.length) return null;
  const completedStages = build.stages.filter((s) => s.status === 'completed');
  if (completedStages.length === 0) return null;
  const durationSec = build.durationMs > 0 ? (build.durationMs / 1000).toFixed(1) : null;

  return (
    <div className={styles.buildSummary}>
      <div className={styles.buildCheckList}>
        {completedStages.map((stage) => (
          <div key={stage.key} className={styles.buildCheckRow}>
            <span className={styles.buildCheckIcon} aria-hidden="true">✓</span>
            <span className={styles.buildCheckLabel}>{stage.label}</span>
          </div>
        ))}
      </div>
      {durationSec ? (
        <div className={styles.buildFooter}>
          <span className={styles.buildDurationBadge}>Built in {durationSec}s</span>
        </div>
      ) : null}
    </div>
  );
}

function AppBuildProgressCard({
  prompt,
  realStage,
}: {
  prompt?: string;
  realStage?: string;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setElapsedSeconds((value) => value + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const currentIndex = realStage ? REAL_BUILD_STAGE_ORDER.indexOf(realStage as typeof REAL_BUILD_STAGE_ORDER[number]) : -1;
  const currentLabel = realStage ? (REAL_BUILD_STAGE_LABELS[realStage] ?? 'Building...') : 'Building...';
  const stages = REAL_BUILD_STAGE_ORDER.map((key, i) => ({
    key,
    label: REAL_BUILD_STAGE_LABELS[key],
    status: i < currentIndex ? 'completed' : i === currentIndex ? 'current' : 'pending',
  }));

  return (
    <div className={styles.toolCard}>
      <div className={styles.buildProgressHeader}>
        <span className={styles.buildSpinner} aria-hidden="true" />
        <span className={styles.buildProgressTitle}>{currentLabel}</span>
        <span className={styles.buildProgressElapsed}>{elapsedSeconds}s</span>
      </div>
      <div className={styles.buildStageList}>
        {stages.map((stage) => (
          <div key={stage.key} className={styles.buildStageRow}>
            <span
              className={[
                styles.buildStageIcon,
                stage.status === 'completed' ? styles.buildStageIconDone : '',
                stage.status === 'current' ? styles.buildStageIconActive : '',
              ].filter(Boolean).join(' ')}
              aria-hidden="true"
            >
              {stage.status === 'completed' ? '✓' : stage.status === 'current' ? '●' : '○'}
            </span>
            <span
              className={[
                styles.buildStageLabel,
                stage.status === 'pending' ? styles.buildStageLabelDim : '',
                stage.status === 'current' ? styles.buildStageLabelActive : '',
              ].filter(Boolean).join(' ')}
            >
              {stage.label}
            </span>
          </div>
        ))}
      </div>
      {prompt ? (
        <div className={styles.buildPrompt}>
          <span className={styles.buildPromptText}>"{prompt}"</span>
        </div>
      ) : null}
    </div>
  );
}

const ACTIVE_THREAD_STORAGE_KEY_PREFIX = 'eternal-agent-active-thread:';

function getActiveThreadStorageKey(uid: string): string {
  return `${ACTIVE_THREAD_STORAGE_KEY_PREFIX}${uid}`;
}

function formatThreadTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isSameDay = date.toDateString() === now.toDateString();

  return isSameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

type AgentChatThreadPaneProps = {
  user: NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
  authToken: string | null;
  activeThread: AgentThreadSummary;
  threadList: AgentThreadSummary[];
  threadsLoading: boolean;
  threadsError: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => Promise<void>;
  onRenameThread: () => Promise<void>;
  onDeleteThread: () => Promise<void>;
  onThreadActivity: () => void;
};

function AgentChatThreadPane({
  user,
  authToken,
  activeThread,
  threadList,
  threadsLoading,
  threadsError,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onDeleteThread,
  onThreadActivity,
}: AgentChatThreadPaneProps) {
  const items = useDesktopStore((state) => state.items);
  const loadDesktop = useDesktopStore((state) => state.loadDesktop);
  const openWindow = useWindowStore((state) => state.openWindow);
  const inputRef = useRef<HTMLInputElement>(null);
  const refreshedToolCalls = useRef(new Set<string>());
  const [draft, setDraft] = useState('');
  const [wsToken, setWsToken] = useState<string | null>(null);
  const [wsReady, setWsReady] = useState(false);

  const apiBaseUrl = useMemo(() => {
    const configured = import.meta.env.VITE_API_URL || window.location.origin;
    return new URL(configured);
  }, []);

  const agentQuery = useMemo(() => (
    wsToken ? { wsToken, threadId: activeThread.id } : undefined
  ), [activeThread.id, wsToken]);

  const chatHeaders = useMemo(() => (
    authToken ? { Authorization: `Bearer ${authToken}` } : undefined
  ), [authToken]);

  useEffect(() => {
    let cancelled = false;
    const token = getAuthToken();

    if (!user || !token) {
      setWsToken(null);
      setWsReady(true);
      return () => {
        cancelled = true;
      };
    }

    setWsReady(false);
    void mintAgentChatWebSocketToken()
      .then((nextWsToken) => {
        if (!cancelled) {
          setWsToken(nextWsToken);
          setWsReady(true);
        }
      })
      .catch((mintError) => {
        console.error('Failed to mint agent chat websocket token:', mintError);
        if (!cancelled) {
          setWsToken(null);
          setWsReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [user?.uid]);

  const agent = useAgent({
    agent: 'OrchestratorAgent',
    basePath: 'api/agent/chat',
    host: apiBaseUrl.host,
    protocol: apiBaseUrl.protocol === 'https:' ? 'wss' : 'ws',
    enabled: wsReady && !!user && !!activeThread.id,
    query: agentQuery,
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
    headers: chatHeaders,
    body: { threadId: activeThread.id },
  });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const refreshToolTypes = [
      'tool-createFolder',
      'tool-moveItems',
      'tool-codemode',
      'tool-previewAppFromPrompt',
      'tool-installAppPreview',
      'tool-buildAppFromPrompt',
      'tool-createApp',
      'tool-updateApp',
      'tool-deleteApp',
    ];
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

  useEffect(() => {
    if (status === 'ready') {
      onThreadActivity();
    }
  }, [messages.length, onThreadActivity, status]);

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

  const openPreviewWindow = (previewId: string, name: string) => {
    openWindow({
      id: `app-preview-${previewId}`,
      title: `${name} Preview`,
      position: { x: 132, y: 92 },
      size: { width: 840, height: 620 },
      minimized: false,
      maximized: false,
      contentType: 'app-preview',
      contentId: previewId,
    });
  };

  const requestInstallPreview = (previewId: string) => {
    void sendMessage({
      text: `Install app preview ${previewId}`,
    });
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

  const renderAssistantPart = (part: MessagePart, index: number, messageParts: MessagePart[]): ReactNode => {
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

    if (part.type === 'tool-listApps') {
      if (part.state !== 'output-available') {
        return (
          <div key={`list-apps-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Apps</div>
            <div className={styles.toolBody}>Checking your apps...</div>
          </div>
        );
      }

      const output = part.output as ListAppsOutput;
      return (
        <div key={`list-apps-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Your apps</div>
          <div className={styles.toolBody}>
            {output.apps.length === 0
              ? 'No apps created yet.'
              : `${output.apps.length} app${output.apps.length === 1 ? '' : 's'} found.`}
          </div>
          {output.apps.length > 0 ? (
            <div className={styles.resultList}>
              {output.apps.map((app) => (
                <div key={app.id} className={styles.resultRow}>
                  <div className={styles.resultHeading}>{app.name}</div>
                  <div className={styles.resultMeta}>Version {app.version}</div>
                  {app.description ? (
                    <div className={styles.resultSummary}>{app.description}</div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    if (part.type === 'tool-getAppSource') {
      if (part.state !== 'output-available') {
        return (
          <div key={`app-source-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App source</div>
            <div className={styles.toolBody}>Loading app files...</div>
          </div>
        );
      }

      const output = part.output as GetAppSourceOutput;
      const fileNames = Object.keys(output.files);
      return (
        <div key={`app-source-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>App source</div>
          <div className={styles.toolBody}>
            <strong>{output.name}</strong> includes {fileNames.length} file{fileNames.length === 1 ? '' : 's'}.
          </div>
          {fileNames.length > 0 ? (
            <div className={styles.matchPills}>
              {fileNames.slice(0, 12).map((fileName) => (
                <span key={fileName} className={styles.matchPill}>{fileName}</span>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    if (part.type === 'tool-rememberMemory') {
      if (part.state !== 'output-available') {
        return (
          <div key={`remember-memory-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Saving memory</div>
            <div className={styles.toolBody}>Updating remembered context...</div>
          </div>
        );
      }

      const output = part.output as RememberMemoryOutput;
      return (
        <div key={`remember-memory-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>{output.status === 'updated' ? 'Memory updated' : 'Memory saved'}</div>
          <div className={styles.toolBody}>
            <strong>{output.memory.kind}</strong>: {output.memory.content}
          </div>
        </div>
      );
    }

    if (part.type === 'tool-listMemories') {
      if (part.state !== 'output-available') {
        return (
          <div key={`list-memories-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Memories</div>
            <div className={styles.toolBody}>Loading saved memories...</div>
          </div>
        );
      }

      const output = part.output as ListMemoriesOutput;
      return (
        <div key={`list-memories-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Saved memories</div>
          <div className={styles.toolBody}>
            {output.returnedCount === 0
              ? 'No saved memories.'
              : `${output.returnedCount} memor${output.returnedCount === 1 ? 'y' : 'ies'} shown.`}
          </div>
          {output.memories.length > 0 ? (
            <div className={styles.resultList}>
              {output.memories.map((memory) => (
                <div key={memory.id} className={styles.resultRow}>
                  <div className={styles.resultHeading}>
                    <strong>{memory.kind}</strong>
                  </div>
                  <div className={styles.resultSummary}>{memory.content}</div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    if (part.type === 'tool-forgetMemory') {
      if (part.state !== 'output-available') {
        return (
          <div key={`forget-memory-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Removing memory</div>
            <div className={styles.toolBody}>Updating remembered context...</div>
          </div>
        );
      }

      const output = part.output as ForgetMemoryOutput;
      return (
        <div key={`forget-memory-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>{output.status === 'deleted' ? 'Memory removed' : 'Memory not found'}</div>
          {output.memory ? (
            <div className={styles.toolBody}>
              <strong>{output.memory.kind}</strong>: {output.memory.content}
            </div>
          ) : null}
        </div>
      );
    }

    if (
      part.type === 'tool-previewAppFromPrompt'
      || part.type === 'tool-installAppPreview'
      || part.type === 'tool-buildAppFromPrompt'
      || part.type === 'tool-createApp'
      || part.type === 'tool-updateApp'
      || part.type === 'tool-deleteApp'
    ) {
      const toolInput = (part.input as {
        prompt?: string;
        name?: string;
        appId?: string;
        previewId?: string;
      } | undefined) ?? {};

      const label = part.type === 'tool-previewAppFromPrompt'
        ? 'Preview app'
        : part.type === 'tool-installAppPreview'
          ? 'Install preview'
          : part.type === 'tool-buildAppFromPrompt'
        ? 'Build app'
        : part.type === 'tool-createApp'
          ? 'Create app'
          : part.type === 'tool-updateApp'
            ? 'Update app'
            : 'Delete app';

      const targetName = toolInput.name || toolInput.appId || toolInput.previewId || 'this app';

      if (part.state === 'approval-requested') {
        const body = part.type === 'tool-previewAppFromPrompt'
          ? (
            <>
              Eternal wants to generate an app preview without installing it yet.
              {toolInput.prompt ? <> <span className={styles.resultSummary}>Request: “{toolInput.prompt}”</span></> : null}
            </>
          )
          : part.type === 'tool-buildAppFromPrompt'
          ? (
            <>
              Eternal wants to build and install a new app on your desktop.
              {toolInput.prompt ? <> <span className={styles.resultSummary}>Request: “{toolInput.prompt}”</span></> : null}
            </>
          )
          : (
            <>Eternal wants to {label.toLowerCase()} <strong>{targetName}</strong>.</>
          );

        return (
          <div key={`app-tool-approval-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Approval required</div>
            <div className={styles.toolBody}>{body}</div>
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
          <div key={`app-tool-denied-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{label} cancelled</div>
          </div>
        );
      }

      if (part.state === 'output-error') {
        return (
          <div key={`app-tool-error-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{label} failed</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }

      if (part.state !== 'output-available') {
        const stagePart = messageParts.find((p) => p.type === 'data-build-stage' && p.id === part.toolCallId);
        const realStage = (stagePart?.data as { stage?: string } | undefined)?.stage;

        if (part.type === 'tool-previewAppFromPrompt') {
          return (
            <AppBuildProgressCard
              key={`app-tool-progress-${index}`}
              prompt={toolInput.prompt}
              realStage={realStage}
            />
          );
        }

        if (part.type === 'tool-installAppPreview') {
          return (
            <AppBuildProgressCard
              key={`app-tool-progress-${index}`}
              prompt={toolInput.previewId}
              realStage={realStage}
            />
          );
        }

        if (part.type === 'tool-buildAppFromPrompt') {
          return (
            <AppBuildProgressCard
              key={`app-tool-progress-${index}`}
              prompt={toolInput.prompt}
              realStage={realStage}
            />
          );
        }

        if (part.type === 'tool-createApp') {
          return (
            <AppBuildProgressCard
              key={`app-tool-progress-${index}`}
              prompt={toolInput.name}
              realStage={realStage}
            />
          );
        }

        if (part.type === 'tool-updateApp') {
          return (
            <AppBuildProgressCard
              key={`app-tool-progress-${index}`}
              prompt={toolInput.appId}
              realStage={realStage}
            />
          );
        }

        return (
          <div key={`app-tool-progress-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Deleting app...</div>
            <div className={styles.toolBody}>Removing the app and cleaning up its files.</div>
          </div>
        );
      }

      if (part.type === 'tool-previewAppFromPrompt') {
        const output = part.output as AppPreviewOutput;
        const permissionSummary = summarizePermissions(output.permissions);

        return (
          <div key={`app-tool-preview-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App preview ready</div>
            <div className={styles.toolBody}>
              <strong>{output.name}</strong> is ready to inspect before installing.
            </div>
            <div className={styles.resultList}>
              <div className={styles.resultRow}>
                <div className={styles.resultHeading}>
                  <button
                    type="button"
                    className={styles.itemLink}
                    onClick={() => openPreviewWindow(output.previewId, output.name)}
                  >
                    Open preview
                  </button>
                </div>
                <div className={styles.resultMeta}>Preview ID: {output.previewId}</div>
              </div>
            </div>
            <div className={styles.approvalRow}>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => openPreviewWindow(output.previewId, output.name)}
              >
                Open in desktop
              </button>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => requestInstallPreview(output.previewId)}
              >
                Install preview
              </button>
            </div>
            {permissionSummary.length > 0 ? (
              <div className={styles.resultList}>
                {permissionSummary.map((entry) => (
                  <div key={entry} className={styles.resultRow}>
                    <div className={styles.resultMeta}>install permission: {entry}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <BuildStageSummary build={output.build} />
          </div>
        );
      }

      if (part.type === 'tool-buildAppFromPrompt' || part.type === 'tool-createApp' || part.type === 'tool-installAppPreview') {
        const output = part.output as AppCreateOutput;
        const permissionSummary = summarizePermissions(output.permissions);

        return (
          <div key={`app-tool-created-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App created</div>
            <div className={styles.toolBody}>
              <strong>{output.name}</strong> has been added to your desktop.
            </div>
            {output.itemId ? (
              <div className={styles.resultList}>
                <div className={styles.resultRow}>
                  <div className={styles.resultHeading}>
                    {renderItemButton({ id: output.itemId, name: output.name, type: 'app' })}
                  </div>
                </div>
              </div>
            ) : null}
            {permissionSummary.length > 0 ? (
              <div className={styles.resultList}>
                {permissionSummary.map((entry) => (
                  <div key={entry} className={styles.resultRow}>
                    <div className={styles.resultMeta}>{entry}</div>
                  </div>
                ))}
              </div>
            ) : null}
            <BuildStageSummary build={output.build} />
          </div>
        );
      }

      if (part.type === 'tool-updateApp') {
        const output = part.output as AppUpdateOutput;
        return (
          <div key={`app-tool-updated-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App updated</div>
            <div className={styles.toolBody}>
              App updated to version {output.version}. Reopen the app window if it is already open.
            </div>
            <BuildStageSummary build={output.build} />
          </div>
        );
      }

      const output = part.output as AppDeleteOutput;
      return (
        <div key={`app-tool-deleted-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>App deleted</div>
          <div className={styles.toolBody}>
            {output.appId ? `Removed app ${output.appId} from your desktop.` : 'The app has been removed from your desktop.'}
          </div>
        </div>
      );
    }

    // Codemode tool — app building via generated TypeScript
    if (part.type === 'tool-codemode') {
      if (part.state === 'approval-requested') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Approval required</div>
            <div className={styles.toolBody}>
              Eternal wants to execute generated code that may create, update, or delete desktop apps.
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
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App action cancelled</div>
          </div>
        );
      }

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
          <AppBuildProgressCard
            key={`codemode-${index}`}
          />
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
  const latestPendingToolPart = [...messages]
    .reverse()
    .flatMap((message) => [...((message.parts as MessagePart[] | undefined) ?? [])].reverse())
    .find((part) => (
      part.type.startsWith('tool-')
      && part.state !== 'output-available'
      && part.state !== 'output-error'
      && part.state !== 'output-denied'
      && part.state !== 'approval-requested'
    ));

  const statusText = !wsReady
    ? 'Connecting...'
    : hasPendingApproval
      ? 'Approval needed'
      : latestPendingToolPart?.type === 'tool-buildAppFromPrompt'
        || latestPendingToolPart?.type === 'tool-previewAppFromPrompt'
        || latestPendingToolPart?.type === 'tool-installAppPreview'
        || latestPendingToolPart?.type === 'tool-createApp'
        || latestPendingToolPart?.type === 'tool-updateApp'
        || latestPendingToolPart?.type === 'tool-codemode'
          ? 'Building your app...'
          : latestPendingToolPart?.type === 'tool-deleteApp'
            ? 'Removing app...'
            : status === 'submitted' || status === 'streaming'
              ? 'Working through your desktop...'
              : 'Ready';
  const currentRequestLabel = activeThread.title.length > 42
    ? `${activeThread.title.slice(0, 39)}...`
    : activeThread.title;
  const capabilityNotes = [
    'Search files, images, OCR text, and desktop metadata',
    'Build and update apps directly on the desktop',
    'Remember stable preferences and project context',
  ];

  return (
    <div className={styles.chatWindow}>
      <div className={styles.header}>
        <div className={styles.toolbarGroup}>
          <div className={styles.windowLabel}>Eternal Workspace</div>
          <button className={`${styles.toolbarTab} ${styles.toolbarTabActive}`} type="button">
            Chat
          </button>
          <button className={styles.toolbarTab} type="button" onClick={() => void onCreateThread()}>
            New Thread
          </button>
        </div>
        <div className={styles.headerTitle}>Ask Eternal</div>
        <div className={styles.toolbarGroup}>
          <div className={styles.searchBadge}>Kimi</div>
          <button className={styles.clearButton} type="button" onClick={() => void clearHistory()}>
            Clear History
          </button>
        </div>
      </div>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarSection}>
            <div className={styles.sidebarHeading}>Workspace</div>
            <button className={styles.sidebarAction} type="button" onClick={() => void onCreateThread()}>
              New Thread
            </button>
            <button className={styles.sidebarAction} type="button" onClick={() => void clearHistory()}>
              Clear History
            </button>
          </div>

          <div className={styles.sidebarSection}>
            <div className={styles.sidebarHeading}>Threads</div>
            {threadsLoading ? (
              <div className={styles.sidebarEmpty}>Loading threads...</div>
            ) : threadsError ? (
              <div className={styles.sidebarEmpty}>{threadsError}</div>
            ) : threadList.length === 0 ? (
              <div className={styles.sidebarEmpty}>No threads yet</div>
            ) : (
              <div className={styles.threadList}>
                {threadList.map((thread) => (
                  <button
                    key={thread.id}
                    type="button"
                    className={`${styles.threadItem} ${thread.id === activeThread.id ? styles.threadItemActive : ''}`}
                    onClick={() => onSelectThread(thread.id)}
                  >
                    <span className={styles.threadItemTitle}>{thread.title}</span>
                    <span className={styles.threadItemMeta}>{formatThreadTimestamp(thread.updatedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className={styles.mainPane}>
          <div className={styles.mainHeader}>
            <div>
              <div className={styles.mainTitle}>{currentRequestLabel}</div>
              <div className={styles.subtitle}>Search your desktop, build apps, and organize files.</div>
            </div>
            <div className={styles.mainBadge}>Aura</div>
          </div>

          {messages.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyCard}>
                <div className={styles.emptyTitle}>Start with a natural-language request</div>
                <div className={styles.emptyCopy}>
                  Ask for a desktop search, a new app, or something you want Eternal to remember.
                </div>
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
                  .map((part, index) => renderAssistantPart(part, index, parts))
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
              <span className={styles.statusLabel}>{statusText}</span>
              {error ? <span className={styles.errorText}>{error.message}</span> : null}
            </div>

            <form className={styles.form} onSubmit={handleSend}>
              <input
                ref={inputRef}
                className={styles.input}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={wsReady
                  ? 'Ask about files, images, tags, OCR text, or recent uploads...'
                  : 'Connecting to Eternal...'}
              />
              <button
                className={styles.sendButton}
                type="submit"
                disabled={!wsReady || status === 'submitted' || status === 'streaming' || !draft.trim()}
              >
                Send
              </button>
            </form>
          </div>
        </section>

        <aside className={styles.inspector}>
          <div className={styles.inspectorSection}>
            <div className={styles.sidebarHeading}>Status</div>
            <div className={styles.statusCard}>
              <div className={styles.statusCardTitle}>{statusText}</div>
              <div className={styles.statusCardMeta}>
                {wsReady ? 'Realtime connection active' : 'Connecting to agent transport'}
              </div>
            </div>
          </div>

          <div className={styles.inspectorSection}>
            <div className={styles.sidebarHeading}>Thread</div>
            <div className={styles.threadSummaryCard}>
              <div className={styles.statusCardTitle}>{activeThread.title}</div>
              <div className={styles.statusCardMeta}>
                Updated {formatThreadTimestamp(activeThread.updatedAt)}
              </div>
              <div className={styles.threadActionRow}>
                <button className={styles.sidebarAction} type="button" onClick={() => void onRenameThread()}>
                  Rename
                </button>
                <button className={styles.sidebarAction} type="button" onClick={() => void onDeleteThread()}>
                  Delete
                </button>
              </div>
            </div>
          </div>

          <div className={styles.inspectorSection}>
            <div className={styles.sidebarHeading}>Quick Starts</div>
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

          <div className={styles.inspectorSection}>
            <div className={styles.sidebarHeading}>Capabilities</div>
            <div className={styles.capabilityList}>
              {capabilityNotes.map((note) => (
                <div key={note} className={styles.capabilityItem}>
                  {note}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function AgentChatWindow() {
  const user = useAuthStore((state) => state.user);
  const authToken = useAuthStore((state) => state.token);
  const [threads, setThreads] = useState<AgentThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const refreshThreads = useCallback(async ({ silent = false }: { silent?: boolean } = {}): Promise<AgentThreadSummary[]> => {
    if (!user) {
      setThreads([]);
      setThreadsError(null);
      return [];
    }

    if (!silent) {
      setThreadsLoading(true);
    }
    try {
      const nextThreads = await listAgentThreads();
      setThreads(nextThreads);
      setThreadsError(null);
      return nextThreads;
    } catch (refreshError) {
      console.error('Failed to load agent threads:', refreshError);
      setThreadsError(refreshError instanceof Error ? refreshError.message : 'Failed to load threads');
      return [];
    } finally {
      if (!silent) {
        setThreadsLoading(false);
      }
    }
  }, [user]);

  const ensureActiveThread = useCallback(async (threadList: AgentThreadSummary[]): Promise<AgentThreadSummary | null> => {
    if (!user) return null;

    const storageKey = getActiveThreadStorageKey(user.uid);
    const savedThreadId = window.localStorage.getItem(storageKey);
    const preferredThreadId = activeThreadId || savedThreadId;
    const preferredThread = preferredThreadId
      ? threadList.find((thread) => thread.id === preferredThreadId)
      : undefined;

    if (preferredThread) {
      setActiveThreadId(preferredThread.id);
      window.localStorage.setItem(storageKey, preferredThread.id);
      return preferredThread;
    }

    if (threadList.length > 0) {
      setActiveThreadId(threadList[0].id);
      window.localStorage.setItem(storageKey, threadList[0].id);
      return threadList[0];
    }

    try {
      const thread = await createAgentThread();
      setThreads([thread]);
      setActiveThreadId(thread.id);
      window.localStorage.setItem(storageKey, thread.id);
      setThreadsError(null);
      return thread;
    } catch (createError) {
      console.error('Failed to create initial agent thread:', createError);
      setThreadsError(createError instanceof Error ? createError.message : 'Failed to create thread');
      return null;
    }
  }, [activeThreadId, user]);

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setThreads([]);
      setActiveThreadId(null);
      setThreadsError(null);
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const nextThreads = await refreshThreads();
      if (cancelled) return;
      await ensureActiveThread(nextThreads);
    })();

    return () => {
      cancelled = true;
    };
  }, [ensureActiveThread, refreshThreads, user]);

  const handleSelectThread = useCallback((threadId: string) => {
    if (!user) return;
    setActiveThreadId(threadId);
    window.localStorage.setItem(getActiveThreadStorageKey(user.uid), threadId);
  }, [user]);

  const handleCreateThread = useCallback(async () => {
    if (!user) return;

    try {
      const thread = await createAgentThread();
      const nextThreads = [thread, ...threads.filter((existing) => existing.id !== thread.id)];
      setThreads(nextThreads);
      setThreadsError(null);
      setActiveThreadId(thread.id);
      window.localStorage.setItem(getActiveThreadStorageKey(user.uid), thread.id);
    } catch (createError) {
      console.error('Failed to create agent thread:', createError);
      setThreadsError(createError instanceof Error ? createError.message : 'Failed to create thread');
    }
  }, [threads, user]);

  const handleRenameThread = useCallback(async () => {
    if (!user || !activeThreadId) return;

    const activeThread = threads.find((thread) => thread.id === activeThreadId);
    const nextTitle = window.prompt('Rename thread', activeThread?.title ?? 'New Thread')?.trim();
    if (!nextTitle) return;

    try {
      const updated = await renameAgentThread(activeThreadId, nextTitle);
      const nextThreads = threads
        .map((thread) => (thread.id === updated.id ? updated : thread))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setThreads(nextThreads);
      setThreadsError(null);
    } catch (renameError) {
      console.error('Failed to rename agent thread:', renameError);
      setThreadsError(renameError instanceof Error ? renameError.message : 'Failed to rename thread');
    }
  }, [activeThreadId, threads, user]);

  const handleDeleteThread = useCallback(async () => {
    if (!user || !activeThreadId) return;

    const activeThread = threads.find((thread) => thread.id === activeThreadId);
    const confirmed = window.confirm(`Delete "${activeThread?.title ?? 'this thread'}"?`);
    if (!confirmed) return;

    try {
      await deleteAgentThread(activeThreadId);
      const nextThreads = threads.filter((thread) => thread.id !== activeThreadId);
      setThreads(nextThreads);
      setThreadsError(null);

      if (nextThreads.length > 0) {
        const nextActiveThread = nextThreads[0];
        setActiveThreadId(nextActiveThread.id);
        window.localStorage.setItem(getActiveThreadStorageKey(user.uid), nextActiveThread.id);
      } else {
        const created = await createAgentThread();
        setThreads([created]);
        setActiveThreadId(created.id);
        window.localStorage.setItem(getActiveThreadStorageKey(user.uid), created.id);
      }
    } catch (deleteError) {
      console.error('Failed to delete agent thread:', deleteError);
      setThreadsError(deleteError instanceof Error ? deleteError.message : 'Failed to delete thread');
    }
  }, [activeThreadId, threads, user]);

  const handleThreadActivity = useCallback(() => {
    void refreshThreads({ silent: true }).then((nextThreads) => {
      if (!user) return;
      const storageKey = getActiveThreadStorageKey(user.uid);
      const currentThreadId = activeThreadId || window.localStorage.getItem(storageKey);
      const matchingThread = currentThreadId
        ? nextThreads.find((thread) => thread.id === currentThreadId)
        : undefined;

      if (matchingThread) {
        window.localStorage.setItem(storageKey, matchingThread.id);
      }
    });
  }, [activeThreadId, refreshThreads, user]);

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

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;

  if (!activeThread) {
    return (
      <div className={styles.unavailable}>
        <h3>Preparing Chat</h3>
        <p>{threadsError ?? 'Creating your first conversation thread...'}</p>
      </div>
    );
  }

  return (
    <AgentChatThreadPane
      key={activeThread.id}
      user={user}
      authToken={authToken}
      activeThread={activeThread}
      threadList={threads}
      threadsLoading={threadsLoading}
      threadsError={threadsError}
      onSelectThread={handleSelectThread}
      onCreateThread={handleCreateThread}
      onRenameThread={handleRenameThread}
      onDeleteThread={handleDeleteThread}
      onThreadActivity={handleThreadActivity}
    />
  );
}
