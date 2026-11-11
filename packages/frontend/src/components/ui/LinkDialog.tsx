/**
 * LinkDialog - Dialog for creating website links
 *
 * A modal dialog for entering a URL to create a new link item.
 * Styled like Mac OS 8 system dialogs.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import styles from './LinkDialog.module.css';

interface LinkDialogProps {
  onSubmit: (url: string, name: string) => void;
  onCancel: () => void;
}

/**
 * Classic Mac OS Link Dialog
 * - URL input field
 * - Optional name field
 * - Create and Cancel buttons
 */
export function LinkDialog({ onSubmit, onCancel }: LinkDialogProps) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus URL input on mount
  useEffect(() => {
    urlInputRef.current?.focus();
  }, []);

  // Validate URL
  const validateUrl = useCallback((urlString: string): boolean => {
    if (!urlString.trim()) {
      setError('Please enter a URL');
      return false;
    }

    // Add protocol if missing
    let testUrl = urlString.trim();
    if (!testUrl.startsWith('http://') && !testUrl.startsWith('https://')) {
      testUrl = 'https://' + testUrl;
    }

    try {
      new URL(testUrl);
      setError(null);
      return true;
    } catch {
      setError('Please enter a valid URL');
      return false;
    }
  }, []);

  // Handle form submission
  const handleSubmit = useCallback(() => {
    let finalUrl = url.trim();

    // Add protocol if missing
    if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = 'https://' + finalUrl;
    }

    if (!validateUrl(finalUrl)) {
      return;
    }

    // Generate name from URL if not provided
    let finalName = name.trim();
    if (!finalName) {
      try {
        const urlObj = new URL(finalUrl);
        finalName = urlObj.hostname.replace(/^www\./, '');
      } catch {
        finalName = 'Link';
      }
    }

    onSubmit(finalUrl, finalName);
  }, [url, name, validateUrl, onSubmit]);

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [onCancel, handleSubmit]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Prevent background interaction
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onCancel();
      }
    },
    [onCancel]
  );

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="link-dialog-title">
        <div className={styles.header}>
          <div className={styles.icon}>
            <svg width="32" height="32" viewBox="0 0 32 32">
              {/* Globe icon */}
              <circle cx="16" cy="16" r="12" fill="var(--control-bg, #fff)" stroke="var(--control-border, #000)" strokeWidth="2"/>
              <ellipse cx="16" cy="16" rx="5" ry="12" fill="none" stroke="var(--text, #000)" strokeWidth="1.5"/>
              <line x1="4" y1="16" x2="28" y2="16" stroke="var(--text, #000)" strokeWidth="1.5"/>
              <ellipse cx="16" cy="10" rx="9" ry="3" fill="none" stroke="var(--text, #000)" strokeWidth="1"/>
              <ellipse cx="16" cy="22" rx="9" ry="3" fill="none" stroke="var(--text, #000)" strokeWidth="1"/>
            </svg>
          </div>
          <div id="link-dialog-title" className={styles.title}>New Link</div>
        </div>

        <div className={styles.content}>
          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="link-url">
              URL:
            </label>
            <input
              ref={urlInputRef}
              id="link-url"
              type="text"
              className={styles.input}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="link-name">
              Name:
            </label>
            <input
              id="link-name"
              type="text"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="(optional - auto-generated from URL)"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </div>

        <div className={styles.buttons}>
          <button type="button" className={styles.button} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={`${styles.button} ${styles.primaryButton}`} onClick={handleSubmit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
