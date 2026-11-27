/**
 * useDocumentMeta - Hook for dynamically updating document title and meta tags
 *
 * Updates document.title and manages OpenGraph/Twitter meta tags for SEO.
 * Meta tags are updated in the document head.
 */

import { useEffect } from 'react';

interface MetaConfig {
  title: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  ogUrl?: string;
  ogImage?: string;
  twitterCard?: 'summary' | 'summary_large_image';
}

/**
 * Updates or creates a meta tag
 */
function setMetaTag(name: string, content: string, isProperty = false): void {
  const attr = isProperty ? 'property' : 'name';
  let meta = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null;

  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute(attr, name);
    document.head.appendChild(meta);
  }

  meta.content = content;
}

/**
 * The canonical form of a page URL: no query string or fragment, and
 * usernames lowercased (they're case-insensitive), so `/@Alice?ref=x#top`
 * and `/@alice` are one page to search engines and link unfurlers.
 */
export function canonicalUrlFor(href: string): string {
  const url = new URL(href);
  url.search = '';
  url.hash = '';
  if (url.pathname.startsWith('/@')) url.pathname = url.pathname.toLowerCase();
  return url.toString();
}

/**
 * Point the canonical link and og:url at `href`. Returns a function that
 * puts back what was there before (removing them if they didn't exist), so
 * routes that don't use this hook don't inherit the last page's URL.
 */
function setPageUrl(href: string): () => void {
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  const previousLink = link?.getAttribute('href') ?? null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }
  link.href = href;

  let meta = document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
  const previousMeta = meta?.getAttribute('content') ?? null;
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('property', 'og:url');
    document.head.appendChild(meta);
  }
  meta.content = href;

  const ownLink = link;
  const ownMeta = meta;
  return () => {
    if (previousLink === null) ownLink.remove();
    else ownLink.setAttribute('href', previousLink);
    if (previousMeta === null) ownMeta.remove();
    else ownMeta.setAttribute('content', previousMeta);
  };
}

/**
 * Hook to set document title and meta tags
 * Cleans up meta tags when component unmounts or config changes
 */
export function useDocumentMeta(config: MetaConfig): void {
  useEffect(() => {
    // Store original title for cleanup
    const originalTitle = document.title;

    // Set document title
    document.title = config.title;

    // Canonical link + og:url always name this page. They're not in
    // index.html: a static one there would claim every route is "/".
    const restorePageUrl = setPageUrl(canonicalUrlFor(config.ogUrl || window.location.href));

    // Set description
    if (config.description) {
      setMetaTag('description', config.description);
    }

    // OpenGraph meta tags
    if (config.ogTitle || config.title) {
      setMetaTag('og:title', config.ogTitle || config.title, true);
    }
    if (config.ogDescription || config.description) {
      setMetaTag('og:description', config.ogDescription || config.description || '', true);
    }
    if (config.ogType) {
      setMetaTag('og:type', config.ogType, true);
    }
    if (config.ogImage) {
      setMetaTag('og:image', config.ogImage, true);
      setMetaTag('twitter:image', config.ogImage);
    }

    // Twitter card meta tags
    if (config.twitterCard) {
      setMetaTag('twitter:card', config.twitterCard);
    }
    if (config.ogTitle || config.title) {
      setMetaTag('twitter:title', config.ogTitle || config.title);
    }
    if (config.ogDescription || config.description) {
      setMetaTag('twitter:description', config.ogDescription || config.description || '');
    }

    // Cleanup function
    return () => {
      document.title = originalTitle;
      restorePageUrl();
      // Note: We don't remove meta tags on cleanup to avoid flicker
      // They will be updated by the next page
    };
  }, [config.title, config.description, config.ogTitle, config.ogDescription, config.ogType, config.ogUrl, config.ogImage, config.twitterCard]);
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
