import { expect, test } from 'vitest';
import { parseMarkdownBlocks } from './chatMarkdown';

test('splits a typical reply into paragraphs and lists', () => {
  const blocks = parseMarkdownBlocks('Both books are in.\n\n- **Project Hail Mary** — Andy Weir\n- *Neuromancer*\n\nFour books total.');
  expect(blocks).toEqual([
    { kind: 'paragraph', lines: ['Both books are in.'] },
    { kind: 'list', ordered: false, items: ['**Project Hail Mary** — Andy Weir', '*Neuromancer*'] },
    { kind: 'paragraph', lines: ['Four books total.'] },
  ]);
});

test('handles headings, ordered lists and fenced code', () => {
  const blocks = parseMarkdownBlocks('## Unread\n1. Dune\n2. Hail Mary\n```\nconst x = 1;\n```');
  expect(blocks).toEqual([
    { kind: 'heading', text: 'Unread' },
    { kind: 'list', ordered: true, items: ['Dune', 'Hail Mary'] },
    { kind: 'code', text: 'const x = 1;' },
  ]);
});

test('keeps consecutive lines in one paragraph (rendered with line breaks)', () => {
  expect(parseMarkdownBlocks('line one\nline two')).toEqual([{ kind: 'paragraph', lines: ['line one', 'line two'] }]);
});

test('parses pipe tables', () => {
  const blocks = parseMarkdownBlocks('Your books:\n\n| Book | Status |\n|---|---|\n| Dune | Unread |\n| Neuromancer |\n\nDone.');
  expect(blocks).toEqual([
    { kind: 'paragraph', lines: ['Your books:'] },
    { kind: 'table', header: ['Book', 'Status'], rows: [['Dune', 'Unread'], ['Neuromancer', '']] },
    { kind: 'paragraph', lines: ['Done.'] },
  ]);
});

test('a lone pipe line is not a table', () => {
  expect(parseMarkdownBlocks('| not a table |\nreally')).toEqual([{ kind: 'paragraph', lines: ['| not a table |', 'really'] }]);
});
