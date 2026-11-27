/**
 * Guestbook domain client — posting to a public desktop's guestbook widget
 * (no auth required, rate limited server-side).
 */

import type { GuestbookEntry } from '../types';
import { ApiError, apiRequest } from './transport';

// The one definition lives in @eternalos/contracts; re-exported for `./api`.
export type { GuestbookEntry };

// ============ Guestbook API ============

export interface GuestbookEntryInput {
  name: string;
  message: string;
}

export interface GuestbookPostResponse {
  success: boolean;
  error?: string;
  entries?: GuestbookEntry[];
}

/**
 * Post a guestbook entry (no auth required, rate limited)
 * @param ownerUid - The UID of the desktop owner
 * @param itemId - The widget item ID
 * @param entry - The entry to post
 */
export async function postGuestbookEntry(
  ownerUid: string,
  itemId: string,
  entry: GuestbookEntryInput
): Promise<GuestbookPostResponse> {
  try {
    return await apiRequest<GuestbookPostResponse>(
      `/api/guestbook/${encodeURIComponent(ownerUid)}/${encodeURIComponent(itemId)}`,
      { method: 'POST', body: JSON.stringify(entry) },
    );
  } catch (err) {
    if (err instanceof ApiError) {
      // A 429 from a layer that sends no JSON error still gets a readable hint.
      const generic = !err.detail || err.detail === 'Request failed' || err.detail === 'Too Many Requests';
      if (err.status === 429 && generic) {
        return { success: false, error: 'You can only sign once per hour. Please try again later.' };
      }
      return { success: false, error: err.detail };
    }
    throw err;
  }
}
