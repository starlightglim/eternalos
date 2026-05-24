/**
 * Shared file-system policy for apps.
 *
 * Both the capability-token-gated endpoints in routes/apps.ts and the
 * service-binding-gated EternalService use the same matching rules.
 * Keep them here so the policy has one source of truth.
 */

import type { DesktopItem } from '../types';
import type { AppGrantedPermissions } from './jwt';

/**
 * Build a "/"-delimited path from a DesktopItem chain (root → leaf).
 * Walks parents with a depth cap to prevent cycles from runaway loops.
 */
export function buildItemPath(itemId: string, items: Map<string, DesktopItem>): string {
  const segments: string[] = [];
  let current: DesktopItem | undefined = items.get(itemId);
  let depth = 0;
  while (current && depth < 16) {
    segments.unshift(current.name);
    current = current.parentId ? items.get(current.parentId) : undefined;
    depth++;
  }
  return '/' + segments.join('/');
}

/**
 * Minimal glob matcher for app fs scopes. Supports:
 *   '**'              → match everything
 *   '/Photos/**'       → anything starting with /Photos/
 *   '*.jpg'            → anything ending with .jpg (in any folder)
 *   '/Notes/*.md'      → any .md file directly in /Notes
 *   exact path         → exact match
 *
 * Intentionally limited so scopes are predictable and auditable.
 */
export function pathMatchesGlob(path: string, pattern: string): boolean {
  if (pattern === '**' || pattern === '/**' || pattern === '**/*') return true;
  if (pattern === path) return true;

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -'/**'.length);
    return path === prefix || path.startsWith(prefix + '/');
  }

  if (pattern.startsWith('*.') && !pattern.includes('/')) {
    const ext = pattern.slice(1);
    return path.toLowerCase().endsWith(ext.toLowerCase());
  }

  if (pattern.includes('/') && pattern.includes('*')) {
    const lastSlash = pattern.lastIndexOf('/');
    const prefix = pattern.slice(0, lastSlash);
    const fileGlob = pattern.slice(lastSlash + 1);
    if (!fileGlob.startsWith('*.')) return false;
    const ext = fileGlob.slice(1);
    const dirPath = path.slice(0, path.lastIndexOf('/'));
    return dirPath === prefix && path.toLowerCase().endsWith(ext.toLowerCase());
  }

  return false;
}

export function anyGlobMatches(path: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => pathMatchesGlob(path, p));
}

export function mimeMatches(mimeType: string | undefined, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0 || !mimeType) return false;
  for (const pattern of patterns) {
    if (pattern === mimeType) return true;
    if (pattern.endsWith('/*') && mimeType.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

/**
 * Does the granted permission set permit reading a given desktop item?
 *
 * An item is readable if either its *path* matches a granted `fs.read` glob,
 * OR its *mime type* matches a granted `fs.mimeTypes` pattern. These are
 * OR'd so an app can say "any image anywhere" without having to enumerate
 * folders.
 */
export function canReadItem(
  granted: AppGrantedPermissions,
  itemPath: string,
  mimeType: string | undefined,
): boolean {
  if (anyGlobMatches(itemPath, granted.fs?.read)) return true;
  if (mimeMatches(mimeType, granted.fs?.mimeTypes)) return true;
  return false;
}
