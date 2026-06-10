/**
 * Cartridge format for the EternalOS fantasy console.
 *
 * A cartridge is a single JSON document: JavaScript game code + a text-encoded
 * sprite sheet + metadata. Validated here on every write path (draft save,
 * bazaar publish) so the play route can trust stored cartridges.
 *
 * Console spec (mirrored in games/consoleRuntime.ts):
 *   - 128x128 screen, 16-color palette
 *   - sprite sheet: 128 rows x 128 hex nibbles (one palette index per pixel),
 *     rows joined by '\n' — 16x16 grid of 8x8 sprites, indices 0-255
 *   - optional per-sprite flags: 256 hex bytes (512 chars) for fget/fset
 */

export interface CartridgeMeta {
  name: string;
  description?: string;
  author: string;
  version: string;
}

export interface Cartridge {
  formatVersion: 1;
  meta: CartridgeMeta;
  code: string;
  spritesheet: string;
  palette?: string[];
  flags?: string;
}

export const CARTRIDGE_LIMITS = {
  maxCodeBytes: 256 * 1024,
  maxTotalBytes: 512 * 1024,
  maxNameLength: 80,
  maxDescriptionLength: 500,
  maxVersionLength: 32,
  screenSize: 128,
  paletteSize: 16,
  flagsHexLength: 512, // 256 sprites x 2 hex chars
} as const;

/** PICO-8 default palette — cartridges may override all 16 entries. */
export const DEFAULT_PALETTE: readonly string[] = [
  '#000000', '#1D2B53', '#7E2553', '#008751',
  '#AB5236', '#5F574F', '#C2C3C7', '#FFF1E8',
  '#FF004D', '#FFA300', '#FFEC27', '#00E436',
  '#29ADFF', '#83769C', '#FF77A8', '#FFCCAA',
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX_ROW_RE = /^[0-9a-fA-F]*$/;

export interface CartridgeValidation {
  ok: boolean;
  errors: string[];
  cartridge?: Cartridge;
}

/**
 * Validate an untrusted value as a Cartridge. Returns a normalized copy on
 * success (trimmed metadata, spritesheet padded to full 128x128).
 */
export function validateCartridge(raw: unknown): CartridgeValidation {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['Cartridge must be a JSON object'] };
  }
  const cart = raw as Record<string, unknown>;

  if (cart.formatVersion !== 1) {
    errors.push('formatVersion must be 1');
  }

  // --- meta ---
  const meta = cart.meta as Record<string, unknown> | undefined;
  let normalizedMeta: CartridgeMeta | null = null;
  if (!meta || typeof meta !== 'object') {
    errors.push('meta is required');
  } else {
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    if (!name) {
      errors.push('meta.name is required');
    } else if (name.length > CARTRIDGE_LIMITS.maxNameLength) {
      errors.push(`meta.name must be at most ${CARTRIDGE_LIMITS.maxNameLength} characters`);
    }
    const description = typeof meta.description === 'string' ? meta.description.trim() : undefined;
    if (description && description.length > CARTRIDGE_LIMITS.maxDescriptionLength) {
      errors.push(`meta.description must be at most ${CARTRIDGE_LIMITS.maxDescriptionLength} characters`);
    }
    const author = typeof meta.author === 'string' ? meta.author.trim() : '';
    const version = typeof meta.version === 'string' && meta.version.trim()
      ? meta.version.trim().slice(0, CARTRIDGE_LIMITS.maxVersionLength)
      : '1.0.0';
    normalizedMeta = { name, author, version, ...(description ? { description } : {}) };
  }

  // --- code ---
  const code = typeof cart.code === 'string' ? cart.code : null;
  if (code === null) {
    errors.push('code must be a string');
  } else if (byteLength(code) > CARTRIDGE_LIMITS.maxCodeBytes) {
    errors.push(`code exceeds ${CARTRIDGE_LIMITS.maxCodeBytes / 1024}KB limit`);
  }

  // --- spritesheet ---
  const size = CARTRIDGE_LIMITS.screenSize;
  let normalizedSheet = '';
  const sheet = typeof cart.spritesheet === 'string' ? cart.spritesheet : null;
  if (sheet === null) {
    errors.push('spritesheet must be a string');
  } else {
    const rows = sheet.split('\n');
    if (rows.length > size) {
      errors.push(`spritesheet has ${rows.length} rows (max ${size})`);
    } else {
      const outRows: string[] = [];
      for (let i = 0; i < size; i++) {
        const row = (rows[i] ?? '').trim();
        if (!HEX_ROW_RE.test(row)) {
          errors.push(`spritesheet row ${i + 1} contains non-hex characters`);
          break;
        }
        if (row.length > size) {
          errors.push(`spritesheet row ${i + 1} is ${row.length} chars (max ${size})`);
          break;
        }
        outRows.push(row.padEnd(size, '0').toLowerCase());
      }
      if (outRows.length === size) normalizedSheet = outRows.join('\n');
    }
  }

  // --- palette ---
  let palette: string[] | undefined;
  if (cart.palette !== undefined) {
    if (
      !Array.isArray(cart.palette) ||
      cart.palette.length !== CARTRIDGE_LIMITS.paletteSize ||
      !cart.palette.every((c) => typeof c === 'string' && HEX_COLOR_RE.test(c))
    ) {
      errors.push(`palette must be exactly ${CARTRIDGE_LIMITS.paletteSize} hex colors like #FF004D`);
    } else {
      palette = cart.palette.map((c) => (c as string).toUpperCase());
    }
  }

  // --- flags ---
  let flags: string | undefined;
  if (cart.flags !== undefined) {
    if (
      typeof cart.flags !== 'string' ||
      cart.flags.length > CARTRIDGE_LIMITS.flagsHexLength ||
      !HEX_ROW_RE.test(cart.flags)
    ) {
      errors.push(`flags must be up to ${CARTRIDGE_LIMITS.flagsHexLength} hex characters`);
    } else {
      flags = cart.flags.padEnd(CARTRIDGE_LIMITS.flagsHexLength, '0').toLowerCase();
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const normalized: Cartridge = {
    formatVersion: 1,
    meta: normalizedMeta as CartridgeMeta,
    code: code as string,
    spritesheet: normalizedSheet,
    ...(palette ? { palette } : {}),
    ...(flags ? { flags } : {}),
  };

  if (byteLength(JSON.stringify(normalized)) > CARTRIDGE_LIMITS.maxTotalBytes) {
    return { ok: false, errors: [`cartridge exceeds ${CARTRIDGE_LIMITS.maxTotalBytes / 1024}KB total limit`] };
  }

  return { ok: true, errors: [], cartridge: normalized };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** An all-zero (blank) sprite sheet, useful for new drafts. */
export function blankSpritesheet(): string {
  const size = CARTRIDGE_LIMITS.screenSize;
  const row = '0'.repeat(size);
  return Array.from({ length: size }, () => row).join('\n');
}
