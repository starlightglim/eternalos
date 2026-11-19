import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { DesktopItem } from '../types';

const api = vi.hoisted(() => ({
  createItem: vi.fn(), updateItems: vi.fn(), deleteItem: vi.fn(), fetchDesktop: vi.fn(),
  analyzeImageItem: vi.fn(), uploadFile: vi.fn(), emptyTrashApi: vi.fn(),
}));
vi.mock('../services/api', () => ({ isApiConfigured: true, ...api }));
vi.mock('./soundStore', () => ({ useSoundStore: { getState: () => ({ playSound: vi.fn() }) } }));
// One stable mock so tests can assert that failures are surfaced to the user.
const alerts = vi.hoisted(() => ({ showError: vi.fn() }));
vi.mock('./alertStore', () => ({ useAlertStore: { getState: () => alerts } }));
import { useDesktopStore } from './desktopStore';
import { getAcknowledgedItem } from './desktopItemSync';

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

test('a successful upload adds the item and completes its progress entry', async () => {
  const uploaded = { ...original, id: 'uploaded', name: 'photo.png', type: 'image' as const };
  api.uploadFile.mockResolvedValue({ item: uploaded });
  const result = await useDesktopStore.getState().uploadFile({ name: 'photo.png' } as File, null, { x: 0, y: 0 });
  expect(result?.id).toBe('uploaded');
  expect(useDesktopStore.getState().getItem('uploaded')).toBeDefined();
  expect(useDesktopStore.getState().uploads.find((u) => u.filename === 'photo.png')?.status).toBe('complete');
});

test('a failed upload leaves no phantom item and marks the upload errored', async () => {
  api.uploadFile.mockRejectedValue(new Error('Network error'));
  const result = await useDesktopStore.getState().uploadFile({ name: 'bad.png' } as File, null, { x: 0, y: 0 });
  expect(result).toBe(null);
  // The item is only added on success, so a failure leaves nothing behind.
  expect(useDesktopStore.getState().items.some((i) => i.name === 'bad.png')).toBe(false);
  expect(useDesktopStore.getState().uploads.find((u) => u.filename === 'bad.png')?.status).toBe('error');
});

test('an upload that resolves after a session switch does not populate the next account', async () => {
  let resolve!: (value: unknown) => void;
  api.uploadFile.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const pending = useDesktopStore.getState().uploadFile({ name: 'late.png' } as File, null, { x: 0, y: 0 });
  // Switch account mid-upload.
  useDesktopStore.getState().reset();
  useDesktopStore.getState().setUid('bob');
  resolve({ item: { ...original, id: 'late', name: 'late.png' } });
  expect(await pending).toBe(null);
  expect(useDesktopStore.getState().items).toEqual([]);
});

// ---------------------------------------------------------------------------
// Rename (updateItem) — success, rollback, and failure surfacing
// ---------------------------------------------------------------------------

test('a successful rename persists the new name', async () => {
  api.updateItems.mockResolvedValue([]);
  const saved = await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(saved).toBe(true);
  expect(api.updateItems).toHaveBeenCalledWith([{ id: 'note', updates: { name: 'Renamed.txt' } }]);
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Renamed.txt');
});

test('a failed rename rolls back to the previous name', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  const saved = await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(saved).toBe(false);
  // The optimistic rename is reverted — nothing looks renamed when the
  // server never recorded it.
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Note.txt');
});

test('a failed rename surfaces the sync failure to the user', async () => {
  api.updateItems.mockRejectedValue(new Error('Offline'));
  await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(alerts.showError).toHaveBeenCalledWith('Could not save your changes. Please try again.', 'Sync Failed');
});

// ---------------------------------------------------------------------------
// The reliability bar (CORE-ROADMAP Workstream 1): a forced 401, 429, 500 or
// network failure must never leave a successful-looking unsaved item. The api
// client surfaces non-2xx responses as `Error("<status> <message>")` and a
// dead connection as a TypeError, so each canonical failure is simulated in
// the shape the store actually receives.
// ---------------------------------------------------------------------------

