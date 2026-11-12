import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import { useWindowStore } from '../../stores/windowStore';
import {
  getAppPermissions,
  mintAppCapability,
  updateAppPermissions,
  type AppPermissionResponse,
} from '../../services/api';
import type { AppPermissions } from '../../types';

interface AppViewerProps {
  appId?: string;
  previewId?: string;
  windowId?: string;
  launchFileId?: string;
}

interface AppIpcMessage {
  type: 'eternal:ipc:message';
  topic: string;
  payload: unknown;
  sender: { appId?: string; previewId?: string };
}

interface ActiveAppListener {
  appId?: string;
  previewId?: string;
  onMessage: (msg: AppIpcMessage) => void;
  granted: AppPermissions;
}

// In-memory list of active app viewers for the parent-mediated IPC event bus.
const activeAppListeners = new Set<ActiveAppListener>();

interface PermissionEntry {
  key: string;
  label: string;
  values: string[];
}

const permissionLabels: Record<string, string> = {
  'fs.read': 'Read desktop files',
  'fs.write': 'Write desktop files',
  'fs.delete': 'Delete desktop files',
  'fs.mimeTypes': 'Access selected file types',
  'profile.read': 'Read profile details',
  'network.outbound': 'Connect to external websites',
  'ipc.listen': 'Receive messages from other apps',
  'ipc.emit': 'Send messages to other apps',
  'handlers.mimeTypes': 'Handle selected file types',
  'handlers.extensions': 'Handle selected file extensions',
};

function getPermissionEntries(value: Record<string, unknown>): PermissionEntry[] {
  const entries: PermissionEntry[] = [];
  for (const [domain, domainValue] of Object.entries(value)) {
    if (!domainValue || typeof domainValue !== 'object') continue;
    for (const [scope, scopeValue] of Object.entries(domainValue as Record<string, unknown>)) {
      if (!Array.isArray(scopeValue) || !scopeValue.every((item) => typeof item === 'string')) continue;
      const key = `${domain}.${scope}`;
      entries.push({
        key,
        label: permissionLabels[key] || `${domain}: ${scope}`,
        values: scopeValue as string[],
      });
    }
  }
  return entries;
}

function hasAllPermissionValues(granted: Record<string, unknown>, entry: PermissionEntry): boolean {
  const [domain, scope] = entry.key.split('.');
  const domainValue = granted[domain];
  if (!domainValue || typeof domainValue !== 'object') return false;
  const values = (domainValue as Record<string, unknown>)[scope];
  return Array.isArray(values) && entry.values.every((value) => values.includes(value));
}

function buildGrantedPermissions(requested: Record<string, unknown>, selectedKeys: string[]): Record<string, unknown> {
  const selected = new Set(selectedKeys);
  const granted: Record<string, Record<string, string[]>> = {};
  for (const entry of getPermissionEntries(requested)) {
    if (!selected.has(entry.key)) continue;
    const [domain, scope] = entry.key.split('.');
    granted[domain] ||= {};
    granted[domain][scope] = entry.values;
  }
  return granted;
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
  const [selectedPermissionKeys, setSelectedPermissionKeys] = useState<string[]>([]);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [grantedPermissions, setGrantedPermissions] = useState<AppPermissions>({});

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
    setSelectedPermissionKeys([]);
    setGrantedPermissions({});
    if (previewId || !appId) return;

    let cancelled = false;
    getAppPermissions(appId)
      .then(async (permissions) => {
        if (cancelled) return;
        const requested = permissions.requested || {};
        const entries = getPermissionEntries(requested);
        const granted = permissions.granted || {};
        setGrantedPermissions(granted as AppPermissions);
        const missing = entries.filter((entry) => !hasAllPermissionValues(granted, entry));
        if (missing.length > 0) {
          setPermissionPrompt(permissions);
          setSelectedPermissionKeys(entries
            .filter((entry) => hasAllPermissionValues(granted, entry))
            .map((entry) => entry.key));
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
  }, [appId, previewId, src, sendCapability]);

  const handlePermissionChoice = useCallback(async (allow: boolean) => {
    if (!appId || !permissionPrompt) return;
    setPermissionBusy(true);
    try {
      const requested = permissionPrompt.requested || {};
      const granted = allow
        ? buildGrantedPermissions(requested, selectedPermissionKeys)
        : permissionPrompt.granted;
      await updateAppPermissions(appId, granted);
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
  }, [appId, permissionPrompt, selectedPermissionKeys, sendCapability]);

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
    };

    activeAppListeners.add(listener);
    return () => {
      activeAppListeners.delete(listener);
    };
  }, [appId, previewId, grantedPermissions]);

  const permissionEntries = permissionPrompt ? getPermissionEntries(permissionPrompt.requested || {}) : [];

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <iframe
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
        <div style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
          background: 'rgba(0, 0, 0, 0.45)',
          zIndex: 2,
        }}>
          <div role="dialog" aria-modal="true" aria-labelledby="app-permissions-title" style={{
            width: 'min(420px, 100%)',
            maxHeight: '100%',
            overflow: 'auto',
            padding: 16,
            background: 'var(--window-bg, #f5f5f5)',
            color: 'var(--window-text-color, #000)',
            border: '2px solid var(--black, #000)',
            boxShadow: '4px 4px 0 rgba(0, 0, 0, 0.35)',
          }}>
            <h2 id="app-permissions-title" style={{ margin: '0 0 8px', fontSize: 15 }}>App permissions</h2>
            <p style={{ margin: '0 0 10px', fontSize: 12 }}>
              {permissionPrompt.rationale || 'Choose what this app can access. You can change this later by reopening the app.'}
            </p>
            {permissionEntries.map((entry) => (
              <label key={entry.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '8px 0', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={selectedPermissionKeys.includes(entry.key)}
                  onChange={(event) => setSelectedPermissionKeys((current) => event.target.checked
                    ? [...current, entry.key]
                    : current.filter((key) => key !== entry.key))}
                />
                <span>
                  <strong>{entry.label}</strong>
                  <br />
                  <small>{entry.values.join(', ')}</small>
                </span>
              </label>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <button type="button" onClick={() => void handlePermissionChoice(false)} disabled={permissionBusy}>Deny</button>
              <button type="button" onClick={() => void handlePermissionChoice(true)} disabled={permissionBusy}>Allow selected</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
