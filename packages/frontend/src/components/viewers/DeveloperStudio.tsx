import { useState, useCallback, useEffect, useMemo } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import {
  deleteAppRuntime,
  deployApp,
  getAppSource,
  listAppVersions,
  rollbackApp,
  type AppRelease,
} from '../../services/api';
import { AlertDialog } from '../ui/AlertDialog';
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
  const { items, loadDesktop, removeItem } = useDesktopStore();


  const [activeApp, setActiveApp] = useState<AppItem | null>(null);
  const [activeTab, setActiveTab] = useState<FileTab>('index.html');
  const [files, setFiles] = useState<Record<FileTab, string>>({
    'eternal.app.json': '',
    'index.html': '',
    'app.js': '',
    'styles.css': '',
  });
  const [sourceFiles, setSourceFiles] = useState<Record<string, string>>({});

  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [releases, setReleases] = useState<AppRelease[]>([]);
  const [rollbackVersion, setRollbackVersion] = useState('');

  // Form states for new app
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newWidth, setNewWidth] = useState(600);
  const [newHeight, setNewHeight] = useState(500);

  useEffect(() => {
    if (!showCreateModal && !showDeleteConfirm) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowCreateModal(false);
        setShowDeleteConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCreateModal, showDeleteConfirm]);

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
    setReleases([]);
    setRollbackVersion('');

    try {
      const data = await getAppSource(app.appId);
      const srcFiles = data.files || {};
      const versionData = await listAppVersions(app.appId);

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
          permissions: { profile: { read: ['username', 'displayName'] } }
        }, null, 2);
      }

      setFiles({
        'eternal.app.json': manifestText,
        'index.html': srcFiles['index.html'] || '<h1>Hello World</h1>',
        'app.js': srcFiles['app.js'] || '// Write your JS logic here',
        'styles.css': srcFiles['styles.css'] || '/* Write your CSS styling here */',
      });
      setSourceFiles(srcFiles);
      setReleases(versionData.releases);

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

      const data = await deployApp({
        appId: activeApp.appId,
        manifest: manifestObj,
        files: {
          ...sourceFiles,
          'index.html': files['index.html'],
          'app.js': files['app.js'],
          'styles.css': files['styles.css'],
        },
      });

      setStatus('success');
      setStatusMsg(`App updated successfully to version ${data.version}!`);
      
      // Update local state and trigger desktop reload
      await loadDesktop();
      setActiveApp((previous) => previous ? { ...previous, version: String(data.version) } : previous);
      const versionData = await listAppVersions(activeApp.appId);
      setReleases(versionData.releases);
      setRollbackVersion('');
      
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
  }, [activeApp, files, loadDesktop, sourceFiles]);

  const handleRollback = useCallback(async () => {
    if (!activeApp || !rollbackVersion) return;

    const version = Number(rollbackVersion);
    if (!Number.isInteger(version)) return;

    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Rolling ${activeApp.name} back to version ${version}...`);

    try {
      await rollbackApp(activeApp.appId, version);
      await loadDesktop();
      await handleSelectApp(activeApp);
      setActiveApp((previous) => previous ? { ...previous, version: String(version) } : previous);
      setStatus('success');
      setStatusMsg(`App rolled back to version ${version}.`);
      setRollbackVersion('');
    } catch (err) {
      setStatus('error');
      setStatusMsg(err instanceof Error ? err.message : 'Rollback failed.');
    } finally {
      setIsLoading(false);
    }
  }, [activeApp, handleSelectApp, loadDesktop, rollbackVersion]);

  // Delete/Uninstall the app
  const handleDeleteApp = useCallback(async () => {
    if (!activeApp) return;

    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Deleting ${activeApp.name}...`);

    try {
      await deleteAppRuntime(activeApp.appId);
      removeItem(activeApp.id);
      setActiveApp(null);
      setFiles({
        'eternal.app.json': '',
        'index.html': '',
        'app.js': '',
        'styles.css': '',
      });
      setSourceFiles({});
      setReleases([]);
      setRollbackVersion('');
      setShowDeleteConfirm(false);
      setStatus('success');
      setStatusMsg('App uninstalled and its runtime data was removed.');

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
  }, [activeApp, loadDesktop, removeItem]);

  // Create a brand new app from scratch
  const handleCreateApp = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    const appName = newName.trim();
    const escapedAppName = appName.replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    })[character] ?? character);

    setIsLoading(true);
    setStatus('loading');
    setStatusMsg(`Scaffolding new app ${appName}...`);
    setShowCreateModal(false);

    try {
      const manifest = {
        name: appName,
        description: newDesc || 'A custom sandboxed application.',
        version: '1.0.0',
        windowConfig: {
          defaultWidth: newWidth,
          defaultHeight: newHeight,
          resizable: true,
        },
        permissions: {
          profile: {
            read: ['username', 'displayName'],
          },
        },
      };

      const defaultHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedAppName}</title>
