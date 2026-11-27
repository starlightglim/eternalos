/**
 * Appearance domain client — profile/appearance updates, custom-CSS history,
 * and wallpaper upload + URL.
 */

import type { UserProfile } from '../types';
import { API_URL, apiRequest, getAuthToken } from './transport';

// ============ Wallpaper Upload API ============

export interface WallpaperUploadResponse {
  success: boolean;
  wallpaper: string;
  r2Key: string;
  profile: UserProfile;
}

export async function uploadWallpaper(
  file: File,
  onProgress?: (progress: number) => void
): Promise<WallpaperUploadResponse> {
  const formData = new FormData();
  formData.append('file', file);

  // Use XMLHttpRequest for progress tracking
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
          reject(new Error(`Wallpaper upload failed: HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during wallpaper upload'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Wallpaper upload cancelled'));
    });

    xhr.open('POST', `${API_URL}/api/wallpaper`);

    const authToken = getAuthToken();
    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }

    xhr.send(formData);
  });
}

/**
 * Get the URL for a custom wallpaper stored in R2.
 * @param wallpaperValue - The wallpaper value (e.g., "custom:uid/wallpaper/id/filename")
 */
export function getWallpaperUrl(wallpaperValue: string): string {
  // Custom wallpapers are prefixed with "custom:"
  if (wallpaperValue.startsWith('custom:')) {
    const r2Key = wallpaperValue.slice('custom:'.length);
    // Encode each path segment to handle special characters
    const encodedKey = r2Key.split('/').map(encodeURIComponent).join('/');
    return `${API_URL}/api/wallpaper/${encodedKey}`;
  }
  return '';
}

// ============ Profile API ============

export interface ProfileUpdateRequest {
  displayName?: string;
  wallpaper?: string;
  wallpaperMode?: 'cover' | 'tile' | 'center';
  // Onboarding flag
  isNewUser?: boolean;
  // Custom appearance settings
  accentColor?: string;
  desktopColor?: string;
  windowBgColor?: string;
  titleBarBgColor?: string;
  titleBarTextColor?: string;
  windowBorderColor?: string;
  buttonBgColor?: string;
  buttonTextColor?: string;
  buttonBorderColor?: string;
  labelColor?: string;
  // Typography
  systemFont?: string;
  bodyFont?: string;
  monoFont?: string;
  fontSmoothing?: boolean;
  windowBorderRadius?: number;
  controlBorderRadius?: number;
  windowShadow?: number;
  windowOpacity?: number;
  // Extended design tokens
  designTokens?: Record<string, string | number | boolean>;
  // Custom CSS (Layer 4 customization)
  customCSS?: string;
  // Watermark setting
  hideWatermark?: boolean;
  // Profile fields
  bio?: string;
  profileLinks?: { title: string; url: string }[];
  shareDescription?: string;
  // Analytics
  analyticsEnabled?: boolean;
  // Sound customization
  soundPack?: { name: string; sounds: Partial<Record<string, string>> };
}

export interface ProfileUpdateResponse {
  success: boolean;
  profile: {
    displayName?: string;
    wallpaper?: string;
    accentColor?: string;
    desktopColor?: string;
    windowBgColor?: string;
    titleBarBgColor?: string;
    titleBarTextColor?: string;
    windowBorderColor?: string;
    buttonBgColor?: string;
    buttonTextColor?: string;
    buttonBorderColor?: string;
    labelColor?: string;
    systemFont?: string;
    bodyFont?: string;
    monoFont?: string;
    fontSmoothing?: boolean;
    windowBorderRadius?: number;
    controlBorderRadius?: number;
    windowShadow?: number;
    windowOpacity?: number;
    designTokens?: Record<string, string | number | boolean>;
    customCSS?: string;
    hideWatermark?: boolean;
  };
}

export async function updateProfile(updates: ProfileUpdateRequest): Promise<ProfileUpdateResponse> {
  return apiRequest<ProfileUpdateResponse>('/api/profile', {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

// ============ CSS History API ============

import type { CustomCSSVersion } from '@eternalos/contracts';

export type { CustomCSSVersion };

export async function listCSSVersions(): Promise<CustomCSSVersion[]> {
  const response = await apiRequest<{ versions: CustomCSSVersion[] }>('/api/css-history');
  return response.versions;
}

export async function revertCSSVersion(versionId: string): Promise<{
  success: boolean;
  profile?: ProfileUpdateResponse['profile'];
  versions?: CustomCSSVersion[];
}> {
  return apiRequest(`/api/css-history/${versionId}/revert`, {
    method: 'POST',
  });
}