const failures: ReadonlyArray<readonly [string, () => Error]> = [
  ['401', () => new Error('401 Unauthorized')],
  ['429', () => new Error('429 Too Many Requests')],
  ['500', () => new Error('500 Internal Server Error')],
  ['network', () => new TypeError('Failed to fetch')],
];

test.each(failures)('create: a forced %s failure leaves no phantom item and surfaces the error', async (_label, fail) => {
  api.createItem.mockRejectedValue(fail());
  useDesktopStore.getState().addItem({ ...original, id: 'phantom', name: 'Phantom.txt' });
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('phantom')).toBeUndefined();
  expect(alerts.showError).toHaveBeenCalledWith(
    expect.stringContaining('Could not create "Phantom.txt"'),
    'Create Failed'
  );
});

test.each(failures)('update: a forced %s failure rolls the rename back and surfaces the error', async (_label, fail) => {
  api.updateItems.mockRejectedValue(fail());
  const saved = await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(saved).toBe(false);
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Note.txt');
  expect(alerts.showError).toHaveBeenCalledWith('Could not save your changes. Please try again.', 'Sync Failed');
});

test.each(failures)('update: a forced %s failure keeps the last acknowledged privacy setting', async (_label, fail) => {
  api.updateItems.mockRejectedValue(fail());
  const saved = await useDesktopStore.getState().updateItem('note', { isPublic: false });
  expect(saved).toBe(false);
  // Privacy only becomes authoritative after a server acknowledgement, so a
  // failed save can never leave the item looking private (or public) when it
  // isn't.
  expect(useDesktopStore.getState().getItem('note')?.isPublic).toBe(true);
  expect(alerts.showError).toHaveBeenCalledWith('Could not save your changes. Please try again.', 'Sync Failed');
});

test.each(failures)('move: a forced %s failure reverts to the last saved position', async (_label, fail) => {
  api.updateItems.mockRejectedValue(fail());
  useDesktopStore.getState().moveItem('note', { x: 100, y: 50 });
  await vi.advanceTimersByTimeAsync(600);
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 0, y: 0 });
  expect(alerts.showError).toHaveBeenCalledWith('Could not save the new position. It has been reverted.', 'Sync Failed');
});

test.each(failures)('trash: a forced %s failure restores the item and surfaces the error', async (_label, fail) => {
  api.updateItems.mockRejectedValue(fail());
  useDesktopStore.getState().moveToTrash(['note']);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBeFalsy();
  expect(alerts.showError).toHaveBeenCalledWith('Failed to move items to trash. They have been restored.', 'Trash Failed');
});

// ---------------------------------------------------------------------------
// The same bar: a retry or reconnect must converge with no duplicates.
// ---------------------------------------------------------------------------

test('create: retrying after a failure does not produce duplicate items', async () => {
  api.createItem.mockRejectedValueOnce(new Error('500 Internal Server Error'));
  api.createItem.mockResolvedValue(undefined);
  const item = { ...original, id: 'retry-note', name: 'Retry.txt' };
  useDesktopStore.getState().addItem(item);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('retry-note')).toBeUndefined();
  // The user retries the same creation once the failure is visible.
  useDesktopStore.getState().addItem(item);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().items.filter((i) => i.id === 'retry-note')).toHaveLength(1);
  expect(api.createItem).toHaveBeenCalledTimes(2);
});

test('update: retrying a failed rename applies it exactly once', async () => {
  api.updateItems.mockRejectedValueOnce(new Error('429 Too Many Requests'));
  api.updateItems.mockResolvedValue([]);
  const first = await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(first).toBe(false);
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Note.txt');
  const second = await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(second).toBe(true);
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Renamed.txt');
  expect(api.updateItems).toHaveBeenCalledTimes(2);
  expect(api.updateItems).toHaveBeenLastCalledWith([{ id: 'note', updates: { name: 'Renamed.txt' } }]);
});

