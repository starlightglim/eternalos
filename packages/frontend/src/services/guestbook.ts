/**
 * Guestbook domain client — posting to a public desktop's guestbook widget
 * (no auth required, rate limited server-side).
 */

import { API_URL } from './transport';

// ============ Guestbook API ============

export interface GuestbookEntryInput {
  name: string;
  message: string;
}

export interface GuestbookEntry {
  name: string;
  message: string;
  timestamp: number;
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
  const response = await fetch(`${API_URL}/api/guestbook/${encodeURIComponent(ownerUid)}/${encodeURIComponent(itemId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(entry),
  });

  if (!response.ok) {
    if (response.status === 429) {
      const error = await response.json().catch(() => ({ error: 'Rate limit exceeded' }));
      return { success: false, error: error.error || 'You can only sign once per hour. Please try again later.' };
    }
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    return { success: false, error: error.error || `HTTP ${response.status}` };
  }

  return response.json();
}
