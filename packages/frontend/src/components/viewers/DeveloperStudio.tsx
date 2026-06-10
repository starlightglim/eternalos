import { useState, useCallback, useMemo } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { getAuthToken } from '../../services/api';
import styles from './DeveloperStudio.module.css';


interface AppItem {
  id: string; // desktop item ID
  appId: string; // manifest app ID
  name: string;
  description?: string;
  version: string;
}

type FileTab = 'eternal.app.json' | 'index.html' | 'app.js' | 'styles.css';

export function DeveloperStudio() {
  const { items, loadDesktop } = useDesktopStore();


  const [activeApp, setActiveApp] = useState<AppItem | null>(null);
  const [activeTab, setActiveTab] = useState<FileTab>('index.html');
  const [files, setFiles] = useState<Record<FileTab, string>>({
    'eternal.app.json': '',
    'index.html': '',
    'app.js': '',
    'styles.css': '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Form states for new app
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newWidth, setNewWidth] = useState(600);
  const [newHeight, setNewHeight] = useState(500);

  // List all registered apps on the user's desktop
  const apps = useMemo(() => {
    return items
      .filter((item) => item.type === 'app' && item.appManifest?.appId && !item.isTrashed)
      .map((item) => ({
        id: item.id,
        appId: item.appManifest!.appId,
        name: item.appManifest!.name || item.name,
        description: item.appManifest!.description,
        version: item.appManifest!.version || '1',
      }));
  }, [items]);

  // Load selected app's files from backend R2
  const handleSelectApp = useCallback(async (app: AppItem) => {
    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Loading ${app.name} source files...`);
    setActiveApp(app);
    setActiveTab('index.html');

    try {
      const token = getAuthToken();
      const base = import.meta.env.VITE_API_URL || window.location.origin;
      const res = await fetch(`${base}/api/apps/${app.appId}/source`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to load app files: status ${res.status}`);
      }

      const data = (await res.json()) as { files: Record<string, string> };
      const srcFiles = data.files || {};

      // Load manifest if it exists, otherwise reconstruct one
      let manifestText = '';
      const desktopItem = items.find((i) => i.id === app.id);
      if (desktopItem?.appManifest) {
        manifestText = JSON.stringify(desktopItem.appManifest, null, 2);
      } else {
        manifestText = JSON.stringify({
          name: app.name,
          description: app.description || '',
          version: app.version,
          windowConfig: { defaultWidth: 600, defaultHeight: 500, resizable: true },
          permissions: { fs: { read: ["/**"], write: ["/**"], delete: ["/**"] } }
        }, null, 2);
      }

      setFiles({
        'eternal.app.json': manifestText,
        'index.html': srcFiles['index.html'] || '<h1>Hello World</h1>',
        'app.js': srcFiles['app.js'] || '// Write your JS logic here',
        'styles.css': srcFiles['styles.css'] || '/* Write your CSS styling here */',
      });

      setStatus('idle');
      setStatusMsg('');
    } catch (err) {
      console.error(err);
      setStatus('error');
      setStatusMsg(err instanceof Error ? err.message : 'Failed to retrieve files.');
    } finally {
      setIsLoading(false);
    }
  }, [items]);

  // Deploy / Update the currently selected app
  const handleDeploy = useCallback(async () => {
    if (!activeApp) return;

    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Compiling and deploying ${activeApp.name}...`);

    try {
      // Validate manifest is valid JSON
      let manifestObj;
      try {
        manifestObj = JSON.parse(files['eternal.app.json']);
      } catch {
        throw new Error('Manifest is not valid JSON! Please check eternal.app.json.');
      }

      const token = getAuthToken();
      const base = import.meta.env.VITE_API_URL || window.location.origin;

      const res = await fetch(`${base}/api/apps/dev-deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          appId: activeApp.appId,
          manifest: manifestObj,
          files: {
            'index.html': files['index.html'],
            'app.js': files['app.js'],
            'styles.css': files['styles.css'],
          },
        }),
      });

      const data = (await res.json()) as { error?: string; version: number };
      if (!res.ok) {
        throw new Error(data.error || `Deployment failed with status ${res.status}`);
      }

      setStatus('success');
      setStatusMsg(`App updated successfully to version ${data.version}!`);
      
      // Update local state and trigger desktop reload
      await loadDesktop();
      
      setTimeout(() => {
        setStatus('idle');
        setStatusMsg('');
      }, 3000);
    } catch (err) {
      console.error(err);
      setStatus('error');
      setStatusMsg(err instanceof Error ? err.message : 'Deployment failed.');
    } finally {
      setIsLoading(false);
    }
  }, [activeApp, files, loadDesktop]);

  // Delete/Uninstall the app
  const handleDeleteApp = useCallback(async () => {
    if (!activeApp) return;

    const confirm = window.confirm(`Are you sure you want to uninstall ${activeApp.name}? This will remove its files and icon from your desktop.`);
    if (!confirm) return;

    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Deleting ${activeApp.name}...`);

    try {
      const { moveToTrash } = useDesktopStore.getState();
      moveToTrash([activeApp.id]);
      setActiveApp(null);
      setStatus('success');
      setStatusMsg('App uninstalled and moved to Trash.');

      await loadDesktop();

      setTimeout(() => {
        setStatus('idle');
        setStatusMsg('');
      }, 3000);
    } catch (err) {
      setStatus('error');
      setStatusMsg(err instanceof Error ? err.message : 'Failed to delete app.');
    } finally {
      setIsLoading(false);
    }
  }, [activeApp, loadDesktop]);

  // Create a brand new app from scratch
  const handleCreateApp = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Scaffolding new app ${newName}...`);
    setShowCreateModal(false);

    try {
      const manifest = {
        name: newName,
        description: newDesc || 'A custom sandboxed application.',
        version: '1.0.0',
        windowConfig: {
          defaultWidth: newWidth,
          defaultHeight: newHeight,
          resizable: true,
        },
        permissions: {
          fs: {
            read: ['/**'],
            write: ['/**'],
            delete: ['/**'],
          },
          profile: {
            read: ['username', 'displayName'],
          },
        },
      };

      const defaultHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${newName}</title>
</head>
<body>
  <div style="padding: 20px; font-family: sans-serif; text-align: center;">
    <h1 style="color: #e43f5a;">Welcome to ${newName}!</h1>
    <p>This app was created manually in the Developer Studio.</p>
    <button id="action-btn" style="background: #e43f5a; border: none; color: white; padding: 10px 16px; border-radius: 4px; cursor: pointer;">
      Greet Me!
    </button>
    <pre id="output" style="margin-top: 20px; padding: 10px; background: #111; color: #0f0; min-height: 40px; text-align: left;"></pre>
  </div>
</body>
</html>`;

      const defaultJs = `const btn = document.getElementById('action-btn');
const out = document.getElementById('output');

btn.addEventListener('click', async () => {
  try {
    out.textContent = "Loading profile...";
    const profile = await window.eternal.profile.get();
    out.textContent = \`Hello, \${profile.displayName || profile.username}! Welcome to your custom app.\`;
  } catch (err) {
    out.textContent = \`Error: \${err.message}\`;
  }
});`;

      const defaultCss = `body {
  background-color: #1a1a2e;
  color: #e2e2e2;
}`;

      const token = getAuthToken();
      const base = import.meta.env.VITE_API_URL || window.location.origin;

      const res = await fetch(`${base}/api/apps/dev-deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          manifest,
          files: {
            'index.html': defaultHtml,
            'app.js': defaultJs,
            'styles.css': defaultCss,
          },
        }),
      });

      const data = (await res.json()) as { error?: string; appId: string };
      if (!res.ok) {
        throw new Error(data.error || `Failed to create app: status ${res.status}`);
      }

      // Reload desktop and set newly created app as active
      await loadDesktop();

      const createdApp: AppItem = {
        id: `app-${data.appId}`, // temp or wait for reload matching
        appId: data.appId,
        name: newName,
        description: newDesc,
        version: '1',
      };

      setStatus('success');
      setStatusMsg(`App "${newName}" created successfully!`);
      setActiveApp(createdApp);
      setFiles({
        'eternal.app.json': JSON.stringify(manifest, null, 2),
        'index.html': defaultHtml,
        'app.js': defaultJs,
        'styles.css': defaultCss,
      });

      setNewName('');
      setNewDesc('');

      setTimeout(() => {
        setStatus('idle');
        setStatusMsg('');
      }, 3000);
    } catch (err) {
      console.error(err);
      setStatus('error');
      setStatusMsg(err instanceof Error ? err.message : 'Creation failed.');
    } finally {
      setIsLoading(false);
    }
  }, [newName, newDesc, newWidth, newHeight, loadDesktop]);

  return (
    <div className={styles.studio} data-no-drag>
      {/* Sidebar - App Browser */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitle}>Developer Studio</div>
          <button
            className={styles.newAppButton}
            onClick={() => setShowCreateModal(true)}
            disabled={isLoading}
          >
            + Create New App
          </button>
        </div>
        <div className={styles.appList}>
          <div className={styles.sidebarTitle} style={{ padding: '4px 8px' }}>My Sandbox Apps</div>
          {apps.length === 0 ? (
            <div style={{ padding: '8px', fontSize: '11px', color: '#666' }}>No custom apps.</div>
          ) : (
            apps.map((app) => (
              <div
                key={app.id}
                className={[
                  styles.appItem,
                  activeApp?.appId === app.appId ? styles.appItemActive : '',
                ].filter(Boolean).join(' ')}
                onClick={() => !isLoading && handleSelectApp(app)}
              >
                <div className={styles.appName}>⚙️ {app.name}</div>
                <div className={styles.appMeta}>v{app.version} | ID: {app.appId.slice(0, 8)}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Editor Workspace */}
      <div className={styles.workspace}>
        {activeApp ? (
          <>
            {/* Header Tabs */}
            <div className={styles.workspaceHeader}>
              <div className={styles.tabs}>
                {(['index.html', 'app.js', 'styles.css', 'eternal.app.json'] as FileTab[]).map((tab) => (
                  <div
                    key={tab}
                    className={[
                      styles.tab,
                      activeTab === tab ? styles.tabActive : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'eternal.app.json' ? '⚙️ ' : '📝 '}
                    {tab}
                  </div>
                ))}
              </div>
              <div className={styles.actions}>
                <button
                  className={[styles.actionBtn, styles.deployBtn].join(' ')}
                  onClick={handleDeploy}
                  disabled={isLoading}
                >
                  🚀 Deploy to Desktop
                </button>
                <button
                  className={[styles.actionBtn, styles.deleteBtn].join(' ')}
                  onClick={handleDeleteApp}
                  disabled={isLoading}
                >
                  🗑️ Uninstall
                </button>
              </div>
            </div>

            {/* Code Field */}
            <div className={styles.editorArea}>
              <textarea
                className={styles.textarea}
                value={files[activeTab] || ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setFiles((prev) => ({ ...prev, [activeTab]: val }));
                }}
                disabled={isLoading}
                spellCheck={false}
              />
            </div>

          </>
        ) : (
          <div className={styles.noAppSelected}>
            <div className={styles.noAppIcon}>🌌</div>
            <div className={styles.noAppText}>
              <h3>Select or Create a Sandbox App</h3>
              <p>Create and edit your custom sandboxed applications directly in the browser.<br />Deployments are compiled instantly into dynamic worker isolates.</p>
            </div>
          </div>
        )}

        {/* Status Bar */}
        <div className={styles.statusBar}>
          <div className={styles.statusMessage}>
            <div
              className={[
                styles.statusIndicator,
                status === 'success' ? styles.statusSuccess : '',
                status === 'error' ? styles.statusError : '',
                status === 'loading' ? styles.statusLoading : '',
              ].filter(Boolean).join(' ')}
            />
            <span className={status === 'error' ? styles.statusTextError : ''}>
              {statusMsg || 'Ready'}
            </span>
          </div>
          <div>EternalOS App Platform v1.2</div>
        </div>
      </div>

      {/* Scaffold App Modal */}
      {showCreateModal && (
        <div className={styles.modalOverlay}>
          <form className={styles.modal} onSubmit={handleCreateApp}>
            <h3 className={styles.modalTitle}>Create Sandbox App</h3>
            
            <div className={styles.formGroup}>
              <label className={styles.label}>Application Name</label>
              <input
                className={styles.input}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Pixel Paint"
                required
                maxLength={40}
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.label}>Description</label>
              <textarea
                className={styles.modalTextarea}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Describe your application..."
                maxLength={200}
              />
            </div>

            <div style={{ display: 'flex', gap: '12px' }}>
              <div className={styles.formGroup} style={{ flex: 1 }}>
                <label className={styles.label}>Default Width (px)</label>
                <input
                  className={styles.input}
                  type="number"
                  value={newWidth}
                  onChange={(e) => setNewWidth(Number(e.target.value))}
                  min={300}
                  max={1920}
                  required
                />
              </div>
              <div className={styles.formGroup} style={{ flex: 1 }}>
                <label className={styles.label}>Default Height (px)</label>
                <input
                  className={styles.input}
                  type="number"
                  value={newHeight}
                  onChange={(e) => setNewHeight(Number(e.target.value))}
                  min={300}
                  max={1080}
                  required
                />
              </div>
            </div>

            <div className={styles.modalButtons}>
              <button
                type="button"
                className={[styles.modalBtn, styles.cancelBtn].join(' ')}
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={[styles.modalBtn, styles.submitBtn].join(' ')}
              >
                Scaffold App
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
