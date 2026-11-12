import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { DesktopItem } from '../types';

const api = vi.hoisted(() => ({
  createItem: vi.fn(), updateItems: vi.fn(), deleteItem: vi.fn(), fetchDesktop: vi.fn(),
  analyzeImageItem: vi.fn(), uploadFile: vi.fn(), emptyTrashApi: vi.fn(),
}));
vi.mock('../services/api', () => ({ isApiConfigured: true, ...api }));
vi.mock('./soundStore', () => ({ useSoundStore: { getState: () => ({ playSound: vi.fn() }) } }));
vi.mock('./alertStore', () => ({ useAlertStore: { getState: () => ({ showError: vi.fn() }) } }));
import { useDesktopStore } from './desktopStore';

const original: DesktopItem = {
  id: 'note', name: 'Note.txt', type: 'text', textContent: 'Saved',
  isPublic: true, parentId: null, position: { x: 0, y: 0 }, createdAt: 1, updatedAt: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = useDesktopStore.getState();
  store.reset();
  store.setUid('alice');
  store.setItems([{ ...original }]);
});
afterEach(() => {
  useDesktopStore.getState().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('failed privacy edits retain the last acknowledged visibility', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  const pending = useDesktopStore.getState().updateItem('note', { isPublic: false });
  expect(useDesktopStore.getState().getItem('note')?.isPublic).toBe(true);
  expect(await pending).toBe(false);
  expect(useDesktopStore.getState().getItem('note')?.isPublic).toBe(true);
});

test('document contents change only after the server acknowledges a save', async () => {
  let acknowledge!: () => void;
  api.updateItems.mockImplementation(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  const pending = useDesktopStore.getState().updateItem('note', { textContent: 'Draft' });
  await Promise.resolve();
  await Promise.resolve();
  expect(useDesktopStore.getState().getItem('note')?.textContent).toBe('Saved');
  acknowledge();
  expect(await pending).toBe(true);
  expect(useDesktopStore.getState().getItem('note')?.textContent).toBe('Draft');
});

test('rapid saves for one file reach the server in order', async () => {
  let acknowledge!: () => void;
  api.updateItems.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  api.updateItems.mockResolvedValueOnce([]);
  const first = useDesktopStore.getState().updateItem('note', { textContent: 'First' });
  const second = useDesktopStore.getState().updateItem('note', { textContent: 'Second' });
  await Promise.resolve();
  await Promise.resolve();
  expect(api.updateItems).toHaveBeenCalledTimes(1);
  acknowledge();
  expect(await first).toBe(true);
  expect(await second).toBe(true);
  expect(useDesktopStore.getState().getItem('note')?.textContent).toBe('Second');
});

test('reset discards late saves and does not send queued writes under the next account', async () => {
  let acknowledge!: () => void;
  api.updateItems.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  const first = useDesktopStore.getState().updateItem('note', { textContent: 'First' });
  const queued = useDesktopStore.getState().updateItem('note', { textContent: 'Second' });
  await Promise.resolve();
  await Promise.resolve();
  useDesktopStore.getState().reset();
  useDesktopStore.getState().setUid('bob');
  acknowledge();
  expect(await first).toBe(false);
  expect(await queued).toBe(false);
  expect(api.updateItems).toHaveBeenCalledTimes(1);
  expect(useDesktopStore.getState().items).toEqual([]);
});

test('failed creates and duplicates do not leave phantom files', async () => {
  api.createItem.mockRejectedValue(new Error('Offline'));
  useDesktopStore.getState().addItem({ ...original, id: 'new-note' });
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('new-note')).toBeUndefined();
  expect(await useDesktopStore.getState().duplicateItems(['note'], null)).toEqual([]);
  expect(useDesktopStore.getState().items).toHaveLength(1);
});

test('failed deletes restore the removed item', async () => {
  api.deleteItem.mockRejectedValue(new Error('Offline'));
  useDesktopStore.getState().removeItem('note');
  expect(useDesktopStore.getState().items).toEqual([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')).toEqual(original);
});

test('a late desktop load cannot populate the next account', async () => {
  let complete!: (response: unknown) => void;
  api.fetchDesktop.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const pending = useDesktopStore.getState().loadDesktop();
  useDesktopStore.getState().reset();
  useDesktopStore.getState().setUid('bob');
  complete({ items: [original] });
  await pending;
  expect(useDesktopStore.getState().items).toEqual([]);
});

test('a successful position save persists the new position', async () => {
  api.updateItems.mockResolvedValue([]);
  useDesktopStore.getState().moveItem('note', { x: 100, y: 50 });
  await vi.advanceTimersByTimeAsync(600);
  expect(api.updateItems).toHaveBeenCalledWith([{ id: 'note', updates: { position: { x: 100, y: 50 } } }]);
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 100, y: 50 });
});

test('a failed position save reverts to the last saved position', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  useDesktopStore.getState().moveItem('note', { x: 100, y: 50 });
  // Optimistic position shows immediately.
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 100, y: 50 });
  await vi.advanceTimersByTimeAsync(600);
  // After the debounced save fails, the position reverts — no silently-unsaved move.
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 0, y: 0 });
});

