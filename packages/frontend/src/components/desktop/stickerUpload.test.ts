import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import type { DesktopItem } from '../../types';

// Same mock surface as desktopStore.test.ts: the sticker command drives the
// real desktop store against a mocked api so its reliability contract
// (nothing looks sticker-applied when the server refused) is testable.
const api = vi.hoisted(() => ({
  createItem: vi.fn(), updateItems: vi.fn(), deleteItem: vi.fn(), fetchDesktop: vi.fn(),
  analyzeImageItem: vi.fn(), uploadFile: vi.fn(), emptyTrashApi: vi.fn(),
}));
vi.mock('../../services/api', () => ({ isApiConfigured: true, ...api }));
vi.mock('../../stores/soundStore', () => ({ useSoundStore: { getState: () => ({ playSound: vi.fn() }) } }));
const alerts = vi.hoisted(() => ({ showError: vi.fn() }));
vi.mock('../../stores/alertStore', () => ({ useAlertStore: { getState: () => alerts } }));
import { useDesktopStore } from '../../stores/desktopStore';
import { getAcknowledgedItem } from '../../stores/desktopItemSync';
import { createStickerFromFile } from './stickerUpload';

// What the server's upload route returns for an image file.
const uploaded: DesktopItem = {
  id: 'sticker-upload', name: 'cat.png', type: 'image',
  isPublic: false, parentId: null, position: { x: 320, y: 240 },
  createdAt: 1, updatedAt: 1, r2Key: 'uploads/alice/sticker-upload.png', mimeType: 'image/png',
};

const STICKER_CONFIG = { width: 120, height: 120, rotation: 0, opacity: 1 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = useDesktopStore.getState();
  store.reset();
  store.setUid('alice');
});
afterEach(() => {
  useDesktopStore.getState().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('a successful sticker flow uploads through the store and applies the sticker', async () => {
  api.uploadFile.mockResolvedValue({ item: { ...uploaded } });
  api.updateItems.mockResolvedValue([]);
  const applied = await createStickerFromFile({ name: 'cat.png' } as File, { x: 320, y: 240 });
  expect(applied).toBe(true);
  const item = useDesktopStore.getState().getItem('sticker-upload');
  expect(item?.type).toBe('sticker');
  expect(item?.stickerConfig).toEqual(STICKER_CONFIG);
  // Stickers are pixel-positioned, not grid-snapped.
  expect(item?.position).toEqual({ x: 320, y: 240 });
  // The apply reached the server as a queued write, and the acknowledged
  // snapshot holds the sticker the server confirmed.
  expect(api.updateItems).toHaveBeenCalledWith([
    { id: 'sticker-upload', updates: { type: 'sticker', stickerConfig: { ...STICKER_CONFIG } } },
  ]);
  expect(getAcknowledgedItem('sticker-upload')?.type).toBe('sticker');
});

test('a refused upload leaves no sticker behind and surfaces the failure', async () => {
  api.uploadFile.mockRejectedValue(new Error('429 Too Many Requests'));
  const applied = await createStickerFromFile({ name: 'cat.png' } as File, { x: 320, y: 240 });
  expect(applied).toBe(false);
  // No phantom sticker and no phantom image item — the store only adds
  // items the server confirmed.
  expect(useDesktopStore.getState().items).toHaveLength(0);
  expect(alerts.showError).toHaveBeenCalledWith(
    expect.stringContaining('Could not upload "cat.png"'),
    'Upload Failed'
  );
  // The refused upload never attempted the apply.
  expect(api.updateItems).not.toHaveBeenCalled();
});

test('a refused apply rolls the sticker back to the plain image the server acknowledged', async () => {
  api.uploadFile.mockResolvedValue({ item: { ...uploaded } });
  api.updateItems.mockRejectedValue(new Error('500 Internal Server Error'));
  const applied = await createStickerFromFile({ name: 'cat.png' } as File, { x: 320, y: 240 });
  expect(applied).toBe(false);
  // The uploaded image stays — the server holds it — but nothing looks
  // sticker-applied: the optimistic type/config patch rolled back to the
  // acknowledged snapshot, and the failure is surfaced.
  const item = useDesktopStore.getState().getItem('sticker-upload');
  expect(item?.type).toBe('image');
  expect(item?.stickerConfig).toBeUndefined();
  expect(getAcknowledgedItem('sticker-upload')?.type).toBe('image');
  expect(alerts.showError).toHaveBeenCalledWith('Could not save your changes. Please try again.', 'Sync Failed');
});
