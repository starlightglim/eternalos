import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { getFileUrl } from '../../services/api';
import { useFileTokenVersion } from '../../hooks/useFileToken';
import { getTextFileContentType, type DesktopItem } from '../../types';
import { searchItems, getLocationName } from '../../utils/search';
import styles from './SearchWindow.module.css';

function formatSummary(summary: string): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'folder':
      return 'Folder';
    case 'image':
      return 'Image';
    case 'text':
      return 'Text';
    case 'link':
      return 'Link';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'pdf':
      return 'PDF';
    case 'widget':
      return 'Widget';
    case 'sticker':
      return 'Sticker';
    default:
      return 'Item';
  }
}

function getPreviewUrl(item: DesktopItem): string | null {
  if (item.type !== 'image') return null;
  const previewKey = item.thumbnailKey || item.r2Key;
  return previewKey ? getFileUrl(previewKey) : null;
}

export function SearchWindow() {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const { items } = useDesktopStore();
  const { openWindow, windows, closeWindow, focusWindow } = useWindowStore();
  const inputRef = useRef<HTMLInputElement>(null);
  // Re-render preview thumbnails when the file token rotates.
  useFileTokenVersion();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const results = useMemo(() => searchItems(items, query), [items, query]);

  const closeSearchWindow = useCallback(() => {
    const searchWindow = windows.find((window) => window.contentType === 'search');
    if (searchWindow) {
      closeWindow(searchWindow.id);
    }
  }, [closeWindow, windows]);

  const handleOpenItem = useCallback(
    (item: DesktopItem) => {
      if (item.type === 'folder') {
        openWindow({
          id: `folder-${item.id}`,
          title: item.name,
          position: { x: 120, y: 96 },
          size: { width: 430, height: 320 },
          minimized: false,
          maximized: false,
          contentType: 'folder',
          contentId: item.id,
        });
      } else if (item.type === 'text') {
        const contentType = getTextFileContentType(item.name);
        openWindow({
          id: `text-${item.id}`,
          title: item.name,
          position: { x: 120, y: 96 },
          size: { width: 520, height: 420 },
          minimized: false,
          maximized: false,
          contentType,
          contentId: item.id,
        });
      } else if (item.type === 'image') {
        openWindow({
          id: `image-${item.id}`,
          title: item.name,
          position: { x: 120, y: 96 },
          size: { width: 520, height: 420 },
          minimized: false,
          maximized: false,
          contentType: 'image',
          contentId: item.id,
        });
      } else if (item.type === 'video') {
        openWindow({
          id: `video-${item.id}`,
          title: item.name,
          position: { x: 120, y: 96 },
          size: { width: 680, height: 480 },
          minimized: false,
          maximized: false,
          contentType: 'video',
          contentId: item.id,
        });
      } else if (item.type === 'audio') {
        openWindow({
          id: `audio-${item.id}`,
          title: item.name,
          position: { x: 120, y: 96 },
          size: { width: 360, height: 240 },
          minimized: false,
          maximized: false,
          contentType: 'audio',
          contentId: item.id,
        });
      } else if (item.type === 'pdf') {
        openWindow({
          id: `pdf-${item.id}`,
          title: item.name,
          position: { x: 100, y: 72 },
          size: { width: 620, height: 720 },
          minimized: false,
          maximized: false,
          contentType: 'pdf',
          contentId: item.id,
        });
      } else if (item.type === 'link') {
        openWindow({
          id: `link-${item.id}`,
          title: item.name,
          position: { x: 100, y: 72 },
          size: { width: 820, height: 620 },
          minimized: false,
          maximized: false,
          contentType: 'link',
          contentId: item.id,
        });
      } else if (item.type === 'widget') {
        openWindow({
          id: `widget-${item.id}`,
          title: item.name,
          position: { x: 120, y: 96 },
          size: { width: 300, height: 260 },
          minimized: false,
          maximized: false,
          contentType: 'widget',
          contentId: item.id,
        });
      }

      closeSearchWindow();
    },
    [closeSearchWindow, openWindow]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, Math.max(0, results.length - 1)));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (e.key === 'Enter' && results[activeIndex]) {
        e.preventDefault();
        handleOpenItem(results[activeIndex].item);
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchWindow();
      }
    },
    [activeIndex, closeSearchWindow, handleOpenItem, results]
  );

  const topResult = results[activeIndex];

  useEffect(() => {
    if (!topResult) return;
    const itemWindowId = `${topResult.item.type}-${topResult.item.id}`;
    if (windows.some((window) => window.id === itemWindowId)) {
      focusWindow(itemWindowId);
    }
  }, [focusWindow, topResult, windows]);

  return (
    <div className={styles.searchWindow}>
      <div className={styles.searchChrome}>
        <div className={styles.inputShell}>
          <span className={styles.searchGlyph}>⌕</span>
          <input
            ref={inputRef}
            type="text"
            className={styles.searchInput}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search names, tags, captions, OCR text, colors..."
            autoFocus
          />
          <span className={styles.shortcutHint}>⌘F</span>
        </div>

        {query.trim() === '' ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>Search your desktop</div>
            <div className={styles.emptyCopy}>
              Match filenames, notes, links, image captions, tags, detected text, and dominant colors.
            </div>
          </div>
        ) : results.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>No results for "{query}"</div>
            <div className={styles.emptyCopy}>
              Try a filename, a tag like <code>street</code>, a color like <code>#87CEEB</code>, or text that appears inside an image.
            </div>
          </div>
        ) : (
          <div className={styles.resultsPanel}>
            <div className={styles.resultsMeta}>
              <span>{results.length} match{results.length === 1 ? '' : 'es'}</span>
              <span>Enter to open</span>
            </div>

            <div className={styles.resultsList}>
              {results.map((result, index) => (
                <button
                  key={result.item.id}
                  type="button"
                  className={`${styles.resultItem} ${index === activeIndex ? styles.activeResult : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => handleOpenItem(result.item)}
                >
                  <div className={styles.resultBody}>
                    {getPreviewUrl(result.item) ? (
                      <div className={styles.resultPreviewFrame}>
                        <img
                          src={getPreviewUrl(result.item)!}
                          alt={result.item.name}
                          className={styles.resultPreviewImage}
                          loading="lazy"
                        />
                      </div>
                    ) : null}

                    <div className={styles.resultContent}>
                      <div className={styles.resultHeader}>
                        <span className={styles.resultKind}>{getTypeIcon(result.item.type)}</span>
                        <span className={styles.resultName}>{result.item.name}</span>
                        <span className={styles.resultLocation}>{getLocationName(result.item, items)}</span>
                      </div>

                      {result.summary && (
                        <div className={styles.resultSummary}>{formatSummary(result.summary)}</div>
                      )}

                      <div className={styles.matchTags}>
                        {result.matchedIn.map((match) => (
                          <span key={`${result.item.id}-${match}`} className={styles.matchTag}>
                            {match}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
