/**
 * stickerUpload — the "Add Sticker..." desktop command.
 *
 * Extracted from Desktop.tsx's context-menu flow so its reliability contract
 * is testable (CORE-ROADMAP Workstream 1): the old flow called the raw
 * `apiUploadFile` and then patched the returned item through `updateItem`,
 * which no-oped because the raw upload never added the item to the store —
 * so a refused upload or apply was silent and the sticker never appeared.
 *
 * Both steps now go through the desktop store's own queued actions, matching
 * how the settings wallpaper path was fixed (upload, then apply through an
 * action that rolls the profile back on refusal):
 *
 *   1. `uploadFile` — adds the item only on the server's confirmation,
 *      tracks progress, and surfaces "Upload Failed" on refusal.
 *   2. `updateItem` — applies the sticker type + config optimistically and
 *      rolls both fields back to the acknowledged snapshot (a plain image)
 *      when the server refuses, surfacing "Sync Failed".
 *
 * So a refused upload leaves no item behind, and a refused apply can never
 * leave the sticker looking applied.
 */

import { useDesktopStore } from '../../stores/desktopStore';

const DEFAULT_STICKER_CONFIG = { width: 120, height: 120, rotation: 0, opacity: 1 };

/**
 * Upload an image file and turn it into a freely placed sticker at the
 * given pixel position. Returns whether the sticker was applied; each step
 * surfaces its own failure to the user, so a `false` result has already
 * been reported.
 */
export async function createStickerFromFile(
  file: File,
  position: { x: number; y: number }
): Promise<boolean> {
  const { uploadFile, updateItem } = useDesktopStore.getState();

  // The upload itself: refused → null, "Upload Failed" already surfaced,
  // and no item was added.
  const item = await uploadFile(file, null, position);
  if (!item) return false;

  // The apply: patch the uploaded image into a sticker. Refused → false,
  // "Sync Failed" already surfaced, and the item rolled back to the plain
  // image the server acknowledged — nothing looks sticker-applied.
  return updateItem(item.id, {
    type: 'sticker',
    stickerConfig: { ...DEFAULT_STICKER_CONFIG },
  });
}
