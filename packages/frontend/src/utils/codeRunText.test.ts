import { describe, expect, test } from 'vitest';
import { appearanceSettingsLine, appearanceSwatches, describeAppChange, describeDesktopEdit, describeDesktopEditDone, readOnlyRunSteps } from './codeRunText';

test('describes single app-data changes in plain words', () => {
  expect(describeAppChange('PATCH', '/api/books/1', { is_read: 1 }, 'Books')).toEqual({
    tool: 'callAppApi',
    summary: 'Update book #1 in Books',
    detail: 'read: yes',
  });
  expect(describeAppChange('POST', '/api/books', { title: 'Dune', author: 'Frank Herbert' }, 'Books').detail)
    .toBe('title: “Dune”, author: “Frank Herbert”');
  expect(describeAppChange('DELETE', '/api/entries/abc12345-6789', undefined, 'Evalog').summary).toBe('Delete entry #abc12345-6789 from Evalog');
  expect(describeAppChange('POST', '/api/reading-lists', {}, undefined).summary).toBe('Add reading list to an app');
  expect(describeAppChange('PATCH', '/api/books/1?cascade=1', { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, 'Books').detail)
    .toBe('a: 1, b: 2, c: 3, d: 4, +2 more fields, with options ?cascade=1');
});

test('folds lookups into short activity lines', async () => {
  const { activityLabel, isQuietToolPart } = await import('./codeRunText');
  const names = (id: string) => (id === 'b1' ? 'Books' : undefined);
  expect(activityLabel({ type: 'tool-readAppApi', state: 'output-available', input: { appId: 'b1', path: '/api/books' }, output: { status: 200, ok: true, data: [1, 2, 3] } }, names))
    .toEqual({ label: 'Read books from Books', detail: '3 records' });
  expect(activityLabel({ type: 'tool-listApps', state: 'input-available', input: {} }, names)).toEqual({ label: 'Checking your apps', detail: undefined });
  expect(isQuietToolPart({ type: 'tool-callAppApi', state: 'output-available', input: { method: 'POST' } })).toBe(false);
  expect(isQuietToolPart({ type: 'tool-callAppApi', state: 'output-available', input: { method: 'GET' } })).toBe(true);
  expect(isQuietToolPart({ type: 'tool-listApps', state: 'output-error' })).toBe(false);
});

describe('readOnlyRunSteps', () => {
  const read = { label: 'Read books from Books', status: 'done' as const, write: false };
  const write = { label: 'Update book #1 in Books', status: 'done' as const, write: true };
  test('folds a finished run that only read', () => {
    expect(readOnlyRunSteps('output-available', { steps: [read], total: 1, failed: 0 }, undefined)).toEqual([read]);
  });
  test('keeps runs that wrote or failed as cards', () => {
    expect(readOnlyRunSteps('output-available', { steps: [read, write], total: 2, failed: 0 }, undefined)).toBeNull();
    expect(readOnlyRunSteps('output-available', { steps: [read], total: 1, failed: 1 }, undefined)).toBeNull();
    expect(readOnlyRunSteps('output-available', undefined, undefined)).toBeNull();
  });
  test('trimmed steps need the preview to vouch for them', () => {
    expect(readOnlyRunSteps('output-available', { steps: [read], total: 5, failed: 0 }, undefined)).toBeNull();
    expect(readOnlyRunSteps('output-available', { steps: [read], total: 5, failed: 0 }, { ok: true, actions: [] })).toEqual([read]);
  });
  test('a running run folds only when the practice run found no writes', () => {
    expect(readOnlyRunSteps('input-available', undefined, { ok: true, actions: [] })).toEqual([]);
    expect(readOnlyRunSteps('input-available', undefined, undefined)).toBeNull();
    expect(readOnlyRunSteps('approval-requested', undefined, { ok: true, actions: [{}] })).toBeNull();
  });
});

describe('desktop edit cards', () => {
  const nameOf = (id: string) => ({ a: 'Read Me.txt', b: 'old.png' } as Record<string, string>)[id];
  test('describes renames, rewrites and trashing with item names', () => {
    expect(describeDesktopEdit('tool-renameItem', { itemId: 'a', newName: 'Welcome.txt' }, nameOf).title).toBe('Rename “Read Me.txt” to “Welcome.txt”');
    expect(describeDesktopEdit('tool-editTextNote', { itemId: 'a', content: 'hi' }, nameOf)).toEqual({ title: 'Rewrite the note “Read Me.txt”', detail: 'New text: hi' });
    const trash = describeDesktopEdit('tool-moveToTrash', { itemIds: ['a', 'b'] }, nameOf);
    expect(trash.title).toBe('Move 2 items to the Trash');
    expect(trash.detail).toContain('Read Me.txt, old.png');
  });
  test('describes a look change: swatches for colors, a line for the rest', () => {
    const input = { name: 'Rainy café', desktopColor: 'linear-gradient(#456, #234)', accentColor: '#c96', systemFont: 'inter', wallpaper: 'dots', clearCustomTheme: true };
    expect(describeDesktopEdit('tool-changeAppearance', input, nameOf).title).toBe("Change your desktop's look to “Rainy café”");
    expect(appearanceSwatches(input)).toEqual([['desktop', 'linear-gradient(#456, #234)'], ['accent', '#c96']]);
    expect(appearanceSettingsLine(input)).toBe('system font inter, wallpaper dots, removes your current custom theme CSS');
    expect(describeDesktopEditDone('tool-changeAppearance', { name: 'Rainy café' })).toBe('Your desktop now has the “Rainy café” look.');
  });
});

test('labels web reads by site and title', async () => {
  const { activityLabel, isQuietToolPart } = await import('./codeRunText');
  const names = () => undefined;
  const done = { type: 'tool-readWebPage', state: 'output-available', input: { url: 'https://www.example.com/a' }, output: { ok: true, finalUrl: 'https://www.example.com/a', title: 'Apple Pie' } };
  expect(isQuietToolPart(done)).toBe(true);
  expect(activityLabel(done, names)).toEqual({ label: 'Read example.com', detail: 'Apple Pie' });
  expect(activityLabel({ type: 'tool-readWebPage', state: 'input-available', input: { url: 'https://x.org/' } }, names)).toEqual({ label: 'Reading x.org', detail: undefined });
  expect(activityLabel({ type: 'tool-readWebPage', state: 'output-available', input: { url: 'https://x.org/' }, output: { ok: false, url: 'https://x.org/', error: '403' } }, names).detail).toBe("couldn't read it");
});

