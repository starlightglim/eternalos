import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

import { AppPermissionDialog } from './AppPermissionDialog';
import { buildGrantedPermissions, getPermissionEntries, initialSelectedKeys } from './appPermissionScopes';
import { installTestDom, TestElement, type TestDom, type TestNode } from '../window/windowTestDom';

let dom: TestDom;
let reactRoot: Root | null = null;

function click(target: TestElement): void {
  dom.pointer(target, 'pointerdown', { clientX: 10, clientY: 10 });
  dom.pointer(target, 'pointerup', { clientX: 10, clientY: 10 });
  act(() => { dom.click({ clientX: 10, clientY: 10 }); });
}

/** React keeps a checkbox's state on the `checked` property (like a real
 *  browser, the attribute is only the initial default). */
function isChecked(target: TestElement): boolean {
  return Boolean((target as unknown as { checked?: boolean }).checked);
}

function setChecked(target: TestElement, value: boolean): void {
  (target as unknown as { checked: boolean }).checked = value;
}

function tickCheckbox(target: TestElement, checked: boolean): void {
  setChecked(target, checked);
  click(target);
}

async function renderDialog(props: Parameters<typeof AppPermissionDialog>[0]): Promise<void> {
  const reactDom = await import('react-dom/client');
  const root = reactDom.createRoot(dom.root as unknown as Element);
  reactRoot = root;
  await act(async () => {
    root.render(createElement(AppPermissionDialog, props));
  });
}

/** Depth-first descendants matching `attr === value`. */
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

function scopeRow(key: string): TestElement {
  const row = descendantsWith(dom.root, 'data-scope', key)[0];
  if (!row) throw new Error(`no row rendered for scope ${key}`);
  return row;
}

function scopeCheckbox(key: string): TestElement {
  const input = scopeRow(key).childNodes.find(
    (child) => child instanceof TestElement && child.nodeName === 'INPUT',
  ) as TestElement | undefined;
  if (!input) throw new Error(`no checkbox rendered for scope ${key}`);
  return input;
}

const REQUESTED = {
  fs: { read: ['/**'], write: ['/Notes/**'] },
  network: { outbound: ['*'] },
  profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
  ipc: { emit: ['music.now_playing'] },
};
const BROAD = ['fs.read', 'network.outbound', 'profile.read'];

beforeEach(() => {
  dom = installTestDom();
});

afterEach(async () => {
  if (reactRoot) {
    await act(async () => { reactRoot!.unmount(); });
    reactRoot = null;
  }
  dom.uninstall();
});

