import { beforeEach, expect, test, describe } from 'vitest';
import { useClipboardStore } from './clipboardStore';

beforeEach(() => {
  useClipboardStore.getState().clear();
});

describe('clipboardStore', () => {
  test('starts empty', () => {
    const s = useClipboardStore.getState();
    expect(s.clipboard).toBeNull();
    expect(s.hasItems()).toBe(false);
    expect(s.isCutting()).toBe(false);
  });

  test('cut records the items, the cut flag, and the source folder', () => {
    useClipboardStore.getState().cut(['a', 'b'], 'folder-1');
    const s = useClipboardStore.getState();
    expect(s.clipboard).toEqual({ itemIds: ['a', 'b'], isCut: true, sourceParentId: 'folder-1' });
    expect(s.hasItems()).toBe(true);
    expect(s.isCutting()).toBe(true);
  });

  test('copy records items but is not a cut', () => {
    useClipboardStore.getState().copy(['a'], null);
    const s = useClipboardStore.getState();
    expect(s.clipboard?.isCut).toBe(false);
    expect(s.hasItems()).toBe(true);
    expect(s.isCutting()).toBe(false);
  });

  test('copy after cut overwrites the clipboard (not a cut anymore)', () => {
    useClipboardStore.getState().cut(['a'], 'f1');
    useClipboardStore.getState().copy(['b'], 'f2');
    const s = useClipboardStore.getState();
    expect(s.clipboard).toEqual({ itemIds: ['b'], isCut: false, sourceParentId: 'f2' });
    expect(s.isCutting()).toBe(false);
  });

  test('clear empties the clipboard', () => {
    useClipboardStore.getState().cut(['a'], null);
    useClipboardStore.getState().clear();
    const s = useClipboardStore.getState();
    expect(s.clipboard).toBeNull();
    expect(s.hasItems()).toBe(false);
    expect(s.isCutting()).toBe(false);
  });

  test('an empty selection is not "having items" even once set', () => {
    useClipboardStore.getState().cut([], null);
    expect(useClipboardStore.getState().hasItems()).toBe(false);
  });
});
