import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopStore } from '../../stores/desktopStore';
import { useWindowStore } from '../../stores/windowStore';
import { getFileUrl } from '../../services/api';
import { getTextFileContentType, type DesktopItem } from '../../types';
import styles from './SearchWindow.module.css';

interface SearchResult {
  item: DesktopItem;
  score: number;
  summary: string;
  matchedIn: string[];
}

const SEARCH_SYNONYMS: Record<string, string[]> = {
  road: ['street', 'highway', 'lane', 'path', 'route'],
  street: ['road', 'avenue', 'boulevard', 'lane'],
  car: ['vehicle', 'automobile', 'sedan', 'truck'],
  vehicle: ['car', 'truck', 'van', 'automobile'],
  portrait: ['person', 'face', 'selfie', 'headshot'],
  person: ['portrait', 'face', 'human', 'people'],
  city: ['urban', 'downtown', 'street', 'buildings'],
  urban: ['city', 'street', 'downtown'],
  ocean: ['sea', 'water', 'beach', 'coast'],
  beach: ['shore', 'coast', 'ocean', 'sand'],
  forest: ['woods', 'trees', 'nature'],
  mountain: ['peak', 'hill', 'alps', 'range'],
  flower: ['plant', 'blossom', 'petal'],
  house: ['home', 'building', 'residence'],
  room: ['interior', 'indoors', 'bedroom', 'living room'],
  sign: ['text', 'poster', 'billboard', 'logo'],
  night: ['dark', 'evening', 'nighttime'],
  sunset: ['dusk', 'sunrise', 'sky'],
  dog: ['puppy', 'canine', 'pet'],
  cat: ['kitten', 'feline', 'pet'],
};

interface QueryTerm {
  exact: string;
  variants: string[];
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function expandQueryTerms(query: string): QueryTerm[] {
  return tokenizeQuery(query).map((term) => ({
    exact: term,
    variants: [term, ...(SEARCH_SYNONYMS[term] || [])],
  }));
}

function getLocationName(item: DesktopItem, items: DesktopItem[]): string {
  if (!item.parentId) return 'Desktop';
  const parent = items.find((candidate) => candidate.id === item.parentId);
  return parent?.name || 'Desktop';
}

function getSearchableTags(item: DesktopItem): string[] {
  if (item.userTags !== undefined) {
    return item.userTags;
  }

  return item.imageAnalysis?.tags ?? [];
}

function buildSearchResult(item: DesktopItem, items: DesktopItem[], terms: QueryTerm[]): SearchResult | null {
  const tags = getSearchableTags(item);
  const haystacks = [
    { label: 'Name', value: item.name, weight: 10 },
    { label: 'Tags', value: tags.join(' '), weight: 9 },
    { label: 'Text', value: item.textContent, weight: 5 },
    { label: 'URL', value: item.url, weight: 5 },
    { label: 'Caption', value: item.imageAnalysis?.caption, weight: 7 },
    { label: 'Image Text', value: item.imageAnalysis?.detectedText?.join(' '), weight: 6 },
    { label: 'Colors', value: item.imageAnalysis?.dominantColors?.join(' '), weight: 4 },
    { label: 'Type', value: item.type, weight: 2 },
    { label: 'Location', value: getLocationName(item, items), weight: 3 },
  ];

  let score = 0;
  const matchedIn = new Set<string>();
  let bestSummary = item.imageAnalysis?.caption || item.textContent || item.url || '';

  for (const term of terms) {
    let termMatched = false;

    for (const haystack of haystacks) {
      if (!haystack.value) continue;
      const lowerValue = haystack.value.toLowerCase();
      let matchedVariant: string | null = null;

      for (const variant of term.variants) {
        if (lowerValue.includes(variant)) {
          matchedVariant = variant;
          break;
        }
      }

      if (matchedVariant) {
        const isExact = matchedVariant === term.exact;
        score += isExact ? haystack.weight : Math.max(1, haystack.weight - 3);
        matchedIn.add(isExact ? haystack.label : `${haystack.label} (Related)`);
        termMatched = true;

        if (!bestSummary || haystack.weight > 5) {
          bestSummary = haystack.value;
        }

        if (lowerValue.startsWith(matchedVariant)) {
          score += isExact ? 2 : 1;
        }
      }
    }

    if (!termMatched) {
      return null;
    }
  }

  if (terms.length > 1) {
    score += 4;
  }

  return {
    item,
    score,
    summary: bestSummary,
    matchedIn: Array.from(matchedIn),
  };
}

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

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const results = useMemo(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    const terms = expandQueryTerms(trimmedQuery);

    return items
      .filter((item) => !item.isTrashed)
      .map((item) => buildSearchResult(item, items, terms))
      .filter((result): result is SearchResult => result !== null)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.item.updatedAt - a.item.updatedAt;
      })
      .slice(0, 24);
  }, [items, query]);

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
