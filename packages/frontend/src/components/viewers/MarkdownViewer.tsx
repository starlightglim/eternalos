import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
 * Sanitize a URL to only allow safe protocols (http, https, mailto).
 * Returns about:blank for any disallowed protocol (e.g. javascript:, data:, vbscript:).
 */
function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  // Relative URLs and anchors are safe
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed, 'https://placeholder.invalid');
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
      return trimmed;
    }
  } catch {
    // If it doesn't parse as a URL and has no protocol, treat as relative
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return trimmed;
    }
  }
  return 'about:blank';
}

/**
 * Simple markdown parser
 * Handles: headers, bold, italic, code blocks, inline code, links, lists, horizontal rules
 */
function parseMarkdown(text: string): string {
  if (!text) return '<p style="color: var(--shadow);">No content</p>';

  let html = text;

  // Escape HTML to prevent XSS
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (``` ... ```) - must be done before other formatting
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="codeBlock">${code.trim()}</pre>`;
  });

  // Inline code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code class="inlineCode">$1</code>');

  // Headers (# to ######)
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Horizontal rule (--- or ***)
  html = html.replace(/^---+$/gm, '<hr />');
  html = html.replace(/^\*\*\*+$/gm, '<hr />');

  // Bold (**text** or __text__)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic (*text* or _text_)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  // Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, text, url) => {
      const safeUrl = sanitizeUrl(url);
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
  );

  // Unordered lists (- item or * item)
  html = html.replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);

  // Ordered lists (1. item)
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  // Note: This would need more sophisticated handling to wrap in <ol>

  // Blockquotes (> text)
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  html = html.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  // Paragraphs - wrap remaining text blocks
  // Split by double newlines and wrap non-tag content in <p>
  const lines = html.split(/\n\n+/);
  html = lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      // Don't wrap if already wrapped in a block element
      if (
        trimmed.startsWith('<h') ||
        trimmed.startsWith('<ul') ||
        trimmed.startsWith('<ol') ||
        trimmed.startsWith('<pre') ||
        trimmed.startsWith('<blockquote') ||
        trimmed.startsWith('<hr')
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, '<br />')}</p>`;
    })
    .join('\n');

  return html;
}
