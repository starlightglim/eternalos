import { beforeEach, describe, expect, test } from 'vitest';

// googleOAuth reads sessionStorage (and, for redirect, window/location). We only
// unit-test the pure CSRF-state verification, which is the sole client-side
// guard for the OAuth flow, so stub a minimal in-memory sessionStorage.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

import { verifyOAuthState } from './googleOAuth';

const KEY = 'google_oauth_state';

describe('verifyOAuthState', () => {
  test('accepts a matching state and consumes it (one-time use)', () => {
    store.set(KEY, 'abc-123');
    expect(verifyOAuthState('abc-123')).toBe(true);
    // Consumed — a replay of the same state now fails.
    expect(store.has(KEY)).toBe(false);
    expect(verifyOAuthState('abc-123')).toBe(false);
  });

  test('rejects a mismatched state (and still consumes the stored one)', () => {
    store.set(KEY, 'real-state');
    expect(verifyOAuthState('attacker-state')).toBe(false);
    expect(store.has(KEY)).toBe(false);
  });

  test('rejects when no state was stored', () => {
    expect(verifyOAuthState('anything')).toBe(false);
  });

  test('fails closed when both stored and incoming state are missing/empty', () => {
    // No stored state; empty or null incoming must NOT pass via null === null.
    expect(verifyOAuthState('')).toBe(false);
    expect(verifyOAuthState(null as unknown as string)).toBe(false);
  });
});
