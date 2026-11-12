/**
 * EternalOS service worker — static app shell caching.
 *
 * Strategy:
 *   - App shell (HTML, Vite-hashed JS/CSS): stale-while-revalidate. Users get
 *     instant load, background update picks up new deploys.
 *   - API requests always reach the network, bypassing the browser HTTP
 *     cache too. File permissions and asset availability can change.
 *   - Navigation: network-first with shell fallback for offline.
 *
 * Bump `CACHE_VERSION` whenever the shell strategy changes. The activation
 * step removes older caches.
 */

const CACHE_VERSION = 'v2';
const SHELL_CACHE = `eternalos-shell-${CACHE_VERSION}`;

// Keep tiny — just the bootstrap HTML. Vite-hashed chunks cache themselves on
// first load via the fetch handler.
const PRECACHE_URLS = ['/', '/index.html', '/manifest.webmanifest'];

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
          .filter((k) => k.startsWith('eternalos-') && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

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

  // Cross-origin APIs also need protection from legacy HTTP cache entries.
  // Never store API bytes in CacheStorage, even when offline.
  const url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  if (url.origin !== self.location.origin) return;

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
