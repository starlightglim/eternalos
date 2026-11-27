/**
 * ShareDialog - Share Desktop Window
 *
 * Allows users to generate share cards and copy/download their desktop URL
 * for sharing on social media. Features:
 * - Preview of the og:image
 * - Copy link button
 * - Download share card button
 * - Social sharing links
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '../../stores/authStore';
import styles from './ShareDialog.module.css';

interface ShareDialogProps {
  isOwner?: boolean;
}

export function ShareDialog({ isOwner = true }: ShareDialogProps) {
  const { profile, setShareDescription } = useAuthStore();
  const [copied, setCopied] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [description, setDescription] = useState(profile?.shareDescription || '');
  const [descSaving, setDescSaving] = useState(false);
  const [descSaved, setDescSaved] = useState(false);
  const [descError, setDescError] = useState<string | null>(null);
  const descTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** The debounced value not yet sent; flushed if the dialog closes first. */
  const pendingDescRef = useRef<string | null>(null);

  const username = profile?.username;
  const shareUrl = username ? `${window.location.origin}/@${username}` : '';
  const apiBase = import.meta.env.VITE_API_URL || '';
  const ogImageUrl = username ? `${apiBase}/api/og/${username}.png` : '';

  // Sync description from profile
  useEffect(() => {
    setDescription(profile?.shareDescription || '');
  }, [profile?.shareDescription]);

  // Reset copied state after 2 seconds
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [copied]);

  // Reset descSaved state after 2 seconds
  useEffect(() => {
    if (descSaved) {
      const timer = setTimeout(() => setDescSaved(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [descSaved]);

  /**
   * Save the share description through the auth store. `setShareDescription`
   * resolves false when the server refused the change (offline / 401 / 429 /
   * 500) and has already rolled the profile back — in that case say so
   * instead of showing "Saved". The user's text stays in the editor as an
   * unsaved draft.
   */
  const saveDescription = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (trimmed === (profile?.shareDescription || '')) return;

    setDescSaving(true);
    setDescError(null);
    try {
      const saved = await setShareDescription(trimmed);
      if (!saved) {
        setDescError('Could not save. Your edit is kept — try again.');
        return;
      }
      setDescSaved(true);
    } finally {
      setDescSaving(false);
    }
  }, [profile?.shareDescription, setShareDescription]);

  const handleSaveDescription = useCallback(() => {
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = undefined;
    pendingDescRef.current = null;
    void saveDescription(description);
  }, [description, saveDescription]);

  // Closing the dialog while the debounce is pending would drop the edit:
  // flush it instead (setShareDescription lives in the auth store, so it
  // completes after this component is gone).
  const flushRef = useRef(saveDescription);
  flushRef.current = saveDescription;
  useEffect(() => () => {
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = undefined;
    const pending = pendingDescRef.current;
    pendingDescRef.current = null;
    if (pending !== null) void flushRef.current(pending);
  }, []);

  // Auto-save description on blur or after typing stops (debounce)
  const handleDescriptionChange = useCallback((value: string) => {
    if (value.length > 200) return;
    setDescription(value);
    setDescError(null);
    // Clear existing timer
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    // Auto-save after 1.5s of no typing
    pendingDescRef.current = value;
    descTimerRef.current = setTimeout(() => {
      descTimerRef.current = undefined;
      pendingDescRef.current = null;
      void saveDescription(value);
    }, 1500);
  }, [saveDescription]);

  const handleCopyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
    }
  }, [shareUrl]);

  const handleDownloadImage = useCallback(async () => {
    if (!ogImageUrl) return;
    try {
      const response = await fetch(ogImageUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${username}-desktop.svg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to download image:', error);
    }
  }, [ogImageUrl, username]);

  const handleShareTwitter = useCallback(() => {
    const text = `Check out my personal desktop on EternalOS`;
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`;
    window.open(url, '_blank', 'noopener,noreferrer,width=600,height=400');
  }, [shareUrl]);

  if (!isOwner || !username) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>
          <p>You need to be logged in to share your desktop.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      {/* Preview Section */}
      <div className={styles.previewSection}>
        <div className={styles.sectionLabel}>Preview</div>
        <div className={styles.previewContainer}>
          {!imageLoaded && !imageError && (
            <div className={styles.loadingPreview}>Loading preview...</div>
          )}
          {imageError && (
            <div className={styles.errorPreview}>Failed to load preview</div>
          )}
          <img
            src={ogImageUrl}
            alt="Desktop preview"
            className={`${styles.previewImage} ${imageLoaded ? styles.visible : ''}`}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageError(true)}
          />
        </div>
        <div className={styles.previewHint}>
          This is how your desktop appears when shared on social media.
        </div>
      </div>

      {/* Description Section */}
      <div className={styles.descriptionSection}>
        <div className={styles.sectionLabel}>
          Share Description
          {descSaving && <span className={styles.savingIndicator}> Saving...</span>}
          {descSaved && !descSaving && !descError && <span className={styles.savedIndicator}> Saved</span>}
          {descError && !descSaving && <span className={styles.saveErrorIndicator} role="alert"> {descError}</span>}
        </div>
        <textarea
          className={styles.descriptionInput}
          placeholder="Describe your desktop for link previews (max 200 chars)"
          value={description}
          onChange={(e) => handleDescriptionChange(e.target.value)}
          onBlur={handleSaveDescription}
          maxLength={200}
          rows={3}
        />
        <div className={styles.descriptionHint}>
          {description.length}/200 - Shown in link previews on social media, Discord, Slack, etc.
        </div>
      </div>

      {/* URL Section */}
      <div className={styles.urlSection}>
        <div className={styles.sectionLabel}>Your Desktop URL</div>
        <div className={styles.urlContainer}>
          <input
            type="text"
            value={shareUrl}
            readOnly
            className={styles.urlInput}
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button
            className={`${styles.copyButton} ${copied ? styles.copied : ''}`}
            onClick={handleCopyLink}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Share Buttons Section */}
      <div className={styles.shareSection}>
        <div className={styles.sectionLabel}>Share</div>
        <div className={styles.shareButtons}>
          <button className={styles.shareButton} onClick={handleShareTwitter}>
            <TwitterIcon />
            <span>Share on X</span>
          </button>
          <button className={styles.shareButton} onClick={handleDownloadImage}>
            <DownloadIcon />
            <span>Download Image</span>
          </button>
        </div>
      </div>

      {/* Info Section */}
      <div className={styles.infoSection}>
        <div className={styles.infoIcon}>
          <InfoIcon />
        </div>
        <div className={styles.infoText}>
          Anyone with your link can view your public items. Private items remain hidden.
        </div>
      </div>
    </div>
  );
}

// Icon components (simple pixel-art style)
function TwitterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={styles.icon}>
      <path
        d="M12.6 1h2.4l-5.3 6.1 6.2 8.3h-4.9l-3.8-5-4.4 5H.5l5.7-6.5L.1 1h5l3.4 4.5L12.6 1zm-.9 12.9h1.4L4.5 2.5H3l8.7 11.4z"
        fill="currentColor"
      />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className={styles.icon}>
      <path
        d="M8 1v8M8 9l-3-3M8 9l3-3M2 12v2h12v-2"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className={styles.icon}>
      <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" fill="none" />
      <line x1="7" y1="6" x2="7" y2="10" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="4" r="0.75" fill="currentColor" />
    </svg>
  );
}
