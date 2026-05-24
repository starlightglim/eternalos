/**
 * EternalService — the bridge exposed to user-created apps running in
 * Dynamic Workers.
 *
 * Apps never see the raw Durable Object or R2. The parent Worker instantiates
 * this class per-app via `ctx.exports.EternalService({ props: { uid, appId,
 * granted } })`, and the Dynamic Worker calls its methods through a service
 * binding (typically `env.ETERNAL`). `this.ctx.props` carries the grants,
 * so every request is policy-checked against the exact permissions the user
 * approved for this specific app.
 *
 * See design/12-orchestrator-v2.md for the architecture.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../index';
import type { DesktopItem, UserProfile } from '../types';
import type { AppGrantedPermissions } from '../utils/jwt';
import { buildItemPath, canReadItem, mimeMatches } from '../utils/fsPolicy';

/**
 * Per-instance context baked into the service binding at Dynamic Worker load
 * time. Serializable — `ctx.props` must round-trip as JSON.
 */
export interface EternalServiceProps {
  uid: string;
  appId: string;
  granted: AppGrantedPermissions;
}

/**
 * Shape returned to apps. Deliberately does NOT expose r2Key or any raw
 * authentication material — just the semantic fields apps want for rendering.
 */
export interface EternalItem {
  id: string;
  name: string;
  type: DesktopItem['type'];
  path: string;
  mimeType?: string;
  fileSize?: number;
  updatedAt: number;
  isPublic: boolean;
  caption?: string;
  tags?: string[];
  dominantColors?: string[];
  url?: string;         // for type='link' items
}

export interface ListOptions {
  path?: string;
  mimeType?: string;
  limit?: number;
  includeTrashed?: boolean;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;   // 50 MB per read

function toEternalItem(item: DesktopItem, path: string): EternalItem {
  const tags = Array.from(new Set([
    ...(item.userTags ?? []),
    ...(item.imageAnalysis?.tags ?? []),
  ]));
  return {
    id: item.id,
    name: item.name,
    type: item.type,
    path,
    mimeType: item.mimeType,
    fileSize: item.fileSize,
    updatedAt: item.updatedAt,
    isPublic: item.isPublic,
    caption: item.imageAnalysis?.caption,
    tags: tags.length > 0 ? tags : undefined,
    dominantColors: item.imageAnalysis?.dominantColors,
    url: item.type === 'link' ? item.url : undefined,
  };
}

function filterProfile(
  profile: UserProfile | null,
  allowed: Array<'username' | 'displayName' | 'bio' | 'avatar'> | undefined,
): Record<string, string | undefined> {
  if (!profile || !allowed || allowed.length === 0) return {};
  const out: Record<string, string | undefined> = {};
  if (allowed.includes('username')) out.username = profile.username;
  if (allowed.includes('displayName')) out.displayName = profile.displayName;
  if (allowed.includes('bio')) out.bio = profile.bio;
  // No dedicated avatar field today — expose wallpaper as a stable fallback
  // so apps can personalize without us lying about having an avatar.
  if (allowed.includes('avatar')) out.avatar = profile.wallpaper;
  return out;
}

export class EternalService extends WorkerEntrypoint<Env> {
  private get props(): EternalServiceProps {
    return (this.ctx as unknown as { props: EternalServiceProps }).props;
  }

  private getDesktopStub(): DurableObjectStub {
    const { uid } = this.props;
    const id = this.env.USER_DESKTOP.idFromName(uid);
    return this.env.USER_DESKTOP.get(id);
  }

  private async loadSnapshot(): Promise<{ items: DesktopItem[]; profile: UserProfile | null }> {
    const response = await this.getDesktopStub().fetch(new Request('http://internal/items'));
    if (!response.ok) {
      throw new Error(`Desktop snapshot failed (${response.status})`);
    }
    return response.json<{ items: DesktopItem[]; profile: UserProfile | null }>();
  }

  /**
   * List items the app is permitted to see. No permissions granted = empty
   * list (not an error), so hermetic apps can call this without checking
   * first.
   */
  async list(options: ListOptions = {}): Promise<EternalItem[]> {
    const { granted } = this.props;
    if (!granted.fs) return [];

    const includeTrashed = options.includeTrashed === true;
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, options.limit ?? DEFAULT_LIST_LIMIT));

    const snapshot = await this.loadSnapshot();
    const itemsMap = new Map(snapshot.items.map((item) => [item.id, item]));
    const results: EternalItem[] = [];

    for (const item of snapshot.items) {
      if (!includeTrashed && item.isTrashed) continue;
      if (item.type === 'app') continue;            // apps don't list themselves to apps

      const itemPath = buildItemPath(item.id, itemsMap);
      if (options.path && !itemPath.startsWith(options.path)) continue;
      if (options.mimeType && !mimeMatches(item.mimeType, [options.mimeType])) continue;
      if (!canReadItem(granted, itemPath, item.mimeType)) continue;

      results.push(toEternalItem(item, itemPath));
      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Read a single item by id. Returns a Response so large blobs stream.
   * Permission checked against the item's path and mime type.
   */
  async read(itemId: string): Promise<Response> {
    const { granted } = this.props;
    if (!itemId || itemId.includes('/') || itemId.includes('..') || itemId.length > 128) {
      return Response.json({ error: 'Invalid item id' }, { status: 400 });
    }

    const snapshot = await this.loadSnapshot();
    const itemsMap = new Map(snapshot.items.map((item) => [item.id, item]));
    const item = itemsMap.get(itemId);
    if (!item || item.isTrashed) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (item.type === 'folder') {
      return Response.json({ error: 'Use list for folders' }, { status: 400 });
    }

    const itemPath = buildItemPath(item.id, itemsMap);
    if (!canReadItem(granted, itemPath, item.mimeType)) {
      return Response.json({ error: 'Not permitted' }, { status: 403 });
    }

    if (item.type === 'text' && typeof item.textContent === 'string') {
      return new Response(item.textContent, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    if (item.type === 'link' && item.url) {
      return Response.json({ url: item.url, name: item.name });
    }

    if (!item.r2Key) {
      return Response.json({ error: 'No blob' }, { status: 404 });
    }

    if (typeof item.fileSize === 'number' && item.fileSize > MAX_BLOB_BYTES) {
      return Response.json({ error: 'Blob too large' }, { status: 413 });
    }

    const object = await this.env.ETERNALOS_FILES.get(item.r2Key);
    if (!object) {
      return Response.json({ error: 'Blob missing' }, { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType ?? item.mimeType ?? 'application/octet-stream');
    headers.set('Content-Length', String(object.size));
    headers.set('Cache-Control', 'private, max-age=0, no-cache');
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(item.name)}"`);
    return new Response(object.body, { headers });
  }

  /**
   * Read profile fields granted to this app. Returns an empty object if the
   * app has no profile permission — never throws for missing permission, so
   * the calling app can fall back gracefully.
   */
  async profile(): Promise<Record<string, string | undefined>> {
    const { granted } = this.props;
    const allowed = granted.profile?.read;
    if (!allowed || allowed.length === 0) return {};
    const snapshot = await this.loadSnapshot();
    return filterProfile(snapshot.profile, allowed);
  }

  /**
   * The appId this binding was minted for — useful for debugging / logs.
   * Not security-load-bearing: a compromised app already knows its own id.
   */
  async whoami(): Promise<{ appId: string; hostVersion: string }> {
    return { appId: this.props.appId, hostVersion: '1' };
  }
}
