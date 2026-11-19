/**
 * sessionStorage ledger of the assets a theme preview has uploaded.
 *
 * `themePreviewStore` uploads cursor/sound files to the user's R2 prefix
 * BEFORE Keep/Revert. Keep adopts them (the saved profile now references
 * them) and Revert deletes them — but if the page dies mid-preview (reload,
 * crash, closed restored tab), neither runs and the files are orphaned in
 * R2 forever. This module records each uploaded id the moment its upload
 * succeeds, clears the record on Keep/Revert, and `sweepAbandonedPreviewAssets`
 * deletes whatever a previous page load left behind.
 *
 * Everything here is best-effort: sessionStorage can be unavailable
 * (disabled, privacy mode, non-DOM hosts) and every access is guarded —
 * bookkeeping must never break an import, and a failed delete leaves an
 * inert orphan exactly like the manual remove flows, never a wrong mapping.
 */

import { deleteCursor, deleteSound } from '../services/assets';

const STORAGE_KEY = 'eternalos-estheme-preview-assets';

interface PreviewAssetRecord {
  cursors: string[];
  sounds: string[];
}

const emptyRecord = (): PreviewAssetRecord => ({ cursors: [], sounds: [] });

function readRecord(): PreviewAssetRecord {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyRecord();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return emptyRecord();
    const { cursors, sounds } = parsed as Record<string, unknown>;
    const ids = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
    return { cursors: ids(cursors), sounds: ids(sounds) };
  } catch {
    // Unavailable storage or corrupted record — behave as if empty.
    return emptyRecord();
  }
}

function writeRecord(record: PreviewAssetRecord): void {
  try {
    if (record.cursors.length === 0 && record.sounds.length === 0) {
      sessionStorage.removeItem(STORAGE_KEY);
    } else {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
    }
  } catch {
    // sessionStorage may be unavailable — see the module note.
  }
}

/** Record one uploaded cursor id the preview now owns in R2. */
export function recordPreviewCursor(cursorId: string): void {
  const record = readRecord();
  if (!record.cursors.includes(cursorId)) record.cursors.push(cursorId);
  writeRecord(record);
}

/** Record one uploaded sound id the preview now owns in R2. */
export function recordPreviewSound(soundId: string): void {
  const record = readRecord();
  if (!record.sounds.includes(soundId)) record.sounds.push(soundId);
  writeRecord(record);
}

/**
 * Keep or Revert landed — no preview asset is awaiting cleanup anymore.
 * Keep calls this BEFORE its first save: once the profile can reference the
 * uploads, a crash mid-Keep must never leave a record that a later sweep
 * would delete just-adopted (owned) assets from.
 */
export function clearPreviewAssetRecord(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage may be unavailable — see the module note.
  }
}

/**
 * App-start sweep: best-effort delete of whatever an abandoned preview
 * uploaded and never resolved (Keep and Revert both clear the record, so
 * anything left over belongs to a preview that died mid-flight).
 *
 * The record is cleared BEFORE the deletes fire — one attempt per id, and a
 * failed delete leaves an inert orphan exactly like the revert flow. This
 * also guarantees a later sweep can never race a preview that is still
 * resolving: anything recorded after this point is a NEW preview's to clean.
 */
export async function sweepAbandonedPreviewAssets(): Promise<void> {
  const { cursors, sounds } = readRecord();
  if (cursors.length === 0 && sounds.length === 0) return;
  clearPreviewAssetRecord();
  for (const cursorId of cursors) {
    deleteCursor(cursorId).catch(() => {});
  }
  for (const soundId of sounds) {
    deleteSound(soundId).catch(() => {});
  }
}
