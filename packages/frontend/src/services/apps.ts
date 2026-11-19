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

// --- Source revisions -------------------------------------------------------

export type AppRevisionKind = 'deploy' | 'restore' | 'rollback' | 'backfill';
export type AppRevisionAuthor = 'human' | 'agent';

export interface AppRevisionSummary {
  id: string;
  createdAt: number;
  author: AppRevisionAuthor;
  valid: boolean;
  kind: AppRevisionKind;
  summary: string;
  /** Release version this revision deployed (valid deploys/restores). */
  appVersion?: number;
  /** Revision a restore took its content from (kind 'restore'), or the
   *  revision the app rolled back FROM (kind 'rollback'). */
  parentRevision?: string;
  name?: string;
}

export interface AppRevisionIssue {
  code: string;
  message: string;
  file?: string;
  evidence?: string;
  hint?: string;
}

export interface AppRevisionDetail {
  id: string;
  createdAt: number;
  author: AppRevisionAuthor;
  valid: boolean;
  kind: AppRevisionKind;
  summary: string;
  appVersion?: number;
  parentRevision?: string;
  name?: string;
  description?: string;
  permissions?: Record<string, unknown>;
  rationale?: string;
  windowConfig?: { defaultWidth: number; defaultHeight: number; resizable?: boolean };
  diagnostics: { valid: boolean; issues: AppRevisionIssue[] };
}

export interface AppRevisionsResponse {
  appId: string;
  currentRevision: string | null;
  lastValidRevision: string | null;
  revisions: AppRevisionSummary[];
}

export interface AppRevisionFilesResponse {
  appId: string;
  revision: AppRevisionDetail;
  files: Record<string, string>;
}

export interface AppRevisionRestoreResponse {
  success: boolean;
  appId: string;
  /** Release version the restore deployed. */
  version: number;
  /** The NEW revision the restore created. */
  revisionId: string;
  restoredFrom: string;
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

export async function listAppRevisions(appId: string): Promise<AppRevisionsResponse> {
  return apiRequest<AppRevisionsResponse>(`/api/apps/${encodeURIComponent(appId)}/revisions`);
}

export async function getAppRevisionFiles(
  appId: string,
  revisionId: string,
): Promise<AppRevisionFilesResponse> {
  return apiRequest<AppRevisionFilesResponse>(
    `/api/apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(revisionId)}`
  );
}

export async function restoreAppRevision(
  appId: string,
  revisionId: string,
): Promise<AppRevisionRestoreResponse> {
  return apiRequest<AppRevisionRestoreResponse>(
    `/api/apps/${encodeURIComponent(appId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
    { method: 'POST' },
  );
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
