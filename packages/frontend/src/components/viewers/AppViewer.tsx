import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import { useWindowStore } from '../../stores/windowStore';
import {
  getAppPermissions,
  mintAppCapability,
  updateAppPermissions,
  type AppPermissionResponse,
} from '../../services/api';
import { AppPermissionDialog } from '../apps/AppPermissionDialog';
import { getPermissionEntries, hasAllPermissionValues } from '../apps/appPermissionScopes';
import type { AppPermissions } from '../../types';
import { activeAppListeners, notifyAppSkinChanged, type ActiveAppListener } from '../../utils/appWindowBus';
import { AppSkinsPanel, type DescribedParts } from '../apps/AppSkinsPanel';
import skinPanelStyles from '../apps/AppSkinsPanel.module.css';
import { getActiveAppSkin, installAppSkin } from '../../services/appSkins';
import { readSkinFile } from '../../utils/appSkins';
import { readAppTheme } from '../../utils/appTheme';
import { useAppearanceStore } from '../../stores/appearanceStore';

interface AppViewerProps {
  appId?: string;
  previewId?: string;
  windowId?: string;
  launchFileId?: string;
}

function topicMatches(topic: unknown, patterns: string[] | undefined): boolean {
  if (typeof topic !== 'string' || topic.length === 0 || topic.length > 120) return false;
  return (patterns ?? []).some((pattern) => (
    pattern === '*' || pattern === topic || (pattern.endsWith('*') && topic.startsWith(pattern.slice(0, -1)))
  ));
}

