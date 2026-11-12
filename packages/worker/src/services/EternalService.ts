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
import type { AppGrantedPermissions, GameCapabilityPayload } from '../utils/jwt';
import { verifyAppCapabilityToken, verifyGameCapabilityToken } from '../utils/jwt';
import { buildItemPath, canReadItem, mimeMatches, canWriteItem, canDeleteItem } from '../utils/fsPolicy';

/**
 * Per-instance context baked into the service binding at Dynamic Worker load
 * time. Serializable — `ctx.props` must round-trip as JSON.
 */
export interface EternalServiceProps {
  uid: string;
  appId: string;
  granted: AppGrantedPermissions;
  requiresCapability?: boolean;
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

function grantsCover(current: AppGrantedPermissions, token: AppGrantedPermissions): boolean {
  const covers = (currentValues: string[] | undefined, tokenValues: string[] | undefined) =>
    !tokenValues || tokenValues.every((value) => currentValues?.includes(value));

  if (token.fs && (!covers(current.fs?.read, token.fs.read)
    || !covers(current.fs?.write, token.fs.write)
    || !covers(current.fs?.delete, token.fs.delete)
    || !covers(current.fs?.mimeTypes, token.fs.mimeTypes)
    || !covers(current.fs?.readMimeTypes, token.fs.readMimeTypes)
    || !covers(current.fs?.writeMimeTypes, token.fs.writeMimeTypes)
    || !covers(current.fs?.deleteMimeTypes, token.fs.deleteMimeTypes))) return false;
  if (token.profile && !covers(current.profile?.read, token.profile.read)) return false;
  if (token.ipc && (!covers(current.ipc?.listen, token.ipc.listen) || !covers(current.ipc?.emit, token.ipc.emit))) return false;
  if (token.network && !covers(current.network?.outbound, token.network.outbound)) return false;
  if (token.handlers && (!covers(current.handlers?.mimeTypes, token.handlers.mimeTypes) || !covers(current.handlers?.extensions, token.handlers.extensions))) return false;
  if (token.virtualFolders && !covers(current.virtualFolders?.mountAt, token.virtualFolders.mountAt)) return false;
  if (token.ai && !covers(current.ai?.modes, token.ai.modes)) return false;
  return true;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_BLOB_BYTES = 50 * 1024 * 1024;   // 50 MB per read
const MAX_APP_STORAGE_KEYS = 200;
const MAX_APP_STORAGE_VALUE_BYTES = 1024 * 1024;
const MAX_NETWORK_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_NETWORK_BODY_BYTES = 1024 * 1024;

function validateStorageKey(key: string): void {
  if (!key || key.length > 256 || key.includes(':') || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error('Invalid storage key');
  }
}

function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0' || host === '169.254.169.254') return true;
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
    const [first, second] = octets;
    if (first === 10 || first === 127 || first === 192 && second === 168 || first === 172 && second >= 16 && second <= 31) return true;
  }
  return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
}

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

  async authorizeApp(capability: string | null): Promise<boolean> {
    if (!this.props.requiresCapability) return true;
    if (!capability || !this.env.JWT_SECRET) return false;

    const payload = await verifyAppCapabilityToken(capability, this.env.JWT_SECRET, {
      expectedAppId: this.props.appId,
      expectedUid: this.props.uid,
    });
    if (!payload) return false;

    const appMeta = await this.env.DESKTOP_KV.get<{ uid: string; granted?: AppGrantedPermissions }>(`app:${this.props.appId}`, 'json');
    return Boolean(appMeta && appMeta.uid === this.props.uid && grantsCover(appMeta.granted ?? {}, payload.granted ?? {}));
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

  /**
   * Write content to a file path. Will create any directories in the path if they do not exist.
   * Resolves paths relative to the desktop root.
   */
  async write(options: { path: string; content: string; mimeType?: string; type?: DesktopItem['type']; parentId?: string | null }): Promise<EternalItem> {
    const { granted } = this.props;
    if (!granted.fs) {
      throw new Error('Not permitted: fs access not granted');
    }

    const path = options.path;
    const mimeType = options.mimeType || 'text/plain';
    const type = options.type || 'text';

    if (!canWriteItem(granted, path, mimeType)) {
      throw new Error(`Not permitted: write access to ${path} denied`);
    }

    let parentId = options.parentId || null;
    let name = path.split('/').pop() || 'Untitled';

    if (path.startsWith('/') && !options.parentId) {
      const segments = path.split('/').filter(Boolean);
      if (segments.length > 1) {
        const parentPath = '/' + segments.slice(0, -1).join('/');
        name = segments[segments.length - 1];

        const snapshot = await this.loadSnapshot();
        const itemsMap = new Map(snapshot.items.map((item) => [item.id, item]));
        const parentFolder = snapshot.items.find(
          (item) => item.type === 'folder' && buildItemPath(item.id, itemsMap) === parentPath
        );

        if (parentFolder) {
          parentId = parentFolder.id;
        } else {
          // Parent folder not found. Recursively create directory chain.
          let currentParentId: string | null = null;
          let currentPath = '';
          for (const segment of segments.slice(0, -1)) {
            currentPath += '/' + segment;
            const existingFolder = snapshot.items.find(
              (item) => item.type === 'folder' && buildItemPath(item.id, itemsMap) === currentPath
            );
            if (existingFolder) {
              currentParentId = existingFolder.id;
            } else {
              const createFolderRes = await this.getDesktopStub().fetch(
                new Request('http://internal/items', {
                  method: 'POST',
                  body: JSON.stringify({
                    type: 'folder',
                    name: segment,
                    parentId: currentParentId,
                  }),
                })
              );
              if (!createFolderRes.ok) {
                throw new Error('Failed to create parent directory chain');
              }
              const newFolder = await createFolderRes.json<DesktopItem>();
              currentParentId = newFolder.id;
              snapshot.items.push(newFolder);
              itemsMap.set(newFolder.id, newFolder);
            }
          }
          parentId = currentParentId;
        }
      }
    }

    const response = await this.getDesktopStub().fetch(
      new Request('http://internal/items', {
        method: 'POST',
        body: JSON.stringify({
          type,
          name,
          parentId,
          textContent: options.content,
          mimeType,
        }),
      })
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to write file: ${err}`);
    }

    const newItem = await response.json<DesktopItem>();
    return toEternalItem(newItem, path);
  }

  /**
   * Update properties on an existing item (e.g. metadata or widget configuration).
   */
  async patch(itemId: string, updates: Partial<DesktopItem>): Promise<EternalItem> {
    const { granted } = this.props;
    if (!granted.fs) {
      throw new Error('Not permitted: fs access not granted');
    }

    const snapshot = await this.loadSnapshot();
    const itemsMap = new Map(snapshot.items.map((item) => [item.id, item]));
    const item = itemsMap.get(itemId);
    if (!item) {
      throw new Error('Item not found');
    }

    const itemPath = buildItemPath(item.id, itemsMap);
    if (!canWriteItem(granted, itemPath, item.mimeType)) {
      throw new Error(`Not permitted: write access to ${itemPath} denied`);
    }

    const response = await this.getDesktopStub().fetch(
      new Request('http://internal/items', {
        method: 'PATCH',
        body: JSON.stringify([{ id: itemId, updates }]),
      })
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to update item: ${err}`);
    }

    const updated = await response.json<DesktopItem[]>();
    if (updated.length === 0) {
      throw new Error('Failed to update item');
    }

    return toEternalItem(updated[0], buildItemPath(updated[0].id, itemsMap));
  }

  /**
   * Delete an existing item.
   */
  async delete(itemId: string): Promise<void> {
    const { granted } = this.props;
    if (!granted.fs) {
      throw new Error('Not permitted: fs access not granted');
    }

    const snapshot = await this.loadSnapshot();
    const itemsMap = new Map(snapshot.items.map((item) => [item.id, item]));
    const item = itemsMap.get(itemId);
    if (!item) {
      throw new Error('Item not found');
    }

    const itemPath = buildItemPath(item.id, itemsMap);
    if (!canDeleteItem(granted, itemPath, item.mimeType)) {
      throw new Error(`Not permitted: delete access to ${itemPath} denied`);
    }

    const response = await this.getDesktopStub().fetch(
      new Request(`http://internal/items/${itemId}`, {
        method: 'DELETE',
      })
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to delete item: ${err}`);
    }
  }

  /**
   * Read a value from private, sandboxed app KV storage.
   */
  async storageGet(key: string): Promise<unknown | null> {
    const { uid, appId } = this.props;
    validateStorageKey(key);
    const value = await this.env.DESKTOP_KV.get(`app-storage:${uid}:${appId}:${key}`);
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  /**
   * Write a value to private, sandboxed app KV storage.
   */
  async storageSet(key: string, value: unknown): Promise<void> {
    const { uid, appId } = this.props;
    validateStorageKey(key);
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new Error('Storage value must be JSON serializable');
    }
    if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > MAX_APP_STORAGE_VALUE_BYTES) {
      throw new Error('Value too large (max 1MB)');
    }
    const prefix = `app-storage:${uid}:${appId}:`;
    const existing = await this.env.DESKTOP_KV.list({ prefix, limit: MAX_APP_STORAGE_KEYS + 1 });
    if (!existing.keys.some((entry) => entry.name === `${prefix}${key}`) && existing.keys.length >= MAX_APP_STORAGE_KEYS) {
      throw new Error(`Storage key limit exceeded (max ${MAX_APP_STORAGE_KEYS})`);
    }
    await this.env.DESKTOP_KV.put(`${prefix}${key}`, serialized);
  }

  /**
   * Delete a key from private, sandboxed app KV storage.
   */
  async storageDelete(key: string): Promise<void> {
    const { uid, appId } = this.props;
    validateStorageKey(key);
    await this.env.DESKTOP_KV.delete(`app-storage:${uid}:${appId}:${key}`);
  }

  /**
   * List all stored keys for this app instance.
   */
  async storageList(): Promise<string[]> {
    const { uid, appId } = this.props;
    const prefix = `app-storage:${uid}:${appId}:`;
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const listResult = await this.env.DESKTOP_KV.list({ prefix, cursor });
      keys.push(...listResult.keys.map((key) => key.name.slice(prefix.length)));
      cursor = listResult.list_complete ? undefined : listResult.cursor;
    } while (cursor);
    return keys;
  }

  // -------------------------------------------------------------------------
  // Fantasy-console game bridge. Unlike app storage (scoped to the app
  // *owner*), game saves are scoped to the *player* whose identity arrives
  // in a short-lived game capability token — so progress persists per player
  // even on games authored by someone else.
  // -------------------------------------------------------------------------

  private static readonly MAX_GAME_SAVE_BYTES = 32 * 1024;

  /**
   * Verify a player capability for the game this binding was minted for.
   * Game bindings carry props.appId = `game:{gameId}` so a capability for
   * one game can never be used through another game's worker.
   */
  private async verifyGameCapability(capToken: string): Promise<GameCapabilityPayload> {
    const { appId } = this.props;
    if (!appId.startsWith('game:')) {
      throw new Error('Not a game binding');
    }
    const expectedGameId = appId.slice('game:'.length);
    const payload = await verifyGameCapabilityToken(capToken, this.env.JWT_SECRET, { expectedGameId });
    if (!payload) {
      throw new Error('Invalid or expired capability');
    }
    return payload;
  }

  /** Read the calling player's save blob for this game. */
  async gameSaveGet(capToken: string): Promise<string | null> {
    const payload = await this.verifyGameCapability(capToken);
    return this.env.DESKTOP_KV.get(`gamesave:${payload.gameId}:${payload.uid}`);
  }

  /** Write the calling player's save blob for this game (≤ 32KB JSON). */
  async gameSavePut(capToken: string, data: string): Promise<void> {
    const payload = await this.verifyGameCapability(capToken);
    if (typeof data !== 'string') {
      throw new Error('Save data must be a string');
    }
    // Save calls arrive via service binding, bypassing the router's rate
    // limiter — cap writes here. The runtime debounces to ~1 write/5s, so an
    // honest client never hits this.
    const rateKey = `gamesave-rate:${payload.gameId}:${payload.uid}`;
    const count = parseInt((await this.env.DESKTOP_KV.get(rateKey)) ?? '0', 10);
    if (count >= 12) {
      throw new Error('Save rate limit exceeded — try again in a minute');
    }
    await this.env.DESKTOP_KV.put(rateKey, String(count + 1), { expirationTtl: 60 });
    if (new TextEncoder().encode(data).length > EternalService.MAX_GAME_SAVE_BYTES) {
      throw new Error('Save data too large (max 32KB)');
    }
    // Must parse as JSON — keeps the namespace inert (no HTML smuggling).
    try {
      JSON.parse(data);
    } catch {
      throw new Error('Save data must be valid JSON');
    }
    await this.env.DESKTOP_KV.put(`gamesave:${payload.gameId}:${payload.uid}`, data);
  }

  /**
   * Make a domain-allowlisted outbound network fetch.
   */
  async fetchProxy(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; statusText: string; body: string; headers: Record<string, string> }> {
    const { granted } = this.props;
    if (!granted.network?.outbound) {
      throw new Error('Not permitted: outbound network access not granted');
    }

    if (typeof url !== 'string' || url.length > 2048) {
      throw new Error('Invalid network URL');
    }
    const targetUrl = new URL(url);
    if (!['http:', 'https:'].includes(targetUrl.protocol) || targetUrl.username || targetUrl.password || isPrivateNetworkHost(targetUrl.hostname)) {
      throw new Error('Network URL is not allowed');
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
      throw new Error('Network method is not allowed');
    }
    if (init?.body && new TextEncoder().encode(init.body).length > MAX_NETWORK_BODY_BYTES) {
      throw new Error('Network request body is too large');
    }
    const isAllowed = granted.network.outbound.some((pattern) => {
      const normalizedPattern = pattern.toLowerCase();
      if (normalizedPattern === '*') return true;
      if (normalizedPattern === targetUrl.hostname.toLowerCase()) return true;
      if (normalizedPattern.startsWith('*.') && targetUrl.hostname.toLowerCase().endsWith(`.${normalizedPattern.slice(2)}`)) return true;
      return false;
    });

    if (!isAllowed) {
      throw new Error(`Not permitted: outbound access to ${targetUrl.hostname} is not allowed`);
    }

    const res = await fetch(url, {
      method,
      headers: init?.headers,
      body: init?.body,
      redirect: 'manual',
    });

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_NETWORK_RESPONSE_BYTES) {
      throw new Error('Network response is too large');
    }
    const bodyBytes = await res.arrayBuffer();
    if (bodyBytes.byteLength > MAX_NETWORK_RESPONSE_BYTES) {
      throw new Error('Network response is too large');
    }
    const bodyText = new TextDecoder().decode(bodyBytes);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    return {
      status: res.status,
      statusText: res.statusText,
      body: bodyText,
      headers: resHeaders,
    };
  }
}
