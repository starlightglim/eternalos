/**
 * Ask Eternal — Code Mode run views.
 *
 *  - ChangePreview: the plain-language list of what a run would change,
 *    produced by a practice run before the approval card appears.
 *  - RunSteps: one line per tool call, live while the run works.
 *  - UndoControl: one-click undo of a finished run.
 *  - RoutineRunCard: a saved routine's run, posted into the thread.
 *  - RoutinesPanel: the thread's routines (inspector), with Run now / Delete.
 *
 * Data comes from data parts the agent streams next to the tool part
 * (`data-codemode-preview|steps|undo`, keyed by tool call id).
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  deleteAgentRoutine,
  listAgentRoutines,
  runAgentRoutineNow,
  undoAgentRun,
  type RoutineSummary,
  type UndoRunResult,
} from '../../services/agent';
import styles from './CodeRunViews.module.css';
import type { PlannedAction } from '../../utils/codeRunText';

export type { PlannedAction };

export interface CodePreviewData {
  ok: boolean;
  actions: PlannedAction[];
  error?: string;
}

export interface RunStep {
  id: number;
  tool: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  write: boolean;
}

export interface RunStepsData {
  steps: RunStep[];
  total: number;
  done: number;
  failed: number;
}

export interface UndoData {
  runId: string;
  available: boolean;
  writes: number;
  steps: string[];
  skipped: string[];
  changedApps: string[];
  /** Set by the agent once the run was undone (survives reloads). */
  undoneAt?: number;
}

export interface RoutineRunData {
  runId: string;
  routineId: string;
  name: string;
  status: 'ok' | 'error';
  summary: string;
  steps: RunStep[];
  undo: UndoData | null;
  changedApps: string[];
  ranAt: number;
  trigger: 'schedule' | 'manual' | 'saved';
}

const MAX_PREVIEW_ROWS = 12;

function changeKind(action: PlannedAction): 'add' | 'remove' | 'trash' | 'edit' {
  // Moving things to the Trash is listed first like a deletion, but counted
  // as "to the Trash": it can be restored.
  if (action.tool === 'moveToTrash') return 'trash';
  if (/^(Add|Create)\b/.test(action.summary)) return 'add';
  if (/^(Delete|Remove)\b/.test(action.summary)) return 'remove';
  return 'edit';
}

const KIND_ICON = { add: '+', remove: '−', trash: '−', edit: '✎' } as const;

const KIND_ORDER = { remove: 0, trash: 1, edit: 2, add: 3 } as const;
const KIND_WORD = {
  add: ['add', 'adds'],
  edit: ['update', 'updates'],
  remove: ['delete', 'deletes'],
  trash: ['move to the Trash', 'moves to the Trash'],
} as const;

function ChangeRow({ action }: { action: PlannedAction }) {
  const kind = changeKind(action);
  return (
    <li className={styles.changeItem}>
      <span className={`${styles.changeIcon} ${styles[`change_${kind === 'trash' ? 'remove' : kind}`]}`} aria-hidden="true">{KIND_ICON[kind]}</span>
      <span className={styles.changeText}>
        <span className={styles.changeSummary}>{action.summary}</span>
        {action.detail ? <span className={styles.changeDetail}>{action.detail}</span> : null}
      </span>
    </li>
  );
}

/**
 * What a run would change — shown in the approval card. Every change stays
 * reachable: deletions are listed first so they can never fall below the
 * fold, a long list states exact counts by kind, and the rest is one click
 * away in the same card.
 */
