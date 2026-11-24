import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import {
  abortChatRequestLocally,
  mergeChatHistory,
  resolveDisconnectAction,
  shouldReloadHistoryAfterReconnect,
  shouldResumeStreamAfterReconnect,
} from '../../utils/agentChatReconciliation';
import { useAuthStore } from '../../stores/authStore';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { getTextFileContentType, type AppPermissions, type DesktopItem } from '../../types';
import { AlertDialog } from '../ui/AlertDialog';
import { notifyAppDataChanged, openAppIds, reloadAppWindows } from '../../utils/appWindowBus';
import styles from './AgentChatWindow.module.css';
import {
  ActivityGroup,
  ChangePreview,
  RoutineRunCard,
  type ActivityItem,
  RoutinesPanel,
  RunSteps,
  UndoControl,
  type CodePreviewData,
  type RoutineRunData,
  type RunStepsData,
  type UndoData,
} from './CodeRunViews';
import type { UndoRunResult } from '../../services/agent';
import { ChatMarkdown } from './ChatMarkdown';
import { DEMO_APP_NAME, DEMO_PROMPT, ensureAgentDemo } from '../../services/agentDemo';
import { activityLabel, describeAppChange, isQuietToolPart, readOnlyRunSteps } from '../../utils/codeRunText';

