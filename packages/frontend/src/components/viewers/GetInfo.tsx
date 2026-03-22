import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import {
  FolderIcon,
  TextFileIcon,
  ImageFileIcon,
  LinkIcon,
} from '../icons/PixelIcons';
import { renderCustomIcon, CUSTOM_ICON_LIBRARY, type CustomIconId } from '../icons/customIconUtils';
import { getCustomIconUrl } from '../../services/api';
import type { DesktopItem } from '../../types';
import styles from './GetInfo.module.css';

interface GetInfoProps {
  item: DesktopItem;
  isOwner?: boolean;
}

/**
 * GetInfo - Classic Mac OS "Get Info" window
 * Shows file/folder properties with editable visibility toggle
 * Features:
 * - Large icon display
 * - Editable name field (owner only)
 * - Kind, size, dates
 * - Public checkbox toggle (owner only)
 */
export function GetInfo({ item, isOwner = true }: GetInfoProps) {
  const [isPublic, setIsPublic] = useState(item.isPublic);
  const [name, setName] = useState(item.name);
  const [isEditingName, setIsEditingName] = useState(false);
  const [retryingAnalysis, setRetryingAnalysis] = useState(false);
  const [addingTag, setAddingTag] = useState(false);
  const [newTagValue, setNewTagValue] = useState('');
  const [editingTagIndex, setEditingTagIndex] = useState<number | null>(null);
  const [editingTagValue, setEditingTagValue] = useState('');
  const nameInputRef = useRef<HTMLInputElement>(null);
  const { updateItem, items, requestImageAnalysis } = useDesktopStore();

  // Get the appropriate icon for this item type
  // Custom icon takes precedence if set
  const hasUploadedIcon = item.customIcon?.startsWith('upload:');
  const hasLibraryIcon = item.customIcon && CUSTOM_ICON_LIBRARY[item.customIcon as CustomIconId];
  const locationLabel = item.parentId
    ? items.find((i) => i.id === item.parentId)?.name || 'Unknown folder'
    : null;

  // Format the file size
  const sizeDisplay = item.fileSize ? formatFileSize(item.fileSize) : '--';

  // Format dates
  const createdDate = new Date(item.createdAt).toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const modifiedDate = new Date(item.updatedAt).toLocaleDateString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  // Get the "kind" description
  const kindDisplay = getKindDescription(item);
  const displayTags = useMemo(
    () => item.userTags ?? item.imageAnalysis?.tags ?? [],
    [item.imageAnalysis?.tags, item.userTags]
  );

  // Handle visibility toggle
  const handlePublicToggle = useCallback(() => {
    if (!isOwner) return;
    const newValue = !isPublic;
    setIsPublic(newValue);
    updateItem(item.id, { isPublic: newValue });
  }, [isOwner, isPublic, updateItem, item.id]);

  useEffect(() => {
    setName(item.name);
  }, [item.name]);

  useEffect(() => {
    setIsPublic(item.isPublic);
  }, [item.isPublic]);

  useEffect(() => {
    if (!isEditingName || !nameInputRef.current) return;
    nameInputRef.current.focus();
    nameInputRef.current.select();
  }, [isEditingName]);

  // Handle name edit
  const { updateWindowTitle } = useWindowStore();
  const handleNameCommit = useCallback(() => {
    setIsEditingName(false);
    const trimmed = name.trim();
    if (trimmed && trimmed !== item.name) {
      updateItem(item.id, { name: trimmed });

      const { windows } = useWindowStore.getState();
      windows
        .filter((window) => window.contentId === item.id)
        .forEach((window) => {
          updateWindowTitle(
            window.id,
            window.contentType === 'get-info' ? `${trimmed} Info` : trimmed
          );
        });
    } else {
      setName(item.name); // Reset if empty
    }
  }, [name, item.name, item.id, updateItem, updateWindowTitle]);

  const handleStartNameEdit = useCallback(() => {
    if (!isOwner) return;
    setName(item.name);
    setIsEditingName(true);
  }, [isOwner, item.name]);

  const handleCancelNameEdit = useCallback(() => {
    setName(item.name);
    setIsEditingName(false);
  }, [item.name]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleNameCommit();
      } else if (e.key === 'Escape') {
        handleCancelNameEdit();
      }
    },
    [handleCancelNameEdit, handleNameCommit]
  );

  useEffect(() => {
    if (!isOwner || item.type !== 'image') return;

    if (!item.imageAnalysis) {
      void requestImageAnalysis(item.id);
    }
  }, [isOwner, item.id, item.imageAnalysis, item.type, requestImageAnalysis]);

  useEffect(() => {
    if (editingTagIndex !== null && !displayTags[editingTagIndex]) {
      setEditingTagIndex(null);
      setEditingTagValue('');
    }
  }, [displayTags, editingTagIndex]);

  const handleRetryAnalysis = useCallback(async () => {
    if (!isOwner || item.type !== 'image' || retryingAnalysis) return;

    setRetryingAnalysis(true);
    try {
      await requestImageAnalysis(item.id);
    } finally {
      setRetryingAnalysis(false);
    }
  }, [isOwner, item.id, item.type, requestImageAnalysis, retryingAnalysis]);

  const normalizeTags = useCallback((tags: string[]) => {
    return Array.from(
      new Set(
        tags
          .map((tag) => tag.trim().toLowerCase().replace(/\s+/g, ' '))
          .filter(Boolean)
      )
    ).slice(0, 12);
  }, []);

  const saveDisplayTags = useCallback((nextTags: string[]) => {
    if (!isOwner) return;
    updateItem(item.id, { userTags: normalizeTags(nextTags) });
  }, [isOwner, item.id, normalizeTags, updateItem]);

  const handleAddTag = useCallback(() => {
    const normalized = newTagValue.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!normalized) {
      setAddingTag(false);
      setNewTagValue('');
      return;
    }

    saveDisplayTags([...displayTags, normalized]);
    setAddingTag(false);
    setNewTagValue('');
  }, [displayTags, newTagValue, saveDisplayTags]);

  const handleDeleteTag = useCallback((tagToDelete: string) => {
    saveDisplayTags(displayTags.filter((tag) => tag !== tagToDelete));
  }, [displayTags, saveDisplayTags]);

  const handleStartEditTag = useCallback((index: number) => {
    if (!isOwner) return;
    setEditingTagIndex(index);
    setEditingTagValue(displayTags[index] || '');
  }, [displayTags, isOwner]);

  const handleCommitEditTag = useCallback(() => {
    if (editingTagIndex === null) return;

    const normalized = editingTagValue.trim().toLowerCase().replace(/\s+/g, ' ');
    const nextTags = [...displayTags];

    if (!normalized) {
      nextTags.splice(editingTagIndex, 1);
    } else {
      nextTags[editingTagIndex] = normalized;
    }

    saveDisplayTags(nextTags);
    setEditingTagIndex(null);
    setEditingTagValue('');
  }, [displayTags, editingTagIndex, editingTagValue, saveDisplayTags]);

  return (
    <div className={styles.getInfo}>
      {/* Header with icon and name */}
      <div className={styles.header}>
        <div className={styles.iconContainer}>
          {hasUploadedIcon ? (
            <img
              src={getCustomIconUrl(item.customIcon!)}
              alt={item.name}
              width={48}
              height={48}
              style={{ imageRendering: 'pixelated' }}
            />
          ) : hasLibraryIcon ? (
            renderCustomIcon(item.customIcon!, 48)
          ) : (
            renderTypeIcon(item.type, 48)
          )}
        </div>
        <div className={styles.nameContainer}>
          {isOwner && isEditingName ? (
            <div className={styles.nameEditorRow}>
              <input
                ref={nameInputRef}
                type="text"
                className={styles.nameInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={handleNameCommit}
                onKeyDown={handleNameKeyDown}
              />
              <button
                type="button"
                className={styles.nameActionButton}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleNameCommit}
              >
                Save
              </button>
              <button
                type="button"
                className={styles.nameActionButton}
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCancelNameEdit}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div
              className={styles.nameDisplayRow}
              onDoubleClick={handleStartNameEdit}
              title={isOwner ? 'Double-click to edit' : undefined}
            >
              <span
                className={styles.name}
              >
                {item.name}
              </span>
              {isOwner && (
                <button
                  type="button"
                  className={styles.nameActionButton}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={handleStartNameEdit}
                >
                  Rename
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className={styles.divider} />

      {/* Info table */}
      <div className={styles.infoTable}>
        <InfoRow label="Kind" value={kindDisplay} />
        <InfoRow label="Size" value={sizeDisplay} />
        {item.type === 'image' && (
          <InfoRow
            label="Limit"
            value={
              <span className={item.fileSize && item.fileSize > 10 * 1024 * 1024 ? styles.warningText : undefined}>
                {item.fileSize && item.fileSize > 10 * 1024 * 1024 ? 'Exceeds 10MB limit' : '10MB max per image'}
              </span>
            }
          />
        )}
        {item.type === 'text' && item.textContent && (
          <InfoRow
            label="Chars"
            value={`${item.textContent.length.toLocaleString()} / 100,000`}
          />
        )}
        {item.mimeType && <InfoRow label="Type" value={item.mimeType} />}
        {item.url && (
          <InfoRow
            label="URL"
            value={
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.link}
              >
                {truncateUrl(item.url)}
              </a>
            }
          />
        )}
      </div>

      {/* Divider */}
      <div className={styles.divider} />

      {/* Dates section */}
      <div className={styles.infoTable}>
        <InfoRow label="Created" value={createdDate} />
        <InfoRow label="Modified" value={modifiedDate} />
      </div>

      <div className={styles.divider} />
      <div className={styles.infoTable}>
        <div className={styles.infoRow}>
          <span className={styles.infoLabel}>Tags:</span>
          <div className={styles.infoValue}>
            <div className={styles.tagsEditor}>
              <div className={styles.tagsHeader}>
                <span className={styles.tagsHint}>
                  {isOwner ? 'Double-click a tag to rename it.' : 'Image tags'}
                </span>
              </div>

              <div className={styles.tagsSurface}>
                <div className={styles.tagList}>
                {displayTags.length === 0 && !addingTag ? (
                  <span className={styles.emptyValue}>No tags yet</span>
                ) : null}

                {displayTags.map((tag, index) => (
                  editingTagIndex === index ? (
                    <input
                      key={`edit-${tag}-${index}`}
                      type="text"
                      className={styles.tagInputPill}
                      value={editingTagValue}
                      onChange={(e) => setEditingTagValue(e.target.value)}
                      onBlur={handleCommitEditTag}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleCommitEditTag();
                        } else if (e.key === 'Escape') {
                          setEditingTagIndex(null);
                          setEditingTagValue('');
                        }
                      }}
                      autoFocus
                    />
                  ) : (
                    <span
                      key={`${tag}-${index}`}
                      className={styles.tagChipEditable}
                      onDoubleClick={() => handleStartEditTag(index)}
                    >
                      <span>{tag}</span>
                      {isOwner && (
                        <button
                          type="button"
                          className={styles.tagRemoveButton}
                          onClick={() => handleDeleteTag(tag)}
                          aria-label={`Remove ${tag}`}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  )
                ))}

                {isOwner && addingTag && (
                  <input
                    type="text"
                    className={styles.tagInputPill}
                    value={newTagValue}
                    onChange={(e) => setNewTagValue(e.target.value)}
                    onBlur={handleAddTag}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddTag();
                      } else if (e.key === 'Escape') {
                        setAddingTag(false);
                        setNewTagValue('');
                      }
                    }}
                    placeholder="new tag"
                    autoFocus
                  />
                )}

                {isOwner && !addingTag && (
                  <button
                    type="button"
                    className={styles.addTagButton}
                    onClick={() => {
                      setAddingTag(true);
                      setEditingTagIndex(null);
                    }}
                    aria-label="Add tag"
                  >
                    <span className={styles.addTagGlyph}>+</span>
                    <span>Add tag</span>
                  </button>
                )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {item.type === 'image' && item.imageAnalysis && (
        <>
          <div className={styles.divider} />
          <div className={styles.infoTable}>
            <InfoRow
              label="Analysis"
              value={item.imageAnalysis.status === 'complete'
                ? 'Ready'
                : item.imageAnalysis.status === 'pending'
                  ? 'Analyzing...'
                  : item.imageAnalysis.status === 'skipped'
                    ? 'Skipped'
                    : 'Failed'}
            />
            {item.imageAnalysis.caption && (
              <InfoRow label="Caption" value={item.imageAnalysis.caption} />
            )}
            {item.imageAnalysis.dominantColors && item.imageAnalysis.dominantColors.length > 0 && (
              <InfoRow
                label="Colors"
                value={
                  <div className={styles.colorList}>
                    {item.imageAnalysis.dominantColors.map((color) => (
                      <span key={color} className={styles.colorChip}>
                        <span className={styles.colorSwatch} style={{ backgroundColor: color }} />
                        {color}
                      </span>
                    ))}
                  </div>
                }
              />
            )}
            {item.imageAnalysis.detectedText && item.imageAnalysis.detectedText.length > 0 && (
              <InfoRow label="Text" value={item.imageAnalysis.detectedText.join(', ')} />
            )}
            {item.imageAnalysis.error && (
              <InfoRow label="Note" value={<span className={styles.warningText}>{item.imageAnalysis.error}</span>} />
            )}
            {isOwner && (item.imageAnalysis.status === 'failed' || item.imageAnalysis.status === 'skipped') && (
              <InfoRow
                label="Retry"
                value={
                  <button
                    type="button"
                    className={styles.retryButton}
                    onClick={() => void handleRetryAnalysis()}
                    disabled={retryingAnalysis}
                  >
                    {retryingAnalysis ? 'Retrying...' : 'Run analysis again'}
                  </button>
                }
              />
            )}
          </div>
        </>
      )}

      {/* Divider */}
      <div className={styles.divider} />

      {/* Visibility section (owner only) */}
      <div className={styles.visibilitySection}>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={isPublic}
            onChange={handlePublicToggle}
            disabled={!isOwner}
          />
          <span className={styles.checkboxText}>
            Visible to visitors
          </span>
        </label>
        <p className={styles.visibilityHint}>
          {isPublic
            ? 'This item can be seen by anyone who visits your desktop.'
            : 'This item is private and only visible to you.'}
        </p>
      </div>

      {/* Location info */}
      {item.parentId && (
        <>
          <div className={styles.divider} />
          <div className={styles.infoTable}>
            <InfoRow label="Location" value={locationLabel} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Single row in the info table
 */
function InfoRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}:</span>
      <span className={styles.infoValue}>{value}</span>
    </div>
  );
}

/**
 * Get the appropriate icon component for an item type
 */
function renderTypeIcon(type: string, size: number) {
  switch (type) {
    case 'folder':
      return <FolderIcon size={size} />;
    case 'text':
      return <TextFileIcon size={size} />;
    case 'image':
      return <ImageFileIcon size={size} />;
    case 'link':
      return <LinkIcon size={size} />;
    default:
      return <TextFileIcon size={size} />;
  }
}

/**
 * Get a human-readable "kind" description
 */
function getKindDescription(item: DesktopItem): string {
  switch (item.type) {
    case 'folder':
      return 'Folder';
    case 'text':
      return 'Text Document';
    case 'image':
      if (item.mimeType) {
        const format = item.mimeType.split('/')[1]?.toUpperCase() || 'Image';
        return `${format} Image`;
      }
      return 'Image';
    case 'link':
      return 'Internet Location';
    default:
      return 'Document';
  }
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Truncate a URL for display
 */
function truncateUrl(url: string, maxLength = 40): string {
  if (url.length <= maxLength) return url;
  return url.substring(0, maxLength - 3) + '...';
}
