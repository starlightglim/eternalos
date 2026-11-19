/**
 * Permission-entry helpers for the app install/approval dialog.
 *
 * The server is the source of truth: `GET /api/apps/:appId/permissions`
 * returns the declared set (`requested`), the granted set (`granted`), the
 * scope ids that are *broad* within the declared set (`broad`), and the
 * per-scope approval metadata (`approvals`). These helpers turn that
 * response into dialog rows and back into a grant submission.
 *
 * Broad-scope gating rule (design/CORE-ROADMAP.md Workstream 3, Phase B):
 * a broad scope is never pre-ticked — the user must explicitly tick it every
 * time it is (re)granted, and the tick travels to the server as that scope's
 * `broadApprovals` entry. Without the tick the scope is simply not granted.
 */

import type { AppGrantApproval } from '../../types';

export interface PermissionEntry {
  key: string;
  label: string;
  values: string[];
  broad: boolean;
}

const permissionLabels: Record<string, string> = {
  'fs.read': 'Read desktop files',
  'fs.write': 'Write desktop files',
  'fs.delete': 'Delete desktop files',
  'fs.mimeTypes': 'Access selected file types',
  'fs.readMimeTypes': 'Read selected file types',
  'fs.writeMimeTypes': 'Write selected file types',
  'fs.deleteMimeTypes': 'Delete selected file types',
  'profile.read': 'Read profile details',
  'network.outbound': 'Connect to external websites',
  'ipc.listen': 'Receive messages from other apps',
  'ipc.emit': 'Send messages to other apps',
  'handlers.mimeTypes': 'Handle selected file types',
  'handlers.extensions': 'Handle selected file extensions',
  'virtualFolders.mountAt': 'Mount virtual folders',
  'ai.modes': 'Use the assistant',
};

/** Short, specific warning shown on a broad scope's row. */
const broadWarnings: Record<string, string> = {
  'fs.read': 'Broad access: read every file on your desktop.',
  'fs.write': 'Broad access: write anywhere on your desktop.',
  'fs.delete': 'Broad access: delete any file on your desktop.',
  'network.outbound': 'Broad access: connect to any external website.',
  'profile.read': 'Broad access: read all your profile details.',
};

export function broadWarningText(key: string): string {
  return broadWarnings[key] ?? 'Broad access: this scope is wider than a single folder, site, or field.';
}

export function getPermissionEntries(
  value: Record<string, unknown>,
  broad: readonly string[] = [],
): PermissionEntry[] {
  const broadSet = new Set(broad);
  const entries: PermissionEntry[] = [];
  for (const [domain, domainValue] of Object.entries(value)) {
    if (!domainValue || typeof domainValue !== 'object') continue;
    for (const [scope, scopeValue] of Object.entries(domainValue as Record<string, unknown>)) {
      if (!Array.isArray(scopeValue) || !scopeValue.every((item) => typeof item === 'string')) continue;
      if (scopeValue.length === 0) continue;
      const key = `${domain}.${scope}`;
      entries.push({
        key,
        label: permissionLabels[key] || `${domain}: ${scope}`,
        values: scopeValue as string[],
        broad: broadSet.has(key),
      });
    }
  }
  return entries;
}

export function hasAllPermissionValues(granted: Record<string, unknown>, entry: PermissionEntry): boolean {
  const [domain, scope] = entry.key.split('.');
  const domainValue = granted[domain];
  if (!domainValue || typeof domainValue !== 'object') return false;
  const values = (domainValue as Record<string, unknown>)[scope];
  return Array.isArray(values) && entry.values.every((value) => values.includes(value));
}

/**
 * The scopes to pre-tick when the dialog opens: granted *narrow* scopes
 * only. Broad scopes are never pre-ticked — each one needs a fresh,
 * explicit tick before it is granted (again).
 */
export function initialSelectedKeys(entries: PermissionEntry[], granted: Record<string, unknown>): string[] {
  return entries
    .filter((entry) => !entry.broad && hasAllPermissionValues(granted, entry))
    .map((entry) => entry.key);
}

/** Build the grant submission from the ticked scope keys. */
export function buildGrantedPermissions(requested: Record<string, unknown>, selectedKeys: string[]): Record<string, unknown> {
  const selected = new Set(selectedKeys);
  const granted: Record<string, Record<string, string[]>> = {};
  for (const entry of getPermissionEntries(requested)) {
    if (!selected.has(entry.key)) continue;
    const [domain, scope] = entry.key.split('.');
    granted[domain] ||= {};
    granted[domain][scope] = entry.values;
  }
  return granted;
}

/** "2026-11-19" from an approval timestamp; null when the date is unknown. */
export function approvalDateText(approval: AppGrantApproval | undefined): string | null {
  if (!approval || typeof approval.approvedAt !== 'number' || !Number.isFinite(approval.approvedAt)) return null;
  return new Date(approval.approvedAt).toISOString().slice(0, 10);
}
