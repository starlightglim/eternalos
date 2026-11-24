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