describe('AppPermissionDialog broad-scope gating', () => {
  test('broad scopes render as warning rows and are never pre-ticked, narrow granted scopes are', async () => {
    await renderDialog({
      requested: REQUESTED,
      granted: { fs: { write: ['/Notes/**'] } },
      broad: BROAD,
      approvals: {
        'fs.write': { approvedAt: 1731993600000, approvedBy: 'uid-1', rationale: 'needs notes' },
      },
      rationale: 'It indexes everything for search.',
      onAllow: vi.fn(),
      onDeny: vi.fn(),
    });

    for (const key of BROAD) {
      const row = scopeRow(key);
      expect(row.getAttribute('data-broad')).toBe('true');
      const warning = descendantsWith(row, 'data-role', 'broad-warning')[0];
      expect(warning, `${key} must show a broad-access warning`).toBeDefined();
      expect(warning!.textContent).toContain('Broad access');
      expect(warning!.textContent).toContain('It indexes everything for search.');
      // Never pre-ticked — even though nothing here was granted yet.
      expect(isChecked(scopeCheckbox(key))).toBe(false);
    }

    const narrowRow = scopeRow('fs.write');
    expect(narrowRow.getAttribute('data-broad')).toBe('false');
    // Narrow + granted → pre-ticked, with its approval date surfaced.
    expect(isChecked(scopeCheckbox('fs.write'))).toBe(true);
    expect(descendantsWith(narrowRow, 'data-role', 'approval-status')[0]?.textContent).toBe('Approved on 2024-11-19');

    // Narrow + ungranted → not pre-ticked, no approval status.
    expect(isChecked(scopeCheckbox('ipc.emit'))).toBe(false);
    expect(descendantsWith(scopeRow('ipc.emit'), 'data-role', 'approval-status')[0]).toBeUndefined();
  });

  test('a granted broad scope still starts unticked and shows an unknown approval date for legacy installs', async () => {
    await renderDialog({
      requested: REQUESTED,
      granted: { fs: { read: ['/**'] }, network: { outbound: ['*'] } },
      broad: BROAD,
      approvals: { 'fs.read': {}, 'network.outbound': {} }, // migrated grants: approved, date unknown
      onAllow: vi.fn(),
      onDeny: vi.fn(),
    });

    expect(isChecked(scopeCheckbox('fs.read'))).toBe(false);
    expect(isChecked(scopeCheckbox('network.outbound'))).toBe(false);
    expect(descendantsWith(scopeRow('fs.read'), 'data-role', 'approval-status')[0]?.textContent)
      .toBe('Approved (date unknown)');
    // The hint explains what an unticked broad row means at submission time.
    expect(descendantsWith(scopeRow('fs.read'), 'data-role', 'broad-hint')[0]?.textContent)
      .toContain('revokes this access');
  });

  test('submitting without a broad tick grants only the ticked narrow scopes and no broad approvals', async () => {
    const onAllow = vi.fn();
    await renderDialog({
      requested: REQUESTED,
      granted: {},
      broad: BROAD,
      onAllow,
      onDeny: vi.fn(),
    });

    tickCheckbox(scopeCheckbox('ipc.emit'), true);
    const allowButton = descendantsWith(dom.root, 'data-role', 'allow')[0]!;
    click(allowButton);

    expect(onAllow).toHaveBeenCalledTimes(1);
    const [granted, broadApprovals] = onAllow.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(granted).toEqual({ ipc: { emit: ['music.now_playing'] } });
    expect(broadApprovals).toEqual([]);
  });

  test('ticking a broad scope includes it in the grant and sends its explicit approval flag', async () => {
    const onAllow = vi.fn();
    await renderDialog({
      requested: REQUESTED,
      granted: {},
      broad: BROAD,
      onAllow,
      onDeny: vi.fn(),
    });

    tickCheckbox(scopeCheckbox('fs.read'), true);
    tickCheckbox(scopeCheckbox('profile.read'), true);
    tickCheckbox(scopeCheckbox('fs.write'), true); // narrow
    click(descendantsWith(dom.root, 'data-role', 'allow')[0]!);

    expect(onAllow).toHaveBeenCalledTimes(1);
    const [granted, broadApprovals] = onAllow.mock.calls[0] as [Record<string, unknown>, string[]];
    expect(granted).toEqual({
      fs: { read: ['/**'], write: ['/Notes/**'] },
      profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
    });
    // Exactly the broad scopes the user ticked — not the unticked network wildcard.
    expect(broadApprovals).toEqual(['fs.read', 'profile.read']);
  });

  test('Deny calls onDeny without submitting a grant', async () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    await renderDialog({
      requested: REQUESTED,
      granted: {},
      broad: BROAD,
      onAllow,
      onDeny,
    });

    const denyButton = descendantsWith(dom.root, 'data-role', 'deny')[0]!;
    click(denyButton);

    expect(onDeny).toHaveBeenCalledTimes(1);
    expect(onAllow).not.toHaveBeenCalled();
  });
});

describe('appPermissionScopes helpers', () => {
  const entries = getPermissionEntries(REQUESTED, BROAD);

  test('flags exactly the server-declared broad scopes on entries', () => {
    expect(entries.find((entry) => entry.key === 'fs.read')?.broad).toBe(true);
    expect(entries.find((entry) => entry.key === 'fs.write')?.broad).toBe(false);
    expect(entries.filter((entry) => entry.broad).map((entry) => entry.key).sort())
      .toEqual([...BROAD].sort());
  });

  test('initialSelectedKeys pre-ticks granted narrow scopes only', () => {
    const granted = {
      fs: { read: ['/**'], write: ['/Notes/**'] },
      ipc: { emit: ['music.now_playing'] },
    };
    expect(initialSelectedKeys(entries, granted)).toEqual(['fs.write', 'ipc.emit']);
  });

  test('buildGrantedPermissions only includes selected scope keys', () => {
    expect(buildGrantedPermissions(REQUESTED, ['fs.write', 'profile.read'])).toEqual({
      fs: { write: ['/Notes/**'] },
      profile: { read: ['username', 'displayName', 'bio', 'avatar'] },
    });
    expect(buildGrantedPermissions(REQUESTED, [])).toEqual({});
  });
});
