import { expect, test, describe } from 'vitest';
import { generateDesktopHTML } from './exportDesktop';
import type { DesktopItem } from '../types';

function item(overrides: Partial<DesktopItem> = {}): DesktopItem {
  return {
    id: 'i1',
    name: 'Note.txt',
    type: 'text',
    parentId: null,
    isPublic: true,
    position: { x: 0, y: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as DesktopItem;
}

const base = { username: 'alice', wallpaper: 'default' };

describe('generateDesktopHTML — HTML escaping (XSS guard)', () => {
  test('escapes a malicious item name so it cannot execute in the export', () => {
    const html = generateDesktopHTML({
      ...base,
      items: [item({ name: '<script>alert(1)</script>' })],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('escapes the username in both the title and the body', () => {
    const html = generateDesktopHTML({ ...base, username: '"><img src=x onerror=alert(1)>', items: [] });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  test('escapes folder names and their children', () => {
    const html = generateDesktopHTML({
      ...base,
      items: [
        item({ id: 'f', type: 'folder', name: '<b>Folder</b>' }),
        item({ id: 'c', parentId: 'f', name: '<i>child</i>' }),
      ],
    });
    expect(html).not.toContain('<b>Folder</b>');
    expect(html).not.toContain('<i>child</i>');
    expect(html).toContain('&lt;b&gt;Folder&lt;/b&gt;');
  });

  test('an attacker-controlled wallpaper cannot inject CSS (allowlisted patterns only)', () => {
    const html = generateDesktopHTML({
      ...base,
      wallpaper: 'x; } body { background: url(https://evil.example/beacon) }',
      items: [],
    });
    expect(html).not.toContain('evil.example');
  });
});

describe('generateDesktopHTML — item filtering', () => {
  test('omits trashed and non-root items from the desktop surface', () => {
    const html = generateDesktopHTML({
      ...base,
      items: [
        item({ id: 'root', name: 'RootFile' }),
        item({ id: 'trashed', name: 'TrashedFile', isTrashed: true }),
        item({ id: 'nested', name: 'NestedFile', parentId: 'root' }),
      ],
    });
    expect(html).toContain('RootFile');
    expect(html).not.toContain('TrashedFile');
    // "1 on desktop" — only the single root, non-trashed item is counted.
    expect(html).toContain('1 on desktop');
  });

  test('renders a folder summary only for folders with children', () => {
    // The `.folder-summary` CSS class is always in the stylesheet, so assert on
    // the body wrapper `class="folder-summaries"`, which is only emitted when at
    // least one folder has contents to summarize.
    const withChild = generateDesktopHTML({
      ...base,
      items: [
        item({ id: 'f', type: 'folder', name: 'HasKids' }),
        item({ id: 'c', parentId: 'f', name: 'Kid' }),
      ],
    });
    expect(withChild).toContain('class="folder-summaries"');
    expect(withChild).toContain('Kid');
    const empty = generateDesktopHTML({
      ...base,
      items: [item({ id: 'f', type: 'folder', name: 'Empty' })],
    });
    expect(empty).not.toContain('class="folder-summaries"');
  });

  test('produces a complete HTML document', () => {
    const html = generateDesktopHTML({ ...base, items: [] });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('</html>');
  });
});
