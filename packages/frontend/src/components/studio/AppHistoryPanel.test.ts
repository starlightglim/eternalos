import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

vi.mock('../../services/apps', () => ({
  listAppRevisions: vi.fn(),
  getAppRevisionFiles: vi.fn(),
  restoreAppRevision: vi.fn(),
}));

import {
  getAppRevisionFiles,
  listAppRevisions,
  restoreAppRevision,
} from '../../services/apps';
import type { AppRevisionFilesResponse, AppRevisionsResponse } from '../../services/apps';
import { AppHistoryPanel } from './AppHistoryPanel';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;

const APP_ID = 'app-1';
const VALID_ID = '1770000000000-aaaaaaaa';
const INVALID_ID = '1769999999999-bbbbbbbb';

const REVISIONS: AppRevisionsResponse = {
  appId: APP_ID,
  currentRevision: VALID_ID,
  lastValidRevision: VALID_ID,
  revisions: [
    {
      id: VALID_ID,
      createdAt: 1770000000000,
      author: 'human',
      valid: true,
      kind: 'deploy',
      summary: 'Deployed v2',
      appVersion: 2,
      name: 'Diff App',
    },
    {
      id: INVALID_ID,
      createdAt: 1769999999999,
      author: 'human',
      valid: false,
      kind: 'deploy',
      summary: 'Failed save — validation rejected',
    },
  ],
};

function revisionDetail(overrides: Partial<AppRevisionFilesResponse['revision']>): AppRevisionFilesResponse {
  return {
    appId: APP_ID,
    revision: {
      id: VALID_ID,
      createdAt: 1770000000000,
      author: 'human',
      valid: true,
      kind: 'deploy',
      summary: 'Deployed v2',
      appVersion: 2,
      name: 'Diff App',
      diagnostics: { valid: true, issues: [] },
      ...overrides,
    },
    files: { 'index.html': '<p>revision</p>', 'app.js': 'revisionCode();' },
  };
}

const CURRENT_FILES = { 'index.html': '<p>current</p>', 'app.js': 'currentCode();' };

function descendantsWith(from: TestNode, name: string, value: string): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if (child.getAttribute(name) === value) found.push(child);
        visit(child);
      }
    }
  };
  visit(from);
  return found;
}

function buttonsIn(from: TestNode): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode): void => {
    for (const child of node.childNodes) {
      if (child instanceof TestElement) {
        if (child.nodeName === 'BUTTON') found.push(child);
        visit(child);
      }
    }
  };
  visit(from);
  return found;
}

function revisionRow(id: string): TestElement {
  const row = descendantsWith(dom.root, 'data-revision', id)[0];
  if (!row) throw new Error(`no row rendered for revision ${id}`);
  return row;
}

