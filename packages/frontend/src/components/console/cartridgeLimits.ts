/**
 * Client-side mirror of the worker's cartridge checks
 * (packages/worker/src/utils/cartridge.ts), using the shared
 * CARTRIDGE_LIMITS so the editor rejects a cartridge before the save
 * round-trip does. Returns human-readable problems; empty = OK to save.
 */
import { CARTRIDGE_LIMITS } from '@eternalos/contracts';
import type { Cartridge } from '../../types';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_RE = /^[0-9a-fA-F]*$/;

// Round up so an over-limit size never reads as equal to the limit.
const kb = (bytes: number) => `${Math.ceil(bytes / 1024)}KB`;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

export function checkCartridgeLimits(cart: Cartridge): string[] {
  const problems: string[] = [];
  const L = CARTRIDGE_LIMITS;

  const name = cart.meta.name.trim();
  if (!name) problems.push('Name is required.');
  else if (name.length > L.maxNameLength) problems.push(`Name must be at most ${L.maxNameLength} characters.`);

  const description = cart.meta.description?.trim() ?? '';
  if (description.length > L.maxDescriptionLength) {
    problems.push(`Description must be at most ${L.maxDescriptionLength} characters.`);
  }
  if (cart.meta.version.trim().length > L.maxVersionLength) {
    problems.push(`Version must be at most ${L.maxVersionLength} characters.`);
  }

  const codeBytes = byteLength(cart.code);
  if (codeBytes > L.maxCodeBytes) {
    problems.push(`Code is ${kb(codeBytes)}; the limit is ${kb(L.maxCodeBytes)}.`);
  }

  const rows = cart.spritesheet.split('\n');
  if (rows.length > L.screenSize) {
    problems.push(`Sprite sheet has ${rows.length} rows; the limit is ${L.screenSize}.`);
  } else {
    const bad = rows.findIndex((r) => !HEX_RE.test(r.trim()) || r.trim().length > L.screenSize);
    if (bad >= 0) {
      problems.push(`Sprite sheet row ${bad + 1} must be at most ${L.screenSize} hex digits (0-f).`);
    }
  }

  if (
    cart.palette !== undefined &&
    (cart.palette.length !== L.paletteSize || !cart.palette.every((c) => HEX_COLOR_RE.test(c)))
  ) {
    problems.push(`Palette must be exactly ${L.paletteSize} hex colors like #FF004D.`);
  }

  if (cart.flags !== undefined && (cart.flags.length > L.flagsHexLength || !HEX_RE.test(cart.flags))) {
    problems.push(`Sprite flags must be at most ${L.flagsHexLength} hex digits.`);
  }

  // The worker measures the normalized cartridge, whose sprite sheet is
  // always padded to the full grid, so measure with a full-size sheet.
  const fullSheet = Array(L.screenSize).fill('0'.repeat(L.screenSize)).join('\n');
  const totalBytes = byteLength(JSON.stringify({ ...cart, spritesheet: fullSheet }));
  if (totalBytes > L.maxTotalBytes) {
    problems.push(`Cartridge is ${kb(totalBytes)}; the limit is ${kb(L.maxTotalBytes)}.`);
  }

  return problems;
}