test('move: retrying after a failed move saves the position exactly once', async () => {
  api.updateItems.mockRejectedValueOnce(new Error('500 Internal Server Error'));
  api.updateItems.mockResolvedValue([]);
  useDesktopStore.getState().moveItem('note', { x: 100, y: 50 });
  await vi.advanceTimersByTimeAsync(600);
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 0, y: 0 });
  // The user drags the item again; this time the save succeeds.
  useDesktopStore.getState().moveItem('note', { x: 100, y: 50 });
  await vi.advanceTimersByTimeAsync(600);
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 100, y: 50 });
  expect(api.updateItems).toHaveBeenCalledTimes(2);
});

test('trash: retrying after a failed trash trashes the item exactly once', async () => {
  api.updateItems.mockRejectedValueOnce(new Error('500 Internal Server Error'));
  api.updateItems.mockResolvedValue([]);
  useDesktopStore.getState().moveToTrash(['note']);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBeFalsy();
  useDesktopStore.getState().moveToTrash(['note']);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('note')?.isTrashed).toBe(true);
  expect(api.updateItems).toHaveBeenCalledTimes(2);
  // The failed attempt + retry left no duplicate behind.
  expect(useDesktopStore.getState().items.filter((i) => i.id === 'note')).toHaveLength(1);
});

test('reconnecting after failures converges to the server state without duplicates', async () => {
  api.createItem.mockRejectedValueOnce(new Error('500 Internal Server Error'));
  useDesktopStore.getState().addItem({ ...original, id: 'phantom', name: 'Phantom.txt' });
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getItem('phantom')).toBeUndefined();
  // Reconnect: the server is the source of truth and never saw the phantom,
  // so the client must end up with exactly the server's items.
  api.fetchDesktop.mockResolvedValue({ items: [original] });
  await useDesktopStore.getState().loadDesktop();
  expect(useDesktopStore.getState().items).toEqual([original]);
});

// ---------------------------------------------------------------------------
// CORE-ROADMAP Workstream 1, item 4: acknowledged server state vs
// interaction state. The displayed items are optimistic; the acknowledged
// snapshot (./desktopItemSync) is the last server-confirmed value per item;
// the selection (./desktopSelectionSlice) is interaction state that a
// server reconcile must never touch.
// ---------------------------------------------------------------------------

test('a successful write makes the displayed item match the acknowledged snapshot', async () => {
  api.updateItems.mockResolvedValue([]);
  const saved = await useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  expect(saved).toBe(true);
  expect(getAcknowledgedItem('note')?.name).toBe('Renamed.txt');
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Renamed.txt');
});

test('a failed write rolls back to the acknowledged snapshot, not the last optimistic value', async () => {
  // Two renames queue back to back and both saves fail. The old code rolled
  // the second failure back to the *intermediate optimistic* rename; the
  // acknowledged snapshot is the only value the server ever knew.
  api.updateItems.mockRejectedValue(new Error('Offline'));
  const first = useDesktopStore.getState().updateItem('note', { name: 'First.txt' });
  const second = useDesktopStore.getState().updateItem('note', { name: 'Second.txt' });
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Note.txt');
  expect(getAcknowledgedItem('note')?.name).toBe('Note.txt');
});

test('a failed rename still reverts while a newer interaction on the same item is preserved', async () => {
  // The rename save is in flight; the user drags the item; the save fails.
  // The name reverts to the acknowledged value, the newer move is untouched.
  let reject!: (e: Error) => void;
  api.updateItems.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
  const pending = useDesktopStore.getState().updateItem('note', { name: 'Renamed.txt' });
  await Promise.resolve();
  await Promise.resolve();
  useDesktopStore.getState().moveItem('note', { x: 5, y: 5 });
  reject(new Error('Offline'));
  expect(await pending).toBe(false);
  const item = useDesktopStore.getState().getItem('note');
  expect(item?.name).toBe('Note.txt');
  expect(item?.position).toEqual({ x: 5, y: 5 });
});