</head>
<body>
  <main class="app-shell">
    <header class="app-header">
      <p class="eyebrow">ETERNALOS APP</p>
      <h1>Welcome to ${escapedAppName}</h1>
      <p class="intro">A small, editable starting point. Make it yours in the Developer Studio.</p>
    </header>
    <section class="app-card" aria-live="polite">
      <p class="card-label">READY TO EXPLORE</p>
      <button id="action-btn" type="button">Greet me</button>
      <output id="output" class="output">Click the button to read your EternalOS profile.</output>
    </section>
  </main>
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

      const defaultCss = `:root {
  --app-accent: #e43f5a;
  --app-accent-strong: #b82f48;
  --app-background: #111827;
  --app-surface: #1f2937;
  --app-text: #f9fafb;
  --app-muted: #b7c1d1;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-width: 240px;
  background: var(--app-background);
  color: var(--app-text);
  font: 15px/1.5 system-ui, sans-serif;
}

.app-shell {
  max-width: 680px;
  margin: 0 auto;
  padding: clamp(24px, 8vw, 64px) clamp(18px, 6vw, 48px);
}

.app-header { margin-bottom: 24px; }
.eyebrow, .card-label {
  margin: 0 0 8px;
  color: var(--app-accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .14em;
}
h1 { margin: 0; font-size: clamp(28px, 6vw, 44px); line-height: 1.05; }
.intro { margin: 14px 0 0; color: var(--app-muted); }
.app-card {
  padding: 22px;
  background: var(--app-surface);
  border: 1px solid color-mix(in srgb, var(--app-text) 12%, transparent);
  border-radius: 16px;
  box-shadow: 0 16px 40px color-mix(in srgb, #000 28%, transparent);
}
button {
  padding: 10px 16px;
  border: 0;
  border-radius: 999px;
  background: var(--app-accent);
  color: #fff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
button:hover { background: var(--app-accent-strong); }
button:focus-visible { outline: 3px solid color-mix(in srgb, var(--app-accent) 55%, #fff); outline-offset: 3px; }
.output { display: block; margin-top: 18px; color: var(--app-muted); }
`;

      const data = await deployApp({
        manifest,
        files: {
          'index.html': defaultHtml,
          'app.js': defaultJs,
          'styles.css': defaultCss,
        },
      });

      // Reload desktop and set newly created app as active
      await loadDesktop();

      const createdDesktopItem = useDesktopStore.getState().items.find(
        (item) => item.type === 'app' && item.appManifest?.appId === data.appId && !item.isTrashed,
      );
      if (!createdDesktopItem?.appManifest) {
        throw new Error('App was created, but the desktop could not reload it. Please refresh and try again.');
      }

      const createdApp: AppItem = {
        id: createdDesktopItem.id,
        appId: data.appId,
        name: createdDesktopItem.appManifest.name || newName,
        description: createdDesktopItem.appManifest.description || newDesc,
        version: createdDesktopItem.appManifest.version || '1',
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
      setSourceFiles({
        'index.html': defaultHtml,
        'app.js': defaultJs,
        'styles.css': defaultCss,
      });
      const versionData = await listAppVersions(data.appId);
      setReleases(versionData.releases);
      setRollbackVersion('');

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
          <div className={styles.appListHeading}>My Sandbox Apps</div>
          {apps.length === 0 ? (
            <div className={styles.emptyAppList}>No custom apps yet.</div>
          ) : (
            apps.map((app) => (
              <button
                type="button"
                key={app.id}
                className={[
                  styles.appItem,
                  activeApp?.appId === app.appId ? styles.appItemActive : '',
                ].filter(Boolean).join(' ')}
                onClick={() => !isLoading && handleSelectApp(app)}
                disabled={isLoading}
              >
                <div className={styles.appName}>⚙️ {app.name}</div>
                <div className={styles.appMeta}>v{app.version} | ID: {app.appId.slice(0, 8)}</div>
              </button>
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
                  <button
                    type="button"
                    key={tab}
                    className={[
                      styles.tab,
                      activeTab === tab ? styles.tabActive : '',
                    ].filter(Boolean).join(' ')}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'eternal.app.json' ? '⚙️ ' : '📝 '}
                    {tab}
                  </button>
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
                {releases.some((release) => !release.current) && (
                  <div className={styles.releaseControls}>
                    <select
                      className={styles.releaseSelect}
                      value={rollbackVersion}
                      onChange={(event) => setRollbackVersion(event.target.value)}
                      disabled={isLoading}
                      aria-label="Select a release to roll back to"
                    >
                      <option value="">Rollback to...</option>
                      {releases.filter((release) => !release.current).map((release) => (
                        <option key={release.version} value={release.version}>
                          v{release.version}
                        </option>
                      ))}
                    </select>
                    <button
                      className={styles.actionBtn}
                      onClick={handleRollback}
                      disabled={isLoading || !rollbackVersion}
                    >
                      ↩ Rollback
                    </button>
                  </div>
                )}
                <button
                  className={[styles.actionBtn, styles.deleteBtn].join(' ')}
                  onClick={() => setShowDeleteConfirm(true)}
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
                  setSourceFiles((prev) => ({ ...prev, [activeTab]: val }));
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
        <div
          className={styles.modalOverlay}
          onClick={(event) => event.target === event.currentTarget && setShowCreateModal(false)}
        >
          <form
            className={styles.modal}
            onSubmit={handleCreateApp}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-app-title"
          >
            <h3 id="create-app-title" className={styles.modalTitle}>Create Sandbox App</h3>
            
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="new-app-name">Application Name</label>
              <input
                id="new-app-name"
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
              <label className={styles.label} htmlFor="new-app-description">Description</label>
              <textarea
                id="new-app-description"
                className={styles.modalTextarea}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Describe your application..."
                maxLength={200}
              />
            </div>

            <div className={styles.dimensionFields}>
              <div className={`${styles.formGroup} ${styles.dimensionField}`}>
                <label className={styles.label} htmlFor="new-app-width">Default Width (px)</label>
                <input
                  id="new-app-width"
                  className={styles.input}
                  type="number"
                  value={newWidth}
                  onChange={(e) => setNewWidth(Number(e.target.value))}
                  min={300}
                  max={1920}
                  required
                />
              </div>
              <div className={`${styles.formGroup} ${styles.dimensionField}`}>
                <label className={styles.label} htmlFor="new-app-height">Default Height (px)</label>
                <input
                  id="new-app-height"
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

      {showDeleteConfirm && activeApp && (
        <AlertDialog
          type="confirm"
          title={`Uninstall ${activeApp.name}?`}
          message="This removes the app files and its desktop icon. This cannot be undone."
          onClose={() => setShowDeleteConfirm(false)}
          buttons={[
            { label: 'Keep App', onClick: () => setShowDeleteConfirm(false) },
            { label: 'Uninstall', onClick: handleDeleteApp, primary: true },
          ]}
        />
      )}
    </div>
  );
}
