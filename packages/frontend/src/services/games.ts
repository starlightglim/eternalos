/**
 * Game Console domain client — player capability tokens and cartridge drafts.
 */

import type { Cartridge, CartridgeDraftSummary } from '../types';
import { apiRequest } from './transport';

// ============ Game Console API ============

export interface GameCapabilityResponse {
  capability: string;
  expiresAt: number; // unix seconds
}

/** Mint a short-lived player capability token for a game's save bridge. */
export async function mintGameCapability(gameId: string): Promise<GameCapabilityResponse> {
  return apiRequest<GameCapabilityResponse>(`/api/games/${encodeURIComponent(gameId)}/capability`, {
    method: 'POST',
  });
}

export async function listCartridgeDrafts(): Promise<CartridgeDraftSummary[]> {
  const response = await apiRequest<{ drafts: CartridgeDraftSummary[] }>('/api/games/drafts');
  return response.drafts;
}

export async function getCartridgeDraft(cartId: string): Promise<{ cartId: string; updatedAt: number; cartridge: Cartridge; publishedPackId: string | null }> {
  return apiRequest(`/api/games/drafts/${encodeURIComponent(cartId)}`);
}

export async function saveCartridgeDraft(cartId: string, cartridge: Cartridge): Promise<{ cartId: string; updatedAt: number }> {
  return apiRequest(`/api/games/drafts/${encodeURIComponent(cartId)}`, {
    method: 'PUT',
    body: JSON.stringify({ cartridge }),
  });
}

export async function deleteCartridgeDraft(cartId: string): Promise<{ deleted: boolean }> {
  return apiRequest(`/api/games/drafts/${encodeURIComponent(cartId)}`, {
    method: 'DELETE',
  });
}
