import { describe, expect, test } from 'vitest';

import {
  diffFileMaps,
  splitLines,
  unifiedDiff,
  type FileDiff,
} from './revisionDiff';

describe('unifiedDiff', () => {
  test('identical text produces no output', () => {
    expect(unifiedDiff('a\nb\nc', 'a\nb\nc')).toBe('');
    // Even when there is no text at all.
    expect(unifiedDiff('', '')).toBe('');
  });

  test('a single changed line emits one full-context hunk', () => {
    const diff = unifiedDiff('a\nb\nc', 'a\nX\nc');
    expect(diff.split('\n')).toEqual([
      '--- current',
      '+++ revision',
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+X',
      ' c',
    ]);
  });

  test('a middle change trims to the surrounding context window', () => {
    const from = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join('\n');
    const toLines = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
    toLines[5] = 'X';
    const diff = unifiedDiff(from, toLines.join('\n'));
    expect(diff.split('\n')).toEqual([
      '--- current',
      '+++ revision',
      '@@ -3,7 +3,7 @@',
      ' L3',
      ' L4',
      ' L5',
      '-L6',
      '+X',
      ' L7',
      ' L8',
      ' L9',
    ]);
  });

  test('distant changes split into separate hunks', () => {
    const fromLines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`);
    const toLines = [...fromLines];
    toLines[0] = 'X';
    toLines[19] = 'Y';
    const diff = unifiedDiff(fromLines.join('\n'), toLines.join('\n'));
    expect(diff.split('\n')).toEqual([
      '--- current',
      '+++ revision',
      '@@ -1,4 +1,4 @@',
      '-L1',
      '+X',
      ' L2',
      ' L3',
      ' L4',
      '@@ -17,4 +17,4 @@',
      ' L17',
      ' L18',
      ' L19',
      '-L20',
      '+Y',
    ]);
  });

  test('changes six lines apart merge into one hunk', () => {
    const fromLines = Array.from({ length: 12 }, (_, i) => `L${i + 1}`);
    const toLines = [...fromLines];
    toLines[1] = 'X';
    toLines[8] = 'Y';
    const diff = unifiedDiff(fromLines.join('\n'), toLines.join('\n'));
    const lines = diff.split('\n');
    expect(lines).toHaveLength(17); // 2 headers + 1 hunk header + 14 body lines
    expect(lines[2]).toBe('@@ -1,12 +1,12 @@');
    const body = lines.slice(3);
    expect(body.filter((line) => line.startsWith('-'))).toEqual(['-L2', '-L9']);
    expect(body.filter((line) => line.startsWith('+'))).toEqual(['+X', '+Y']);
  });

  test('an added file diffs against the empty text', () => {
    const diff = unifiedDiff('', 'a\nb', '/dev/null', 'index.html');
    expect(diff.split('\n')).toEqual([
      '--- /dev/null',
      '+++ index.html',
      '@@ -1 +1,2 @@',
      '-',
      '+a',
      '+b',
    ]);
  });

  test('a removed file diffs down to the empty text', () => {
    const diff = unifiedDiff('a\nb', '', 'index.html', '/dev/null');
    expect(diff.split('\n')).toEqual([
      '--- index.html',
      '+++ /dev/null',
      '@@ -1,2 +1 @@',
      '-a',
      '-b',
      '+',
    ]);
  });

  test('oversized pairs degrade to a single whole-file hunk instead of an O(n·m) table', () => {
    const from = Array.from({ length: 1100 }, (_, i) => `l${i}`).join('\n');
    const toLines = Array.from({ length: 1100 }, (_, i) => `l${i}`);
    toLines[500] = 'changed';
    const diff = unifiedDiff(from, toLines.join('\n'));
    const lines = diff.split('\n');
    // 2 headers + 1 hunk header + 1100 deletions + 1100 insertions.
    expect(lines).toHaveLength(2203);
    expect(lines[2]).toBe('@@ -1,1100 +1,1100 @@');
    expect(lines[3]).toBe('-l0');
    expect(lines[1102]).toBe('-l1099');
    expect(lines[1103]).toBe('+l0');
    expect(lines[1603]).toBe('+changed');
  });

  test('custom labels land in the headers', () => {
    const diff = unifiedDiff('a', 'b', 'from.txt', 'to.txt');
    expect(diff.split('\n').slice(0, 2)).toEqual(['--- from.txt', '+++ to.txt']);
  });

  test('splitLines keeps both trailing-newline conventions consistent', () => {
    // A trailing newline shows up as an explicit empty last line on both
    // sides, so "added a trailing newline" is visible in the diff.
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
    expect(unifiedDiff('a\nb', 'a\nb\n').split('\n')).toEqual([
      '--- current',
      '+++ revision',
      '@@ -1,2 +1,3 @@',
      ' a',
      ' b',
      '+',
    ]);
  });
});

describe('diffFileMaps', () => {
  test('classifies added, removed, and changed files and skips unchanged ones', () => {
    const diffs = diffFileMaps(
      {
        'index.html': '<p>current</p>',
        'app.js': 'same();',
        'gone.css': 'body {}',
      },
      {
        'index.html': '<p>revision</p>',
        'app.js': 'same();',
        'new.css': 'body {}',
      },
    );

    const byFile = new Map(diffs.map((diff: FileDiff) => [diff.file, diff]));
    expect([...byFile.keys()]).toEqual(['gone.css', 'index.html', 'new.css']);
    expect(byFile.get('gone.css')?.status).toBe('removed');
    expect(byFile.get('index.html')?.status).toBe('changed');
    expect(byFile.get('new.css')?.status).toBe('added');

    const changed = byFile.get('index.html')?.diff.split('\n') ?? [];
    expect(changed).toContain('-<p>current</p>');
    expect(changed).toContain('+<p>revision</p>');
  });

  test('added and removed files use /dev/null for the missing side', () => {
    const [added] = diffFileMaps({}, { 'app.js': 'x();' });
    expect(added.file).toBe('app.js');
    expect(added.diff.split('\n').slice(0, 2)).toEqual(['--- /dev/null', '+++ app.js']);

    const [removed] = diffFileMaps({ 'app.js': 'x();' }, {});
    expect(removed.file).toBe('app.js');
    expect(removed.diff.split('\n').slice(0, 2)).toEqual(['--- app.js', '+++ /dev/null']);
  });

  test('empty maps and identical maps produce no diffs', () => {
    expect(diffFileMaps({}, {})).toEqual([]);
    expect(diffFileMaps({ 'a.txt': 'x' }, { 'a.txt': 'x' })).toEqual([]);
  });
});
