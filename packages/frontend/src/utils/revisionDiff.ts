/**
 * A small dependency-free line diff for the Developer Studio revision
 * history: per-file unified diffs between two source-file maps.
 *
 * Direction convention: `diffFileMaps(current, revision)` reads as
 * "current → revision" — `-` lines are what the current state has that the
 * revision doesn't, `+` lines are what the restore would bring in. That is
 * the Aider-style review orientation (edits easy to inspect before applying).
 *
 * The diff is a classic LCS over lines (O(n·m) dynamic programming, bounded
 * by the LCS_SIZE_GUARD below — beyond it the pair degrades to a single
 * whole-file hunk instead of blowing the memory budget). Good enough for
 * hand-edited app sources; no Myers/patience machinery needed.
 */

export type FileDiffStatus = 'added' | 'removed' | 'changed';

export interface FileDiff {
  file: string;
  status: FileDiffStatus;
  /** Full unified diff (headers + hunks); empty string never happens here —
   *  diffFileMaps skips unchanged files entirely. */
  diff: string;
}

type OpType = 'context' | 'delete' | 'insert';

interface DiffOp {
  type: OpType;
  line: string;
}

/** Max fromLines·toLines for the LCS table (4MB Uint32Array at 1e6). */
const LCS_SIZE_GUARD = 1_000_000;

/** Context lines shown around each change in the unified output. */
const DIFF_CONTEXT = 3;

export function splitLines(text: string): string[] {
  // Both sides use the same rule, so trailing-newline differences show up as
  // an explicit empty-line add/remove instead of being silently normalized.
  return text.split('\n');
}

/**
 * One LCS pass over two line arrays → the edit operations, oldest first,
 * with all `delete`s for a position preceding its `insert`s.
 */
function buildOps(from: string[], to: string[]): DiffOp[] {
  const n = from.length;
  const m = to.length;
  const width = m + 1;
  // Longest common suffix lengths: table[i * width + j] = LCS(from[i..], to[j..])
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = from[i] === to[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (from[i] === to[j]) {
      ops.push({ type: 'context', line: from[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ type: 'delete', line: from[i] });
      i++;
    } else {
      ops.push({ type: 'insert', line: to[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'delete', line: from[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'insert', line: to[j] });
    j++;
  }
  return ops;
}

/** Whole-file replacement as one hunk — the over-size fallback. */
function wholeFileOps(from: string[], to: string[]): DiffOp[] {
  return [
    ...from.map((line): DiffOp => ({ type: 'delete', line })),
    ...to.map((line): DiffOp => ({ type: 'insert', line })),
  ];
}

/**
 * Format one file's edit operations as a unified diff. Returns '' when the
 * texts are identical. Hunks carry `DIFF_CONTEXT` lines around changes; two
 * changes less than 2·context+1 apart share one hunk.
 */
export function unifiedDiff(
  fromText: string,
  toText: string,
  fromLabel = 'current',
  toLabel = 'revision',
): string {
  const from = splitLines(fromText);
  const to = splitLines(toText);
  if (fromText === toText) return '';

  const ops = from.length * to.length > LCS_SIZE_GUARD
    ? wholeFileOps(from, to)
    : buildOps(from, to);
  if (ops.every((op) => op.type === 'context')) return '';

  // Hunk membership: an op is included when a change sits within
  // DIFF_CONTEXT ops of it. Maximal runs of included ops become hunks, so
  // two changes merge unless more than 2·DIFF_CONTEXT contexts separate them.
  const lastChange = new Int32Array(ops.length).fill(-1);
  const nextChange = new Int32Array(ops.length).fill(-1);
  let last = -1;
  for (let i = 0; i < ops.length; i++) {
    lastChange[i] = last;
    if (ops[i].type !== 'context') last = i;
  }
  let next = -1;
  for (let i = ops.length - 1; i >= 0; i--) {
    nextChange[i] = next;
    if (ops[i].type !== 'context') next = i;
  }
  const included = ops.map((op, i) => {
    // A change op is always part of a hunk; contexts join when a change sits
    // within DIFF_CONTEXT ops of them.
    if (op.type !== 'context') return true;
    const prevDistance = lastChange[i] === -1 ? Infinity : i - lastChange[i];
    const nextDistance = nextChange[i] === -1 ? Infinity : nextChange[i] - i;
    return Math.min(prevDistance, nextDistance) <= DIFF_CONTEXT;
  });

  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let fromLine = 1; // 1-based line number of the next unprocessed op, from-side
  let toLine = 1;
  let i = 0;
  while (i < ops.length) {
    if (!included[i]) {
      if (ops[i].type !== 'insert') fromLine++;
      if (ops[i].type !== 'delete') toLine++;
      i++;
      continue;
    }
    // One hunk: the maximal included run starting at i.
    const start = i;
    let end = i;
    while (end < ops.length && included[end]) end++;

    const hunkStartFrom = fromLine;
    const hunkStartTo = toLine;
    let fromCount = 0;
    let toCount = 0;
    const body: string[] = [];
    for (let k = start; k < end; k++) {
      const op = ops[k];
      if (op.type === 'delete') {
        body.push(`-${op.line}`);
        fromCount++;
      } else if (op.type === 'insert') {
        body.push(`+${op.line}`);
        toCount++;
      } else {
        body.push(` ${op.line}`);
        fromCount++;
        toCount++;
      }
    }
    // Standard unified-header quirk: an empty side anchors at the line
    // *before* the hunk (git writes `@@ -0,0 +1 @@` for a fully added file).
    const fromStart = fromCount === 0 ? Math.max(fromLine - 1, 0) : hunkStartFrom;
    const toStart = toCount === 0 ? Math.max(toLine - 1, 0) : hunkStartTo;
    const fromRange = fromCount === 1 ? `${fromStart}` : `${fromStart},${fromCount}`;
    const toRange = toCount === 1 ? `${toStart}` : `${toStart},${toCount}`;
    lines.push(`@@ -${fromRange} +${toRange} @@`, ...body);

    // Advance past the hunk.
    for (let k = start; k < end; k++) {
      const type = ops[k].type;
      if (type !== 'insert') fromLine++;
      if (type !== 'delete') toLine++;
    }
    i = end;
  }
  return lines.join('\n');
}

/**
 * Per-file diffs between two source-file maps, sorted by file name.
 * Unchanged files are skipped; a file present on only one side is
 * 'removed' (in `from`, not in `to`) or 'added' (in `to`, not in `from`).
 */
export function diffFileMaps(
  from: Record<string, string>,
  to: Record<string, string>,
): FileDiff[] {
  const names = Array.from(new Set([...Object.keys(from), ...Object.keys(to)])).sort();
  const diffs: FileDiff[] = [];
  for (const file of names) {
    const fromText = from[file];
    const toText = to[file];
    if (fromText === toText) continue;
    if (fromText === undefined) {
      diffs.push({ file, status: 'added', diff: unifiedDiff('', toText, '/dev/null', file) });
    } else if (toText === undefined) {
      diffs.push({ file, status: 'removed', diff: unifiedDiff(fromText, '', file, '/dev/null') });
    } else {
      diffs.push({ file, status: 'changed', diff: unifiedDiff(fromText, toText, file, file) });
    }
  }
  return diffs;
}
