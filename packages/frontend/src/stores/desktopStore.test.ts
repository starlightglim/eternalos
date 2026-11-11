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