test('a failed position save reverts to the last server-acknowledged position', async () => {
  // First drag's save is in flight; the user drags again; the first save
  // lands (the server now knows (10,10)); the second save fails. The old
  // code deleted the rollback target on the first success and left the
  // unsaved (20,20) looking persisted.
  let resolveFirst!: (value: unknown) => void;
  api.updateItems.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
  api.updateItems.mockRejectedValue(new Error('Offline'));
  const store = useDesktopStore.getState();
  store.moveItem('note', { x: 10, y: 10 });
  await vi.advanceTimersByTimeAsync(600); // first save fires, still pending
  store.moveItem('note', { x: 20, y: 20 }); // user drags again before it settles
  resolveFirst([]); // first save lands: the server knows (10,10)
  await vi.advanceTimersByTimeAsync(600); // second save fires and fails
  expect(useDesktopStore.getState().getItem('note')?.position).toEqual({ x: 10, y: 10 });
});

test('a server echo after an optimistic write converges to one item with no duplicate', async () => {
  api.createItem.mockResolvedValue(undefined);
  const created = { ...original, id: 'echo-note', name: 'Echo.txt' };
  useDesktopStore.getState().addItem(created);
  await vi.advanceTimersByTimeAsync(0); // the create lands server-side
  // Reconnect: the server list echoes the item back.
  api.fetchDesktop.mockResolvedValue({ items: [original, created] });
  await useDesktopStore.getState().loadDesktop();
  const items = useDesktopStore.getState().items;
  expect(items.filter((i) => i.id === 'echo-note')).toHaveLength(1);
  expect(items).toHaveLength(2);
  expect(useDesktopStore.getState().getItem('echo-note')?.name).toBe('Echo.txt');
});

test('a server reconcile refreshes the acknowledged snapshot', async () => {
  api.fetchDesktop.mockResolvedValue({ items: [{ ...original, name: 'Server.txt' }] });
  await useDesktopStore.getState().loadDesktop();
  expect(useDesktopStore.getState().getItem('note')?.name).toBe('Server.txt');
  expect(getAcknowledgedItem('note')?.name).toBe('Server.txt');
});

test('interaction state survives a server reconcile', async () => {
  api.fetchDesktop.mockResolvedValue({ items: [{ ...original }] });
  useDesktopStore.getState().selectItem('note');
  await useDesktopStore.getState().loadDesktop();
  expect(useDesktopStore.getState().isSelected('note')).toBe(true);
});

test('interaction state survives a server snapshot applied via setItems', () => {
  useDesktopStore.getState().selectItem('note');
  useDesktopStore.getState().setItems([{ ...original, name: 'Echo.txt' }]);
  expect(useDesktopStore.getState().selectedIds.has('note')).toBe(true);
});

test('trashing or deleting a selected item drops it from the selection', async () => {
  api.updateItems.mockResolvedValue([]);
  const store = useDesktopStore.getState();
  store.selectItem('note');
  store.moveToTrash(['note']);
  expect(useDesktopStore.getState().selectedIds.has('note')).toBe(false);
  // And the delete path.
  useDesktopStore.getState().restoreFromTrash(['note']);
  useDesktopStore.getState().selectItem('note');
  useDesktopStore.getState().removeItem('note');
  expect(useDesktopStore.getState().selectedIds.has('note')).toBe(false);
});

test('reset clears the interaction state with the session', () => {
  useDesktopStore.getState().selectItem('note');
  useDesktopStore.getState().reset();
  expect(useDesktopStore.getState().selectedIds.size).toBe(0);
});

// ---------------------------------------------------------------------------
// Clean Up / sort (CORE-ROADMAP Workstream 1): the batch arrangement saves
// now route through the per-item write queue, so a refused batch reverts
// every failed item to its acknowledged position and surfaces the shared
// "Sync Failed" error — no desktop left looking re-arranged when the
// server never recorded it.
// ---------------------------------------------------------------------------

