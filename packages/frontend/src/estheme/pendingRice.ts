/**
 * "Try this rice": a visitor on someone's public desktop exports that look
 * as an .estheme and carries it to their own desktop, which previews it with
 * the usual Keep / Revert banner. In memory only (same tab, same session).
 */

let pending: { blob: Blob; from: string } | null = null;

export function setPendingRice(blob: Blob, from: string): void {
  pending = { blob, from };
}

/** The waiting rice, once (cleared when taken). */
export function takePendingRice(): { blob: Blob; from: string } | null {
  const value = pending;
  pending = null;
  return value;
}
