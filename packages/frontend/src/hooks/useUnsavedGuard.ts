/**
 * Unsaved-work guards.
 *
 * - `useUnsavedGuard(dirty)`: while `dirty`, leaving or reloading the page
 *   asks first (the browser's own `beforeunload` prompt).
 * - `useCloseGuard(windowId, guard)` / `setContentTypeCloseGuard(type, guard)`: lets a viewer step in when its window
 *   is closed (title-bar ×, ⌘W, programmatic close). `windowStore.closeWindow`
 *   consults `interceptWindowClose`; a guard that returns true has taken over
 *   and must call `proceed()` to really close the window (e.g. after the user
 *   confirms in a dialog).
 *
 * The non-hook pieces are plain functions so they are testable in the repo's
 * node test environment.
 */

import { useEffect, useRef } from 'react';

type UnloadTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** Ask before unload while `isDirty()` is true. Returns the cleanup. */
export function addUnloadGuard(target: UnloadTarget, isDirty: () => boolean): () => void {
  const handler = (event: Event) => {
    if (!isDirty()) return;
    event.preventDefault();
    // Older browsers only prompt when returnValue is set.
    (event as BeforeUnloadEvent).returnValue = '';
  };
  target.addEventListener('beforeunload', handler);
  return () => target.removeEventListener('beforeunload', handler);
}

export function useUnsavedGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return;
    return addUnloadGuard(window, () => true);
  }, [dirty]);
}

/** Returns true when it handled the close itself (it then calls `proceed`). */
export type CloseGuard = (proceed: () => void) => boolean;

const closeGuards = new Map<string, CloseGuard>();
const contentTypeKey = (contentType: string) => `contentType:${contentType}`;
const bypassing = new Set<string>();

export function setCloseGuard(windowId: string, guard: CloseGuard): () => void {
  closeGuards.set(windowId, guard);
  return () => {
    if (closeGuards.get(windowId) === guard) closeGuards.delete(windowId);
  };
}

/**
 * Guard every window of a content type. Unlike `useCloseGuard` this does not
 * depend on the viewer being mounted (a collapsed window unmounts its
 * content), so the guard reads its state from stores.
 */
export function setContentTypeCloseGuard(contentType: string, guard: CloseGuard): () => void {
  return setCloseGuard(contentTypeKey(contentType), guard);
}

/**
 * Called by `closeWindow`. Returns true when a guard took over the close;
 * `close` is what the guard's `proceed()` runs, bypassing the guard once.
 */
export function interceptWindowClose(windowId: string, close: () => void, contentType?: string): boolean {
  const guard = closeGuards.get(windowId) ?? (contentType ? closeGuards.get(contentTypeKey(contentType)) : undefined);
  if (!guard || bypassing.has(windowId)) return false;
  return guard(() => {
    bypassing.add(windowId);
    try {
      close();
    } finally {
      bypassing.delete(windowId);
    }
  });
}

export function useCloseGuard(windowId: string | undefined, guard: CloseGuard): void {
  const guardRef = useRef(guard);
  useEffect(() => {
    guardRef.current = guard;
  });
  useEffect(() => {
    if (!windowId) return;
    return setCloseGuard(windowId, (proceed) => guardRef.current(proceed));
  }, [windowId]);
}
