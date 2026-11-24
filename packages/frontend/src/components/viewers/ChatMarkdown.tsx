/**
 * Minimal, safe markdown for Ask Eternal replies. The model writes light
 * markdown (bold, lists, inline code); showing it raw ("**Dune**") looked
 * broken. This renders a small subset straight to React elements — never
 * HTML strings, so nothing in a reply can inject markup.
 *
 * Supported: paragraphs, line breaks, # headings (rendered as bold lines),
 * - / * / 1. lists, ``` fenced code, `inline code`, **bold**, *italic*,
 * _italic_, and | pipe | tables |.
 */

import type { ReactNode } from 'react';
import styles from './ChatMarkdown.module.css';
import { parseMarkdownBlocks } from '../../utils/chatMarkdown';

const INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s\n][^*\n]*\*|(?<![A-Za-z0-9])_[^_\s\n][^_\n]*_(?![A-Za-z0-9]))/g;

function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let count = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const key = `${keyPrefix}-${count++}`;
    if (token.startsWith('`')) nodes.push(<code key={key} className={styles.inlineCode}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**') || token.startsWith('__')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function ChatMarkdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className={`${styles.markdown} ${className ?? ''}`}>
      {blocks.map((block, blockIndex) => {
        const key = `b${blockIndex}`;
        if (block.kind === 'heading') return <p key={key} className={styles.heading}>{renderInline(block.text, key)}</p>;
        if (block.kind === 'table') {
          return (
            <div key={key} className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>)}</tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{renderInline(cell, `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === 'code') return <pre key={key} className={styles.codeBlock}>{block.text}</pre>;
        if (block.kind === 'list') {
          const items = block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>);
          return block.ordered ? <ol key={key} className={styles.list}>{items}</ol> : <ul key={key} className={styles.list}>{items}</ul>;
        }
        return (
          <p key={key} className={styles.paragraph}>
            {block.lines.map((line, lineIndex) => (
              <span key={`${key}-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInline(line, `${key}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
