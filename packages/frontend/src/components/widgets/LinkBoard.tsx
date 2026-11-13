/**
 * LinkBoard Widget - Grid of bookmarks with labels
 *
 * Features:
 * - 3-column grid of links
 * - Custom labels for each link
 * - Optional favicon display
 * - Click opens in new tab
 */

import { useState, useCallback, useMemo } from 'react';
import type { LinkBoardConfig, LinkBoardLink } from '../../types';
import { openExternalUrl } from '../../utils/safeUrl';
import { useDesktopStore } from '../../stores/desktopStore';
import styles from './LinkBoard.module.css';

interface LinkBoardProps {
  itemId: string;
  config?: LinkBoardConfig;
  isOwner: boolean;
  onConfigUpdate?: (config: LinkBoardConfig) => void;
}

export function LinkBoard({ itemId, config, isOwner, onConfigUpdate }: LinkBoardProps) {
  const updateItem = useDesktopStore((state) => state.updateItem);

  const links = useMemo(() => config?.links || [], [config?.links]);

  const [isAdding, setIsAdding] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  const saveConfig = useCallback(
    (newLinks: LinkBoardLink[]) => {
      const newConfig: LinkBoardConfig = { links: newLinks };
      updateItem(itemId, { widgetConfig: newConfig });
      onConfigUpdate?.(newConfig);
    },
    [itemId, updateItem, onConfigUpdate]
  );

  const addLink = useCallback(() => {
    if (!editTitle.trim() || !editUrl.trim()) return;

    let url = editUrl.trim();
    // Add protocol if missing
    if (!url.match(/^https?:\/\//)) {
      url = 'https://' + url;
    }

    const newLink: LinkBoardLink = {
      title: editTitle.trim(),
      url,
    };

    if (editingIndex !== null) {
      // Update existing link
      const newLinks = [...links];
      newLinks[editingIndex] = newLink;
      saveConfig(newLinks);
    } else {
      // Add new link
      saveConfig([...links, newLink]);
    }

    setEditTitle('');
    setEditUrl('');
    setIsAdding(false);
    setEditingIndex(null);
  }, [editTitle, editUrl, editingIndex, links, saveConfig]);

  const removeLink = useCallback(
    (index: number) => {
      const newLinks = links.filter((_, i) => i !== index);
      saveConfig(newLinks);
    },
    [links, saveConfig]
  );

  const editLink = useCallback(
    (index: number) => {
      const link = links[index];
      setEditTitle(link.title);
      setEditUrl(link.url);
      setEditingIndex(index);
      setIsAdding(true);
    },
    [links]
  );

  const cancelEdit = useCallback(() => {
    setEditTitle('');
    setEditUrl('');
    setIsAdding(false);
    setEditingIndex(null);
  }, []);

  const getFaviconUrl = (url: string) => {
    try {
      const hostname = new URL(url).hostname;
      return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
    } catch {
      return null;
    }
  };

  const handleLinkClick = (e: React.MouseEvent, url: string) => {
    // Prevent click if we're in edit mode
    if (isAdding) {
      e.preventDefault();
      return;
    }
    // SECURITY: only open http(s) URLs. The editor prepends https://, but
    // widgetConfig is stored without server-side scheme validation, so a link
    // set directly via the API could carry a `javascript:` URL — opening that
    // (esp. on a public board a visitor clicks) is an XSS risk.
    openExternalUrl(url);
  };

  return (
    <div className={styles.linkBoard}>
      {/* Links grid */}
      <div className={styles.grid}>
        {links.length === 0 && !isAdding ? (
          <div className={styles.empty}>
            {isOwner ? 'Click below to add links' : 'No links added yet'}
          </div>
        ) : (
          links.map((link, index) => (
            <div
              key={`${link.url}-${index}`}
              className={styles.linkItem}
              onClick={(e) => handleLinkClick(e, link.url)}
            >
              <div className={styles.linkIcon}>
                <img
                  src={getFaviconUrl(link.url) || ''}
                  alt=""
                  className={styles.favicon}
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                <span className={styles.defaultIcon}>🔗</span>
              </div>
              <span className={styles.linkTitle}>{link.title}</span>
              {isOwner && (
                <div className={styles.linkActions}>
                  <button
                    className={styles.editButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      editLink(index);
                    }}
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    className={styles.removeButton}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeLink(index);
                    }}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Add/Edit form (owner only) */}
      {isOwner && (
        <div className={styles.addSection}>
          {isAdding ? (
            <div className={styles.addForm}>
              <input
                type="text"
                className={styles.addInput}
                placeholder="Link title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
              <input
                type="url"
                className={styles.addInput}
                placeholder="URL (e.g., https://example.com)"
                value={editUrl}
                onChange={(e) => setEditUrl(e.target.value)}
              />
              <div className={styles.addButtons}>
                <button className={styles.saveButton} onClick={addLink}>
                  {editingIndex !== null ? 'Update' : 'Add'}
                </button>
                <button className={styles.cancelButton} onClick={cancelEdit}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className={styles.addLinkButton}
              onClick={() => setIsAdding(true)}
            >
              + Add Link
            </button>
          )}
        </div>
      )}
    </div>
  );
}
