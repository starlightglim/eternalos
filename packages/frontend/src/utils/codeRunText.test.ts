import { expect, test } from 'vitest';
import { describeAppChange } from './codeRunText';

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
