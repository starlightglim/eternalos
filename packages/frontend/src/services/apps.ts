/**
 * Apps domain client — the Developer Studio surface: dev deploys, source
 * access, permissions, versions/rollback, capability tokens, and runtime
 * deletion.
 */

import { apiRequest } from './transport';
import type { AppGrantApproval } from '../types';

export interface AppCapabilityResponse {
  token: string;
  appId: string;
  uid: string;
  expiresAt: number;
  granted: Record<string, unknown>;
}

export interface AppPermissionResponse {
  appId: string;
  requested: Record<string, unknown>;
  granted: Record<string, unknown>;
  /** Scope ids that are broad within the declared set (warning rows in the
   *  install/approval dialog). Computed server-side — see worker
   *  utils/appScopes.ts. */
  broad?: string[];
  /** Per-scope approval metadata ("approved on …"). Absent approvedAt =
   *  legacy install, approved with the date unknown. */
  approvals?: Record<string, AppGrantApproval>;
  rationale?: string;
}

export interface AppSourceResponse {
  success: boolean;
  files: Record<string, string>;
}

export interface AppDeployResponse {
  success: boolean;
  appId: string;
  version: number;
  isUpdate: boolean;
}

export interface AppRelease {
  version: number;
  r2Prefix: string;
  name?: string;
  description?: string;
  createdAt?: number;
  permissions?: Record<string, unknown>;
  rationale?: string;
  current: boolean;
}

export interface AppVersionsResponse {
  appId: string;
  currentVersion: number;
  releases: AppRelease[];
}

/** Mint a short-lived capability for the authenticated owner app iframe. */
export async function mintAppCapability(appId: string): Promise<AppCapabilityResponse> {
  return apiRequest<AppCapabilityResponse>(`/api/apps/${encodeURIComponent(appId)}/capability`, {
    method: 'POST',
  });
}

export async function getAppSource(appId: string): Promise<AppSourceResponse> {
  return apiRequest<AppSourceResponse>(`/api/apps/${encodeURIComponent(appId)}/source`);
}

export async function deployApp(input: {
  appId?: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
}): Promise<AppDeployResponse> {
  return apiRequest<AppDeployResponse>('/api/apps/dev-deploy', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getAppPermissions(appId: string): Promise<AppPermissionResponse> {
  return apiRequest<AppPermissionResponse>(`/api/apps/${encodeURIComponent(appId)}/permissions`);
}

export async function updateAppPermissions(
  appId: string,
  granted: Record<string, unknown>,
  /** Broad scope ids the user explicitly ticked. The server rejects a grant
   *  request that includes a broad scope without its tick (400). */
  broadApprovals: string[] = [],
): Promise<AppPermissionResponse> {
  return apiRequest<AppPermissionResponse>(`/api/apps/${encodeURIComponent(appId)}/permissions`, {
    method: 'PATCH',
    body: JSON.stringify({ granted, broadApprovals }),
  });
}

export async function listAppVersions(appId: string): Promise<AppVersionsResponse> {
  return apiRequest<AppVersionsResponse>(`/api/apps/${encodeURIComponent(appId)}/versions`);
}

export async function rollbackApp(appId: string, version: number): Promise<{ appId: string; version: number }> {
  return apiRequest<{ appId: string; version: number }>(`/api/apps/${encodeURIComponent(appId)}/rollback`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  });
}

export async function deleteAppRuntime(appId: string): Promise<{ success: boolean; deletedDesktopItem: boolean }> {
  return apiRequest<{ success: boolean; deletedDesktopItem: boolean }>(`/api/apps/${encodeURIComponent(appId)}`, {
    method: 'DELETE',
  });
}