/** Flush one macrotask so the panel's async loads settle inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(target: TestElement): Promise<void> {
  dom.pointer(target, 'pointerdown', { clientX: 10, clientY: 10 });
  dom.pointer(target, 'pointerup', { clientX: 10, clientY: 10 });
  await act(async () => {
    dom.click({ clientX: 10, clientY: 10 });
  });
  await flush();
}

async function renderPanel(props: Partial<Parameters<typeof AppHistoryPanel>[0]>): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(createElement(AppHistoryPanel, {
      appId: APP_ID,
      currentFiles: CURRENT_FILES,
      onRestored: vi.fn(),
      onClose: vi.fn(),
      ...props,
    }));
  });
  await flush();
}

beforeEach(() => {
  dom = installTestDom();
  vi.mocked(listAppRevisions).mockResolvedValue(REVISIONS);
  vi.mocked(getAppRevisionFiles).mockResolvedValue(revisionDetail({}));
  vi.mocked(restoreAppRevision).mockResolvedValue({
    success: true,
    appId: APP_ID,
    version: 3,
    revisionId: '1770000000500-newrev00',
    restoredFrom: VALID_ID,
  });
});

afterEach(async () => {
  if (reactRoot) {
    const root = reactRoot;
    reactRoot = null;
    await act(async () => {
      root.unmount();
    });
  }
  dom.uninstall();
  vi.clearAllMocks();
});

describe('AppHistoryPanel', () => {
  test('lists revisions with validity, kind, and pointer context', async () => {
    await renderPanel({});

    expect(vi.mocked(listAppRevisions)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(listAppRevisions)).toHaveBeenCalledWith(APP_ID);

    const rows = descendantsWith(dom.root, 'data-role', 'revision-row');
    expect(rows).toHaveLength(2);

    const validRow = revisionRow(VALID_ID);
    expect(validRow.getAttribute('data-valid')).toBe('true');
    expect(validRow.textContent).toContain('Deployed v2');
    expect(validRow.textContent).toContain('current');

    const invalidRow = revisionRow(INVALID_ID);
    expect(invalidRow.getAttribute('data-valid')).toBe('false');
    expect(invalidRow.textContent).toContain('Failed save');
    expect(invalidRow.textContent).toContain('invalid');
  });

  test('selecting a revision fetches its files and shows the per-file diff against the editor', async () => {
    const onRestored = vi.fn();
    await renderPanel({ onRestored });

    await click(revisionRow(VALID_ID));

    expect(vi.mocked(getAppRevisionFiles)).toHaveBeenCalledWith(APP_ID, VALID_ID);

    const diffFiles = descendantsWith(dom.root, 'data-role', 'diff-file');
    expect(diffFiles).toHaveLength(2); // index.html + app.js, both changed
    const htmlDiff = descendantsWith(dom.root, 'data-file', 'index.html')[0];
    expect(htmlDiff.getAttribute('data-status')).toBe('changed');
    const body = descendantsWith(htmlDiff, 'data-role', 'diff-body')[0];
    expect(body.textContent).toContain('--- index.html');
    expect(body.textContent).toContain('-<p>current</p>');
    expect(body.textContent).toContain('+<p>revision</p>');
    expect(onRestored).not.toHaveBeenCalled();
  });

  test('an invalid revision shows its stored validation diagnostics', async () => {
    vi.mocked(getAppRevisionFiles).mockResolvedValue(revisionDetail({
      id: INVALID_ID,
      valid: false,
      summary: 'Failed save — validation rejected',
      diagnostics: {
        valid: false,
        issues: [{
          code: 'source/external-script',
          message: 'External script URLs are not allowed',
          hint: 'Bundle the script as a local file.',
        }],
      },
    }));
    await renderPanel({});

    await click(revisionRow(INVALID_ID));

    const diagnostics = descendantsWith(dom.root, 'data-role', 'diagnostics')[0];
    expect(diagnostics).toBeDefined();
    expect(diagnostics.textContent).toContain('source/external-script');
    expect(diagnostics.textContent).toContain('External script URLs are not allowed');
  });

  test('restore requires confirmation; cancelling never calls the API', async () => {
    await renderPanel({});
    await click(revisionRow(VALID_ID));

    await click(descendantsWith(dom.root, 'data-role', 'restore')[0]);

    const dialog = descendantsWith(dom.root, 'role', 'alertdialog')[0];
    expect(dialog).toBeDefined();
    expect(dialog.textContent).toContain('Restore this revision?');
    const [cancel] = buttonsIn(dialog);
    expect(cancel.textContent).toBe('Cancel');

    await click(cancel);

    expect(restoreAppRevision).not.toHaveBeenCalled();
    expect(descendantsWith(dom.root, 'role', 'alertdialog')).toHaveLength(0);
  });

  test('confirming the restore calls the API, refreshes the list, and notifies the parent', async () => {
    const onRestored = vi.fn();
    await renderPanel({ onRestored });
    await click(revisionRow(VALID_ID));

    await click(descendantsWith(dom.root, 'data-role', 'restore')[0]);
    const dialog = descendantsWith(dom.root, 'role', 'alertdialog')[0];
    const [, confirm] = buttonsIn(dialog);
    expect(confirm.textContent).toBe('Restore');
    await click(confirm);

    expect(restoreAppRevision).toHaveBeenCalledTimes(1);
    expect(restoreAppRevision).toHaveBeenCalledWith(APP_ID, VALID_ID);

    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onRestored).toHaveBeenCalledWith({ version: 3, revisionId: '1770000000500-newrev00' });

    // The list refreshes after the restore.
    expect(vi.mocked(listAppRevisions).mock.calls.length).toBeGreaterThanOrEqual(2);

    const status = descendantsWith(dom.root, 'data-role', 'panel-status')[0];
    expect(status.getAttribute('data-kind')).toBe('success');
    expect(status.textContent).toContain('Restored as version 3');
  });

  test('a failed restore surfaces the error and keeps the panel usable', async () => {
    const onRestored = vi.fn();
    vi.mocked(restoreAppRevision).mockRejectedValue(new Error('400 App bundle validation failed'));
    await renderPanel({ onRestored });
    await click(revisionRow(VALID_ID));

    await click(descendantsWith(dom.root, 'data-role', 'restore')[0]);
    const dialog = descendantsWith(dom.root, 'role', 'alertdialog')[0];
    const [, confirm] = buttonsIn(dialog);
    await click(confirm);

    expect(restoreAppRevision).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();

    const status = descendantsWith(dom.root, 'data-role', 'panel-status')[0];
    expect(status.getAttribute('data-kind')).toBe('error');
    expect(status.textContent).toContain('400 App bundle validation failed');

    // Still usable: the diff view is still there and a new restore can start.
    expect(descendantsWith(dom.root, 'data-role', 'diff-file')).toHaveLength(2);
    expect(descendantsWith(dom.root, 'data-role', 'restore')).toHaveLength(1);
  });
});
