/**
 * Permission-scope helpers for user-created apps.
 *
 * A manifest *declares* permissions; the user *grants* a subset; each granted
 * scope carries approval metadata (see design/01-apps-interop.md §install UX
 * and design/CORE-ROADMAP.md Workstream 3 Phase B).
 *
 * Two rules live here:
 *
 *  1. **Broad scopes.** Some grants hand an app the user's whole filesystem,
 *     the whole profile, or an unbounded set of network domains. Those are
 *     *broad*: the install/approval UI must show them as an explicit warning
 *     and the permissions route rejects a grant request containing one
 *     unless the request carries that scope's explicit approval tick.
 *
 *  2. **Approval metadata + lazy migration.** Every granted scope gets an
 *     `AppGrantApproval` record (approvedAt / approvedBy / the manifest
 *     rationale at approval time). Installs granted before the metadata
 *     existed have no stored record; reads treat those grants as approved
 *     with `approvedAt` unknown instead of requiring a migration pass.
 */

import type { AppGrantApproval, AppGrantedPermissions } from '../types';

/** Canonical permission scope ids: `${domain}.${scope}`. */
export const APP_SCOPE_IDS = [
  'fs.read',
  'fs.write',
  'fs.delete',
  'fs.mimeTypes',
  'fs.readMimeTypes',
  'fs.writeMimeTypes',
  'fs.deleteMimeTypes',
  'ipc.listen',
  'ipc.emit',
  'network.outbound',
  'handlers.mimeTypes',
  'handlers.extensions',
  'virtualFolders.mountAt',
  'profile.read',
  'ai.modes',
] as const;

export type AppScopeId = (typeof APP_SCOPE_IDS)[number];

const APP_SCOPE_ID_SET: ReadonlySet<string> = new Set(APP_SCOPE_IDS);

export interface AppScopeEntry {
  id: AppScopeId;
  values: string[];
}

/**
 * Enumerate the scopes present in a permissions object (declared or granted),
 * walking `${domain}.${scope}` pairs whose value is a non-empty string[].
 * Unknown domains/scopes and non-array values are skipped, so this is safe on
 * arbitrary client-shaped input.
 */
export function listAppScopes(permissions: unknown): AppScopeEntry[] {
  if (!permissions || typeof permissions !== 'object') return [];
  const entries: AppScopeEntry[] = [];
  for (const [domain, domainValue] of Object.entries(permissions as Record<string, unknown>)) {
    if (!domainValue || typeof domainValue !== 'object') continue;
    for (const [scope, scopeValue] of Object.entries(domainValue as Record<string, unknown>)) {
      const id = `${domain}.${scope}`;
      if (!APP_SCOPE_ID_SET.has(id)) continue;
      if (!Array.isArray(scopeValue) || scopeValue.length === 0) continue;
      if (!scopeValue.every((value) => typeof value === 'string')) continue;
      entries.push({ id: id as AppScopeId, values: scopeValue as string[] });
    }
  }
  return entries;
}

/**
 * fs path globs that hand an app the user's entire desktop. Mirrors the
 * match-everything forms of pathMatchesGlob (worker utils/fsPolicy.ts), plus
 * the bare root `/`.
 */
const BROAD_FS_PATHS = new Set(['**', '/**', '**/*', '/']);

export function isBroadFsPath(value: string): boolean {
  return BROAD_FS_PATHS.has(value);
}

/**
 * Network domains that are not a single concrete host: `*` (everything) or
 * any wildcard pattern (`*.example.com`, `*.org`). A concrete host
 * (`api.example.com`) is narrow.
 */
export function isBroadNetworkDomain(value: string): boolean {
  return value === '*' || value.includes('*');
}

const ALL_PROFILE_FIELDS: ReadonlySet<string> = new Set(['username', 'displayName', 'bio', 'avatar']);

/**
 * A profile grant is broad only when it covers *all* profile fields.
 */
function isBroadProfileScope(values: string[]): boolean {
  return values.every((value) => ALL_PROFILE_FIELDS.has(value)) && values.length >= ALL_PROFILE_FIELDS.size;
}

/**
 * Is this granted scope broad (whole-filesystem / whole-profile /
 * wildcard-network)? Broad scopes require an explicit per-scope approval
 * tick before granting. Every other scope keeps the normal flow.
 */
export function isBroadScope(id: string, values: string[]): boolean {
  if (id === 'fs.read' || id === 'fs.write' || id === 'fs.delete') {
    return values.some(isBroadFsPath);
  }
  if (id === 'network.outbound') {
    return values.some(isBroadNetworkDomain);
  }
  if (id === 'profile.read') {
    return isBroadProfileScope(values);
  }
  return false;
}

