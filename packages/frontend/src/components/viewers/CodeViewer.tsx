import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { ContextMenu, type ContextMenuItem } from '../ui';
import styles from './CodeViewer.module.css';

interface CodeViewerProps {
  itemId: string;
  windowId: string;
  name: string;
  textContent?: string;
  isOwner?: boolean;
  language?: string;
}

/**
 * Map file extensions to Prism language identifiers.
 * prism-react-renderer bundles a subset of Prism languages by default.
 */
const EXT_TO_PRISM_LANG: Record<string, string> = {
  js: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  json: 'json',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  md: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
};

/**
 * CodeViewer - displays code with syntax highlighting
 *
 * Uses prism-react-renderer for accurate, XSS-safe syntax highlighting.
 * No dangerouslySetInnerHTML — all tokens are rendered as React elements.
 */
export function CodeViewer({
  itemId,
  windowId,
  name,
  textContent: initialContent = '',
  isOwner = true,
  language,
}: CodeViewerProps) {
  const [content] = useState(initialContent);
  const [fileName, setFileName] = useState(name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { updateItem } = useDesktopStore();
  const { updateWindowTitle } = useWindowStore();

  // Detect language from file extension if not provided
  const detectedLanguage = useMemo(() => {
    if (language) return language;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    return EXT_TO_PRISM_LANG[ext] || 'text';
  }, [name, language]);

  // Display-friendly language name
  const displayLanguage = useMemo(() => {
    if (language) return language;
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const displayMap: Record<string, string> = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', sh: 'bash', yml: 'yaml', rs: 'rust', md: 'markdown',
      h: 'c', hpp: 'cpp', gql: 'graphql',
    };
    return displayMap[ext] || ext || 'text';
  }, [name, language]);

  useEffect(() => { setFileName(name); }, [name]);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  const handleRename = useCallback(() => {
    if (!isOwner || !fileName.trim()) {
      setFileName(name);
      setIsEditingName(false);
      return;
    }
    const newName = fileName.trim();
    if (newName !== name) {
      updateItem(itemId, { name: newName });
      updateWindowTitle(windowId, newName);
    }
    setIsEditingName(false);
  }, [fileName, name, isOwner, itemId, windowId, updateItem, updateWindowTitle]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') { e.preventDefault(); handleRename(); }
      else if (e.key === 'Escape') { e.preventDefault(); setFileName(name); setIsEditingName(false); }
    },
    [handleRename, name]
  );

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);
  }, [content, fileName]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => { setContextMenu(null); }, []);

  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    return [{ id: 'download', label: 'Download', shortcut: '⌘S', action: handleDownload }];
  }, [handleDownload]);

  const lines = content.split('\n');

  return (
    <div className={styles.codeViewer} onContextMenu={handleContextMenu}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        {isEditingName ? (
          <input
            ref={nameInputRef}
            type="text"
            className={styles.fileNameInput}
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={handleNameKeyDown}
          />
        ) : (
          <span
            className={`${styles.fileName} ${isOwner ? styles.fileNameEditable : ''}`}
            onClick={isOwner ? () => setIsEditingName(true) : undefined}
            title={isOwner ? 'Click to rename' : undefined}
          >
            {fileName}
          </span>
        )}
        <div className={styles.toolbarRight}>
          <span className={styles.languageBadge}>{displayLanguage}</span>
          {!isOwner && <span className={styles.readOnly}>Read Only</span>}
        </div>
      </div>

      {/* Code content with syntax highlighting via prism-react-renderer (XSS-safe, no innerHTML) */}
      <div className={styles.content}>
        <div className={styles.lineNumbers}>
          {lines.map((_, i) => (
            <div key={i} className={styles.lineNumber}>{i + 1}</div>
          ))}
        </div>
        <Highlight theme={themes.github} code={content} language={detectedLanguage}>
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre className={styles.codeContent}>
              {tokens.map((line, i) => (
                <div key={i} {...getLineProps({ line })}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                  {'\n'}
                </div>
              ))}
            </pre>
          )}
        </Highlight>
      </div>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={styles.lineCount}>{lines.length} lines</span>
          <span className={styles.charCount}>{content.length} chars</span>
        </div>
      </div>

      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems()}
          position={contextMenu}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
