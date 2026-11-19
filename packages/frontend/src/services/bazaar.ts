/**
 * Bazaar domain client — browse / install / publish / delete packs.
 */

import type { Cartridge } from '../types';
import { API_URL, getAuthToken } from './transport';

// ---------------------------------------------------------------------------
// Bazaar API
// ---------------------------------------------------------------------------

export interface BazaarPack {
  packId: string;
  type: 'cursor' | 'icon' | 'sound' | 'effect' | 'skin' | 'game';
  name: string;
  description: string;
  authorUid: string;
  authorUsername: string;
  version: string;
  previewUrl: string;
  createdAt: number;
  updatedAt: number;
  installs: number;
  tags: string[];
  assets: Record<string, string>;
  config: Record<string, string | number | boolean>;
}

/** Browse packs in the Bazaar */
export async function bazaarBrowse(options?: {
  type?: string; q?: string; page?: number;
}): Promise<{ packs: BazaarPack[]; total: number; page: number; pageSize: number }> {
  const params = new URLSearchParams();
  if (options?.type) params.set('type', options.type);
  if (options?.q) params.set('q', options.q);
  if (options?.page) params.set('page', String(options.page));

  const response = await fetch(`${API_URL}/api/bazaar/browse?${params}`);
  return response.json();
}

/** Get a single pack */
export async function bazaarGetPack(packId: string): Promise<{ pack: BazaarPack }> {
  const response = await fetch(`${API_URL}/api/bazaar/pack/${packId}`);
  return response.json();
}

/** Install a pack (returns the config to apply) */
export async function bazaarInstall(packId: string): Promise<{ success: boolean; config: Record<string, string | number | boolean>; pack: BazaarPack; error?: string }> {
  const authToken = getAuthToken();
  const response = await fetch(`${API_URL}/api/bazaar/install/${packId}`, {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  return response.json();
}

/** Publish a pack to the Bazaar */
export async function bazaarPublish(
  manifest: { type: string; name: string; description: string; tags: string[]; config: Record<string, string | number | boolean> },
  preview: File,
  assets: Record<string, File>,
): Promise<{ success: boolean; pack?: BazaarPack; error?: string }> {
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('preview', preview);
  for (const [key, file] of Object.entries(assets)) {
    formData.append(`asset_${key}`, file);
  }

  const authToken = getAuthToken();
  const response = await fetch(`${API_URL}/api/bazaar/publish`, {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: formData,
  });
  return response.json();
}

/** Publish (or republish with packId) a game cartridge to the Bazaar */
export async function bazaarPublishGame(
  cartridge: Cartridge,
  cover: Blob | null,
  packId?: string,
  draftId?: string,
): Promise<{ success: boolean; pack?: BazaarPack; error?: string }> {
  const formData = new FormData();
  formData.append('cartridge', JSON.stringify(cartridge));
  if (cover) {
    formData.append('preview', new File([cover], 'cover.png', { type: 'image/png' }));
  }
  if (packId) {
    formData.append('packId', packId);
  }
  if (draftId) {
    formData.append('draftId', draftId);
  }

  const authToken = getAuthToken();
  const response = await fetch(`${API_URL}/api/bazaar/publish-game`, {
    method: 'POST',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: formData,
  });
  return response.json();
}

/** Delete a pack you published */
export async function bazaarDelete(packId: string): Promise<{ success: boolean; error?: string }> {
  const authToken = getAuthToken();
  const response = await fetch(`${API_URL}/api/bazaar/pack/${packId}`, {
    method: 'DELETE',
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  return response.json();
}

/** List your own published packs */
export async function bazaarMyPacks(): Promise<{ packs: BazaarPack[] }> {
  const authToken = getAuthToken();
  const response = await fetch(`${API_URL}/api/bazaar/my-packs`, {
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });
  return response.json();
}
