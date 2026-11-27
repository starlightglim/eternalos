/**
 * Bazaar domain client — browse / install / publish / delete packs.
 */

import type { Cartridge } from '../types';
import { ApiError, apiRequest, publicGet } from './transport';

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

export interface BazaarBrowseResult {
  packs: BazaarPack[];
  total: number;
  page: number;
  pageSize: number;
  /** Opaque cursor for the next page (newer backends only). */
  nextCursor?: string;
}

type BazaarResult<T> = { success: boolean; error?: string } & Partial<T>;

/** Turn a thrown request error into the `{ success: false, error }` shape. */
function failure(err: unknown, fallback: string): { success: false; error: string } {
  if (err instanceof ApiError) return { success: false, error: err.detail || fallback };
  if (err instanceof Error && err.name === 'AbortError') throw err;
  return { success: false, error: err instanceof Error && err.message ? err.message : fallback };
}

/**
 * Browse packs in the Bazaar. Works with page-based backends and with
 * cursor-paginated ones (`limit`/`cursor` in, `nextCursor` out; `page` still
 * honoured). Throws on a failed request.
 */
export async function bazaarBrowse(options?: {
  type?: string; q?: string; page?: number; limit?: number; cursor?: string; signal?: AbortSignal;
}): Promise<BazaarBrowseResult> {
  const params = new URLSearchParams();
  if (options?.type) params.set('type', options.type);
  if (options?.q) params.set('q', options.q);
  if (options?.page) params.set('page', String(options.page));
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.cursor) params.set('cursor', options.cursor);

  const data = await publicGet<Partial<BazaarBrowseResult>>(`/api/bazaar/browse?${params}`, {
    signal: options?.signal,
  });
  const pageSize = Number(data.pageSize) > 0 ? Number(data.pageSize) : options?.limit || 20;
  return {
    packs: Array.isArray(data.packs) ? data.packs : [],
    total: Number(data.total) || 0,
    page: Number(data.page) || options?.page || 1,
    pageSize,
    ...(typeof data.nextCursor === 'string' && data.nextCursor ? { nextCursor: data.nextCursor } : {}),
  };
}

/** Get a single pack. Throws on a failed request. */
export async function bazaarGetPack(packId: string): Promise<{ pack: BazaarPack }> {
  return publicGet<{ pack: BazaarPack }>(`/api/bazaar/pack/${encodeURIComponent(packId)}`);
}

/** Install a pack (returns the config to apply) */
export async function bazaarInstall(packId: string): Promise<BazaarResult<{ config: Record<string, string | number | boolean>; pack: BazaarPack }>> {
  try {
    return await apiRequest(`/api/bazaar/install/${encodeURIComponent(packId)}`, { method: 'POST' });
  } catch (err) {
    return failure(err, 'Install failed');
  }
}

/** Publish a pack to the Bazaar */
export async function bazaarPublish(
  manifest: { type: string; name: string; description: string; tags: string[]; config: Record<string, string | number | boolean> },
  preview: File,
  assets: Record<string, File>,
): Promise<BazaarResult<{ pack: BazaarPack }>> {
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('preview', preview);
  for (const [key, file] of Object.entries(assets)) {
    formData.append(`asset_${key}`, file);
  }

  try {
    return await apiRequest('/api/bazaar/publish', { method: 'POST', body: formData });
  } catch (err) {
    return failure(err, 'Publish failed');
  }
}

/** Publish (or republish with packId) a game cartridge to the Bazaar */
export async function bazaarPublishGame(
  cartridge: Cartridge,
  cover: Blob | null,
  packId?: string,
  draftId?: string,
): Promise<BazaarResult<{ pack: BazaarPack }>> {
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

  try {
    return await apiRequest('/api/bazaar/publish-game', { method: 'POST', body: formData });
  } catch (err) {
    return failure(err, 'Publish failed');
  }
}

/** Delete a pack you published */
export async function bazaarDelete(packId: string): Promise<{ success: boolean; error?: string }> {
  try {
    return await apiRequest(`/api/bazaar/pack/${encodeURIComponent(packId)}`, { method: 'DELETE' });
  } catch (err) {
    return failure(err, 'Delete failed');
  }
}

/** List your own published packs. Throws on a failed request. */
export async function bazaarMyPacks(): Promise<{ packs: BazaarPack[] }> {
  const data = await apiRequest<{ packs?: BazaarPack[] }>('/api/bazaar/my-packs');
  return { packs: Array.isArray(data.packs) ? data.packs : [] };
}
