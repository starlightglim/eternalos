/**
 * useVisitorSync — WebSocket hook for real-time visitor page updates.
 *
 * Connects to the owner's Durable Object via /api/ws/:username and
 * receives live item, window, and profile changes.
 */
import { useEffect, useEffectEvent } from 'react';
import type { DesktopItem, UserProfile } from '../types';
import type { SavedWindowState } from '../services/api';
import { visitorSocketUrl } from '../utils/visitorView';

interface UseVisitorSyncOptions {
  username: string | undefined;
  enabled: boolean;
  onItemsUpdate: (items: DesktopItem[]) => void;
  onWindowsUpdate: (windows: SavedWindowState[]) => void;
  onProfileUpdate: (profile: UserProfile) => void;
}

export function useVisitorSync({
  username,
  enabled,
  onItemsUpdate,
  onWindowsUpdate,
  onProfileUpdate,
}: UseVisitorSyncOptions) {
  const handleMessage = useEffectEvent((raw: unknown) => {
    try {
      const data = JSON.parse(String(raw));
      switch (data.type) {
        case 'snapshot':
          if (data.items) onItemsUpdate(data.items);
          if (data.windows) onWindowsUpdate(data.windows);
          if (data.profile) onProfileUpdate(data.profile);
          break;
        case 'items':
          if (data.items) onItemsUpdate(data.items);
          break;
        case 'windows':
          if (data.windows) onWindowsUpdate(data.windows);
          break;
        case 'profile':
          if (data.profile) onProfileUpdate(data.profile);
          break;
      }
    } catch (err) {
      console.error('[useVisitorSync] message parse error:', err);
    }
  });

  useEffect(() => {
    if (!enabled || !username) return;

    // Everything below belongs to this effect run. Once it is cleaned up
    // (unmount, username change, disabled) `disposed` stops the old socket's
    // close handler from scheduling a reconnect to the previous desktop.
    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let delay = 1000;
    const url = visitorSocketUrl(import.meta.env.VITE_API_URL || '', username, window.location);

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(url);
      ws = socket;
      socket.onopen = () => {
        delay = 1000; // reset backoff on a good connection
      };
      socket.onmessage = (event) => {
        if (!disposed) handleMessage(event.data);
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (disposed) return;
        // Reconnect with exponential backoff (cap at 30s)
        reconnectTimer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
      socket.onerror = () => {
        // onclose follows; reconnect is handled there
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onmessage = null;
        ws.close();
        ws = null;
      }
    };
  }, [enabled, username]);
}
