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
import { activeAppListeners, type ActiveAppListener } from '../../utils/appWindowBus';

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
  }, [windowId, appId, previewId, grantedPermissions]);

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
    };

    activeAppListeners.add(listener);
    return () => {
      activeAppListeners.delete(listener);
    };
  }, [appId, previewId, grantedPermissions]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <iframe
        key={reloadKey}
        ref={iframeRef}
        src={src}
        onLoad={() => {
          iframeLoadedRef.current = true;
          sendCapability();
        }}
        sandbox="allow-scripts"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: '#1a1a2e',
        }}
        title="App"
      />
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
