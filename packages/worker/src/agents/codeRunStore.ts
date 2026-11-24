/**
 * Per-thread storage (the agent DO's SQLite) for Code Mode undo plans and
 * saved routines.
 *
 *  - code_runs: one row per run that changed something and can be undone.
 *    Undo is one-shot: the row records when it was undone.
 *  - routines: saved Code Mode scripts that run on a schedule without a new
 *    approval each time (the user approved the code when saving it). They
 *    make no AI calls, so a routine costs no AI budget.
 */

import type { InverseOp, RoutineSchedule } from './tools/codeModeRuns';

export const MAX_ROUTINES_PER_THREAD = 10;
export const MAX_ROUTINE_CODE_CHARS = 20_000;
const MAX_STORED_RUNS = 200;

export interface StoredUndoPlan {
  ops: InverseOp[];
  skipped: string[];
  writes: number;
}

export interface RoutineRecord {
  id: string;
  name: string;
  code: string;
  schedule: RoutineSchedule;
  createdAt: number;
  nextRunAt: number | null;
  scheduleId: string | null;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  lastSummary: string | null;
  enabled: boolean;
}

export function initCodeRunStore(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS code_runs (
    run_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    plan TEXT NOT NULL,
    undone_at INTEGER
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS code_previews (
    run_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    signatures TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL,
    schedule TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    next_run_at INTEGER,
    schedule_id TEXT,
    last_run_at INTEGER,
    last_status TEXT,
    last_summary TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  )`);
}

/* ---------------------------- undo plans ---------------------------- */

export function saveUndoPlan(sql: SqlStorage, runId: string, plan: StoredUndoPlan, now = Date.now()): void {
  sql.exec(
    'INSERT OR REPLACE INTO code_runs (run_id, created_at, plan, undone_at) VALUES (?, ?, ?, NULL)',
    runId,
    now,
    JSON.stringify(plan),
  );
  // Keep the table small: only the most recent runs stay undoable.
  sql.exec(
    'DELETE FROM code_runs WHERE run_id NOT IN (SELECT run_id FROM code_runs ORDER BY created_at DESC LIMIT ?)',
    MAX_STORED_RUNS,
  );
}

export type UndoLookup =
  | { status: 'ready'; plan: StoredUndoPlan }
  | { status: 'missing' }
  | { status: 'undone'; undoneAt: number };

export function getUndoPlan(sql: SqlStorage, runId: string): UndoLookup {
  const row = sql.exec<{ plan: string; undone_at: number | null }>(
    'SELECT plan, undone_at FROM code_runs WHERE run_id = ?',
    runId,
  ).toArray()[0];
  if (!row) return { status: 'missing' };
  if (row.undone_at) return { status: 'undone', undoneAt: row.undone_at };
  return { status: 'ready', plan: JSON.parse(row.plan) as StoredUndoPlan };
}

export function markUndone(sql: SqlStorage, runId: string, now = Date.now()): void {
  sql.exec('UPDATE code_runs SET undone_at = ? WHERE run_id = ?', now, runId);
}

/* ------------------------ approved previews ------------------------- */

export function savePreviewSignatures(sql: SqlStorage, runId: string, signatures: string[], now = Date.now()): void {
  sql.exec('INSERT OR REPLACE INTO code_previews (run_id, created_at, signatures) VALUES (?, ?, ?)', runId, now, JSON.stringify(signatures));
  sql.exec('DELETE FROM code_previews WHERE created_at < ?', now - 7 * 86_400_000);
}

export function loadPreviewSignatures(sql: SqlStorage, runId: string): string[] | null {
  const row = sql.exec<{ signatures: string }>('SELECT signatures FROM code_previews WHERE run_id = ?', runId).toArray()[0];
  return row ? JSON.parse(row.signatures) as string[] : null;
}

/* ----------------------------- routines ----------------------------- */

type RoutineRow = {
  id: string;
  name: string;
  code: string;
  schedule: string;
  created_at: number;
  next_run_at: number | null;
  schedule_id: string | null;
  last_run_at: number | null;
  last_status: string | null;
  last_summary: string | null;
  enabled: number;
};

function toRoutine(row: RoutineRow): RoutineRecord {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    schedule: JSON.parse(row.schedule) as RoutineSchedule,
    createdAt: row.created_at,
    nextRunAt: row.next_run_at,
    scheduleId: row.schedule_id,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status === 'ok' || row.last_status === 'error' ? row.last_status : null,
    lastSummary: row.last_summary,
    enabled: Boolean(row.enabled),
  };
}

export function listRoutineRecords(sql: SqlStorage): RoutineRecord[] {
  return sql.exec<RoutineRow>('SELECT * FROM routines ORDER BY created_at ASC').toArray().map(toRoutine);
}

export function getRoutineRecord(sql: SqlStorage, id: string): RoutineRecord | null {
  const row = sql.exec<RoutineRow>('SELECT * FROM routines WHERE id = ?', id).toArray()[0];
  return row ? toRoutine(row) : null;
}

export function countRoutines(sql: SqlStorage): number {
  return sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM routines').toArray()[0]?.n ?? 0;
}

export function insertRoutine(
  sql: SqlStorage,
  routine: Pick<RoutineRecord, 'id' | 'name' | 'code' | 'schedule' | 'createdAt' | 'nextRunAt' | 'scheduleId'>,
): void {
  sql.exec(
    `INSERT INTO routines (id, name, code, schedule, created_at, next_run_at, schedule_id, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    routine.id,
    routine.name,
    routine.code,
    JSON.stringify(routine.schedule),
    routine.createdAt,
    routine.nextRunAt,
    routine.scheduleId,
  );
}

export function updateRoutineSchedule(sql: SqlStorage, id: string, nextRunAt: number | null, scheduleId: string | null): void {
  sql.exec('UPDATE routines SET next_run_at = ?, schedule_id = ? WHERE id = ?', nextRunAt, scheduleId, id);
}

export function recordRoutineRun(sql: SqlStorage, id: string, status: 'ok' | 'error', summary: string, now = Date.now()): void {
  sql.exec(
    'UPDATE routines SET last_run_at = ?, last_status = ?, last_summary = ? WHERE id = ?',
    now,
    status,
    summary.slice(0, 2000),
    id,
  );
}

export function deleteRoutineRecord(sql: SqlStorage, id: string): boolean {
  const existed = Boolean(getRoutineRecord(sql, id));
  sql.exec('DELETE FROM routines WHERE id = ?', id);
  return existed;
}
