import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { marked, type MarkedOptions } from 'marked';
import DOMPurify from 'dompurify';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { ContextMenu, type ContextMenuItem } from '../ui';
import styles from './MarkdownViewer.module.css';

interface MarkdownViewerProps {
  itemId: string;
  windowId: string;
  name: string;
  textContent?: string;
  isOwner?: boolean;
}

/**
 * MarkdownViewer - renders markdown files with classic Mac styling
 * Features:
 * - Basic markdown rendering (headers, bold, italic, links, code, lists)
 * - Toggle between rendered and source view
 * - Download button
 */
export function MarkdownViewer({
  itemId,
  windowId,
  name,
  textContent: initialContent = '',
  isOwner = true,
}: MarkdownViewerProps) {
  const [content, setContent] = useState(initialContent);
  const [fileName, setFileName] = useState(name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { updateItem } = useDesktopStore();
  const { updateWindowTitle } = useWindowStore();

  // Update content when prop changes
  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  // Update filename when prop changes
  useEffect(() => {
    setFileName(name);
  }, [name]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  // Handle filename rename
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

  // Handle name input key events
  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRename();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setFileName(name);
        setIsEditingName(false);
      }
    },
    [handleRename, name]
  );

  // Download the markdown file
  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const downloadUrl = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);
  }, [content, fileName]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const getContextMenuItems = useCallback((): ContextMenuItem[] => {
    return [
      {
        id: 'download',
        label: 'Download',
        shortcut: '⌘S',
        action: handleDownload,
      },
    ];
  }, [handleDownload]);

  // Parse and render markdown
  const renderedContent = useMemo(() => {
    return parseMarkdown(content);
  }, [content]);

  return (
    <div className={styles.markdownViewer} onContextMenu={handleContextMenu}>
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
          <button
            className={`${styles.viewToggle} ${showSource ? styles.active : ''}`}
            onClick={() => setShowSource(!showSource)}
            title={showSource ? 'Show rendered' : 'Show source'}
          >
            {showSource ? 'Preview' : 'Source'}
          </button>
          {!isOwner && <span className={styles.readOnly}>Read Only</span>}
        </div>
      </div>

      {/* Content */}
      <div className={styles.content}>
        {showSource ? (
          <pre className={styles.sourceView}>{content}</pre>
        ) : (
          <div
            className={styles.renderedView}
            dangerouslySetInnerHTML={{ __html: renderedContent }}
          />
        )}
      </div>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <span className={styles.charCount}>{content.length} characters</span>
      </div>

      {/* Context Menu */}
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

/**
 * Configure marked for safe rendering with classic Mac styling.
 *
 * Security: DOMPurify sanitizes the final HTML output, providing defense-in-depth
 * against any parser-level XSS bypasses. This replaces the fragile hand-rolled
 * regex parser that had multiple XSS vulnerabilities.
 */
const markedOptions: MarkedOptions = {
  breaks: true, // Convert \n to <br>
  gfm: true,    // GitHub Flavored Markdown (tables, task lists, strikethrough)
};

// Configure DOMPurify to allow safe attributes while blocking dangerous ones
const purifyConfig: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'del',
    'a', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'input', // For task list checkboxes
    'span',
  ],
  ALLOWED_ATTR: [
    'href', 'target', 'rel',
    'class',
    'type', 'checked', 'disabled', // For task list checkboxes
  ],
  // Force all links to open in new tab with noopener
  ADD_ATTR: ['target'],
};

// Hook: ensure all links open safely in new tabs
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
    // Block javascript: and data: URLs that might slip through
    const href = node.getAttribute('href') || '';
    if (!/^(https?:|mailto:|\/|#|\?)/.test(href.trim()) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href.trim())) {
      node.setAttribute('href', 'about:blank');
    }
  }
});

function parseMarkdown(text: string): string {
  if (!text) return '<p style="color: var(--shadow);">No content</p>';

  // Parse markdown to HTML with marked, then sanitize with DOMPurify
  const rawHtml = marked.parse(text, markedOptions) as string;
  return DOMPurify.sanitize(rawHtml, purifyConfig);
}