export function ChangePreview({ preview }: { preview?: CodePreviewData }) {
  if (!preview) return null;
  if (!preview.ok) {
    return (
      <div className={styles.previewNote} role="note">
        Couldn’t preview this run{preview.error ? `: ${preview.error}` : ''}. Running it may still work; check the code below.
      </div>
    );
  }
  if (preview.actions.length === 0) {
    return <div className={styles.previewNote}>This run won’t change anything.</div>;
  }
  const sorted = [...preview.actions].sort((a, b) => KIND_ORDER[changeKind(a)] - KIND_ORDER[changeKind(b)]);
  const shown = sorted.slice(0, MAX_PREVIEW_ROWS);
  const rest = sorted.slice(MAX_PREVIEW_ROWS);
  const counts = (['remove', 'trash', 'edit', 'add'] as const)
    .map((kind) => [kind, sorted.filter((a) => changeKind(a) === kind).length] as const)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => `${n} ${KIND_WORD[kind][n === 1 ? 0 : 1]}`);
  return (
    <div className={styles.preview}>
      <div className={styles.previewHeading}>
        {sorted.length === 1 ? 'It will make 1 change:' : `It will make ${sorted.length} changes${counts.length > 1 ? ` (${counts.join(', ')})` : ''}:`}
      </div>
      <ul className={styles.changeList}>
        {shown.map((action, index) => <ChangeRow key={index} action={action} />)}
      </ul>
      {rest.length ? (
        <details className={styles.previewRest}>
          <summary>Show the other {rest.length} change{rest.length === 1 ? '' : 's'}</summary>
          <ul className={styles.changeList}>
            {rest.map((action, index) => <ChangeRow key={index} action={action} />)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export interface ActivityItem {
  key: string;
  label: string;
  detail?: string;
  running: boolean;
  failed?: boolean;
  details: ReactNode;
}

/**
 * Lookups the assistant made on the way to an answer, folded into one quiet
 * line instead of a stack of cards. The full cards are one click away.
 */
export function ActivityGroup({ items }: { items: ActivityItem[] }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const running = items.some((item) => item.running);
  // The same lookup twice (a check, then a re-check) reads as one.
  const summary = [...new Set(items.map((item) => item.label))].join(' · ');
  return (
    <div className={styles.activity}>
      <button
        type="button"
        className={styles.activityToggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className={styles.activityIcon} aria-hidden="true">
          {running ? <span className={styles.spinner} /> : '✓'}
        </span>
        <span className={styles.activitySummary}>{summary}{running ? '…' : ''}</span>
        <span className={styles.activityChevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open ? (
        <div className={styles.activityDetails}>
          <ul className={styles.activityList}>
            {items.map((item) => (
              <li key={item.key} className={item.failed ? styles.activityFailed : undefined}>
                {item.label}{item.detail ? <span className={styles.stepDetail}> · {item.detail}</span> : null}
              </li>
            ))}
          </ul>
          {items.map((item) => <div key={`${item.key}-card`}>{item.details}</div>)}
        </div>
      ) : null}
    </div>
  );
}

/** One line per tool call; live while running, a record afterwards. */
export function RunSteps({ data, running }: { data?: RunStepsData; running: boolean }) {
  if (!data || data.steps.length === 0) {
    return running ? <div className={styles.stepsEmpty}>Starting…</div> : null;
  }
  const hidden = data.total - data.steps.length;
  return (
    <div className={styles.steps} aria-live={running ? 'polite' : undefined}>
      {hidden > 0 ? <div className={styles.stepsMore}>{hidden} earlier step{hidden === 1 ? '' : 's'}</div> : null}
      <ol className={styles.stepList}>
        {data.steps.map((step) => (
          <li key={step.id} className={`${styles.step} ${styles[`step_${step.status}`]}`}>
            <span className={styles.stepIcon} aria-label={step.status}>
              {step.status === 'done' ? '✓' : step.status === 'error' ? '✕' : <span className={styles.spinner} />}
            </span>
            <span className={`${styles.stepLabel} ${step.write ? styles.stepWrite : ''}`}>{step.label}</span>
            {step.detail ? <span className={styles.stepDetail}>{step.detail}</span> : null}
          </li>
        ))}
      </ol>
      {!running && data.total > 1 ? (
        <div className={styles.stepsSummary}>
          {data.done} of {data.total} steps done{data.failed ? `, ${data.failed} failed` : ''}
        </div>
      ) : null}
    </div>
  );
}

type UndoState =
  | { phase: 'idle' }
  | { phase: 'working' }
  | { phase: 'done'; result: UndoRunResult }
  | { phase: 'error'; message: string };

/** One-click undo of a finished run. */
export function UndoControl({
  threadId,
  undo,
  onUndone,
}: {
  threadId: string;
  undo?: UndoData | null;
  onUndone?: (result: UndoRunResult) => void;
}) {
  const [state, setState] = useState<UndoState>({ phase: 'idle' });
  if (!undo || undo.writes === 0) return null;

  const run = async () => {
    setState({ phase: 'working' });
    try {
      const result = await undoAgentRun(threadId, undo.runId);
      setState({ phase: 'done', result });
      onUndone?.(result);
    } catch (error) {
      setState({ phase: 'error', message: error instanceof Error ? error.message : 'Undo failed' });
    }
  };

  const skipped = undo.skipped.length ? (
    <div className={styles.undoSkipped}>Can’t undo: {undo.skipped.join('; ')}</div>
  ) : null;

  if (!undo.available) return skipped;

  if (undo.undoneAt && state.phase === 'idle') {
    return (
      <div className={styles.undoRow}>
        <span className={styles.undoDone}>↶ Undone {new Date(undo.undoneAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span>
      </div>
    );
  }

  if (state.phase === 'done') {
    const { result } = state;
    const text = result.status === 'already-undone'
      ? 'Already undone.'
      : result.status === 'missing'
        ? 'This run can no longer be undone.'
        : result.status === 'partial'
          ? `Partly undone: ${result.done.length} reversed, ${result.failed.length} could not be.`
          : `Undone — ${result.done.length === 1 ? '1 change' : `${result.done.length} changes`} reversed.`;
    return (
      <div className={styles.undoRow}>
        <span className={styles.undoDone} role="status">↶ {text}</span>
        {result.failed.length ? (
          <ul className={styles.undoFailures}>
            {result.failed.map((failure, index) => <li key={index}>{failure.summary}: {failure.error}</li>)}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <div className={styles.undoRow}>
      <button
        type="button"
        className={styles.undoButton}
        onClick={() => void run()}
        disabled={state.phase === 'working'}
      >
        {state.phase === 'working' ? 'Undoing…' : `↶ Undo ${undo.writes === 1 ? 'this change' : `these ${undo.writes} changes`}`}
      </button>
      {state.phase === 'error' ? <span className={styles.undoError}>{state.message}</span> : null}
      {skipped}
    </div>
  );
}

function formatWhen(timestamp: number | null): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

/** A routine's run, posted into the thread by the agent. */
export function RoutineRunCard({
  data,
  threadId,
  onUndone,
}: {
  data: RoutineRunData;
  threadId: string;
  onUndone?: (result: UndoRunResult) => void;
}) {
  const steps: RunStepsData = {
    steps: data.steps ?? [],
    total: data.steps?.length ?? 0,
    done: (data.steps ?? []).filter((s) => s.status === 'done').length,
    failed: (data.steps ?? []).filter((s) => s.status === 'error').length,
  };
  return (
    <div className={styles.routineRun}>
      <div className={styles.routineRunHead}>
        <span className={styles.routineBadge}>Routine</span>
        <span className={styles.routineRunName}>{data.name}</span>
        <span className={data.status === 'ok' ? styles.routineOk : styles.routineFailed}>
          {data.status === 'ok' ? 'ran' : 'failed'} {formatWhen(data.ranAt)}
        </span>
      </div>
      <RunSteps data={steps} running={false} />
      <UndoControl threadId={threadId} undo={data.undo} onUndone={onUndone} />
    </div>
  );
}

/** The thread's saved routines, for the inspector. */
export function RoutinesPanel({
  threadId,
  refreshKey,
  onRan,
}: {
  threadId: string;
  refreshKey: number;
  onRan?: (changedApps: string[]) => void;
}) {
  const [routines, setRoutines] = useState<RoutineSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRoutines(await listAgentRoutines(threadId));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load routines');
    }
  }, [threadId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (error && !routines) return <div className={styles.routinesEmpty}>{error}</div>;
  if (!routines) return <div className={styles.routinesEmpty}>Loading…</div>;
  if (routines.length === 0) {
    return <div className={styles.routinesEmpty}>None yet. Ask for something to happen “every morning” or “every 3 hours”.</div>;
  }

  return (
    <ul className={styles.routineList}>
      {routines.map((routine) => (
        <li key={routine.id} className={styles.routineItem}>
          <div className={styles.routineName}>{routine.name}</div>
          <div className={styles.routineMeta}>{routine.schedule}</div>
          <div className={styles.routineMeta}>
            Next: {formatWhen(routine.nextRunAt)}
            {routine.lastRunAt ? ` · Last: ${routine.lastStatus === 'error' ? 'failed' : 'ok'} ${formatWhen(routine.lastRunAt)}` : ''}
          </div>
          <div className={styles.routineActions}>
            <button
              type="button"
              className={styles.smallButton}
              disabled={busy === routine.id}
              onClick={async () => {
                setBusy(routine.id);
                try {
                  const result = await runAgentRoutineNow(threadId, routine.id);
                  onRan?.(result.changedApps ?? []);
                } finally {
                  setBusy(null);
                  void load();
                }
              }}
            >
              {busy === routine.id ? 'Running…' : 'Run now'}
            </button>
            <button
              type="button"
              className={styles.smallButton}
              disabled={busy === routine.id}
              onClick={async () => {
                if (confirmDelete !== routine.id) {
                  setConfirmDelete(routine.id);
                  return;
                }
                setBusy(routine.id);
                try {
                  await deleteAgentRoutine(threadId, routine.id);
                } finally {
                  setBusy(null);
                  setConfirmDelete(null);
                  void load();
                }
              }}
            >
              {confirmDelete === routine.id ? 'Confirm delete' : 'Delete'}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
