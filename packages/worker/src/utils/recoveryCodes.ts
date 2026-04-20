/**
 * Recovery codes — one-time-use account recovery tokens.
 *
 * Generated at signup + shown to the user ONCE. Hashed with the same PBKDF2
 * scheme as passwords (verifyPassword works directly). Burning a code is a
 * simple filter of the stored array.
 *
 * Format: 10-char alphanumeric from an unambiguous alphabet, grouped as
 * XXXXX-XXXXX for readability. The dash is stripped on compare, so users can
 * type either form.
 */

import { hashPassword, verifyPassword } from './password';

// Unambiguous alphabet — excludes 0/O/o, 1/I/l, easily confused pairs.
// 32 chars → 5 bits per character → 50 bits of entropy per 10-char code.
// With 10 codes per user, guessing is infeasible (2^50 / 1e9 attempts ≈ 30 years).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
const DEFAULT_COUNT = 10;

/**
 * Generate N one-time recovery codes. Returns plaintext codes — the caller is
 * responsible for hashing before storage and surfacing the plaintext to the
 * user exactly once.
 */
export function generateRecoveryCodes(count: number = DEFAULT_COUNT): string[] {
  const codes: string[] = [];
  const bytes = new Uint8Array(count * CODE_LENGTH);
  crypto.getRandomValues(bytes);

  for (let i = 0; i < count; i++) {
    let code = '';
    for (let j = 0; j < CODE_LENGTH; j++) {
      code += ALPHABET[bytes[i * CODE_LENGTH + j] % ALPHABET.length];
    }
    // Insert a dash for readability — XXXXX-XXXXX.
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }

  return codes;
}

/**
 * Normalize a user-supplied code for comparison. Strips whitespace, dashes,
 * and uppercases. Returns an empty string if nothing usable is left.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Hash a set of plaintext recovery codes for storage. Uses the shared
 * password hashing scheme (PBKDF2-SHA256) for parity.
 */
export async function hashRecoveryCodes(plaintextCodes: string[]): Promise<string[]> {
  const normalized = plaintextCodes.map(normalizeRecoveryCode);
  return Promise.all(normalized.map((code) => hashPassword(code)));
}

/**
 * Check a user-supplied code against the stored hashed list. Returns the
 * matching hash on success so the caller can burn it, or null on failure.
 */
export async function findMatchingRecoveryHash(
  input: string,
  storedHashes: string[],
): Promise<string | null> {
  const normalized = normalizeRecoveryCode(input);
  if (normalized.length < CODE_LENGTH) return null;

  for (const hash of storedHashes) {
    if (await verifyPassword(normalized, hash)) return hash;
  }
  return null;
}

/**
 * Remove a specific hash from the stored list (used after successful recovery
 * login to burn the code).
 */
export function burnRecoveryCode(storedHashes: string[], usedHash: string): string[] {
  return storedHashes.filter((h) => h !== usedHash);
}
