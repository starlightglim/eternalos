import { expect, test } from 'vitest';
import { isChunkLoadError } from './chunkError';

test('recognizes lazy-chunk load failures across browsers', () => {
  const messages = [
    'Failed to fetch dynamically imported module: https://x/assets/ImageViewer-abc.js',
    'error loading dynamically imported module: https://x/assets/a.js',
    'Importing a module script failed.',
    'Loading chunk 42 failed.',
    'Loading CSS chunk viewer failed',
    'Unable to preload CSS for /assets/AppViewer-1.css',
  ];
  for (const message of messages) {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  }
  const named = new Error('whatever');
  named.name = 'ChunkLoadError';
  expect(isChunkLoadError(named)).toBe(true);
  expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(true);
});

test('ignores ordinary viewer errors and non-errors', () => {
  expect(isChunkLoadError(new Error("Cannot read properties of undefined (reading 'name')"))).toBe(false);
  expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false);
  expect(isChunkLoadError(null)).toBe(false);
  expect(isChunkLoadError(undefined)).toBe(false);
  expect(isChunkLoadError(42)).toBe(false);
  expect(isChunkLoadError({ message: 7 })).toBe(false);
});