/** Scope ids in `permissions` whose values make them broad. */
export function broadScopeIds(permissions: unknown): string[] {
  return listAppScopes(permissions)
    .filter((entry) => isBroadScope(entry.id, entry.values))
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// Approval metadata
// ---------------------------------------------------------------------------

/** Cap approval-rationale snapshots, matching the manifest rationale cap. */
const MAX_APPROVAL_RATIONALE_LENGTH = 500;

function sanitizeApprovalRationale(rationale: unknown): string | undefined {
  if (typeof rationale !== 'string') return undefined;
  const trimmed = rationale.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_APPROVAL_RATIONALE_LENGTH);
}

/**
 * Build fresh approval metadata for every scope in a (sanitized) granted
 * set: approved now, by `approvedBy`, with the manifest's rationale as it
 * read at approval time.
 */
export function buildGrantApprovals(
  granted: unknown,
  approvedBy: string,
  rationale: unknown,
  now: number = Date.now(),
): Record<string, AppGrantApproval> {
  const snapshot = sanitizeApprovalRationale(rationale);
  const approvals: Record<string, AppGrantApproval> = {};
  for (const entry of listAppScopes(granted)) {
    approvals[entry.id] = snapshot
      ? { approvedAt: now, approvedBy, rationale: snapshot }
      : { approvedAt: now, approvedBy };
  }
  return approvals;
}

/**
 * Keep only the approval entries whose scope still has a grant — approval
 * metadata describes a grant, so a revoked scope must not keep one.
 */
export function pruneGrantApprovals(
  approvals: Record<string, AppGrantApproval> | undefined,
  granted: unknown,
): Record<string, AppGrantApproval> {
  if (!approvals) return {};
  const grantedIds: ReadonlySet<string> = new Set(listAppScopes(granted).map((entry) => entry.id));
  const pruned: Record<string, AppGrantApproval> = {};
  for (const [id, approval] of Object.entries(approvals)) {
    if (!grantedIds.has(id)) continue;
    if (!approval || typeof approval !== 'object') continue;
    pruned[id] = {
      ...(typeof approval.approvedAt === 'number' && Number.isFinite(approval.approvedAt)
        ? { approvedAt: approval.approvedAt }
        : {}),
      ...(typeof approval.approvedBy === 'string' && approval.approvedBy.length > 0 && approval.approvedBy.length <= 128
        ? { approvedBy: approval.approvedBy }
        : {}),
      ...(typeof approval.rationale === 'string' && approval.rationale.length > 0
        ? { rationale: approval.rationale.slice(0, MAX_APPROVAL_RATIONALE_LENGTH) }
        : {}),
    };
  }
  return pruned;
}

/**
 * Resolve the approval metadata to expose for a granted set. Lazy migration:
 * a granted scope with no stored approval record predates approval metadata —
 * treat it as approved with `approvedAt` unknown (an empty record), rather
 * than as unapproved or as a write-back migration.
 */
export function resolveGrantApprovals(
  granted: unknown,
  storedApprovals: Record<string, AppGrantApproval> | undefined,
): Record<string, AppGrantApproval> {
  const resolved: Record<string, AppGrantApproval> = {};
  for (const entry of listAppScopes(granted)) {
    const stored = storedApprovals?.[entry.id];
    if (stored && typeof stored === 'object') {
      resolved[entry.id] = {
        ...(typeof stored.approvedAt === 'number' && Number.isFinite(stored.approvedAt)
          ? { approvedAt: stored.approvedAt }
          : {}),
        ...(typeof stored.approvedBy === 'string' && stored.approvedBy.length > 0 ? { approvedBy: stored.approvedBy } : {}),
        ...(typeof stored.rationale === 'string' && stored.rationale.length > 0 ? { rationale: stored.rationale } : {}),
      };
    } else {
      // Legacy install: approved before approval metadata existed.
      resolved[entry.id] = {};
    }
  }
  return resolved;
}

/**
 * Parse a client's explicit broad-scope approval ticks: the list of scope ids
 * the user individually ticked. Unknown ids and non-strings are dropped
 * (only known scope ids can ever be broad).
 */
export function sanitizeBroadApprovals(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(input.filter((value): value is string =>
    typeof value === 'string' && APP_SCOPE_ID_SET.has(value)));
}

// Re-export for callers that deal in the granted shape (capability checks).
export type { AppGrantedPermissions };
