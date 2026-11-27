import { describe, expect, test } from 'vitest';
import { CARTRIDGE_LIMITS } from '@eternalos/contracts';
import type { Cartridge } from '../../types';
import { checkCartridgeLimits } from './cartridgeLimits';

const base = (): Cartridge => ({
  formatVersion: 1,
  meta: { name: 'Game', author: 'me', version: '1.0.0' },
  code: 'function _draw() {}',
  spritesheet: '',
});

describe('checkCartridgeLimits', () => {
  test('a small valid cartridge passes', () => {
    expect(checkCartridgeLimits(base())).toEqual([]);
  });

  test('values exactly at the limits pass', () => {
    const cart = base();
    cart.meta.name = 'n'.repeat(CARTRIDGE_LIMITS.maxNameLength);
    cart.meta.description = 'd'.repeat(CARTRIDGE_LIMITS.maxDescriptionLength);
    cart.meta.version = 'v'.repeat(CARTRIDGE_LIMITS.maxVersionLength);
    cart.spritesheet = Array(CARTRIDGE_LIMITS.screenSize).fill('f'.repeat(CARTRIDGE_LIMITS.screenSize)).join('\n');
    cart.palette = Array(CARTRIDGE_LIMITS.paletteSize).fill('#FF004D');
    cart.flags = '0'.repeat(CARTRIDGE_LIMITS.flagsHexLength);
    expect(checkCartridgeLimits(cart)).toEqual([]);
  });

  test('flags each metadata limit', () => {
    const cart = base();
    cart.meta.name = '   ';
    expect(checkCartridgeLimits(cart)).toEqual(['Name is required.']);
    cart.meta.name = 'n'.repeat(CARTRIDGE_LIMITS.maxNameLength + 1);
    cart.meta.description = 'd'.repeat(CARTRIDGE_LIMITS.maxDescriptionLength + 1);
    cart.meta.version = 'v'.repeat(CARTRIDGE_LIMITS.maxVersionLength + 1);
    expect(checkCartridgeLimits(cart)).toEqual([
      'Name must be at most 80 characters.',
      'Description must be at most 500 characters.',
      'Version must be at most 32 characters.',
    ]);
  });

  test('code over the byte limit is blocked (multi-byte chars count as bytes)', () => {
    const cart = base();
    cart.code = 'é'.repeat(CARTRIDGE_LIMITS.maxCodeBytes / 2 + 1);
    expect(checkCartridgeLimits(cart)[0]).toMatch(/^Code is 257KB; the limit is 256KB\.$/);
  });

  test('sprite sheet rows, palette and flags', () => {
    const cart = base();
    cart.spritesheet = Array(CARTRIDGE_LIMITS.screenSize + 1).fill('0').join('\n');
    cart.palette = ['#000000'];
    cart.flags = 'zz';
    expect(checkCartridgeLimits(cart)).toEqual([
      'Sprite sheet has 129 rows; the limit is 128.',
      'Palette must be exactly 16 hex colors like #FF004D.',
      'Sprite flags must be at most 512 hex digits.',
    ]);
    cart.spritesheet = '00\n0g';
    expect(checkCartridgeLimits(cart)[0]).toBe('Sprite sheet row 2 must be at most 128 hex digits (0-f).');
  });

  test('total size counts the padded sprite sheet', () => {
    const cart = base();
    // Code under its own limit, but code + full sheet exceeds the total.
    cart.code = 'x'.repeat(CARTRIDGE_LIMITS.maxTotalBytes - 10_000);
    const problems = checkCartridgeLimits(cart);
    expect(problems.some((p) => p.startsWith('Code is'))).toBe(true);
    expect(problems.some((p) => p.startsWith('Cartridge is'))).toBe(true);
  });
});
