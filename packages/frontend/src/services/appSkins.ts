/**
 * App skins client (worker routes/appSkins.ts). Skins are per app and
 * owner-only; the active one is handed to open windows by AppViewer.
 */

import { apiRequest } from './transport';
import type { AppSkin } from '../utils/appSkins';

export interface AppSkinEntry {
  id: string;
  name: string;
  createdAt: number;
  source: 'user' | 'assistant';
  summary: { name: string; author?: string; description?: string; parts: string[]; colors: string[]; images: number; sprites: boolean };
}

export interface AppSkinIndex {
  active: string | null;
  skins: AppSkinEntry[];
}

export interface AppSkinSaveResult {
  skinId: string;
  entry: AppSkinEntry;
  active: string | null;
  previousActive: string | null;
  textures?: number;
}

export interface SkinPartDescription {
  name: string;
  w: number;
  h: number;
  states: string[];
  frames?: number;
  label: string;
}

const base = (appId: string) => `/api/apps/${encodeURIComponent(appId)}/skins`;

export function listAppSkins(appId: string): Promise<AppSkinIndex> {
  return apiRequest<AppSkinIndex>(base(appId));
}

export function getActiveAppSkin(appId: string): Promise<{ skinId: string | null; skin: AppSkin | null }> {
  return apiRequest(`${base(appId)}/active`);
}

/** Visitors: the active skin of an app on a public desktop (404 for private apps). */
export function getPublicAppSkin(appId: string): Promise<{ skin: AppSkin | null }> {
  return apiRequest(`/api/apps/${encodeURIComponent(appId)}/public-skin`);
}

export function setActiveAppSkin(appId: string, skinId: string | null): Promise<{ active: string | null; previousActive: string | null }> {
  return apiRequest(`${base(appId)}/active`, { method: 'PUT', body: JSON.stringify({ skinId }) });
}

export function getAppSkin(appId: string, skinId: string): Promise<{ skinId: string; skin: AppSkin }> {
  return apiRequest(`${base(appId)}/${encodeURIComponent(skinId)}`);
}

export function installAppSkin(appId: string, skin: AppSkin, activate = true): Promise<AppSkinSaveResult> {
  return apiRequest(base(appId), { method: 'POST', body: JSON.stringify({ skin, activate }) });
}

export function replaceAppSkin(appId: string, skinId: string, skin: AppSkin): Promise<{ skinId: string; entry: AppSkinEntry }> {
  return apiRequest(`${base(appId)}/${encodeURIComponent(skinId)}`, { method: 'PUT', body: JSON.stringify({ skin }) });
}

export function deleteAppSkin(appId: string, skinId: string): Promise<AppSkinIndex> {
  return apiRequest(`${base(appId)}/${encodeURIComponent(skinId)}`, { method: 'DELETE' });
}

export function generateAppSkin(appId: string, prompt: string, parts?: SkinPartDescription[]): Promise<AppSkinSaveResult> {
  return apiRequest(`${base(appId)}/generate`, {
    method: 'POST',
    body: JSON.stringify({ prompt, parts: parts?.map(({ name, label, frames }) => ({ name, label, frames })) }),
  });
}
