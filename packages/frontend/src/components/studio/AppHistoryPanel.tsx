/**
 * App revision history — the Developer Studio's diff/undo surface for the
 * app source-revision slice (design/13 "human review, diff, and undo are
 * first-class").
 *
 * Lists the app's immutable source revisions; selecting one shows the
 * per-file unified diff against the studio's current editor files;
 * "Restore" appends a NEW revision from the selected one (server-side:
 * revalidates, redeploys, grants never widen) behind an AlertDialog
 * confirmation. Failed saves appear in the list flagged invalid with their
 * stored diagnostics.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getAppRevisionFiles,
  listAppRevisions,
  restoreAppRevision,
  type AppRevisionDetail,
  type AppRevisionSummary,
} from '../../services/apps';
import { diffFileMaps, type FileDiff } from '../../utils/revisionDiff';
import { AlertDialog } from '../ui/AlertDialog';
import styles from './AppHistoryPanel.module.css';

interface AppHistoryPanelProps {
  appId: string;
  /** The studio's current editor files — the "from" side of every diff. */
  currentFiles: Record<string, string>;
  /** Called after a successful restore so the studio can reload source,
   *  releases, and the desktop item. */
  onRestored?: (result: { version: number; revisionId: string }) => void;
  onClose: () => void;
}

type StatusKind = 'idle' | 'loading' | 'success' | 'error';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function kindLabel(kind: AppRevisionSummary['kind']): string {
  switch (kind) {
    case 'deploy':
      return 'Deploy';
    case 'restore':
      return 'Restore';
    case 'rollback':
      return 'Rollback';
    case 'backfill':
      return 'Imported';
  }
}

export function AppHistoryPanel({ appId, currentFiles, onRestored, onClose }: AppHistoryPanelProps) {
  const [revisions, setRevisions] = useState<AppRevisionSummary[]>([]);
  const [currentRevision, setCurrentRevision] = useState<string | null>(null);
  const [lastValidRevision, setLastValidRevision] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppRevisionDetail | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: StatusKind; text: string }>({ kind: 'idle', text: '' });

  const refresh = useCallback(async () => {
    setBusy(true);
    setStatus({ kind: 'loading', text: 'Loading revision history…' });
    try {
      const data = await listAppRevisions(appId);
      setRevisions(data.revisions);
      setCurrentRevision(data.currentRevision);
      setLastValidRevision(data.lastValidRevision);
      setStatus({ kind: 'idle', text: '' });
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to load revisions.',
      });
    } finally {
      setBusy(false);
    }
  }, [appId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectRevision = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDiffs(null);
    setBusy(true);
    setStatus({ kind: 'loading', text: 'Loading revision…' });
    try {
      const data = await getAppRevisionFiles(appId, id);
      setDetail(data.revision);
      setDiffs(diffFileMaps(currentFiles, data.files));
      setStatus({ kind: 'idle', text: '' });
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Failed to load revision.',
      });
    } finally {
      setBusy(false);
    }
  }, [appId, currentFiles]);

  const handleRestore = useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setStatus({ kind: 'loading', text: 'Restoring revision…' });
    try {
      const result = await restoreAppRevision(appId, selectedId);
      onRestored?.({ version: result.version, revisionId: result.revisionId });
      await refresh();
      // After the refresh (which resets the status line), keep the restored
      // revision selected and surface the outcome.
      setSelectedId(selectedId);
      setStatus({ kind: 'success', text: `Restored as version ${result.version}.` });
    } catch (err) {
      setStatus({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Restore failed.',
      });
    } finally {
      setBusy(false);
    }
  }, [appId, onRestored, refresh, selectedId]);

  const selected = revisions.find((revision) => revision.id === selectedId) ?? null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.title}>Revision History</div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.headerBtn}
            data-role="refresh"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh
          </button>
          <button
            type="button"
            className={styles.headerBtn}
            data-role="close"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.list} data-role="revision-list">
          {revisions.length === 0 && !busy ? (
            <div className={styles.empty}>No revisions yet. Every save records one.</div>
          ) : (
            revisions.map((revision) => (
              <button
                type="button"
                key={revision.id}
                className={[
                  styles.row,
                  selectedId === revision.id ? styles.rowActive : '',
                ].filter(Boolean).join(' ')}
                data-role="revision-row"
                data-revision={revision.id}
                data-valid={revision.valid ? 'true' : 'false'}
                onClick={() => void selectRevision(revision.id)}
                disabled={busy}
              >
                <span className={styles.rowSummary}>{revision.summary}</span>
                <span className={styles.rowMeta}>
                  {formatDate(revision.createdAt)} · {revision.author}
                  {revision.id === currentRevision ? ' · current' : ''}
                  {revision.id === lastValidRevision && revision.id !== currentRevision ? ' · last valid' : ''}
                </span>
                <span className={styles.rowBadges}>
                  <span className={styles.badge}>{kindLabel(revision.kind)}</span>
                  <span className={revision.valid ? styles.badgeValid : styles.badgeInvalid}>
                    {revision.valid ? 'valid' : 'invalid'}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className={styles.detail} data-role="revision-detail">
          {detail && selected ? (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailTitle}>
                  {detail.summary}
                  {detail.parentRevision ? (
                    <span className={styles.detailParent}> from …{detail.parentRevision.slice(-8)}</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={styles.restoreBtn}
                  data-role="restore"
                  onClick={() => setConfirmOpen(true)}
                  disabled={busy}
                >
                  ↩ Restore this revision
                </button>
              </div>

              {!detail.valid && detail.diagnostics.issues.length > 0 ? (
                <div className={styles.diagnostics} data-role="diagnostics">
                  <div className={styles.diagnosticsTitle}>
                    This save was rejected ({detail.diagnostics.issues.length} issue
                    {detail.diagnostics.issues.length === 1 ? '' : 's'}):
                  </div>
                  {detail.diagnostics.issues.map((issue, index) => (
                    <div key={index} className={styles.issue}>
                      <span className={styles.issueCode}>{issue.code}</span>
                      <span>{issue.message}</span>
                      {issue.hint ? <span className={styles.issueHint}>fix: {issue.hint}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {diffs === null ? null : diffs.length === 0 ? (
                <div className={styles.noDiff}>No differences against the current editor files.</div>
              ) : (
                diffs.map((diff) => (
                  <div
                    key={diff.file}
                    className={styles.diffFile}
                    data-role="diff-file"
                    data-file={diff.file}
                    data-status={diff.status}
                  >
                    <div className={styles.diffFileHeader}>
                      <span className={styles.diffFileName}>{diff.file}</span>
                      <span className={styles.diffStatus} data-status={diff.status}>{diff.status}</span>
                    </div>
                    <pre className={styles.diffBody} data-role="diff-body">{diff.diff}</pre>
                  </div>
                ))
              )}
            </>
          ) : (
            <div className={styles.empty}>Select a revision to see its diff against the current files.</div>
          )}
        </div>
      </div>

      <div className={styles.statusBar} data-role="panel-status" data-kind={status.kind}>
        {status.text || `${revisions.length} revision${revisions.length === 1 ? '' : 's'}`}
      </div>

      {confirmOpen && selected && (
        <AlertDialog
          type="confirm"
          title="Restore this revision?"
          message={`This creates a new revision from "${selected.summary}" and redeploys it as a new release if it still validates. The installed app is only replaced when validation passes; grants never widen.`}
          onClose={() => setConfirmOpen(false)}
          buttons={[
            { label: 'Cancel', onClick: () => setConfirmOpen(false) },
            { label: 'Restore', onClick: () => void handleRestore(), primary: true },
          ]}
        />
      )}
    </div>
  );
}
