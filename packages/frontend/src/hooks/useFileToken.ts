import { useSyncExternalStore, useEffect } from 'react';
import {
  ensureFileToken,
  getFileTokenVersion,
  subscribeToFileToken,
} from '../services/api';

/**
 * Subscribe to file-token rotations so a component re-renders whenever the
 * token loads or refreshes. Useful for components that build media URLs via
 * `getFileUrl(r2Key)` — they need to recompute the URL once the short-lived
 * `?ft=` token is available, otherwise the first render after a page refresh
 * shows a tokenless URL that 401s.
 *
 * Returns the current version number; the value itself is opaque, components
 * should ignore it and just rely on the re-render side effect.
 */
export function useFileTokenVersion(): number {
  const version = useSyncExternalStore(
    subscribeToFileToken,
    getFileTokenVersion,
    getFileTokenVersion,
  );

  useEffect(() => {
    void ensureFileToken();
  }, []);

  return version;
}
