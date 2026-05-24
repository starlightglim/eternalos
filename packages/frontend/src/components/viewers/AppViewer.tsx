import { useMemo } from 'react';

interface AppViewerProps {
  appId?: string;
  previewId?: string;
}

export function AppViewer({ appId, previewId }: AppViewerProps) {
  const src = useMemo(() => {
    const base = import.meta.env.VITE_API_URL || window.location.origin;
    if (previewId) {
      return `${base}/api/app-previews/${previewId}/`;
    }
    return `${base}/api/apps/${appId}/`;
  }, [appId, previewId]);

  return (
    <iframe
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
