import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWindowStore } from '../../stores/windowStore';
import { getAuthToken, mintGameCapability } from '../../services/api';
import styles from './ConsolePlayer.module.css';

interface ConsolePlayerProps {
  /** 'demo', 'draft:{cartId}', or a published packId */
  gameId: string;
  windowId?: string;
  /** Bumped by the editor to force a fresh load after saving a draft */
  reloadKey?: number;
}

// Mirrors the KEYMAP inside the console runtime. The host forwards keys so
// games respond even before the iframe itself has focus.
const HOST_KEYMAP: Record<string, number> = {
  ArrowLeft: 0, a: 0, A: 0,
  ArrowRight: 1, d: 1, D: 1,
  ArrowUp: 2, w: 2, W: 2,
  ArrowDown: 3, s: 3, S: 3,
  z: 4, Z: 4, c: 4, C: 4, n: 4, N: 4,
  x: 5, X: 5, v: 5, V: 5, m: 5, M: 5,
};

// Refresh the 10-minute capability with comfortable margin.
const CAPABILITY_REFRESH_MS = 8 * 60 * 1000;

const localSaveKey = (gameId: string) => `eternalos-gamesave:${gameId}`;

export function ConsolePlayer({ gameId, windowId, reloadKey = 0 }: ConsolePlayerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pressed, setPressed] = useState<Record<number, boolean>>({});
  const initializedRef = useRef(false);

  const src = useMemo(() => {
    const base = import.meta.env.VITE_API_URL || window.location.origin;
    return `${base}/api/games/play/${encodeURIComponent(gameId)}/${reloadKey ? `?v=${reloadKey}` : ''}`;
  }, [gameId, reloadKey]);

  const showGamepad = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    [],
  );

  const postToGame = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);

  // Reset per-load state when the iframe navigates to a new cartridge.
  useEffect(() => {
    initializedRef.current = false;
    setError(null);
  }, [src]);

  // Handle messages from the console runtime.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'console:meta':
          if (windowId && typeof msg.name === 'string' && msg.name) {
            useWindowStore.getState().updateWindowTitle(windowId, msg.name);
          }
          break;

        case 'console:ready': {
          // Every console:ready means a freshly loaded document (the runtime
          // sends it exactly once per load), so always answer — the iframe
          // may reload itself independently of this component's lifecycle.
          initializedRef.current = true;
          if (getAuthToken()) {
            mintGameCapability(gameId)
              .then(({ capability }) => postToGame({ type: 'console:init', capability }))
              .catch(() => {
                // Capability mint failed (e.g. game missing) — play without cloud saves.
                postToGame({ type: 'console:init', saveData: localStorage.getItem(localSaveKey(gameId)) || '' });
              });
          } else {
            // Anonymous visitor: saves live in this browser only.
            postToGame({ type: 'console:init', saveData: localStorage.getItem(localSaveKey(gameId)) || '' });
          }
          break;
        }

        case 'console:save':
          // Anonymous fallback path — clamp to the same 32KB the server enforces.
          if (typeof msg.data === 'string' && msg.data.length <= 32 * 1024) {
            try {
              localStorage.setItem(localSaveKey(gameId), msg.data);
            } catch {
              // storage full — saving is best-effort for anonymous play
            }
          }
          break;

        case 'console:error':
          setError(`${msg.phase ? `[${msg.phase}] ` : ''}${msg.message || 'Unknown error'}`);
          break;

        case 'net:connect':
          // Multiplayer bridge lands with the RealtimeRoom milestone.
          postToGame({ type: 'net:error', message: 'Multiplayer is not available yet' });
          break;

        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [gameId, windowId, postToGame]);

  // Keep the short-lived capability fresh while the game is open.
  useEffect(() => {
    if (!getAuthToken()) return;
    const interval = setInterval(() => {
      if (!initializedRef.current) return;
      mintGameCapability(gameId)
        .then(({ capability }) => postToGame({ type: 'console:capability', capability }))
        .catch(() => { /* next interval retries */ });
    }, CAPABILITY_REFRESH_MS);
    return () => clearInterval(interval);
  }, [gameId, postToGame]);

  // Forward keyboard input while this window is the top one, so the game
  // responds even when the iframe doesn't have focus yet.
  useEffect(() => {
    const isTopWindow = () => {
      if (!windowId) return true;
      const wins = useWindowStore.getState().windows.filter((w) => !w.minimized);
      if (wins.length === 0) return false;
      const top = wins.reduce((a, b) => (b.zIndex > a.zIndex ? b : a));
      return top.id === windowId;
    };

    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      const btn = HOST_KEYMAP[e.key];
      if (btn === undefined || !isTopWindow()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      postToGame({ type: 'console:setBtn', i: btn, down });
      e.preventDefault();
    };

    const keydown = onKey(true);
    const keyup = onKey(false);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
    };
  }, [windowId, postToGame]);

  const padPress = useCallback(
    (i: number) => (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setPressed((p) => ({ ...p, [i]: true }));
      postToGame({ type: 'console:setBtn', i, down: true });
    },
    [postToGame],
  );

  const padRelease = useCallback(
    (i: number) => (e: React.PointerEvent) => {
      e.preventDefault();
      setPressed((p) => ({ ...p, [i]: false }));
      postToGame({ type: 'console:setBtn', i, down: false });
    },
    [postToGame],
  );

  const padButton = (i: number, label: string, className: string) => (
    <button
      type="button"
      className={className}
      data-pressed={pressed[i] ? 'true' : 'false'}
      onPointerDown={padPress(i)}
      onPointerUp={padRelease(i)}
      onPointerCancel={padRelease(i)}
      onPointerLeave={padRelease(i)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <div className={styles.player}>
      <iframe
        ref={iframeRef}
        src={src}
        sandbox="allow-scripts"
        className={styles.frame}
        title="Game console"
      />
      {error && <div className={styles.errorStrip}>{error}</div>}
      {showGamepad && (
        <div className={styles.gamepad}>
          <div className={styles.dpad}>
            <span className={styles.dpadSpacer} />
            {padButton(2, '▲', styles.dpadBtn)}
            <span className={styles.dpadSpacer} />
            {padButton(0, '◀', styles.dpadBtn)}
            <span className={styles.dpadSpacer} />
            {padButton(1, '▶', styles.dpadBtn)}
            <span className={styles.dpadSpacer} />
            {padButton(3, '▼', styles.dpadBtn)}
            <span className={styles.dpadSpacer} />
          </div>
          <div className={styles.actions}>
            {padButton(4, 'O', styles.actionBtn)}
            {padButton(5, 'X', styles.actionBtn)}
          </div>
        </div>
      )}
    </div>
  );
}