const STARTER_PROMPTS = [
  'What is on my desktop right now?',
  'Build me a habit tracker with a backend',
  'Summarize my text files into one note',
  'Every morning, list my newest files in a note',
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

/** The data part of `type` streamed for a given tool call (previews, steps, undo). */
function dataPartFor<T>(parts: MessagePart[], type: string, toolCallId: string | undefined): T | undefined {
  if (!toolCallId) return undefined;
  return parts.find((p) => p.type === type && p.id === toolCallId)?.data as T | undefined;
}

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

type ReadTextFileOutput = {
  found: boolean;
  id?: string;
  name?: string;
  location?: string;
  truncated?: boolean;
  message?: string;
  candidates?: Array<{ id: string; name: string; location: string }>;
};

type CreateTextNoteOutput = {
  note: {
    id: string;
    name: string;
    type: DesktopItem['type'];
  };
  location: string;
  characters: number;
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

/**
 * Keep open app windows in step with what the assistant just did: new code
 * remounts the window, backend data changes ping the running app.
 */
function syncOpenAppWindows(part: MessagePart): void {
  const input = (part.input ?? {}) as { appId?: unknown; method?: unknown };
  const output = (part.output ?? {}) as { appId?: unknown; ok?: unknown; changedApps?: unknown };
  if (part.type === 'tool-updateApp' || part.type === 'tool-editApp' || part.type === 'tool-installAppPreview') {
    if (typeof output.appId === 'string') reloadAppWindows(output.appId);
    return;
  }
  if (part.type === 'tool-callAppApi') {
    const method = typeof input.method === 'string' ? input.method.toUpperCase() : 'GET';
    if (typeof input.appId === 'string' && method !== 'GET' && output.ok !== false) {
      notifyAppDataChanged(input.appId);
    }
    return;
  }
  if (part.type === 'tool-codemode' && Array.isArray(output.changedApps)) {
    // Code Mode reports every app whose data its run changed.
    const open = new Set(openAppIds());
    for (const appId of output.changedApps) {
      if (typeof appId === 'string' && open.has(appId)) notifyAppDataChanged(appId);
    }
  }
}

type GetAppSourceOutput = {
  appId: string;
  name: string;
  files: Record<string, string>;
  workspaceManifest?: {
    version: 1;
    profile: 'static-html' | 'fullstack';
    entryHtml: string;
    sourceFiles: string[];
    runtimeAsset: string;
    workerEntrypoint: string;
  } | null;
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

/** The message values produced by useAgentChat (UIMessage from the AI SDK). */
type AgentChatMessage = ReturnType<typeof useAgentChat>['messages'][number];

function isAgentChatMessage(value: unknown): value is AgentChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; role?: unknown; parts?: unknown };
  return (
    typeof candidate.id === 'string'
    && candidate.id.length > 0
    && (candidate.role === 'user' || candidate.role === 'assistant' || candidate.role === 'system')
    && Array.isArray(candidate.parts)
  );
}

// 'probe' (running server.js against its routes) only happens for apps
// with a backend; static builds go straight from codegen to bundle.
const REAL_BUILD_STAGE_ORDER = ['spec', 'codegen', 'probe', 'bundle', 'storage', 'install'] as const;

const REAL_BUILD_STAGE_LABELS: Record<string, string> = {
  spec: 'Generating specification',
  codegen: 'Writing source files',
  probe: 'Testing backend routes',
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
  if (permissions.fs?.write?.length) {
    parts.push(`save to: ${permissions.fs.write.join(', ')}`);
  }
  if (permissions.fs?.delete?.length) {
    parts.push(`delete in: ${permissions.fs.delete.join(', ')}`);
  }
  if (permissions.profile?.read?.length) {
    parts.push(`profile: ${permissions.profile.read.join(', ')}`);
  }
  if (permissions.network?.outbound?.length) {
    parts.push(`internet: ${permissions.network.outbound.join(', ')}`);
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
  // Joined string (not the array) so moving windows doesn't re-render the chat.
  const openAppWindowIds = useWindowStore((state) => state.windows.filter((w) => w.contentType === 'app').map((w) => w.id).join('|'));
  const [demoStatus, setDemoStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const refreshedToolCalls = useRef(new Set<string>());
  const [draft, setDraft] = useState('');
  const [wsSession, setWsSession] = useState<{ userId: string | null; token: string | null; ready: boolean }>({
    userId: null,
    token: null,
    ready: false,
  });
  const [mainView, setMainView] = useState<'chat' | 'history'>('chat');
  const userId = user?.uid;
  const wsToken = wsSession.userId === userId ? wsSession.token : null;
  const wsReady = wsSession.userId === userId && wsSession.ready;

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

    if (!userId || !token) {
      return () => {
        cancelled = true;
      };
    }

    void mintAgentChatWebSocketToken()
      .then((nextWsToken) => {
        if (!cancelled) {
          setWsSession({ userId, token: nextWsToken, ready: true });
        }
      })
      .catch((mintError) => {
        console.error('Failed to mint agent chat websocket token:', mintError);
        if (!cancelled) {
          setWsSession({ userId, token: null, ready: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const agent = useAgent({
    agent: 'OrchestratorAgent',
    basePath: 'api/agent/chat',
    host: apiBaseUrl.host,
    protocol: apiBaseUrl.protocol === 'https:' ? 'wss' : 'ws',
    enabled: wsReady && !!user && !!activeThread.id,
    query: agentQuery,
  });

  const browserTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }, []);
  const [routinesRefresh, setRoutinesRefresh] = useState(0);
  // After Undo (a Code Mode run or a routine run): refresh the desktop and
  // any open windows of apps whose data changed back.
  const handleRunUndone = useCallback((result: UndoRunResult) => {
    void loadDesktop();
    const open = new Set(openAppIds());
    for (const appId of result.changedApps) if (open.has(appId)) notifyAppDataChanged(appId);
  }, [loadDesktop]);

  // useAgentChat keys its chat (and its Suspense-based history fetch) on the
  // socket URL, which carries the one-time wsToken. Every reconnect mints a
  // new token, so the default behaviour re-suspended the whole window
  // ("Loading viewer…") and rebuilt the chat each time the socket dropped,
  // e.g. after the tab sat in the background. Instead: no suspending fetch,
  // the pane loads history itself (below), and a rebuilt chat is seeded with
  // the messages on screen when the socket dropped.
  const [seedMessages, setSeedMessages] = useState<AgentChatMessage[]>([]);
  const {
    messages,
    sendMessage,
    setMessages,
    clearHistory,
    status,
    error,
    stop,
    resumeStream,
    addToolApprovalResponse,
  } = useAgentChat({
    agent,
    headers: chatHeaders,
    body: { threadId: activeThread.id, timeZone: browserTimeZone },
    getInitialMessages: null,
    messages: seedMessages,
  });
  const latestMessages = useRef<AgentChatMessage[]>([]);
  useEffect(() => {
    latestMessages.current = messages as AgentChatMessage[];
  }, [messages]);

  // Stick-to-bottom: follow streaming replies, tool cards and approval cards
  // while the reader is at the bottom; stop following once they scroll up to
  // read, and jump back down when they send a message or switch threads.
  // (There was no auto-scroll at all: approval cards landed below the fold.)
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  const lastMessageRole = messages.at(-1)?.role;
  useEffect(() => {
    stickToBottom.current = true;
  }, [activeThread.id]);
  useLayoutEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (lastMessageRole === 'user') stickToBottom.current = true;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, status, lastMessageRole]);

  // Socket lifecycle for disconnect recovery. partysocket reconnects on its
  // own, but the chat transport has no close handling: without the stop()
  // below, a request that was mid-flight when the socket dropped spins
  // forever (its local stream never hears the close, and the server keeps
  // this connection out of stream broadcasts until a resume handshake
  // completes). The recovery logic itself is pure and tested in
  // utils/agentChatReconciliation.ts. The handlers close over the current
  // render's status/stop/setMessages, so they always see fresh values (the
  // effect re-attaches them when those change).
  const [socketOnline, setSocketOnline] = useState(false);
  const [sawDrop, setSawDrop] = useState(false);
  // Set by the close handler when the drop aborted an in-flight request,
  // consumed by the open handler to re-attach to the still-running server
  // stream. Since @cloudflare/ai-chat 0.2.x the abort KEEPS the request id
  // in the transport's active-request set, so the server's spontaneous
  // stream-resuming notification for it is skipped locally and never
  // ACKed — the replay must be driven explicitly via resumeStream()
  // (shouldResumeStreamAfterReconnect pins the exact rule).
  const pendingStreamResume = useRef(false);

  // The chat socket authenticates with a ONE-TIME wsToken (60s expiry), and
  // partysocket reconnects with the same URL — so after any drop (a deploy,
  // a network blip) every reconnect was rejected 401 and the pane sat on
  // "Reconnecting..." until a page reload. Mint a fresh token on each drop;
  // a changed query makes useAgent open a new socket with it. Throttled so a
  // server that is genuinely down is not asked for a token every second.
  const lastWsTokenRefresh = useRef(0);
  const refreshWsToken = useCallback(() => {
    if (!userId) return;
    const now = Date.now();
    if (now - lastWsTokenRefresh.current < 5_000) return;
    lastWsTokenRefresh.current = now;
    void mintAgentChatWebSocketToken()
      .then((token) => {
        setWsSession((current) => (current.userId === userId ? { ...current, token } : current));
      })
      .catch((mintError) => {
        console.error('Failed to refresh agent chat websocket token:', mintError);
      });
  }, [userId]);

  const reloadThreadHistory = useCallback(async (): Promise<AgentChatMessage[] | null> => {
    if (!authToken) return null;
    const url = new URL('/api/agent/chat/get-messages', apiBaseUrl.origin);
    url.searchParams.set('threadId', activeThread.id);
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!response.ok) return null;
      const text = await response.text();
      if (!text.trim()) return [];
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isAgentChatMessage);
    } catch (reloadError) {
      console.error('Failed to reload agent chat history:', reloadError);
      return null;
    }
  }, [activeThread.id, apiBaseUrl, authToken]);

  // Load this thread's saved messages (the pane is keyed by thread, so a
  // thread switch remounts it), and again for each new socket token, since
  // useAgentChat rebuilds its chat for every new socket URL. Merged so
  // nothing already on screen or still streaming is lost. setMessages is not
  // stable across renders, so it is read through a ref, not a dependency
  // (as a dependency it re-ran every render and hammered get-messages).
  const setMessagesRef = useRef(setMessages);
  useEffect(() => {
    setMessagesRef.current = setMessages;
  }, [setMessages]);
  useEffect(() => {
    if (!wsToken) return;
    let cancelled = false;
    void reloadThreadHistory().then((history) => {
      if (cancelled || !history) return;
      setMessagesRef.current((current) => mergeChatHistory(current, history));
      // Also seed the next rebuilt chat, in case this landed in the instance
      // that is about to be replaced for the new socket.
      setSeedMessages((current) => mergeChatHistory(current, history));
    });
    return () => {
      cancelled = true;
    };
  }, [reloadThreadHistory, wsToken]);

  useEffect(() => {
    const handleSocketOpen = () => {
      setSocketOnline(true);
      const hadDisconnect = sawDrop;
      setSawDrop(false);
      // If the drop aborted a mid-flight request, re-attach to the server
      // stream that kept running (the strip kept its cancel frame from
      // truncating it). The resume handshake ACKs the server's resuming
      // notification and replays the generation into the same message —
      // the 0.2.x transport no longer does this by itself for a request it
      // aborted. If the server already finished (or nothing is active) the
      // handshake resolves empty and the history reload below converges.
      const requestAbortedAtDrop = pendingStreamResume.current;
      pendingStreamResume.current = false;
      if (shouldResumeStreamAfterReconnect(hadDisconnect, requestAbortedAtDrop, status)) {
        void resumeStream();
      }
      if (!shouldReloadHistoryAfterReconnect(hadDisconnect, status)) return;
      // Converge with anything the server settled while we were offline
      // (e.g. a reply that finished after the drop, or messages sent from
      // another device) without duplicating what is already on screen.
      void reloadThreadHistory().then((history) => {
        if (!history) return;
        setMessages((current) => mergeChatHistory(current, history));
      });
    };

    const handleSocketClose = (event: Event) => {
      // Intentional closes (unmount, thread switch, socket recreation) must
      // not abort an in-flight reply — the server finishes and persists it
      // either way, and the pane (or its successor) reloads it later.
      const target = event.target as { shouldReconnect?: boolean } | null;
      if (target?.shouldReconnect === false) return;
      setSocketOnline(false);
      setSawDrop(true);
      setSeedMessages(latestMessages.current);
      refreshWsToken();
      // Abort the in-flight request so the pane is not stuck — and strip the
      // cancel frame the abort just queued: the socket is down, so party-
      // socket would flush that frame on reconnect, where it would cancel
      // the very generation the resume path replays (a truncated reply).
      // stop() self-guards on the chat's authoritative internal status, so
      // this is a no-op unless a request is actually in flight. A
      // user-pressed Stop on a live socket is unaffected — its cancel is
      // sent immediately and the queue is empty while the socket is open.
      // Remember whether a request was dropped mid-flight: 0.2.x keeps the
      // aborted request id in the transport's active set, so the server's
      // spontaneous resuming notification for it is never ACKed locally —
      // the open handler must drive the resume handshake itself.
      pendingStreamResume.current = resolveDisconnectAction(status) === 'stop-request';
      abortChatRequestLocally(stop, (agent as unknown as { _messageQueue?: unknown })._messageQueue);
    };

    agent.addEventListener('open', handleSocketOpen);
    agent.addEventListener('close', handleSocketClose);
    return () => {
      agent.removeEventListener('open', handleSocketOpen);
      agent.removeEventListener('close', handleSocketClose);
    };
  }, [agent, refreshWsToken, reloadThreadHistory, resumeStream, sawDrop, setMessages, status, stop]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const refreshToolTypes = [
      'tool-createFolder',
      'tool-moveItems',
      'tool-createTextNote',
      'tool-codemode',
      'tool-callAppApi',
      'tool-previewAppFromPrompt',
      'tool-installAppPreview',
      'tool-buildAppFromPrompt',
      'tool-createApp',
      'tool-updateApp',
      'tool-editApp',
      'tool-deleteApp',
      'tool-saveRoutine',
      'tool-deleteRoutine',
    ];
    for (const message of messages) {
      for (const part of (message.parts as MessagePart[] | undefined) ?? []) {
        // A routine ran (posted by the agent): refresh its routines list and,
        // for a fresh run, the desktop and open windows of apps it changed.
        if (part.type === 'data-routine-run' && part.id && !refreshedToolCalls.current.has(part.id)) {
          refreshedToolCalls.current.add(part.id);
          setRoutinesRefresh((n) => n + 1);
          const run = part.data as RoutineRunData | undefined;
          if (run && Date.now() - run.ranAt < 120_000) {
            void loadDesktop();
            const open = new Set(openAppIds());
            for (const appId of run.changedApps ?? []) if (open.has(appId)) notifyAppDataChanged(appId);
          }
          continue;
        }
        if (
          refreshToolTypes.includes(part.type) &&
          part.state === 'output-available' &&
          part.toolCallId &&
          !refreshedToolCalls.current.has(part.toolCallId)
        ) {
          refreshedToolCalls.current.add(part.toolCallId);
          void loadDesktop();
          syncOpenAppWindows(part);
          if (part.type === 'tool-saveRoutine' || part.type === 'tool-deleteRoutine') setRoutinesRefresh((n) => n + 1);
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

  const appNameOf = (appId: string) =>
    items.find((item) => item.type === 'app' && item.appManifest?.appId === appId)?.appManifest?.name;

  const submitPrompt = (prompt: string) => {
    void sendMessage({
      text: prompt,
    });
  };

  const handleSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;

    if (isBusy) return;
    void sendMessage({ text: trimmed });
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  /** Open an app window next to the chat, so changes are visible as they land. */
  const openAppBesideChat = (item: DesktopItem) => {
    const chat = useWindowStore.getState().windows.find((w) => w.id === 'agent-chat');
    const width = item.appManifest?.windowConfig?.defaultWidth || 420;
    const height = item.appManifest?.windowConfig?.defaultHeight || 480;
    const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
    const rightOfChat = chat ? chat.position.x + chat.size.width + 12 : viewportWidth - width - 24;
    const x = rightOfChat + width <= viewportWidth ? rightOfChat : Math.max(12, viewportWidth - width - 24);
    openWindow({
      id: `app-${item.id}`,
      title: item.appManifest?.name || item.name,
      position: { x, y: chat ? chat.position.y : 72 },
      size: { width, height },
      minimized: false,
      maximized: false,
      contentType: 'app',
      contentId: item.id,
    });
  };

  const appItemFor = (appId: string) =>
    items.find((item) => item.type === 'app' && !item.isTrashed && item.appManifest?.appId === appId);

  const startDemo = async () => {
    if (demoStatus === 'loading' || isBusy) return;
    setDemoStatus('loading');
    try {
      const { appItemId } = await ensureAgentDemo(items, async () => {
        await loadDesktop();
        return useDesktopStore.getState().items;
      });
      const appItem = appItemId ? useDesktopStore.getState().items.find((item) => item.id === appItemId) : undefined;
      if (appItem) openAppBesideChat(appItem);
      setDemoStatus('idle');
      submitPrompt(DEMO_PROMPT);
    } catch (error) {
      console.error('Demo setup failed:', error);
      setDemoStatus('error');
    }
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
      return <ChatMarkdown key={`text-${index}`} text={text} className={styles.messageText} />;
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

    if (part.type === 'tool-readTextFile') {
      if (part.state === 'output-error') {
        return (
          <div key={`read-text-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Read file failed</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }

      if (part.state !== 'output-available') {
        const input = (part.input as { name?: string } | undefined) ?? {};
        return (
          <div key={`read-text-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Reading file</div>
            <div className={styles.toolBody}>{input.name ? `Opening "${input.name}"...` : 'Opening file...'}</div>
          </div>
        );
      }

      const output = part.output as ReadTextFileOutput;
      if (!output.found) {
        return (
          <div key={`read-text-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>File not found</div>
            <div className={styles.toolBody}>{output.message ?? 'No matching text file.'}</div>
            {output.candidates && output.candidates.length > 0 ? (
              <div className={styles.resultList}>
                {output.candidates.map((item) => (
                  <div key={item.id} className={styles.resultRow}>
                    <div className={styles.resultHeading}>
                      {renderItemButton({ id: item.id, name: item.name, type: 'text' })}
                    </div>
                    <div className={styles.resultMeta}>In {item.location}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      }

      return (
        <div key={`read-text-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Read file</div>
          <div className={styles.toolBody}>
            {renderItemButton({ id: output.id ?? '', name: output.name ?? 'file', type: 'text' })} from {output.location}
            {output.truncated ? ' (long file — read a truncated copy)' : ''}.
          </div>
        </div>
      );
    }

    if (part.type === 'tool-createTextNote') {
      const input = (part.input as { name?: string; content?: string } | undefined) ?? {};

      if (part.state === 'approval-requested') {
        const preview = (input.content ?? '').slice(0, 240);
        return (
          <div key={`create-note-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Approval required</div>
            <div className={styles.toolBody}>
              Create note: <strong>{input.name || ''}</strong>
              {preview ? (
                <div className={styles.resultSummary}>
                  {preview}{(input.content?.length ?? 0) > 240 ? '…' : ''}
                </div>
              ) : null}
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
          <div key={`create-note-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Create note cancelled</div>
          </div>
        );
      }

      if (part.state === 'output-error') {
        return (
          <div key={`create-note-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Create note failed</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }

      if (part.state === 'output-available') {
        const output = part.output as CreateTextNoteOutput;
        return (
          <div key={`create-note-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Note created</div>
            <div className={styles.toolBody}>
              {renderItemButton(output.note)} saved to {output.location}.
            </div>
          </div>
        );
      }

      return null;
    }

    if (part.type === 'tool-createFolder' || part.type === 'tool-moveItems') {
      const input = (part.input as { folderName?: string; itemIds?: unknown } | undefined) ?? {};
      const label = part.type === 'tool-createFolder' ? 'Create folder' : 'Move items';
      const movingCount = Array.isArray(input.itemIds) ? input.itemIds.length : 0;
      const movingNames = Array.isArray(input.itemIds)
        ? input.itemIds.map((id) => items.find((item) => item.id === id)?.name).filter(Boolean).slice(0, 4).join(', ')
        : '';

      if (part.state === 'approval-requested') {
        return (
          <div key={`folder-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Approval required</div>
            <div className={styles.toolBody}>
              {label}: <strong>{input.folderName || ''}</strong>
              {part.type === 'tool-createFolder' ? (
                <div>
                  {movingCount === 0
                    ? 'An empty folder on your desktop.'
                    : `Moves ${movingCount} item${movingCount === 1 ? '' : 's'} into it${movingNames ? `: ${movingNames}${movingCount > 4 ? '…' : ''}` : ''}.`}
                </div>
              ) : null}
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
      || part.type === 'tool-editApp'
      || part.type === 'tool-deleteApp'
    ) {
      const toolInput = (part.input as {
        prompt?: string;
        name?: string;
        appId?: string;
        previewId?: string;
        edits?: Array<{ file?: string; find?: string; replace?: string }>;
        permissions?: AppPermissions;
        rationale?: string;
      } | undefined) ?? {};
      // An update that declares new access: say so on the approval card.
      // Nothing is granted here — the app asks when it next opens.
      const requestedAccess = (part.type === 'tool-updateApp' || part.type === 'tool-editApp')
        ? summarizePermissions(toolInput.permissions)
        : [];

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
            : part.type === 'tool-editApp'
              ? 'Edit app'
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
          : part.type === 'tool-editApp'
          ? (
            <>
              Eternal wants to edit <strong>{targetName}</strong>:
              {(toolInput.edits ?? []).map((edit, editIndex) => (
                <details key={editIndex} className={styles.codeDetails} open={editIndex === 0}>
                  <summary>{edit.file ?? 'file'}</summary>
                  <pre className={styles.codeBlock}>{`- ${edit.find ?? ''}\n+ ${edit.replace ?? ''}`}</pre>
                </details>
              ))}
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
            <div className={styles.toolBody}>
              {body}
              {requestedAccess.length > 0 ? (
                <div className={styles.resultSummary}>
                  Asks for access: {requestedAccess.join('; ')}.{toolInput.rationale ? ` ${toolInput.rationale}` : ''} The app will ask you to allow it the next time it opens.
                </div>
              ) : null}
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

        if (part.type === 'tool-updateApp' || part.type === 'tool-editApp') {
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

      if (part.type === 'tool-updateApp' || part.type === 'tool-editApp') {
        const output = part.output as AppUpdateOutput;
        return (
          <div key={`app-tool-updated-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{part.type === 'tool-editApp' ? 'App edited' : 'App updated'}</div>
            <div className={styles.toolBody}>
              Now on version {output.version}. Open windows of this app reload automatically.
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

    // Code Mode — the agent runs one sandboxed JS function (Dynamic Worker,
    // no network) that orchestrates several tools at once. Before asking, a
    // practice run lists what it would change (data-codemode-preview); a real
    // run streams its steps (data-codemode-steps) and offers Undo
    // (data-codemode-undo). All keyed by the tool call id.
    if (part.type === 'tool-codemode') {
      const input = part.input as { code?: string } | undefined;
      const code = typeof input?.code === 'string' ? input.code : '';
      const preview = dataPartFor<CodePreviewData>(messageParts, 'data-codemode-preview', part.toolCallId);
      const stepsData = dataPartFor<RunStepsData>(messageParts, 'data-codemode-steps', part.toolCallId);
      const undoData = dataPartFor<UndoData>(messageParts, 'data-codemode-undo', part.toolCallId);
      const codeDetails = code ? (
        <details className={styles.codeDetails}>
          <summary>Code ({code.split('\n').length} lines)</summary>
          <pre className={styles.codeBlock} tabIndex={0}>{code}</pre>
        </details>
      ) : null;

      if (part.state === 'approval-requested') {
        const changes = preview?.ok ? preview.actions.length : 0;
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>{preview ? 'Make these changes?' : 'Run code?'}</div>
            {preview ? (
              <ChangePreview preview={preview} />
            ) : (
              <div className={styles.toolBody}>
                Eternal wants to run this code in a sandbox. It can make changes through the tools it calls (desktop items or app data). Review the full script before running it.
              </div>
            )}
            {/* Consent must cover the whole script: it stays complete here. */}
            {preview?.ok ? codeDetails : (code ? <pre className={styles.codeBlock} tabIndex={0}>{code}</pre> : null)}
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
                {changes > 0 ? `Approve ${changes === 1 ? 'change' : `${changes} changes`}` : 'Run'}
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
                Cancel
              </button>
            </div>
          </div>
        );
      }

      if (part.state === 'output-denied') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Cancelled — nothing was changed</div>
          </div>
        );
      }

      if (part.state === 'output-error') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Code failed</div>
            <RunSteps data={stepsData} running={false} />
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
            <UndoControl threadId={activeThread.id} undo={undoData} onUndone={handleRunUndone} />
            {codeDetails}
          </div>
        );
      }

      if (part.state !== 'output-available') {
        return (
          <div key={`codemode-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Working…</div>
            <RunSteps data={stepsData} running />
            {codeDetails}
          </div>
        );
      }

      const output = part.output as { result?: unknown; logs?: string[]; changedApps?: unknown } | undefined;
      const resultText = output?.result === undefined ? '' : JSON.stringify(output.result, null, 2);
      const openIds = new Set(openAppWindowIds.split('|'));
      const closedChangedApps = (Array.isArray(output?.changedApps) ? output.changedApps : [])
        .map((appId) => (typeof appId === 'string' ? appItemFor(appId) : undefined))
        .filter((item): item is DesktopItem => Boolean(item) && !openIds.has(`app-${item?.id}`));
      return (
        <div key={`codemode-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>{stepsData?.failed ? 'Done, with errors' : 'Done'}</div>
          <RunSteps data={stepsData} running={false} />
          <UndoControl threadId={activeThread.id} undo={undoData} onUndone={handleRunUndone} />
          {closedChangedApps.length > 0 ? (
            <div className={styles.openAppsRow}>
              {closedChangedApps.map((item) => (
                <button key={item.id} type="button" className={styles.openAppButton} onClick={() => openAppBesideChat(item)}>
                  Open {item.appManifest?.name || item.name} ↗
                </button>
              ))}
            </div>
          ) : null}
          {resultText ? (
            <details className={styles.codeDetails}>
              <summary>Result</summary>
              <pre className={styles.codeBlock}>{resultText.length > 1600 ? `${resultText.slice(0, 1600)}\n…` : resultText}</pre>
            </details>
          ) : null}
          {output?.logs && output.logs.length > 0 ? (
            <details className={styles.codeDetails}>
              <summary>Console ({output.logs.length})</summary>
              <pre className={styles.codeBlock}>{output.logs.join('\n')}</pre>
            </details>
          ) : null}
          {codeDetails}
        </div>
      );
    }

    // A saved routine's run, posted into the thread by the agent.
    if (part.type === 'data-routine-run') {
      const data = part.data as RoutineRunData | undefined;
      if (!data) return null;
      return <RoutineRunCard key={`routine-run-${index}`} data={data} threadId={activeThread.id} onUndone={handleRunUndone} />;
    }

    // Routines: save (approval shows the schedule, a preview and the code),
    // list, delete.
    if (part.type === 'tool-saveRoutine') {
      const input = part.input as { name?: string; code?: string; schedule?: { every?: string; at?: string; hours?: number } } | undefined;
      const schedule = input?.schedule?.every === 'hours'
        ? `every ${input.schedule.hours === 1 ? 'hour' : `${input.schedule.hours ?? '?'} hours`}`
        : `every day at ${input?.schedule?.at ?? '08:00'}`;
      const preview = dataPartFor<CodePreviewData>(messageParts, 'data-codemode-preview', part.toolCallId);
      if (part.state === 'approval-requested') {
        return (
          <div key={`routine-save-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Save routine “{input?.name ?? 'Untitled'}”?</div>
            <div className={styles.toolBody}>
              Runs {schedule}, automatically and without asking each time. You can delete it any time.
            </div>
            {preview ? (
              <>
                <div className={styles.toolBody}>If it ran right now:</div>
                <ChangePreview preview={preview} />
              </>
            ) : null}
            {input?.code ? <pre className={styles.codeBlock} tabIndex={0}>{input.code}</pre> : null}
            <div className={styles.approvalRow}>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  if (part.approval?.id) void addToolApprovalResponse({ id: part.approval.id, approved: true });
                }}
              >
                Save routine
              </button>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  if (part.approval?.id) void addToolApprovalResponse({ id: part.approval.id, approved: false });
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      }
      if (part.state === 'output-denied') {
        return (
          <div key={`routine-save-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Routine not saved</div>
          </div>
        );
      }
      if (part.state === 'output-error') {
        return (
          <div key={`routine-save-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Could not save the routine</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }
      if (part.state !== 'output-available') {
        return (
          <div key={`routine-save-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Saving routine…</div>
          </div>
        );
      }
      const output = part.output as { routine?: { name: string; schedule: string; nextRunAt: number | null }; ranNow?: { status: string; summary: string } } | undefined;
      return (
        <div key={`routine-save-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Routine saved</div>
          <div className={styles.toolBody}>
            “{output?.routine?.name}” runs {output?.routine?.schedule}
            {output?.routine?.nextRunAt ? `; next run ${new Date(output.routine.nextRunAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}.
          </div>
        </div>
      );
    }

    if (part.type === 'tool-listRoutines') {
      if (part.state !== 'output-available') {
        return (
          <div key={`routine-list-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Routines</div>
            <div className={styles.toolBody}>Loading…</div>
          </div>
        );
      }
      const routines = (part.output as { routines?: Array<{ id: string; name: string; schedule: string }> } | undefined)?.routines ?? [];
      return (
        <div key={`routine-list-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>Routines</div>
          <div className={styles.toolBody}>
            {routines.length === 0 ? 'No routines in this thread.' : routines.map((r) => `${r.name} — ${r.schedule}`).join('\n')}
          </div>
        </div>
      );
    }

    if (part.type === 'tool-deleteRoutine') {
      if (part.state === 'approval-requested') {
        return (
          <div key={`routine-delete-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Delete this routine?</div>
            <div className={styles.toolBody}>It will stop running.</div>
            <div className={styles.approvalRow}>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  if (part.approval?.id) void addToolApprovalResponse({ id: part.approval.id, approved: true });
                }}
              >
                Delete
              </button>
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  if (part.approval?.id) void addToolApprovalResponse({ id: part.approval.id, approved: false });
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        );
      }
      if (part.state !== 'output-available') return null;
      const deleted = (part.output as { deleted?: boolean } | undefined)?.deleted;
      return (
        <div key={`routine-delete-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>{deleted ? 'Routine deleted' : 'Routine not found'}</div>
        </div>
      );
    }

    // Full-stack app data — calls into an app's own server.js backend.
    if (part.type === 'tool-callAppApi' || part.type === 'tool-readAppApi') {
      const input = part.input as { appId?: string; method?: string; path?: string; body?: unknown } | undefined;
      const method = part.type === 'tool-readAppApi' ? 'GET' : (input?.method ?? 'GET');
      const target = `${method} ${input?.path ?? ''}`.trim();

      if (part.state === 'approval-requested') {
        const appName = items.find((item) => item.type === 'app' && item.appManifest?.appId === input?.appId)?.appManifest?.name;
        return (
          <div key={`app-api-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>Make this change?</div>
            <ChangePreview preview={{ ok: true, actions: [describeAppChange(method, input?.path ?? '/', input?.body, appName)] }} />
            {/* The exact request stays visible, not just the summary. */}
            <pre className={styles.codeBlock}>{target}{input?.body !== undefined ? `\n${JSON.stringify(input.body, null, 2)}` : ''}</pre>
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
          <div key={`app-api-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App change cancelled</div>
          </div>
        );
      }
      if (part.state === 'output-error') {
        return (
          <div key={`app-api-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App request failed</div>
            <div className={styles.errorText}>{String(part.errorText ?? 'Unknown error')}</div>
          </div>
        );
      }
      if (part.state !== 'output-available') {
        return (
          <div key={`app-api-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App data</div>
            <div className={styles.toolBody}>{target}…</div>
          </div>
        );
      }
      const output = part.output as { status?: number; ok?: boolean } | undefined;
      return (
        <div key={`app-api-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>App data</div>
          <div className={output?.ok === false ? styles.errorText : styles.toolBody}>
            {target} → {output?.status ?? '?'}
          </div>
        </div>
      );
    }

    if (part.type === 'tool-getAppBackendLogs') {
      if (part.state !== 'output-available') {
        return (
          <div key={`app-logs-${index}`} className={styles.toolCard}>
            <div className={styles.toolTitle}>App backend logs</div>
            <div className={styles.toolBody}>Reading logs…</div>
          </div>
        );
      }
      const output = part.output as { logs?: Array<{ level: string; message: string }> } | undefined;
      const logs = output?.logs ?? [];
      return (
        <div key={`app-logs-${index}`} className={styles.toolCard}>
          <div className={styles.toolTitle}>App backend logs</div>
          {logs.length === 0 ? (
            <div className={styles.toolBody}>No recent log output.</div>
          ) : (
            <pre className={styles.codeBlock}>{logs.slice(-12).map((entry) => `[${entry.level}] ${entry.message}`).join('\n')}</pre>
          )}
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
    : !socketOnline
      ? sawDrop ? 'Reconnecting...' : 'Connecting...'
      : hasPendingApproval
      ? 'Approval needed'
      : latestPendingToolPart?.type === 'tool-buildAppFromPrompt'
        || latestPendingToolPart?.type === 'tool-previewAppFromPrompt'
        || latestPendingToolPart?.type === 'tool-installAppPreview'
        || latestPendingToolPart?.type === 'tool-createApp'
        || latestPendingToolPart?.type === 'tool-updateApp'
        || latestPendingToolPart?.type === 'tool-editApp'
          ? 'Building your app...'
          : latestPendingToolPart?.type === 'tool-codemode'
            ? 'Running code...'
          : latestPendingToolPart?.type === 'tool-deleteApp'
            ? 'Removing app...'
            : status === 'submitted' || status === 'streaming'
              ? 'Working through your desktop...'
              : status === 'error'
                ? 'Error'
                : 'Ready';
  const currentRequestLabel = activeThread.title.length > 42
    ? `${activeThread.title.slice(0, 39)}...`
    : activeThread.title;

  const isBusy = status === 'submitted' || status === 'streaming';

  return (
    <div className={styles.chatWindow}>
      <header className={styles.toolbar}>
        <div className={styles.toolbarGroup}>
          <button className={styles.toolbarButton} type="button" onClick={() => void onCreateThread()}>
            <span className={styles.toolbarButtonGlyph} aria-hidden="true">＋</span>
            New Thread
          </button>
          <button className={styles.toolbarButton} type="button" onClick={() => void clearHistory()}>
            <span className={styles.toolbarButtonGlyph} aria-hidden="true">⌫</span>
            Clear
          </button>
        </div>

        <div className={styles.segmentedControl} data-theme-immune role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'chat'}
            className={`${styles.segment} ${mainView === 'chat' ? styles.segmentActive : ''}`}
            onClick={() => setMainView('chat')}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'history'}
            className={`${styles.segment} ${mainView === 'history' ? styles.segmentActive : ''}`}
            onClick={() => setMainView('history')}
          >
            History
          </button>
        </div>

        <div className={`${styles.toolbarGroup} ${styles.toolbarGroupEnd}`}>
          <span className={`${styles.statusDot} ${wsReady && socketOnline ? styles.statusDotReady : ''}`} aria-hidden="true" />
          <span className={styles.toolbarStatus}>{statusText}</span>
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar} data-theme-immune>
          <div className={styles.sidebarSection}>
            <div className={styles.sidebarHeading}>Workspace</div>
            <button className={styles.sidebarNavItem} type="button" onClick={() => void onCreateThread()}>
              <span className={styles.sidebarNavIcon} aria-hidden="true">✎</span>
              New thread
            </button>
            <button className={styles.sidebarNavItem} type="button" onClick={() => setMainView('history')}>
              <span className={styles.sidebarNavIcon} aria-hidden="true">≡</span>
              History
            </button>
          </div>

          <div className={`${styles.sidebarSection} ${styles.sidebarSectionGrow}`}>
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
                    onClick={() => {
                      onSelectThread(thread.id);
                      setMainView('chat');
                    }}
                  >
                    <span className={styles.threadItemTitle}>{thread.title}</span>
                    <span className={styles.threadItemMeta}>{formatThreadTimestamp(thread.updatedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        {mainView === 'history' ? (
          <section className={styles.mainPane}>
            <div className={styles.mainHeader}>
              <div className={styles.mainHeaderText}>
                <div className={styles.mainTitle}>History</div>
                <div className={styles.subtitle}>All conversations with Eternal</div>
              </div>
            </div>
            <div className={styles.historyList}>
              {threadList.map((thread) => (
                <div
                  key={thread.id}
                  className={`${styles.historyRow} ${thread.id === activeThread.id ? styles.historyRowActive : ''}`}
                >
                  <button
                    type="button"
                    className={styles.historyRowMain}
                    onClick={() => {
                      onSelectThread(thread.id);
                      setMainView('chat');
                    }}
                  >
                    <span className={styles.threadItemTitle}>{thread.title}</span>
                    <span className={styles.threadItemMeta}>Updated {formatThreadTimestamp(thread.updatedAt)}</span>
                  </button>
                  {thread.id === activeThread.id ? (
                    <div className={styles.historyRowActions}>
                      <button className={styles.ghostButton} type="button" onClick={() => void onRenameThread()}>
                        Rename
                      </button>
                      <button className={styles.ghostButton} type="button" onClick={() => void onDeleteThread()}>
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : (
          <section className={styles.mainPane}>
            <div className={styles.mainHeader}>
              <div className={styles.mainHeaderText}>
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
                    Search your desktop, change your apps’ data, build new apps, or set up routines that run on their own. You’ll see every change before it happens, and can undo it after.
                  </div>
                  <button
                    type="button"
                    className={styles.demoButton}
                    onClick={() => void startDemo()}
                    disabled={demoStatus === 'loading' || isBusy}
                  >
                    <span className={styles.demoTitle}>
                      {demoStatus === 'loading' ? 'Setting up the demo…' : 'Try the 30-second demo'}
                    </span>
                    <span className={styles.demoCopy}>
                      {demoStatus === 'error'
                        ? 'Setup didn’t finish. Click to try again.'
                        : `Adds a sample “${DEMO_APP_NAME}” app and a note, then asks for one change across both. Preview it, approve once, watch the app update, then undo.`}
                    </span>
                  </button>
                  <div className={styles.emptyPrompts}>
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
              </div>
            ) : (
              <div className={styles.messages} ref={messagesRef} onScroll={handleMessagesScroll} data-theme-immune>
                {messages.map((message) => {
                  const parts = (message.parts as MessagePart[] | undefined) ?? [];

                  if (message.role === 'user') {
                    const text = getUserMessageText(message);
                    if (!text) return null;

                    return (
                      <div key={message.id} className={styles.userRow}>
                        <div className={styles.userBubble}>{text}</div>
                      </div>
                    );
                  }

                  // Lookups (listing apps, reading data, reading files) fold
                  // into one quiet activity line; changes, approvals and the
                  // answer itself stay as full cards.
                  const renderedParts: ReactNode[] = [];
                  let activity: ActivityItem[] = [];
                  const flushActivity = (key: string) => {
                    if (!activity.length) return;
                    renderedParts.push(<ActivityGroup key={key} items={activity} />);
                    activity = [];
                  };
                  parts.forEach((part, index) => {
                    // A Code Mode run that only read things is a lookup too:
                    // its steps join the activity line instead of a card.
                    if (part.type === 'tool-codemode') {
                      const stepsData = dataPartFor<RunStepsData>(parts, 'data-codemode-steps', part.toolCallId);
                      const preview = dataPartFor<CodePreviewData>(parts, 'data-codemode-preview', part.toolCallId);
                      const lookupSteps = readOnlyRunSteps(part.state, stepsData, preview);
                      if (lookupSteps) {
                        const details = renderAssistantPart(part, index, parts);
                        lookupSteps.forEach((step, stepIndex) => {
                          activity.push({
                            key: `${part.toolCallId ?? `p${index}`}-${stepIndex}`,
                            label: step.label,
                            detail: step.detail,
                            running: step.status === 'running',
                            details: stepIndex === lookupSteps.length - 1 ? details : null,
                          });
                        });
                        if (!lookupSteps.length) {
                          activity.push({ key: part.toolCallId ?? `p${index}`, label: 'Looking things up', running: true, details });
                        }
                        return;
                      }
                    }
                    if (part.type.startsWith('tool-') && isQuietToolPart(part)) {
                      const { label, detail } = activityLabel(part, appNameOf);
                      activity.push({
                        key: part.toolCallId ?? `p${index}`,
                        label,
                        detail,
                        running: part.state !== 'output-available',
                        failed: (part.output as { ok?: unknown } | undefined)?.ok === false,
                        details: renderAssistantPart(part, index, parts),
                      });
                      return;
                    }
                    const node = renderAssistantPart(part, index, parts);
                    if (node === null) return; // data parts, step markers: invisible, keep the group going
                    flushActivity(`activity-${index}`);
                    renderedParts.push(node);
                  });
                  flushActivity('activity-end');

                  if (renderedParts.length === 0) {
                    return null;
                  }

                  return (
                    <div key={message.id} className={styles.assistantMessage}>
                      <div className={styles.messageParts}>{renderedParts}</div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className={styles.composerArea}>
              {error ? <div className={styles.composerError}>{error.message}</div> : null}
              <form className={styles.composer} data-theme-immune onSubmit={handleSend}>
                <textarea
                  ref={inputRef}
                  className={styles.composerInput}
                  rows={1}
                  value={draft}
                  aria-label="Message Eternal"
                  onChange={(event) => {
                    setDraft(event.target.value);
                    // Grow with the text, up to about six lines.
                    const el = event.target;
                    el.style.height = 'auto';
                    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
                  }}
                  onKeyDown={(event) => {
                    // Enter sends; Shift+Enter adds a line; never mid-IME-composition.
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={wsReady ? 'Ask Eternal anything…' : 'Connecting to Eternal…'}
                />
                <div className={styles.composerRow}>
                  <div className={styles.composerHint}>
                    {isBusy ? 'Working…' : status === 'error' ? 'Something went wrong — try again' : 'Enter to send · Shift+Enter for a new line'}
                  </div>
                  {isBusy ? (
                    <button
                      className={styles.stopButton}
                      type="button"
                      onClick={() => void stop()}
                    >
                      Stop
                    </button>
                  ) : null}
                  <button
                    className={styles.sendButton}
                    type="submit"
                    disabled={!wsReady || isBusy || !draft.trim()}
                  >
                    Send
                  </button>
                </div>
              </form>
            </div>
          </section>
        )}

        <aside className={styles.inspector} data-theme-immune>
          <div className={styles.inspectorSection}>
            <div className={styles.sidebarHeading}>Routines</div>
            <RoutinesPanel
              threadId={activeThread.id}
              refreshKey={routinesRefresh}
              onRan={(changedApps) => {
                void loadDesktop();
                const open = new Set(openAppIds());
                for (const appId of changedApps) if (open.has(appId)) notifyAppDataChanged(appId);
              }}
            />
          </div>

          <div className={styles.inspectorSection}>
            <div className={styles.sidebarHeading}>Thread</div>
            <div className={styles.statusCard}>
              <div className={styles.statusCardTitle}>{activeThread.title}</div>
              <div className={styles.statusCardMeta}>
                Updated {formatThreadTimestamp(activeThread.updatedAt)}
              </div>
              <div className={styles.threadActionRow}>
                <button className={styles.ghostButton} type="button" onClick={() => void onRenameThread()}>
                  Rename
                </button>
                <button className={styles.ghostButton} type="button" onClick={() => void onDeleteThread()}>
                  Delete
                </button>
              </div>
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
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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
    setRenameDraft(activeThread?.title ?? 'New Thread');
    setShowRenameDialog(true);
  }, [activeThreadId, threads, user]);

  const commitRenameThread = useCallback(async () => {
    if (!user || !activeThreadId) return;

    const nextTitle = renameDraft.trim();
    if (!nextTitle) {
      setThreadsError('Enter a name for this thread.');
      return;
    }

    try {
      const updated = await renameAgentThread(activeThreadId, nextTitle);
      const nextThreads = threads
        .map((thread) => (thread.id === updated.id ? updated : thread))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setThreads(nextThreads);
      setThreadsError(null);
      setShowRenameDialog(false);
    } catch (renameError) {
      console.error('Failed to rename agent thread:', renameError);
      setThreadsError(renameError instanceof Error ? renameError.message : 'Failed to rename thread');
    }
  }, [activeThreadId, renameDraft, threads, user]);

  const handleDeleteThread = useCallback(async () => {
    if (!user || !activeThreadId) return;

    setShowDeleteConfirm(true);
  }, [activeThreadId, user]);

  const confirmDeleteThread = useCallback(async () => {
    if (!user || !activeThreadId) return;

    try {
      await deleteAgentThread(activeThreadId);
      const nextThreads = threads.filter((thread) => thread.id !== activeThreadId);
      setThreads(nextThreads);
      setThreadsError(null);
      setShowDeleteConfirm(false);

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
    <>
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

      {showRenameDialog && (
        <div
          className={styles.threadDialogOverlay}
          onClick={(event) => event.target === event.currentTarget && setShowRenameDialog(false)}
        >
          <form
            className={styles.threadDialog}
            onSubmit={(event) => {
              event.preventDefault();
              void commitRenameThread();
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-thread-title"
          >
            <h3 id="rename-thread-title" className={styles.threadDialogTitle}>Rename thread</h3>
            <label className={styles.threadDialogLabel} htmlFor="rename-thread-input">Thread name</label>
            <input
              id="rename-thread-input"
              className={styles.threadDialogInput}
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              maxLength={120}
              autoFocus
            />
            <div className={styles.threadDialogActions}>
              <button type="button" className={styles.ghostButton} onClick={() => setShowRenameDialog(false)}>
                Cancel
              </button>
              <button type="submit" className={styles.primaryButton}>
                Rename
              </button>
            </div>
          </form>
        </div>
      )}

      {showDeleteConfirm && (
        <AlertDialog
          type="confirm"
          title="Delete this thread?"
          message={`“${activeThread.title}” and its messages will be removed permanently.`}
          onClose={() => setShowDeleteConfirm(false)}
          buttons={[
            { label: 'Keep Thread', onClick: () => setShowDeleteConfirm(false) },
            { label: 'Delete', onClick: confirmDeleteThread, primary: true },
          ]}
        />
      )}
    </>
  );
}
