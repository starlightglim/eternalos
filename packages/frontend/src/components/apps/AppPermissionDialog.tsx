/**
 * App install/approval dialog — shown when an installed app's manifest
 * declares permissions the user has not granted yet.
 *
 * Broad scopes (whole-filesystem globs, wildcard network domains, all
 * profile fields — computed server-side and passed in via `broad`) get a
 * distinct warning row carrying the manifest's rationale, and each one
 * requires its own explicit tick before it is granted; the tick is sent to
 * the server as that scope's `broadApprovals` entry. Narrow scopes keep the
 * plain checkbox flow and are pre-ticked when already granted.
 *
 * Extracted from AppViewer.tsx (Workstream 3, Phase B).
 */

import { useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { AppGrantApproval } from '../../types';
import {
  approvalDateText,
  broadWarningText,
  buildGrantedPermissions,
  getPermissionEntries,
  hasAllPermissionValues,
  initialSelectedKeys,
  type PermissionEntry,
} from './appPermissionScopes';

export interface AppPermissionDialogProps {
  /** The manifest's declared permission set. */
  requested: Record<string, unknown>;
  /** The currently granted set (scopes fully granted are marked approved). */
  granted: Record<string, unknown>;
  /** Broad scope ids within the declared set, from the permissions GET. */
  broad?: string[];
  /** Per-scope approval metadata ("approved on …"), from the permissions GET. */
  approvals?: Record<string, AppGrantApproval>;
  /** The manifest's rationale, shown in broad-scope warning rows. */
  rationale?: string;
  busy?: boolean;
  /** The user ticked their selection. Receives the grant payload and the
   *  explicitly approved broad scope ids. */
  onAllow: (granted: Record<string, unknown>, broadApprovals: string[]) => void;
  onDeny: () => void;
}

function approvalStatusText(entry: PermissionEntry, granted: Record<string, unknown>, approvals?: Record<string, AppGrantApproval>): string | null {
  if (!hasAllPermissionValues(granted, entry)) return null;
  const date = approvalDateText(approvals?.[entry.key]);
  return date ? `Approved on ${date}` : 'Approved (date unknown)';
}

export function AppPermissionDialog({
  requested,
  granted,
  broad = [],
  approvals,
  rationale,
  busy = false,
  onAllow,
  onDeny,
}: AppPermissionDialogProps) {
  const entries = useMemo(() => getPermissionEntries(requested, broad), [requested, broad]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => initialSelectedKeys(entries, granted));

  // Focus starts on Deny (the least-privilege choice, so a stray Space can't
  // tick a scope); Escape denies unless a grant is in flight; Tab stays inside.
  // Window scope: the prompt only covers its app window, so it never takes
  // keys or focus from the rest of the desktop (or while minimized).
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, { onEscape: busy ? undefined : onDeny, initialFocus: denyRef, scope: 'window' });

  const toggle = (key: string, checked: boolean) => {
    setSelectedKeys((current) => checked
      ? [...current, key]
      : current.filter((candidate) => candidate !== key));
  };

  const handleAllow = () => {
    const grantedPayload = buildGrantedPermissions(requested, selectedKeys);
    // The broad scopes the user explicitly ticked — exactly the broad scopes
    // included in the submission. The server rejects a grant request whose
    // broad scopes are not listed here.
    const broadApprovals = selectedKeys.filter((key) => broad.includes(key));
    onAllow(grantedPayload, broadApprovals);
  };

  return (
    <div style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      background: 'rgba(0, 0, 0, 0.45)',
      zIndex: 2,
    }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="app-permissions-title" style={{
        width: 'min(420px, 100%)',
        maxHeight: '100%',
        overflow: 'auto',
        padding: 16,
        background: 'var(--window-bg, #f5f5f5)',
        color: 'var(--window-text-color, #000)',
        border: '2px solid var(--black, #000)',
        boxShadow: '4px 4px 0 rgba(0, 0, 0, 0.35)',
      }}>
        <h2 id="app-permissions-title" style={{ margin: '0 0 8px', fontSize: 15 }}>App permissions</h2>
        <p style={{ margin: '0 0 10px', fontSize: 12 }}>
          {rationale || 'Choose what this app can access. You can change this later by reopening the app.'}
        </p>
        {entries.map((entry) => {
          const approved = approvalStatusText(entry, granted, approvals);
          const isGranted = hasAllPermissionValues(granted, entry);
          return (
            <label
              key={entry.key}
              data-scope={entry.key}
              data-broad={entry.broad ? 'true' : 'false'}
              data-granted={isGranted ? 'true' : 'false'}
              style={entry.broad ? {
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                margin: '10px 0',
                padding: '8px 10px',
                fontSize: 12,
                border: '1px solid var(--danger, #990000)',
                background: 'color-mix(in srgb, var(--danger, #990000) 10%, var(--window-bg, #fff))',
              } : {
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                margin: '8px 0',
                fontSize: 12,
              }}
            >
              <input
                type="checkbox"
                checked={selectedKeys.includes(entry.key)}
                onChange={(event) => toggle(entry.key, event.target.checked)}
              />
              <span>
                <strong>{entry.label}</strong>
                <br />
                <small>{entry.values.join(', ')}</small>
                {entry.broad && (
                  <>
                    <br />
                    <small data-role="broad-warning" style={{ color: 'var(--danger, #990000)' }}>
                      {broadWarningText(entry.key)}
                      {rationale ? <> Why: {rationale}</> : null}
                    </small>
                    <br />
                    <small data-role="broad-hint">
                      {isGranted
                        ? 'Requires an explicit tick — leaving it unticked revokes this access.'
                        : 'Requires an explicit tick before this app gets it.'}
                    </small>
                  </>
                )}
                {approved && (
                  <>
                    <br />
                    <small data-role="approval-status">{approved}</small>
                  </>
                )}
              </span>
            </label>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button type="button" ref={denyRef} data-role="deny" onClick={onDeny} disabled={busy}>Deny</button>
          <button type="button" data-role="allow" onClick={handleAllow} disabled={busy}>Allow selected</button>
        </div>
      </div>
    </div>
  );
}