const sortSeed: DesktopItem[] = [
  { ...original, id: 'note-c', name: 'C.txt', position: { x: 5, y: 0 }, updatedAt: 3 },
  { ...original, id: 'note-a', name: 'A.txt', position: { x: 3, y: 1 }, updatedAt: 1 },
  { ...original, id: 'note-b', name: 'B.txt', position: { x: 1, y: 2 }, updatedAt: 2 },
];

// [action, arranged position per id] — the arrangement each command produces.
const arrangements: ReadonlyArray<
  readonly [
    'cleanUp' | 'sortByName' | 'sortByDate' | 'sortByKind',
    ReadonlyArray<readonly [string, { x: number; y: number }]>
  ]
> = [
  // Alphabetical: Clean Up and sort-by-name; sort-by-kind is alphabetical
  // too because every item here is a text file.
  ['cleanUp', [['note-a', { x: 0, y: 0 }], ['note-b', { x: 0, y: 1 }], ['note-c', { x: 0, y: 2 }]]],
  ['sortByName', [['note-a', { x: 0, y: 0 }], ['note-b', { x: 0, y: 1 }], ['note-c', { x: 0, y: 2 }]]],
  // Newest first: C (3), B (2), A (1).
  ['sortByDate', [['note-c', { x: 0, y: 0 }], ['note-b', { x: 0, y: 1 }], ['note-a', { x: 0, y: 2 }]]],
  ['sortByKind', [['note-a', { x: 0, y: 0 }], ['note-b', { x: 0, y: 1 }], ['note-c', { x: 0, y: 2 }]]],
];

test.each(arrangements)(
  '%s: a forced failure reverts every item to its acknowledged position',
  async (action, arranged) => {
    api.updateItems.mockRejectedValue(new Error('Offline'));
    const store = useDesktopStore.getState();
    store.setItems(sortSeed.map((item) => ({ ...item })));
    store[action](null);
    // The optimistic arrangement shows immediately.
    for (const [id, position] of arranged) {
      expect(store.getItem(id)?.position).toEqual(position);
    }
    await vi.advanceTimersByTimeAsync(0);
    // Every write was refused: each item rolls back to its acknowledged
    // position, and one shared error surfaces for the batch.
    for (const item of sortSeed) {
      expect(store.getItem(item.id)?.position).toEqual(item.position);
    }
    expect(alerts.showError).toHaveBeenCalledWith(
      'Could not save the new arrangement. It has been reverted.',
      'Sync Failed'
    );
  }
);

test.each(failures)('sort: a forced %s failure reverts the arrangement and surfaces the error', async (_label, fail) => {
  api.updateItems.mockRejectedValue(fail());
  const store = useDesktopStore.getState();
  store.setItems(sortSeed.map((item) => ({ ...item })));
  store.sortByName(null);
  await vi.advanceTimersByTimeAsync(0);
  for (const item of sortSeed) {
    expect(store.getItem(item.id)?.position).toEqual(item.position);
  }
  expect(alerts.showError).toHaveBeenCalledWith(
    'Could not save the new arrangement. It has been reverted.',
    'Sync Failed'
  );
});

test('a successful sort persists each arranged position through the item write queue', async () => {
  api.updateItems.mockResolvedValue([]);
  const store = useDesktopStore.getState();
  store.setItems(sortSeed.map((item) => ({ ...item })));
  store.sortByName(null);
  await vi.advanceTimersByTimeAsync(0);
  // Each item's position reached the server as its own queued write,
  // keeping per-item write order — not one fire-and-forget batch.
  expect(api.updateItems).toHaveBeenCalledWith([{ id: 'note-a', updates: { position: { x: 0, y: 0 } } }]);
  expect(api.updateItems).toHaveBeenCalledWith([{ id: 'note-b', updates: { position: { x: 0, y: 1 } } }]);
  expect(api.updateItems).toHaveBeenCalledWith([{ id: 'note-c', updates: { position: { x: 0, y: 2 } } }]);
  // And the acknowledged snapshot holds the arranged positions.
  expect(getAcknowledgedItem('note-a')?.position).toEqual({ x: 0, y: 0 });
  expect(store.getItem('note-c')?.position).toEqual({ x: 0, y: 2 });
});

