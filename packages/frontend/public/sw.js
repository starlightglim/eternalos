/* eslint-env serviceworker */
/* eslint-disable no-undef */

/**
 * EternalOS service worker — app shell + R2 asset caching.
 *
 * Strategy:
 *   - App shell (HTML, Vite-hashed JS/CSS): stale-while-revalidate. Users get
 *     instant load, background update picks up new deploys.
 *   - R2-backed asset URLs (/api/files, /api/wallpaper, /api/css-assets,
 *     /api/sounds, /api/cursors, /api/bazaar/assets): cache-first. They are
 *     served with `immutable` cache-control, so staleness is a non-issue.
 *   - API calls: network-first. We never cache auth/state responses.
 *   - Navigation: network-first with shell fallback for offline.
 *
 * Bump `CACHE_VERSION` whenever the shell strategy changes. The activation
 * step removes older caches.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `eternalos-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `eternalos-assets-${CACHE_VERSION}`;

// Keep tiny — just the bootstrap HTML. Vite-hashed chunks cache themselves on
// first load via the fetch handler.
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest'];

const ASSET_PATH_PREFIXES = [
  '/api/files/',
  '/api/wallpaper/',
  '/api/css-assets/',
  '/api/sounds/',
  '/api/cursors/',
  '/api/bazaar/assets/',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(PRECACHE_URLS);
      self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('eternalos-') && !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isAssetRequest(url) {
  return ASSET_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
}

function isShellNavigation(request) {
  return request.mode === 'navigate';
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);
  return cached || (await networkPromise) || new Response('Offline', { status: 503 });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirstWithShellFallback(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (
      (await cache.match(request)) ||
      (await cache.match('/')) ||
      new Response('Offline', { status: 503 })
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin GET. Everything else (cross-origin, POST, PATCH,
  // DELETE, etc.) goes straight to the network unhandled.
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // R2-backed assets are content-addressable and immutable; cache-first is safe.
  if (isAssetRequest(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // API responses (other than assets above) are state — never cache.
  if (url.pathname.startsWith('/api/')) return;

  // Navigation: try network first, fall back to cached shell when offline.
  if (isShellNavigation(request)) {
    event.respondWith(networkFirstWithShellFallback(request));
    return;
  }

  // Static assets from the Vite build — hashed, immutable.
  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

// Listen for a SKIP_WAITING postMessage so the client can force an update on
// demand (useful when the user explicitly reloads after a deploy banner).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
