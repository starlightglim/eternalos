/**
 * EternalOS API Client
 *
 * Communicates with Cloudflare Workers backend.
 * Falls back to mock mode when VITE_API_URL is not configured.
 */

import type { DesktopItem, UserProfile } from '../types';

const API_URL = import.meta.env.VITE_API_URL || '';

// Check if API is configured
export const isApiConfigured = !!API_URL;

// Store JWT in memory
let authToken: string | null = null;
let refreshToken: string | null = null;
let refreshRequest: Promise<boolean> | null = null;

/**
 * Set the auth token for API requests
 */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/**
 * Get the current auth token
 */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * Set the refresh token for session rotation.
 */
export function setRefreshToken(token: string | null): void {
  refreshToken = token;
}

/**
 * Get the current refresh token.
 */
export function getRefreshToken(): string | null {
  return refreshToken;
}

// Callback for handling session expiry — set by authStore during init
let onSessionExpired: (() => void) | null = null;

export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

interface RefreshResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
}

async function refreshSession(): Promise<boolean> {
  if (!refreshToken) {
    return false;
  }

  if (refreshRequest) {
    return refreshRequest;
  }

  refreshRequest = (async () => {
    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        return false;
      }

      const data = await response.json() as RefreshResponse;
      authToken = data.token;
      refreshToken = data.refreshToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshRequest = null;
    }
  })();

  return refreshRequest;
}

/**
 * Make an authenticated API request
 */
async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
  allowRetry = true
): Promise<T> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (authToken) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    if (response.status === 401 && authToken && allowRetry) {
      const refreshed = await refreshSession();
      if (refreshed) {
        return apiRequest<T>(path, options, false);
      }
    }

    // Handle expired/invalid token after refresh attempt
    if (response.status === 401 && authToken) {
      authToken = null;
      refreshToken = null;
      onSessionExpired?.();
      throw new Error('Session expired. Please log in again.');
    }

    const rawText = await response.text().catch(() => '');
    let errorMessage = '';

    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { error?: string };
        errorMessage = parsed.error || '';
      } catch {
        errorMessage = rawText.trim();
      }
    }

    if (!errorMessage) {
      errorMessage = response.statusText || 'Request failed';
    }

    throw new Error(`${response.status} ${errorMessage}`);
  }

  return response.json();
}

// ============ Auth API ============

export interface SignupResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    uid: string;
    username: string;
    email: string;
  };
}

export interface LoginResponse {
  token: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    uid: string;
    username: string;
    email: string;
  };
}

export async function signup(
  email: string,
  password: string,
  username: string
): Promise<SignupResponse> {
  return apiRequest<SignupResponse>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password, username }),
  });
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function logout(): Promise<void> {
  await apiRequest('/api/auth/logout', { method: 'POST' });
  setAuthToken(null);
  setRefreshToken(null);
  clearFileToken();
}

// ============ Password Reset API ============

export interface ForgotPasswordResponse {
  success: boolean;
  message: string;
  resetToken?: string; // Only in development
  resetUrl?: string; // Only in development
}

