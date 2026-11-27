import { describe, expect, it } from 'vitest';
import { canonicalUrlFor } from './useDocumentMeta';

describe('canonicalUrlFor', () => {
  it('drops the query string and fragment', () => {
    expect(canonicalUrlFor('https://eternalos.me/@alice?ref=x#top')).toBe('https://eternalos.me/@alice');
  });

  it('lowercases usernames, which are case-insensitive', () => {
    expect(canonicalUrlFor('https://eternalos.me/@Alice')).toBe('https://eternalos.me/@alice');
  });

  it('keeps the origin and path as they are', () => {
    expect(canonicalUrlFor('https://eternalos.me/')).toBe('https://eternalos.me/');
    expect(canonicalUrlFor('http://localhost:5173/@bob')).toBe('http://localhost:5173/@bob');
  });
});
