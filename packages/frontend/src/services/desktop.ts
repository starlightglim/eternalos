/**
 * Desktop domain client — desktop snapshot, item CRUD, trash, server window
 * state, file upload, and storage quota.
 */

import type { DesktopItem, UserProfile } from '../types';
import { API_URL, apiRequest, getAuthToken } from './transport';

// ============ Window State ============

/** Window state as saved/loaded from the server */
export interface SavedWindowState {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  collapsed?: boolean;
  contentType: string;
  contentId?: string;
}

// ============ Desktop API ============

export interface DesktopResponse {
  items: DesktopItem[];
  profile: UserProfile | null;
  windows?: SavedWindowState[];
}

export async function fetchDesktop(): Promise<DesktopResponse> {
  return apiRequest<DesktopResponse>('/api/desktop');
}

export async function createItem(item: Partial<DesktopItem>): Promise<DesktopItem> {
  return apiRequest<DesktopItem>('/api/desktop/items', {
    method: 'POST',
    body: JSON.stringify(item),
  });
}

export async function updateItems(
  patches: Array<{ id: string; updates: Partial<DesktopItem> }>
): Promise<DesktopItem[]> {
  return apiRequest<DesktopItem[]>('/api/desktop/items', {
    method: 'PATCH',
    body: JSON.stringify(patches),
  });
}

export async function deleteItem(id: string): Promise<{ deleted: boolean }> {
  return apiRequest<{ deleted: boolean }>(`/api/desktop/items/${id}`, {
    method: 'DELETE',
  });
}

export async function analyzeImageItem(itemId: string): Promise<{ success: boolean; itemId: string; status: string }> {
  return apiRequest<{ success: boolean; itemId: string; status: string }>(`/api/desktop/items/${itemId}/analyze`, {
    method: 'POST',
  });
}

export async function emptyTrashApi(): Promise<{ deleted: number; r2Keys: string[] }> {
  return apiRequest<{ deleted: number; r2Keys: string[] }>('/api/trash', {
    method: 'DELETE',
  });
}

// ============ Window State API ============

export async function saveWindowsToServer(
  windows: SavedWindowState[],
  options: { keepalive?: boolean } = {},
): Promise<void> {
  await apiRequest('/api/desktop/windows', {
    method: 'PUT',
    body: JSON.stringify(windows),
    // keepalive lets a save sent from `pagehide` finish after the page is gone.
    ...(options.keepalive ? { keepalive: true } : {}),
  });
}

// ============ Upload API ============

export interface UploadResponse {
  item: DesktopItem;
}

export async function uploadFile(
  file: File,
  parentId: string | null,
  position: { x: number; y: number },
  onProgress?: (progress: number) => void
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('parentId', parentId || '');
  formData.append('position', JSON.stringify(position));

  // Use XMLHttpRequest for progress tracking with 60s timeout
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = 60000; // 60 second timeout

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress(progress);
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const response = JSON.parse(xhr.responseText);
          resolve(response);
        } catch {
          reject(new Error('Invalid response from server'));
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText);
          reject(new Error(error.error || `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });

    xhr.addEventListener('timeout', () => {
      reject(new Error('Upload timed out. Please try again.'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload cancelled'));
    });

    xhr.open('POST', `${API_URL}/api/upload`);

    const authToken = getAuthToken();
    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }

    xhr.send(formData);
  });
}

// ============ Quota API ============

export interface QuotaInfo {
  used: number;      // Bytes used
  limit: number;     // Quota limit in bytes
  remaining: number; // Bytes remaining
  itemCount: number; // Number of items with files
}

export async function fetchQuota(): Promise<QuotaInfo> {
  return apiRequest<QuotaInfo>('/api/quota');
}