test('a failed save during a rapid drag reverts to the pre-drag position', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  const store = useDesktopStore.getState();
  // Three moves within the debounce window — only the last one saves, and the
  // rollback target must be the pre-drag position (0,0), not an intermediate.
  store.moveItem('note', { x: 10, y: 10 });
  store.moveItem('note', { x: 20, y: 20 });
  store.moveItem('note', { x: 30, y: 30 });
  await vi.advanceTimersByTimeAsync(600);
  expect(api.updateItems).toHaveBeenCalledTimes(1);
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 0, y: 0 });
});

test('a position save that fails after the item moved again is not clobbered', async () => {
  // First save is in-flight and will reject; meanwhile the user moves again.
  let reject!: (e: Error) => void;
  api.updateItems.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  api.updateItems.mockResolvedValue([]);
  const store = useDesktopStore.getState();
  store.moveItem('note', { x: 40, y: 40 });
  await vi.advanceTimersByTimeAsync(600); // fire first save (pending)
  store.moveItem('note', { x: 80, y: 80 }); // user moves again before failure
  reject(new Error('Offline'));
  await vi.advanceTimersByTimeAsync(0);
  // The stale failure must not revert the newer position.
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 80, y: 80 });
});

test('a successful move-to-trash keeps the item trashed', async () => {
  api.updateItems.mockResolvedValue([]);
  useDesktopStore.getState().moveToTrash(['note']);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(true);
});

test('a failed move-to-trash restores the item', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  useDesktopStore.getState().moveToTrash(['note']);
  // Optimistically trashed.
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  // Rolled back after the failure — no item left looking trashed when it isn't.
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBeFalsy();
});

test('a failed restore returns the item to the trash', async () => {
  const store = useDesktopStore.getState();
  // Trash it first (succeeds).
  api.updateItems.mockResolvedValue([]);
  store.moveToTrash(['note']);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(true);
  // Now the restore fails.
  api.updateItems.mockRejectedValue(new Error('Offline'));
  store.restoreFromTrash(['note']);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(false); // optimistic
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(true); // rolled back
});

test('a successful cut-paste moves items into the target folder', async () => {
  api.updateItems.mockResolvedValue([]);
  await useDesktopStore.getState().pasteItems(['note'], true, 'folder-1');
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.parentId).toBe('folder-1');
});

test('a failed cut-paste returns items to their original location', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  await useDesktopStore.getState().pasteItems(['note'], true, 'folder-1');
  await vi.advanceTimersByTimeAsync(0);
  // Rolled back after the failure — nothing looks moved when the server never recorded it.
  const item = useDesktopStore.getState().getItem('note');
  expect(item?.parentId).toBe(null);
  expect(item?.position).toEqual({ x: 0, y: 0 });
});