export async function forgotPassword(email: string): Promise<ForgotPasswordResponse> {
  return apiRequest<ForgotPasswordResponse>('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export interface ResetPasswordResponse {
  success: boolean;
  message: string;
}

export async function resetPassword(
  token: string,
  newPassword: string
): Promise<ResetPasswordResponse> {
  return apiRequest<ResetPasswordResponse>('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

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

export async function saveWindowsToServer(windows: SavedWindowState[]): Promise<void> {
  await apiRequest('/api/desktop/windows', {
    method: 'PUT',
    body: JSON.stringify(windows),
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

    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }

    xhr.send(formData);
  });
}

// ============ Visitor API ============

interface VisitorApiResponse {
  username: string;
  displayName: string;
  wallpaper?: string;
  wallpaperMode?: 'cover' | 'tile' | 'center';
  // Custom appearance settings
  accentColor?: string;
  desktopColor?: string;
  windowBgColor?: string;
  fontSmoothing?: boolean;
  customCSS?: string;
  hideWatermark?: boolean;
  // Profile fields
  bio?: string;
  profileLinks?: { title: string; url: string }[];
  shareDescription?: string;
  items: DesktopItem[];
  windows?: SavedWindowState[];
}

export interface VisitorResponse {
  items: DesktopItem[];
  profile: UserProfile;
  windows?: SavedWindowState[];
}

export async function fetchVisitorDesktop(username: string): Promise<VisitorResponse> {
  const response = await fetch(`${API_URL}/api/visit/${username}`);

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('User not found');
    }
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data: VisitorApiResponse = await response.json();

  // Transform API response to match expected format
  return {
    items: data.items,
    profile: {
      uid: '', // Not exposed to visitors
      username: data.username,
      displayName: data.displayName,
      wallpaper: data.wallpaper,
      wallpaperMode: data.wallpaperMode,
      accentColor: data.accentColor,
      desktopColor: data.desktopColor,
      windowBgColor: data.windowBgColor,
      fontSmoothing: data.fontSmoothing,
      customCSS: data.customCSS,
      hideWatermark: data.hideWatermark,
      bio: data.bio,
      profileLinks: data.profileLinks,
      shareDescription: data.shareDescription,
      createdAt: 0, // Not exposed to visitors
    },
    windows: data.windows,
  };
}

// ============ File URL ============

/**
 * Short-lived file token for media src URLs.
 * Replaces the old approach of putting the full JWT in query params, which
 * leaked credentials into server logs, browser history, and referrer headers.
 *
 * The token is cached and refreshed automatically every 4 minutes (token TTL is 5 min).
 */
let cachedFileToken: string | null = null;
let fileTokenExpiresAt = 0;
let fileTokenRequest: Promise<string | null> | null = null;

async function fetchFileToken(): Promise<string | null> {
  if (!authToken) return null;

  // Return cached token if still valid (with 60s buffer)
  if (cachedFileToken && Date.now() < fileTokenExpiresAt - 60_000) {
    return cachedFileToken;
  }

  // Deduplicate concurrent requests
  if (fileTokenRequest) return fileTokenRequest;

  fileTokenRequest = (async () => {
    try {
      const response = await fetch(`${API_URL}/api/file-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
      });
      if (!response.ok) return null;
      const data = await response.json() as { ft: string };
      cachedFileToken = data.ft;
      fileTokenExpiresAt = Date.now() + 5 * 60 * 1000; // 5 min TTL
      return cachedFileToken;
    } catch {
      return null;
    } finally {
      fileTokenRequest = null;
    }
  })();

  return fileTokenRequest;
}

/**
 * Get the current cached file token synchronously.
 * Returns null if no token is available yet — call ensureFileToken() first.
 */
export function getCachedFileToken(): string | null {
  if (cachedFileToken && Date.now() < fileTokenExpiresAt - 60_000) {
    return cachedFileToken;
  }
  return null;
}

/**
 * Ensure a file token is available. Call this before rendering media.
 * Returns the token (or null if not authenticated).
 */
export async function ensureFileToken(): Promise<string | null> {
  return fetchFileToken();
}

/**
 * Clear cached file token (called on logout).
 */
export function clearFileToken(): void {
  cachedFileToken = null;
  fileTokenExpiresAt = 0;
}

/**
 * Get the URL for a file stored in R2.
 * Uses a short-lived file token (not the full JWT) in the query param.
 * @param r2Key - The full R2 key path (e.g., "uid/itemId/filename")
 */
export function getFileUrl(r2Key: string): string {
  const ft = getCachedFileToken();
  const tokenParam = ft ? `?ft=${encodeURIComponent(ft)}` : '';
  // Encode each path segment to handle special characters in filenames
  const encodedKey = r2Key.split('/').map(encodeURIComponent).join('/');
  return `${API_URL}/api/files/${encodedKey}${tokenParam}`;
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

    if (authToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
    }

    xhr.send(formData);
  });
}

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
  fontSmoothing?: boolean;
  windowBorderRadius?: number;
  controlBorderRadius?: number;
  windowShadow?: number;
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
    fontSmoothing?: boolean;
    windowBorderRadius?: number;
    controlBorderRadius?: number;
    windowShadow?: number;
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

export interface CustomCSSVersion {
  id: string;
  css: string;
  createdAt: number;
  source: 'manual' | 'assistant' | 'revert';
  summary?: string;
}

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
// ============ Analytics API ============

export interface AnalyticsData {
  totalViews: number;
  dailyViews: { date: string; count: number }[];
}

export async function fetchAnalytics(): Promise<AnalyticsData> {
  return apiRequest<AnalyticsData>('/api/analytics');
}

// ============ Guestbook API ============

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
