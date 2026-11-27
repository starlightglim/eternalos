/**
 * useDocumentMeta - Hook for dynamically updating document title and meta tags
 *
 * Updates document.title and manages OpenGraph/Twitter meta tags for SEO.
 * Meta tags are updated in the document head and restored on cleanup.
 */

import { useEffect } from 'react';

export interface MetaConfig {
  title: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  ogUrl?: string;
  ogImage?: string;
  twitterCard?: 'summary' | 'summary_large_image';
}

export interface MetaElementLike {
  content: string;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

export interface MetaHead {
  querySelector(selector: string): MetaElementLike | null;
  appendChild(node: MetaElementLike): unknown;
}

/**
 * Sets (or creates) a meta tag and returns how to undo exactly that change:
 * a tag it created is removed, an existing tag gets its old content back.
 */
export function setMetaTag(
  head: MetaHead,
  createMeta: () => MetaElementLike,
  name: string,
  content: string,
  isProperty = false,
): () => void {
  const attr = isProperty ? 'property' : 'name';
  const existing = head.querySelector(`meta[${attr}="${name}"]`);
  if (existing) {
    const previous = existing.content;
    existing.content = content;
    return () => {
      existing.content = previous;
    };
  }
  const meta = createMeta();
  meta.setAttribute(attr, name);
  meta.content = content;
  head.appendChild(meta);
  return () => meta.remove();
}

/** The meta tags a config produces, as [name, content, isProperty]. */
export function metaTagsFor(config: MetaConfig): Array<[string, string, boolean]> {
  const tags: Array<[string, string, boolean]> = [];
  const title = config.ogTitle || config.title;
  const description = config.ogDescription || config.description;
  if (config.description) tags.push(['description', config.description, false]);
  if (title) tags.push(['og:title', title, true]);
  if (description) tags.push(['og:description', description, true]);
  if (config.ogType) tags.push(['og:type', config.ogType, true]);
  if (config.ogUrl) tags.push(['og:url', config.ogUrl, true]);
  if (config.ogImage) {
    tags.push(['og:image', config.ogImage, true]);
    tags.push(['twitter:image', config.ogImage, false]);
  }
  if (config.twitterCard) tags.push(['twitter:card', config.twitterCard, false]);
  if (title) tags.push(['twitter:title', title, false]);
  if (description) tags.push(['twitter:description', description, false]);
  return tags;
}

/**
 * Applies the config's meta tags to `head` and returns a function that puts
 * the head back the way it was (undone in reverse order).
 */
export function applyMetaTags(
  head: MetaHead,
  createMeta: () => MetaElementLike,
  config: MetaConfig,
): () => void {
  const restores = metaTagsFor(config).map(([name, content, isProperty]) =>
    setMetaTag(head, createMeta, name, content, isProperty),
  );
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) restores[i]();
  };
}

/**
 * Hook to set document title and meta tags.
 * On unmount or config change it restores the title and every meta tag it
 * touched, so one page's share tags don't linger on the next.
 */
export function useDocumentMeta(config: MetaConfig): void {
  const { title, description, ogTitle, ogDescription, ogType, ogUrl, ogImage, twitterCard } = config;
  useEffect(() => {
    const originalTitle = document.title;
    document.title = title;
    const restoreMeta = applyMetaTags(
      document.head as unknown as MetaHead,
      () => document.createElement('meta'),
      { title, description, ogTitle, ogDescription, ogType, ogUrl, ogImage, twitterCard },
    );
    return () => {
      restoreMeta();
      document.title = originalTitle;
    };
  }, [title, description, ogTitle, ogDescription, ogType, ogUrl, ogImage, twitterCard]);
}

/**
 * Sets the page title only (simpler hook)
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const originalTitle = document.title;
    document.title = title;
    return () => {
      document.title = originalTitle;
    };
  }, [title]);
}