export function AppViewer({ appId, previewId, windowId, launchFileId }: AppViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const capabilityRef = useRef<string | null>(null);
  const iframeLoadedRef = useRef(false);
  const [permissionPrompt, setPermissionPrompt] = useState<AppPermissionResponse | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [grantedPermissions, setGrantedPermissions] = useState<AppPermissions>({});
  const [reloadKey, setReloadKey] = useState(0);

  const sendCapability = useCallback(() => {
    if (!iframeLoadedRef.current || !capabilityRef.current) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: 'eternal:capability',
      token: capabilityRef.current,
    }, '*');
  }, []);

  // The desktop theme, handed to the app as --eternal-* CSS variables. Sent
  // when the app asks (runtime start), on load, and whenever the look changes.
  const sendTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage({ type: 'eternal:theme', theme: readAppTheme(frame) }, '*');
  }, []);

  useEffect(() => {
    let frame = 0;
    const unsubscribe = useAppearanceStore.subscribe(() => {
      // Theme CSS is applied to the DOM after the store changes; read it a
      // couple of frames later.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(sendTheme); });
    });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [sendTheme]);

  // App skins: the active skin is sent when the app asks (runtime start)
  // and whenever it changes; the Skins panel and .eskin drops live here.
  const canSkin = Boolean(appId && !previewId);
  const [skinsOpen, setSkinsOpen] = useState(false);
  const [skinDrag, setSkinDrag] = useState(false);
  const [skinToast, setSkinToast] = useState<string | null>(null);
  const describeWaiters = useRef(new Map<string, (parts: DescribedParts | null) => void>());
  const appName = useWindowStore((state) => state.windows.find((w) => w.id === windowId)?.title) ?? 'App';

  const sendSkin = useCallback(async () => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    if (!canSkin || !appId) {
      frame.contentWindow.postMessage({ type: 'eternal:skin', skin: null }, '*');
      return;
    }
    try {
      const { skin } = await getActiveAppSkin(appId);
      iframeRef.current?.contentWindow?.postMessage({ type: 'eternal:skin', skin }, '*');
    } catch {
      // Visitors and offline: the app keeps its own look.
    }
  }, [appId, canSkin]);

  const describeParts = useCallback((): Promise<DescribedParts | null> => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return Promise.resolve(null);
    const requestId = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        describeWaiters.current.delete(requestId);
        resolve(null);
      }, 3000);
      describeWaiters.current.set(requestId, (parts) => {
        clearTimeout(timer);
        resolve(parts);
      });
      frame.contentWindow!.postMessage({ type: 'eternal:skin:describe', requestId }, '*');
    });
  }, []);

  useEffect(() => {
    if (!skinToast) return;
    const timer = setTimeout(() => setSkinToast(null), 4000);
    return () => clearTimeout(timer);
  }, [skinToast]);

  // Show a drop target over the (event-swallowing) iframe while files are dragged.
  useEffect(() => {
    if (!canSkin) return;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onEnter = (event: DragEvent) => { if (hasFiles(event)) setSkinDrag(true); };
    const onLeave = (event: DragEvent) => { if (!event.relatedTarget) setSkinDrag(false); };
    const onEnd = () => setSkinDrag(false);
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onEnd);
    window.addEventListener('dragend', onEnd);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onEnd);
      window.removeEventListener('dragend', onEnd);
    };
  }, [canSkin]);

  const handleSkinDrop = useCallback(async (event: React.DragEvent) => {
    setSkinDrag(false);
    const file = event.dataTransfer.files?.[0];
    if (!file || !/\.(eskin|json)$/i.test(file.name)) {
      // Not a skin: let the desktop handle it as usual.
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!appId) return;
    try {
      const skin = await readSkinFile(file);
      const result = await installAppSkin(appId, skin);
      notifyAppSkinChanged(appId);
      setSkinToast(`Skin "${result.entry.name}" applied.`);
    } catch (error) {
      setSkinToast(error instanceof Error ? error.message : 'That skin could not be installed.');
    }
  }, [appId]);

  const src = useMemo(() => {
    const base = import.meta.env.VITE_API_URL || window.location.origin;
    if (previewId) {
      return `${base}/api/app-previews/${previewId}/`;
    }
    const query = launchFileId ? `?fileId=${encodeURIComponent(launchFileId)}` : '';
    return `${base}/api/apps/${appId}/${query}`;
  }, [appId, previewId, launchFileId]);

  useEffect(() => {
    capabilityRef.current = null;
    iframeLoadedRef.current = false;
    setPermissionPrompt(null);
    setGrantedPermissions({});
    if (previewId || !appId) return;

    let cancelled = false;
    getAppPermissions(appId)
      .then(async (permissions) => {
        if (cancelled) return;
        const requested = permissions.requested || {};
        const broad = permissions.broad || [];
        const entries = getPermissionEntries(requested, broad);
        const granted = permissions.granted || {};
        setGrantedPermissions(granted as AppPermissions);
        const missing = entries.filter((entry) => !hasAllPermissionValues(granted, entry));
        if (missing.length > 0) {
          // The dialog owns the pre-tick state: granted narrow scopes are
          // pre-ticked, broad scopes never are (each needs its explicit
          // tick every time it is granted).
          setPermissionPrompt(permissions);
          return;
        }
        const { token } = await mintAppCapability(appId);
        if (cancelled) return;
        capabilityRef.current = token;
        sendCapability();
      })
      .catch(() => {
        // Public/visitor app viewers do not receive owner capabilities.
        // The app remains runnable, but its privileged bridge stays closed.
      });

    return () => {
      cancelled = true;
    };
    // reloadKey: an update reloads the app; it may now declare new
    // permissions, so check again (and ask) instead of reusing old state.
  }, [appId, previewId, src, sendCapability, reloadKey]);

  const handlePermissionAllow = useCallback(async (granted: Record<string, unknown>, broadApprovals: string[]) => {
    if (!appId || !permissionPrompt) return;
    setPermissionBusy(true);
    try {
      await updateAppPermissions(appId, granted, broadApprovals);
      setGrantedPermissions(granted as AppPermissions);
      setPermissionPrompt(null);
      if (Object.keys(granted).length > 0) {
        const { token } = await mintAppCapability(appId);
        capabilityRef.current = token;
        sendCapability();
      }
    } catch {
      // Keep the dialog open so a transient failure cannot silently change access.
    } finally {
      setPermissionBusy(false);
    }
  }, [appId, permissionPrompt, sendCapability]);

  const handlePermissionDeny = useCallback(() => {
    // Deny only the new ask: keep exactly what is already granted and close.
    // No server write — a denial must not touch (or re-date) the approval
    // metadata of grants the user already confirmed.
    setPermissionPrompt(null);
  }, []);

  // Handle messages posted from inside the iframe bridge
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;

      const data = event.data;
      if (!data || typeof data !== 'object') return;

      switch (data.type) {
        case 'eternal:theme:request':
          sendTheme();
          break;
        case 'eternal:skin:request':
          void sendSkin();
          break;
        case 'eternal:skin:parts': {
          const waiter = describeWaiters.current.get(String(data.requestId));
          if (waiter) {
            describeWaiters.current.delete(String(data.requestId));
            waiter(data.parts && typeof data.parts === 'object' ? data.parts as DescribedParts : null);
          }
          break;
        }
        case 'eternal:window:setTitle':
          if (windowId) {
            useWindowStore.getState().updateWindowTitle(windowId, data.title);
          }
          break;
        case 'eternal:window:close':
          if (windowId) {
            useWindowStore.getState().closeWindow(windowId);
          }
          break;
        case 'eternal:window:requestFocus':
          if (windowId) {
            useWindowStore.getState().focusWindow(windowId);
          }
          break;
        case 'eternal:window:resize':
          if (windowId) {
            useWindowStore.getState().resizeWindow(windowId, {
              width: data.width,
              height: data.height,
            });
          }
          break;
        case 'eternal:ipc:emit': {
          const topic = data.topic;
          const payload = data.payload;
          const payloadSize = (() => {
            try {
              return JSON.stringify(payload)?.length ?? 0;
            } catch {
              return Number.POSITIVE_INFINITY;
            }
          })();
          if (!topicMatches(topic, grantedPermissions.ipc?.emit) || payloadSize > 64 * 1024) break;

          activeAppListeners.forEach((listener) => {
            if (listener.appId === appId && listener.previewId === previewId) return; // skip sender
            if (!topicMatches(topic, listener.granted.ipc?.listen)) return;
            listener.onMessage({
              type: 'eternal:ipc:message',
              topic: topic as string,
              payload,
              sender: { appId, previewId },
            });
          });
          break;
        }
        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [windowId, appId, previewId, grantedPermissions, sendTheme, sendSkin]);

  // Register on the global client-side IPC event bus to receive broadcasts from other apps
  useEffect(() => {
    const listener: ActiveAppListener = {
      appId,
      previewId,
      granted: grantedPermissions,
      onMessage: (msg) => {
        if (iframeRef.current && iframeRef.current.contentWindow) {
          iframeRef.current.contentWindow.postMessage(msg, '*');
        }
      },
      onReload: () => {
        iframeLoadedRef.current = false;
        setReloadKey((key) => key + 1);
      },
      windowId,
      onSkinChanged: () => { void sendSkin(); },
      openSkins: canSkin ? () => setSkinsOpen(true) : undefined,
    };

    activeAppListeners.add(listener);
    return () => {
      activeAppListeners.delete(listener);
    };
  }, [appId, previewId, grantedPermissions, windowId, sendSkin, canSkin]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={src}
        onLoad={() => {
          iframeLoadedRef.current = true;
          sendCapability();
          sendTheme();
        }}
        sandbox="allow-scripts"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: 'var(--surface, var(--window-bg, #1a1a2e))',
        }}
        title="App"
      />
      {canSkin && skinDrag && (
        <div
          className={skinPanelStyles.dropOverlay}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setSkinDrag(false); }}
          onDrop={(event) => void handleSkinDrop(event)}
        >
          <span>Drop a .eskin skin to restyle this app</span>
        </div>
      )}
      {canSkin && skinsOpen && appId && (
        <AppSkinsPanel
          appId={appId}
          appName={appName}
          describeParts={describeParts}
          onChanged={() => notifyAppSkinChanged(appId)}
          onClose={() => setSkinsOpen(false)}
        />
      )}
      {skinToast && <div className={skinPanelStyles.toast} role="status">{skinToast}</div>}
      {permissionPrompt && (
        <AppPermissionDialog
          requested={permissionPrompt.requested || {}}
          granted={permissionPrompt.granted || {}}
          broad={permissionPrompt.broad || []}
          approvals={permissionPrompt.approvals}
          rationale={permissionPrompt.rationale}
          busy={permissionBusy}
          onAllow={(granted, broadApprovals) => void handlePermissionAllow(granted, broadApprovals)}
          onDeny={handlePermissionDeny}
        />
      )}
    </div>
  );
}
