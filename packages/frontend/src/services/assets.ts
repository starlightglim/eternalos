/**
 * Customization asset clients — CSS assets, sound packs, cursors, and custom
 * item icons (upload / list / delete / URL helpers).
 */

import type { DesktopItem } from '../types';
import { API_URL, apiRequest, getAuthToken } from './transport';

// ============ CSS Asset API ============

export interface CSSAsset {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  url: string;
}

export async function uploadCSSAsset(
  file: File,
  onProgress?: (progress: number) => void
): Promise<{ success: boolean; asset: CSSAsset }> {
  const formData = new FormData();
  formData.append('file', file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          reject(new Error(error.error || `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`CSS asset upload failed: HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during CSS asset upload')));
    xhr.addEventListener('abort', () => reject(new Error('CSS asset upload cancelled')));

    xhr.open('POST', `${API_URL}/api/css-assets`);
    const authToken = getAuthToken();
    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }
    xhr.send(formData);
  });
}

export async function listCSSAssets(): Promise<CSSAsset[]> {
  const response = await apiRequest<{ assets: CSSAsset[] }>('/api/css-assets');
  return response.assets;
}

export async function deleteCSSAsset(assetId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/css-assets/${assetId}`, {
    method: 'DELETE',
  });
}

export function getCSSAssetUrl(urlPath: string): string {
  return `${API_URL}${urlPath}`;
}

// ============ Sound Asset API ============

export interface SoundAsset {
  soundId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  soundType?: string;
  url: string;
}

export async function uploadSound(
  file: File,
  soundType?: string,
  onProgress?: (progress: number) => void
): Promise<{ success: boolean; asset: SoundAsset }> {
  const formData = new FormData();
  formData.append('file', file);
  if (soundType) {
    formData.append('soundType', soundType);
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          reject(new Error(error.error || `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Sound upload failed: HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during sound upload')));
    xhr.addEventListener('abort', () => reject(new Error('Sound upload cancelled')));

    xhr.open('POST', `${API_URL}/api/sounds`);
    const authToken = getAuthToken();
    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }
    xhr.send(formData);
  });
}

export async function listSounds(): Promise<SoundAsset[]> {
  const response = await apiRequest<{ assets: SoundAsset[] }>('/api/sounds');
  return response.assets;
}

export async function deleteSound(soundId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/sounds/${soundId}`, {
    method: 'DELETE',
  });
}

export function getSoundUrl(urlPath: string): string {
  return `${API_URL}${urlPath}`;
}

// ============ Cursor Asset API ============

export interface CursorAsset {
  cursorId: string;
  filename: string;
  mimeType: string;
  size: number;
  uploadedAt: number;
  cursorState?: string;
  hotspotX?: number;
  hotspotY?: number;
  url: string;
}

export async function uploadCursor(
  file: File,
  cursorState?: string,
  hotspotX?: number,
  hotspotY?: number,
  onProgress?: (progress: number) => void
): Promise<{ success: boolean; asset: CursorAsset }> {
  const formData = new FormData();
  formData.append('file', file);
  if (cursorState) {
    formData.append('cursorState', cursorState);
  }
  if (hotspotX !== undefined) {
    formData.append('hotspotX', String(hotspotX));
  }
  if (hotspotY !== undefined) {
    formData.append('hotspotY', String(hotspotY));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          reject(new Error(error.error || `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Cursor upload failed: HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error during cursor upload')));
    xhr.addEventListener('abort', () => reject(new Error('Cursor upload cancelled')));

    xhr.open('POST', `${API_URL}/api/cursors`);
    const authToken = getAuthToken();
    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }
    xhr.send(formData);
  });
}

export async function listCursors(): Promise<CursorAsset[]> {
  const response = await apiRequest<{ assets: CursorAsset[] }>('/api/cursors');
  return response.assets;
}

export async function deleteCursor(cursorId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/cursors/${cursorId}`, {
    method: 'DELETE',
  });
}

export function getCursorUrl(urlPath: string): string {
  return `${API_URL}${urlPath}`;
}

// ============ Custom Icon API ============

export interface IconUploadResponse {
  success: boolean;
  customIcon: string;  // The value to store in item.customIcon (e.g., "upload:uid/icons/itemId.png")
  r2Key: string;
  item: DesktopItem;
}

/**
 * Upload a custom icon for a desktop item
 * @param file - PNG file (max 50KB, 32x32 or 64x64 recommended)
 * @param itemId - The desktop item ID to associate the icon with
 */
export async function uploadCustomIcon(
  file: File,
  itemId: string
): Promise<IconUploadResponse> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('itemId', itemId);

  const authToken = getAuthToken();
  const response = await fetch(`${API_URL}/api/icon`, {
    method: 'POST',
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {},
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Get the URL for a custom icon stored in R2.
 * @param customIconValue - The customIcon value (e.g., "upload:uid/icons/itemId.png")
 */
export function getCustomIconUrl(customIconValue: string): string {
  // Uploaded icons are prefixed with "upload:"
  if (customIconValue.startsWith('upload:')) {
    const r2Key = customIconValue.slice('upload:'.length);
    // Extract uid and itemId from the r2Key: uid/icons/itemId.png
    const parts = r2Key.split('/');
    if (parts.length >= 3) {
      const uid = parts[0];
      const itemId = parts[2].replace('.png', '');
      return `${API_URL}/api/icon/${encodeURIComponent(uid)}/${encodeURIComponent(itemId)}/icon.png`;
    }
  }
  return '';
}
