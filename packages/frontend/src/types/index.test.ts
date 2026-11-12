import { expect, test, describe } from 'vitest';
import { getTextFileContentType } from './index';

describe('getTextFileContentType', () => {
  test('classifies markdown by extension', () => {
    expect(getTextFileContentType('README.md')).toBe('markdown');
    expect(getTextFileContentType('notes.markdown')).toBe('markdown');
  });

  test('classifies known code extensions (case-insensitive)', () => {
    for (const name of ['app.tsx', 'main.PY', 'style.css', 'data.json', 'run.sh', 'mod.rs']) {
      expect(getTextFileContentType(name), name).toBe('code');
    }
  });

  test('falls back to plain text for everything else', () => {
    for (const name of ['notes.txt', 'noextension', 'archive.zip', 'photo.png']) {
      expect(getTextFileContentType(name), name).toBe('text');
    }
  });

  test('matches only the final extension', () => {
    expect(getTextFileContentType('readme.md.txt')).toBe('text');
    expect(getTextFileContentType('script.txt.py')).toBe('code');
  });
});
