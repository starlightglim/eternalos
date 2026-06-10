import { useMemo, useEffect, useRef } from 'react';
import { useWindowStore } from '../../stores/windowStore';

interface AppViewerProps {
  appId?: string;
  previewId?: string;
  windowId?: string;
  launchFileId?: string;
}

interface AppIpcMessage {
  type: 'eternal:ipc:message';
  topic: unknown;
  payload: unknown;
  sender: { appId?: string; previewId?: string };
}

interface ActiveAppListener {
  appId?: string;
  previewId?: string;
  onMessage: (msg: AppIpcMessage) => void;
}

// In-memory list of active app viewers for the parent-mediated IPC event bus.
const activeAppListeners = new Set<ActiveAppListener>();

export function AppViewer({ appId, previewId, windowId, launchFileId }: AppViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const src = useMemo(() => {
    const base = import.meta.env.VITE_API_URL || window.location.origin;
    if (previewId) {
      return `${base}/api/app-previews/${previewId}/`;
    }
    const query = launchFileId ? `?fileId=${encodeURIComponent(launchFileId)}` : '';
    return `${base}/api/apps/${appId}/${query}`;
  }, [appId, previewId, launchFileId]);

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
          
          // Broadcast message to all OTHER open apps registered on the client event bus
          activeAppListeners.forEach((listener) => {
            if (listener.appId === appId && listener.previewId === previewId) return; // skip sender
            listener.onMessage({
              type: 'eternal:ipc:message',
              topic,
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
  }, [windowId, appId, previewId]);

  // Register on the global client-side IPC event bus to receive broadcasts from other apps
  useEffect(() => {
    const listener: ActiveAppListener = {
      appId,
      previewId,
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
  }, [appId, previewId]);

  return (
    <iframe
      ref={iframeRef}
      src={src}
      sandbox="allow-scripts"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        backgroundColor: '#1a1a2e',
      }}
      title="App"
    />
  );
}
