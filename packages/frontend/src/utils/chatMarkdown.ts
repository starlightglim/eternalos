/**
 * Block parser for Ask Eternal's minimal chat markdown (see ChatMarkdown).
 * Pure: text in, block list out.
 */

export type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] };

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_RULE_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** A pipe table starts with a | row followed by a |---|---| rule. */
function isTableStart(lines: string[], index: number): boolean {
  return TABLE_ROW_RE.test(lines[index] ?? '') && TABLE_RULE_RE.test(lines[index + 1] ?? '');
}

export function parseMarkdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) body.push(lines[index++]);
      index += 1; // closing fence (or end)
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW_RE.test(lines[index])) {
        const cells = tableCells(lines[index++]);
        rows.push(header.map((_, column) => cells[column] ?? ''));
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', text: heading[1] });
      index += 1;
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const items: string[] = [];
      while (index < lines.length) {
        const match = (isOrdered ? ORDERED_RE : BULLET_RE).exec(lines[index]);
        if (!match) break;
        items.push(match[1]);
        index += 1;
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !HEADING_RE.test(lines[index])
      && !BULLET_RE.test(lines[index])
      && !ORDERED_RE.test(lines[index])
      && !/^\s*```/.test(lines[index])
      && !isTableStart(lines, index)
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: paragraph });
  }
  return blocks;
}

