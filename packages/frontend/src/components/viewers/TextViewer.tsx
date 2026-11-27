import { useState, useEffect, useRef, useCallback } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { isApiConfigured } from '../../services/api';
import { ContextMenu, type ContextMenuItem } from '../ui';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { createAutosave } from '../../utils/autosave';
import styles from './TextViewer.module.css';

interface TextViewerProps {
  itemId: string;
  windowId: string;
  name: string;
  textContent?: string;
  isOwner?: boolean; // Whether current user owns this file
}

// 100KB character limit to prevent browser/storage performance issues
const MAX_TEXT_LENGTH = 100_000;
// Save this long after typing stops.
const AUTOSAVE_DELAY_MS = 1500;

/**
 * TextViewer - SimpleText clone
 * Features:
 * - Monaco font, white background, black text
 * - Editable for owner, read-only for visitor
 * - Auto-save after typing stops, on blur, on close, or Cmd+S
 * - Classic Mac scrollable text area
 */
export function TextViewer({
  itemId,
  windowId,
  name,
  textContent: initialContent = '',
  isOwner = true,
}: TextViewerProps) {
  const [content, setContent] = useState(initialContent);
  const [fileName, setFileName] = useState(name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // After a failed save, stop autosaving (each failure raises a global
  // "Sync Failed" alert) until the user retries or presses Cmd+S.
  const saveFailedRef = useRef(false);
  const contentRef = useRef(content);
  const isDirtyRef = useRef(isDirty);
  contentRef.current = content;
  isDirtyRef.current = isDirty;
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { updateItem } = useDesktopStore();
  const { updateWindowTitle } = useWindowStore();

  // Update content when prop changes
  useEffect(() => {
    if (isDirtyRef.current) return;
    setContent(initialContent);
    setIsDirty(false);
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

  // Save handler. Reads refs so the debounced autosave always saves the
  // latest text; one save runs at a time (see createAutosave).
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;
  const saveNow = useCallback(async () => {
    if (!isDirtyRef.current || !isOwner) return;
    const saving = contentRef.current;
    setIsSaving(true);
    setSaveFailed(false);
    saveFailedRef.current = false;
    try {
      // Update the desktop item with new content
      const saved = await updateItem(itemId, { textContent: saving });
      if (!saved) {
        saveFailedRef.current = true;
        setSaveFailed(true);
        return;
      }
      // A completed save must not mark newer typing as saved.
      if (contentRef.current === saving) {
        isDirtyRef.current = false;
        setIsDirty(false);
        updateWindowTitle(windowId, fileNameRef.current);
      }
    } catch (error) {
      console.error('Failed to save:', error);
      saveFailedRef.current = true;
      setSaveFailed(true);
    } finally {
      setIsSaving(false);
    }
  }, [isOwner, itemId, updateItem, windowId, updateWindowTitle]);

  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const [autosave] = useState(() => createAutosave(() => saveNowRef.current(), AUTOSAVE_DELAY_MS));
  const saveContent = useCallback(() => autosave.flush(), [autosave]);

  // Leaving the page with unsaved text asks first.
  useUnsavedGuard(isDirty);

  // Auto-save on unmount (e.g., when window is closed) if there are unsaved changes
  useEffect(() => {
    return () => {
      autosave.cancel();
      // flush() queues behind a save already running, so closing mid-save
      // sends one more write, not two.
      if (isDirtyRef.current && isOwner) {
        void autosave.flush().catch(() => {});
      }
    };
  }, [autosave, isOwner]);

  // Handle keyboard shortcuts — only save if this editor's textarea is focused
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+S or Ctrl+S to save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        // Only handle if our textarea is focused (prevents saving ALL open editors)
        if (document.activeElement === textareaRef.current) {
          e.preventDefault();
          void saveContent();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [saveContent]);

  // Handle content change
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!isOwner) return;
    const newValue = e.target.value;
    // Enforce size limit to prevent browser/storage performance issues
    if (newValue.length > MAX_TEXT_LENGTH) return;
    setContent(newValue);
    contentRef.current = newValue;
    isDirtyRef.current = true;
    if (!isDirty) {
      // First edit — show unsaved indicator in window title bar
      updateWindowTitle(windowId, `• ${fileName}`);
    }
    setIsDirty(true);
    if (!saveFailedRef.current) autosave.schedule();
  };

  // Auto-save on blur
  const handleBlur = () => {
    if (isDirtyRef.current && !saveFailedRef.current) {
      void saveContent();
    }
  };

  // Download the text file
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

  return (
    <div className={styles.textViewer} onContextMenu={handleContextMenu}>
      {/* Title bar with file info */}
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
        {isDirty && <span className={styles.unsaved}>•</span>}
        {isSaving && <span className={styles.saving}>Saving...</span>}
        {saveFailed && <button type="button" onClick={() => void saveContent()}>Save failed — Retry</button>}
        {!isOwner && <span className={styles.readOnly}>Read Only</span>}
      </div>

      {/* Text content area */}
      <div className={styles.content}>
        {isOwner ? (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={content}
            onChange={handleChange}
            onBlur={handleBlur}
            placeholder="Enter text..."
            spellCheck={false}
          />
        ) : (
          <div className={styles.readOnlyText}>
            {content || (
              <span className={styles.emptyText}>
                {isApiConfigured
                  ? 'No content'
                  : 'Demo mode: This is sample text content.'}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={content.length >= MAX_TEXT_LENGTH * 0.9 ? styles.charCountWarn : styles.charCount}>
            {content.length.toLocaleString()}{content.length >= MAX_TEXT_LENGTH * 0.9 ? ` / ${MAX_TEXT_LENGTH.toLocaleString()}` : ''} characters
          </span>
          <span className={styles.lineCount}>
            {content.split('\n').length} lines
          </span>
        </div>
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
