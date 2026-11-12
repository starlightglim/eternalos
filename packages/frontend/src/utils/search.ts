/**
 * Desktop search ranking.
 *
 * Pure, deterministic scoring + ordering for desktop item search, extracted
 * from SearchWindow so it can be unit-tested. Results are sorted by score
 * (desc), then recency (desc), then item id (asc) — the id tiebreak makes the
 * order total, so identical scores/timestamps can't produce non-deterministic
 * results.
 */

import type { DesktopItem } from '../types';

export interface SearchResult {
  item: DesktopItem;
  score: number;
  summary: string;
  matchedIn: string[];
}

interface QueryTerm {
  exact: string;
  variants: string[];
}

export const SEARCH_SYNONYMS: Record<string, string[]> = {
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

export const DEFAULT_SEARCH_LIMIT = 24;

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

export function getLocationName(item: DesktopItem, items: DesktopItem[]): string {
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

export function buildSearchResult(
  item: DesktopItem,
  items: DesktopItem[],
  terms: QueryTerm[],
): SearchResult | null {
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

    // AND semantics: every query term must match somewhere, or the item is out.
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

/**
 * Rank desktop items against a query. Trashed items are excluded. Returns at
 * most `limit` results in a fully deterministic order.
 */
export function searchItems(
  items: DesktopItem[],
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): SearchResult[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const terms = expandQueryTerms(trimmedQuery);

  return items
    .filter((item) => !item.isTrashed)
    .map((item) => buildSearchResult(item, items, terms))
    .filter((result): result is SearchResult => result !== null)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.item.updatedAt !== a.item.updatedAt) return b.item.updatedAt - a.item.updatedAt;
      // Total-order tiebreak so equal score + timestamp is still deterministic.
      return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
    })
    .slice(0, limit);
}
