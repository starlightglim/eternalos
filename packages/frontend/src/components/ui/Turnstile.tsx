/**
 * Cloudflare Turnstile widget — invisible CAPTCHA for signup/login.
 *
 * Usage:
 *   const [token, setToken] = useState<string | null>(null);
 *   <Turnstile onToken={setToken} action="signup" />
 *   // Include `cf-turnstile-response: token` in the submitted form / JSON
 *
 * When the site key isn't configured (VITE_TURNSTILE_SITE_KEY unset), renders
 * nothing and calls onToken(null). The worker-side verifier is also no-op
 * without TURNSTILE_SECRET, so dev work continues unblocked.
 */

import { useEffect, useRef } from 'react';

interface TurnstileProps {
  /** Called with the token on challenge pass, or null on reset/expire. */
  onToken: (token: string | null) => void;
  /** Optional named action — must match the server-side expectedAction check. */
  action?: string;
  /** Theme: 'light' | 'dark' | 'auto'. Defaults to 'auto'. */
  theme?: 'light' | 'dark' | 'auto';
  /** 'normal' | 'flexible' | 'compact' | 'invisible'. Defaults to 'invisible'. */
  size?: 'normal' | 'flexible' | 'compact' | 'invisible';
  /** Custom className for the container div. */
  className?: string;
}

interface TurnstileRenderOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: (error: string) => void;
  'expired-callback'?: () => void;
  'timeout-callback'?: () => void;
  action?: string;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'flexible' | 'compact' | 'invisible';
  appearance?: 'always' | 'execute' | 'interaction-only';
}

interface TurnstileAPI {
  render: (container: HTMLElement | string, options: TurnstileRenderOptions) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileAPI;
    _turnstileLoader?: Promise<void>;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Load the Turnstile script once per page; reused across all instances. */
function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (window._turnstileLoader) return window._turnstileLoader;

  window._turnstileLoader = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${SCRIPT_URL}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Turnstile script failed to load')));
      return;
    }
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Turnstile script failed to load'));
    document.head.appendChild(script);
  });

  return window._turnstileLoader;
}

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

export function Turnstile({ onToken, action, theme = 'auto', size = 'invisible', className }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!SITE_KEY) {
      // No site key → dev mode. Emit null so the caller knows we're not gating.
      onToken(null);
      return;
    }

    let cancelled = false;

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          action,
          theme,
          size,
          callback: (token) => onToken(token),
          'error-callback': () => onToken(null),
          'expired-callback': () => onToken(null),
          'timeout-callback': () => onToken(null),
        });
      })
      .catch((err) => {
        console.warn('Turnstile load failed:', err);
        // Fail-open in dev; server-side verifier will still enforce.
        onToken(null);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore teardown errors — widget may already be gone.
        }
        widgetIdRef.current = null;
      }
    };
    // action/theme/size are static for a given mount; re-render not supported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the site key isn't configured, render nothing.
  if (!SITE_KEY) return null;

  return <div ref={containerRef} className={className} />;
}

/** True when Turnstile is configured for this build. Use to branch UI. */
export const TURNSTILE_ENABLED: boolean = Boolean(SITE_KEY);
