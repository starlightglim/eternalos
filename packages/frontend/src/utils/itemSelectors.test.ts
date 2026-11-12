import { expect, test, describe } from 'vitest';
import { getItemExtension } from './itemSelectors';

describe('getItemExtension', () => {
  test('reads the extension from the filename, lowercased', () => {
    expect(getItemExtension({ name: 'Photo.PNG' })).toBe('png');
    expect(getItemExtension({ name: 'archive.tar.gz' })).toBe('gz');
  });

  test('strips non-alphanumerics from the extension', () => {
    expect(getItemExtension({ name: 'weird.p!n g' })).toBe('png');
  });

  test('falls back to the mime subtype when there is no usable extension', () => {
    expect(getItemExtension({ name: 'noext', mimeType: 'image/webp' })).toBe('webp');
    expect(getItemExtension({ name: '.hidden', mimeType: 'text/plain' })).toBe('plain');
    expect(getItemExtension({ name: 'trailingdot.', mimeType: 'application/pdf' })).toBe('pdf');
  });

  test('returns undefined when neither name nor mime yields an extension', () => {
    expect(getItemExtension({ name: 'noext' })).toBeUndefined();
    expect(getItemExtension({ name: 'noext', mimeType: 'weird' })).toBeUndefined();
  });
});
