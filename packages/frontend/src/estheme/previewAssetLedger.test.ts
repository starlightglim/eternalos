import { beforeEach, describe, expect, test, vi } from 'vitest';

// The ledger is pure sessionStorage bookkeeping over the asset services; the
// storage is stubbed (node has no sessionStorage) and the delete services are
// recorded for assertion — the same seam pattern themePreview.test.ts uses.

const mocks = vi.hoisted(() => {
  const backing = new Map<string, string>();
  const g = globalThis as unknown as { sessionStorage?: unknown };
  g.sessionStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
  };
  return {
    backing,
    deleteCursor: vi.fn(),
    deleteSound: vi.fn(),
  };
});

vi.mock('../services/assets', () => ({
  deleteCursor: mocks.deleteCursor,
  deleteSound: mocks.deleteSound,
}));

import {
  recordPreviewCursor,
  recordPreviewSound,
  clearPreviewAssetRecord,
  sweepAbandonedPreviewAssets,
} from './previewAssetLedger';

const KEY = 'eternalos-estheme-preview-assets';

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  mocks.backing.clear();
  vi.clearAllMocks();
  mocks.deleteCursor.mockResolvedValue({ success: true });
  mocks.deleteSound.mockResolvedValue({ success: true });
});

describe('record / clear bookkeeping', () => {
  test('records cursor and sound ids as they upload, without duplicates', () => {
    recordPreviewCursor('cur-1');
    recordPreviewCursor('cur-2');
    recordPreviewCursor('cur-1'); // duplicate upload id — recorded once
    recordPreviewSound('snd-1');

    expect(mocks.backing.get(KEY)).toBe(
      JSON.stringify({ cursors: ['cur-1', 'cur-2'], sounds: ['snd-1'] }),
    );
  });

  test('clear removes the record entirely', () => {
    recordPreviewCursor('cur-1');
    clearPreviewAssetRecord();
    expect(mocks.backing.has(KEY)).toBe(false);
  });

  test('every operation is a no-op when sessionStorage is unavailable', () => {
    const g = globalThis as unknown as { sessionStorage?: unknown };
    const saved = g.sessionStorage;
    delete g.sessionStorage;
    try {
      expect(() => recordPreviewCursor('cur-1')).not.toThrow();
      expect(() => recordPreviewSound('snd-1')).not.toThrow();
      expect(() => clearPreviewAssetRecord()).not.toThrow();
    } finally {
      g.sessionStorage = saved;
    }
  });

  test('a corrupted record is treated as empty', async () => {
    mocks.backing.set(KEY, '{not json');
    recordPreviewCursor('cur-1'); // must not throw, must not inherit garbage
    expect(mocks.backing.get(KEY)).toBe(
      JSON.stringify({ cursors: ['cur-1'], sounds: [] }),
    );
    await sweepAbandonedPreviewAssets();
    expect(mocks.deleteCursor).toHaveBeenCalledWith('cur-1');
  });
});

describe('sweepAbandonedPreviewAssets', () => {
  test('deletes leftover ids from an abandoned preview and clears the record', async () => {
    recordPreviewCursor('cur-a');
    recordPreviewCursor('cur-b');
    recordPreviewSound('snd-a');

    await sweepAbandonedPreviewAssets();
    await flushAsync();

    expect(mocks.deleteCursor).toHaveBeenCalledWith('cur-a');
    expect(mocks.deleteCursor).toHaveBeenCalledWith('cur-b');
    expect(mocks.deleteSound).toHaveBeenCalledWith('snd-a');
    expect(mocks.backing.has(KEY)).toBe(false);
  });

  test('a clean record deletes nothing', async () => {
    await sweepAbandonedPreviewAssets();
    expect(mocks.deleteCursor).not.toHaveBeenCalled();
    expect(mocks.deleteSound).not.toHaveBeenCalled();
  });

  test('failed deletes are tolerated and the record is still cleared', async () => {
    recordPreviewCursor('cur-a');
    mocks.deleteCursor.mockRejectedValue(new Error('network'));

    await expect(sweepAbandonedPreviewAssets()).resolves.toBeUndefined();
    await flushAsync();

    expect(mocks.deleteCursor).toHaveBeenCalledWith('cur-a');
    expect(mocks.backing.has(KEY)).toBe(false);
  });
});