test('a sort waits for an earlier in-flight save on the same item', async () => {
  let acknowledge!: () => void;
  api.updateItems.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
  api.updateItems.mockResolvedValue([]);
  const store = useDesktopStore.getState();
  store.setItems(sortSeed.map((item) => ({ ...item })));
  // The user drags note-c; its position save is still in flight when the
  // sort runs.
  store.moveItem('note-c', { x: 9, y: 9 });
  await vi.advanceTimersByTimeAsync(600); // the drag save fires, still pending
  store.sortByName(null);
  await vi.advanceTimersByTimeAsync(0);
  // note-a's and note-b's writes ran (nothing queued ahead of them);
  // note-c's arranged write waits behind its in-flight drag save instead
  // of overtaking it — the old fire-and-forget batch could land before the
  // drag, letting the stale drag position clobber the arrangement.
  expect(api.updateItems).toHaveBeenCalledTimes(3);
  expect(api.updateItems).not.toHaveBeenCalledWith([{ id: 'note-c', updates: { position: { x: 0, y: 2 } } }]);
  acknowledge();
  await vi.advanceTimersByTimeAsync(0);
  // Now the arranged write for note-c lands — after the drag save settled.
  expect(api.updateItems).toHaveBeenCalledWith([{ id: 'note-c', updates: { position: { x: 0, y: 2 } } }]);
  expect(api.updateItems).toHaveBeenCalledTimes(4);
  expect(store.getItem('note-c')?.position).toEqual({ x: 0, y: 2 });
});

// ---------------------------------------------------------------------------
// Empty trash (CORE-ROADMAP Workstream 1): a refused permanent delete must
// restore the trashed items from the acknowledged snapshot — the server still
// holds them, so they must not stay gone locally.
// ---------------------------------------------------------------------------

test('a failed empty-trash restores the trashed items from the acknowledged snapshot', async () => {
  const store = useDesktopStore.getState();
  const second = { ...original, id: 'memo', name: 'Memo.txt', position: { x: 1, y: 0 } };
  store.setItems([{ ...original }, second]);
  // Both items are trashed with the server's blessing first.
  api.updateItems.mockResolvedValue([]);
  store.moveToTrash(['note', 'memo']);
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().getTrashCount()).toBe(2);

  // The server refuses the permanent delete.
  api.emptyTrashApi.mockRejectedValue(new Error('500 Internal Server Error'));
  useDesktopStore.getState().emptyTrash();
  expect(useDesktopStore.getState().getTrashCount()).toBe(0); // optimistic removal
  await vi.advanceTimersByTimeAsync(0);
  // Rolled back: both items are back, exactly as the server still knows
  // them, and the failure says so instead of "they may reappear on reload".
  expect(useDesktopStore.getState().getTrashCount()).toBe(2);
  expect(useDesktopStore.getState().getItem('note')).toEqual(getAcknowledgedItem('note'));
  expect(useDesktopStore.getState().getItem('memo')).toEqual(getAcknowledgedItem('memo'));
  expect(alerts.showError).toHaveBeenCalledWith(
    'Failed to permanently delete the trash. Your trashed items have been restored.',
    'Empty Trash Failed'
  );
});

test('a successful empty-trash forgets the acknowledged items', async () => {
  api.updateItems.mockResolvedValue([]);
  useDesktopStore.getState().moveToTrash(['note']);
  await vi.advanceTimersByTimeAsync(0);
  api.emptyTrashApi.mockResolvedValue({ success: true });
  useDesktopStore.getState().emptyTrash();
  await vi.advanceTimersByTimeAsync(0);
  expect(useDesktopStore.getState().items).toHaveLength(0);
  expect(getAcknowledgedItem('note')).toBeUndefined();
});

