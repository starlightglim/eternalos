/**
 * Register the service worker that caches the app shell and R2-backed assets.
 *
 * No-op when:
 *   - The browser doesn't support service workers.
 *   - The page is loaded over HTTP (service workers require HTTPS except on localhost).
 *   - The URL contains ?no-sw=1 (escape hatch for debugging).
 *
 * Call from main.tsx during boot.
 */

export interface RegisterSWOptions {
  /** Called when a new SW is installed and waiting to activate. */
  onUpdateAvailable?: (registration: ServiceWorkerRegistration) => void;
  /** Called on successful first registration. */
  onReady?: (registration: ServiceWorkerRegistration) => void;
  /** Swallow errors (default true) — we don't want SW problems to break app boot. */
  logErrors?: boolean;
}

export function registerServiceWorker(options: RegisterSWOptions = {}): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  if (new URLSearchParams(window.location.search).has('no-sw')) return;

  const logErrors = options.logErrors ?? true;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

      // Already have a waiting worker (fresh install after an update).
      if (registration.waiting) {
        options.onUpdateAvailable?.(registration);
      }

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            options.onUpdateAvailable?.(registration);
          }
        });
      });

      options.onReady?.(registration);
    } catch (error) {
      if (logErrors) {
        console.error('Service worker registration failed:', error);
      }
    }
  });
}

/**
 * Ask the waiting SW to skipWaiting and reload the page. Call from an
 * "app update available" UI banner's "Reload" button.
 */
export function activateWaitingServiceWorker(registration: ServiceWorkerRegistration): void {
  if (!registration.waiting) return;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  // When the new SW takes control, reload.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}
