/**
 * UserDesktop Durable Object
 *
 * Per-user desktop state management. Each user gets one instance
 * that holds their complete desktop: items, positions, folder hierarchy.
 *
 * All state is persisted in Durable Object transactional storage.
 */

import type { Env } from '../index';
import type {
  CustomCSSVersion,
  DesktopItem,
  UserProfile,
  GuestbookConfig,
  GuestbookEntry,
} from '../types';
import type { CSSAssetMeta } from '../routes/upload';
import { sanitizeText } from '../utils/sanitize';

// Default storage quota: 100MB per user
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;

export interface QuotaInfo {
  used: number;      // Bytes used
  limit: number;     // Quota limit in bytes
  remaining: number; // Bytes remaining
  itemCount: number; // Number of items with files
}

/** Minimal window state persisted for visitor mode */
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

export class UserDesktop {
  private state: DurableObjectState;
  private env: Env;
  private items: Map<string, DesktopItem> = new Map();
  private profile: UserProfile | null = null;
  private windows: SavedWindowState[] = [];
  private cssAssets: CSSAssetMeta[] = [];
  private cssHistory: CustomCSSVersion[] = [];
  private initialized = false;
  // Track bytes reserved by in-flight uploads (not yet committed as items)
  // to prevent quota bypass via concurrent uploads.
  private pendingUploadBytes = 0;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private normalizeUserTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];

    const normalized = new Set<string>();
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const value = tag.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 32);
      if (!value) continue;
      normalized.add(value);
      if (normalized.size >= 12) break;
    }

    return Array.from(normalized);
  }

  /**
   * Initialize state from storage on first request
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load all items from storage
    const storedItems = await this.state.storage.get<DesktopItem[]>('items');
    if (storedItems) {
      for (const item of storedItems) {
        this.items.set(item.id, item);
      }
    }

    // Load profile
    this.profile = await this.state.storage.get<UserProfile>('profile') ?? null;

    // Load saved window state
    this.windows = await this.state.storage.get<SavedWindowState[]>('windows') ?? [];

    // Load CSS assets
    this.cssAssets = await this.state.storage.get<CSSAssetMeta[]>('css-assets') ?? [];

    // Load custom CSS history
    this.cssHistory = await this.state.storage.get<CustomCSSVersion[]>('css-history') ?? [];

    this.initialized = true;
  }

  /**
   * Keep the public KV snapshot in sync with the latest DO state.
   */
  private async syncPublicSnapshot(): Promise<void> {
    if (!this.profile?.uid) return;

    const data = this.getVisitorData();
    // SECURITY: Use a short TTL (60s) to minimize the window where a
    // newly-private item might still appear in the cached public snapshot.
    // The snapshot is also eagerly refreshed on every mutation (see saveItems).
    await this.env.DESKTOP_KV.put(
      `public:${this.profile.uid}`,
      JSON.stringify(data),
      { expirationTtl: 60 }
    );
  }

  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // WebSocket upgrade for visitor live-sync
      if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        this.state.acceptWebSocket(server);

        // Send initial snapshot to the new visitor
        const snapshot = this.getVisitorData();
        server.send(JSON.stringify({ type: 'snapshot', ...snapshot }));

        return new Response(null, { status: 101, webSocket: client });
      }

      // GET /items - Get all items
      if (path === '/items' && method === 'GET') {
        return Response.json({
          items: Array.from(this.items.values()),
          profile: this.profile,
          windows: this.windows,
        });
      }

      // POST /items - Create new item (client-facing, strips r2Key/fileSize/mimeType)
      if (path === '/items' && method === 'POST') {
        const item = await request.json() as Partial<DesktopItem>;
        const newItem = await this.createItem(item);
        return Response.json(newItem);
      }

      // POST /items-internal - Create new item (trusted, used by upload handler only)
      // Allows setting r2Key, fileSize, mimeType which are stripped from /items
      if (path === '/items-internal' && method === 'POST') {
        const item = await request.json() as Partial<DesktopItem>;
        const newItem = await this.createItemInternal(item);
        return Response.json(newItem);
      }

      // PATCH /items - Batch update items
      if (path === '/items' && method === 'PATCH') {
        const patches = await request.json() as Array<{ id: string; updates: Partial<DesktopItem> }>;
        const updated = await this.updateItems(patches);
        return Response.json(updated);
      }

      // DELETE /items/:id - Delete item
      if (path.startsWith('/items/') && method === 'DELETE') {
        const id = path.slice('/items/'.length);
        const deleted = await this.deleteItem(id);
        return Response.json(deleted);
      }

      // GET /public-snapshot - Get public items only
      if (path === '/public-snapshot' && method === 'GET') {
        const snapshot = await this.getPublicSnapshot();
        return Response.json(snapshot);
      }

      // POST /profile - Initialize or update profile (full replace)
      if (path === '/profile' && method === 'POST') {
        const profileData = await request.json() as UserProfile;
        await this.setProfile(profileData);
        return Response.json({ success: true });
      }

      // PATCH /profile - Partial update profile
      if (path === '/profile' && method === 'PATCH') {
        const updates = await request.json() as Partial<UserProfile>;
        const updatedProfile = await this.updateProfile(updates);
        return Response.json({ success: true, profile: updatedProfile });
      }

      // GET /profile - Get profile
      if (path === '/profile' && method === 'GET') {
        return Response.json({ profile: this.profile });
      }

      // PUT /windows - Save window state
      if (path === '/windows' && method === 'PUT') {
        const windowData = await request.json() as SavedWindowState[];
        await this.saveWindows(windowData);
        return Response.json({ success: true });
      }

      // GET /trash - Get trashed items
      if (path === '/trash' && method === 'GET') {
        const trashedItems = await this.getTrashedItems();
        return Response.json({ items: trashedItems });
      }

      // POST /trash/restore/:id - Restore item from trash
      if (path.startsWith('/trash/restore/') && method === 'POST') {
        const id = path.slice('/trash/restore/'.length);
        const restored = await this.restoreFromTrash(id);
        return Response.json(restored);
      }

      // DELETE /trash - Empty trash (permanently delete all trashed items)
      if (path === '/trash' && method === 'DELETE') {
        const deleted = await this.emptyTrash();
        return Response.json(deleted);
      }

      // POST /trash/cleanup - Delete items trashed more than 30 days ago
      if (path === '/trash/cleanup' && method === 'POST') {
        const cleaned = await this.cleanupOldTrash();
        return Response.json(cleaned);
      }

      // GET /quota - Get storage quota usage
      if (path === '/quota' && method === 'GET') {
        const quota = await this.getQuota();
        return Response.json(quota);
      }

      // POST /quota/check - Check if a file of given size would fit
      if (path === '/quota/check' && method === 'POST') {
        const { fileSize } = await request.json() as { fileSize: number };
        const result = await this.checkQuota(fileSize);
        return Response.json(result);
      }

      // POST /quota/reserve - Atomically reserve quota for an in-flight upload
      if (path === '/quota/reserve' && method === 'POST') {
        const { fileSize } = await request.json() as { fileSize: number };
        const result = await this.reserveQuota(fileSize);
        return Response.json(result);
      }

      // POST /quota/release - Release reserved quota (upload finished or failed)
      if (path === '/quota/release' && method === 'POST') {
        const { fileSize } = await request.json() as { fileSize: number };
        this.releaseQuota(fileSize);
        return Response.json({ success: true });
      }

      // GET /css-assets - List CSS assets
      if (path === '/css-assets' && method === 'GET') {
        return Response.json({ assets: this.cssAssets });
      }

      // POST /css-assets - Add CSS asset metadata
      if (path === '/css-assets' && method === 'POST') {
        const meta = await request.json() as CSSAssetMeta;
        this.cssAssets.push(meta);
        await this.state.storage.put('css-assets', this.cssAssets);
        return Response.json({ success: true });
      }

      // DELETE /css-assets/:assetId - Remove CSS asset metadata
      if (path.startsWith('/css-assets/') && method === 'DELETE') {
        const assetId = path.slice('/css-assets/'.length);
        this.cssAssets = this.cssAssets.filter(a => a.assetId !== assetId);
        await this.state.storage.put('css-assets', this.cssAssets);
        return Response.json({ success: true });
      }

      // GET /css-history - List saved custom CSS versions
      if (path === '/css-history' && method === 'GET') {
        return Response.json({ versions: this.cssHistory });
      }

      // POST /css-history/save - Save a CSS version with explicit metadata
      if (path === '/css-history/save' && method === 'POST') {
        const payload = await request.json() as {
          css?: string;
          source?: CustomCSSVersion['source'];
          summary?: string;
        };
        const updatedProfile = await this.saveCustomCSSVersion(
          payload.css ?? '',
          payload.source ?? 'assistant',
          payload.summary
        );
        return Response.json({ success: true, profile: updatedProfile, versions: this.cssHistory });
      }

      // POST /css-history/:versionId/revert - Restore a previous CSS version
      if (path.startsWith('/css-history/') && path.endsWith('/revert') && method === 'POST') {
        const versionId = path.slice('/css-history/'.length, -'/revert'.length);
        const updatedProfile = await this.restoreCustomCSSVersion(versionId);
        return Response.json({ success: true, profile: updatedProfile, versions: this.cssHistory });
      }

      // POST /guestbook/:itemId - Add guestbook entry
      if (path.startsWith('/guestbook/') && method === 'POST') {
        const itemId = path.slice('/guestbook/'.length);
        const entry = await request.json() as { name: string; message: string };
        const result = await this.addGuestbookEntry(itemId, entry);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 400 });
        }
        return Response.json(result);
      }

      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error) {
      console.error('UserDesktop error:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Internal error' },
        { status: 500 }
      );
    }
  }

  /**
   * Create a new desktop item
   *
   * SECURITY: r2Key, fileSize, mimeType, and imageAnalysis are set ONLY by
   * the upload handler via createItemInternal(). The public createItem() strips
   * them to prevent IDOR attacks where a client supplies another user's R2 key.
   * Item IDs are always generated server-side to prevent overwrite attacks.
   */
  private async createItem(partial: Partial<DesktopItem>): Promise<DesktopItem> {
    return this.createItemInternal({
      ...partial,
      // Strip server-controlled fields — these are only set by upload handlers
      id: undefined,
      r2Key: undefined,
      fileSize: undefined,
      mimeType: undefined,
      imageAnalysis: undefined,
    });
  }

  /**
   * Internal item creation used by upload handlers that need to set r2Key/fileSize/mimeType.
   * NOT exposed to client input directly.
   */
  private async createItemInternal(partial: Partial<DesktopItem>): Promise<DesktopItem> {
    const now = Date.now();
    const id = partial.id || crypto.randomUUID();

    // Prevent overwriting existing items
    if (this.items.has(id)) {
      throw new Error('Item with this ID already exists');
    }

    const item: DesktopItem = {
      id,
      type: partial.type ?? 'folder',
      name: partial.name ?? 'Untitled',
      parentId: partial.parentId ?? null,
      position: partial.position ?? { x: 0, y: 0 },
      isPublic: partial.isPublic ?? true,
      createdAt: now,
      updatedAt: now,
      r2Key: partial.r2Key,
      mimeType: partial.mimeType,
      fileSize: partial.fileSize,
      textContent: partial.textContent,
      url: partial.url,
      customIcon: partial.customIcon,
      widgetType: partial.widgetType,
      widgetConfig: partial.widgetConfig,
      stickerConfig: partial.stickerConfig,
      userTags: partial.userTags === undefined ? undefined : this.normalizeUserTags(partial.userTags),
      imageAnalysis: partial.imageAnalysis,
    };

    this.items.set(item.id, item);
    await this.saveItems();
    this.broadcastItems();
    return item;
  }

  /**
   * Batch update items (positions, names, visibility, etc.)
   * Only allows updating safe fields — prevents IDOR attacks that could
   * overwrite r2Key, fileSize, id, or other sensitive fields.
   */
  private async updateItems(
    patches: Array<{ id: string; updates: Partial<DesktopItem> }>
  ): Promise<DesktopItem[]> {
    // Only these fields can be updated via the PATCH endpoint
    const ALLOWED_UPDATE_FIELDS: (keyof DesktopItem)[] = [
      'name',
      'position',
      'parentId',
      'isPublic',
      'textContent',
      'url',
      'customIcon',
      'widgetType',
      'widgetConfig',
      'stickerConfig',
      'userTags',
      'imageAnalysis',
      'isTrashed',
      'trashedAt',
      'originalParentId',
    ];

    const updated: DesktopItem[] = [];

    for (const { id, updates } of patches) {
      const item = this.items.get(id);
      if (item) {
        // Filter updates to only allowed fields
        const filteredUpdates: Partial<DesktopItem> = {};
        for (const field of ALLOWED_UPDATE_FIELDS) {
          if (updates[field] !== undefined) {
            if (field === 'userTags') {
              (filteredUpdates as Record<string, unknown>)[field] = this.normalizeUserTags(updates[field]);
            } else {
              (filteredUpdates as Record<string, unknown>)[field] = updates[field];
            }
          }
        }

        // Prevent circular folder references: if parentId is being changed,
        // walk up the target parent's ancestor chain and ensure this item
        // doesn't appear (which would create a cycle).
        if (
          filteredUpdates.parentId !== undefined &&
          filteredUpdates.parentId !== null &&
          item.type === 'folder'
        ) {
          let ancestor: string | null | undefined = filteredUpdates.parentId as string;
          let isCycle = false;
          const visited = new Set<string>();
          while (ancestor) {
            if (ancestor === id) {
              isCycle = true;
              break;
            }
            if (visited.has(ancestor)) break; // safety against existing cycles
            visited.add(ancestor);
            const parentItem = this.items.get(ancestor);
            ancestor = parentItem?.parentId;
          }
          if (isCycle) {
            // Skip this update — moving a folder into its own descendant
            continue;
          }
        }

        const updatedItem = {
          ...item,
          ...filteredUpdates,
          updatedAt: Date.now(),
        };
        this.items.set(id, updatedItem);
        updated.push(updatedItem);
      }
    }

    if (updated.length > 0) {
      await this.saveItems();
      this.broadcastItems();
    }

    return updated;
  }

  /**
   * Delete an item and all its children (cascade), return r2Keys for cleanup
   */
  private async deleteItem(id: string): Promise<{ deleted: boolean; r2Key?: string; r2Keys?: string[] }> {
    const item = this.items.get(id);
    if (!item) {
      return { deleted: false };
    }

    const r2Keys: string[] = [];

    // Collect this item's r2Key
    if (item.r2Key) {
      r2Keys.push(item.r2Key);
    }

    // Cascade delete: recursively find and delete all children
    const collectChildren = (parentId: string) => {
      for (const [childId, child] of this.items) {
        if (child.parentId === parentId) {
          if (child.r2Key) {
            r2Keys.push(child.r2Key);
          }
          collectChildren(childId); // recurse into subfolders
          this.items.delete(childId);
        }
      }
    };

    // If this is a folder, delete all descendants
    if (item.type === 'folder') {
      collectChildren(id);
    }

    this.items.delete(id);
    await this.saveItems();
    this.broadcastItems();
    this.broadcastWindows();

    return { deleted: true, r2Key: item.r2Key, r2Keys };
  }

  /**
   * Compute public items (non-trashed, not explicitly private)
   */
  private getPublicItemsFiltered(): DesktopItem[] {
    return Array.from(this.items.values()).filter(
      (item) => item.isPublic !== false && !item.isTrashed
    );
  }

  /**
   * Compute visitor-visible data (items, windows, profile) without side effects
   */
  private getVisitorData(): { items: DesktopItem[]; windows: SavedWindowState[]; profile: UserProfile | null } {
    const items = this.getPublicItemsFiltered();
    const publicItemIds = new Set(items.map((i) => i.id));
    const windows = this.windows.filter(
      (w) => !w.contentId || publicItemIds.has(w.contentId)
    );
    return { items, windows, profile: this.profile };
  }

  /**
   * Get visitor-visible items (for visitor mode)
   * Shows all non-trashed items unless explicitly marked private (isPublic === false).
   * Items default to visible — users opt-out by setting isPublic to false.
   */
  private async getPublicSnapshot(): Promise<{
    items: DesktopItem[];
    profile: UserProfile | null;
    windows: SavedWindowState[];
  }> {
    const data = this.getVisitorData();

    // Also push to KV for fast visitor reads (if we have the UID in profile)
    await this.syncPublicSnapshot();

    return data;
  }

  /**
   * Set user profile (full replace)
   */
  private async setProfile(profile: UserProfile): Promise<void> {
    this.profile = profile;
    await this.state.storage.put('profile', profile);
    await this.syncPublicSnapshot();
    this.broadcastProfile();
  }

  /**
   * Update user profile (partial update)
   */
  private async updateProfile(updates: Partial<UserProfile>): Promise<UserProfile | null> {
    if (!this.profile) {
      return null;
    }

    const currentCustomCSS = this.profile.customCSS ?? '';

    // Only allow updating certain fields
    const allowedFields: (keyof UserProfile)[] = [
      'username',
      'displayName',
      'wallpaper',
      'accentColor',
      'desktopColor',
      'windowBgColor',
      'titleBarBgColor',
      'titleBarTextColor',
      'windowBorderColor',
      'buttonBgColor',
      'buttonTextColor',
      'buttonBorderColor',
      'labelColor',
      'systemFont',
      'bodyFont',
      'monoFont',
      'fontSmoothing',
      'windowBorderRadius',
      'controlBorderRadius',
      'windowShadow',
      'windowOpacity',
      'designTokens',
      'customCSS',
      'isNewUser',
      'hideWatermark',
      'wallpaperMode',
      'bio',
      'profileLinks',
      'shareDescription',
      'analyticsEnabled',
    ];
    const filteredUpdates: Partial<UserProfile> = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        (filteredUpdates as Record<string, unknown>)[field] = updates[field];
      }
    }

    // Color fields now accept full CSS color values (hex, rgb, hsl, gradients)
    // Security: block dangerous patterns but allow rich styling
    const colorFields: (keyof UserProfile)[] = [
      'accentColor',
      'desktopColor',
      'windowBgColor',
      'titleBarBgColor',
      'titleBarTextColor',
      'windowBorderColor',
      'buttonBgColor',
      'buttonTextColor',
      'buttonBorderColor',
      'labelColor',
    ];

    const dangerousCSSPatterns = [
      /javascript:/i,
      /expression\s*\(/i,
      /behavior\s*:/i,
      /-moz-binding/i,
      /<script/i,
      /data:/i,
      /vbscript:/i,
    ];

    for (const field of colorFields) {
      const value = filteredUpdates[field];
      if (typeof value === 'string') {
        // Max length to prevent abuse
        if (value.length > 500) {
          throw new Error(`${field} value too long`);
        }
        // Block dangerous patterns
        for (const pattern of dangerousCSSPatterns) {
          if (pattern.test(value)) {
            throw new Error(`Invalid ${field} value: contains disallowed pattern`);
          }
        }
        // Block url() unless it's a first-party asset
        const urlMatches = value.match(/url\s*\(/gi);
        if (urlMatches) {
          // Only allow url() pointing to our own assets
          const urlRegex = /url\s*\(\s*['"]?([^)'"]*?)['"]?\s*\)/gi;
          let match;
          while ((match = urlRegex.exec(value)) !== null) {
            const urlValue = match[1].trim();
            if (!urlValue.startsWith('/api/css-assets/') && !urlValue.startsWith('/api/wallpaper/') && !urlValue.startsWith('/api/icon/')) {
              throw new Error(`${field} contains disallowed url()`);
            }
          }
        }
      }
    }

    const numericFields: Array<[keyof UserProfile, number, number]> = [
      ['windowBorderRadius', 0, 24],
      ['controlBorderRadius', 0, 24],
      ['windowShadow', 0, 32],
      ['windowOpacity', 30, 100],
    ];

    for (const [field, min, max] of numericFields) {
      const value = filteredUpdates[field];
      if (value !== undefined) {
        if (typeof value !== 'number' || Number.isNaN(value) || value < min || value > max) {
          throw new Error(`Invalid ${field} value`);
        }
      }
    }

    // Validate font ID fields (alphanumeric + limited length)
    const fontFields: (keyof UserProfile)[] = ['systemFont', 'bodyFont', 'monoFont'];
    for (const field of fontFields) {
      const value = filteredUpdates[field];
      if (typeof value === 'string') {
        if (value.length > 50 || !/^[a-zA-Z0-9]+$/.test(value)) {
          throw new Error(`Invalid ${field} value`);
        }
      }
    }

    // Server-side validation for designTokens blob
    if (filteredUpdates.designTokens !== undefined) {
      const dt = filteredUpdates.designTokens;
      if (typeof dt !== 'object' || dt === null || Array.isArray(dt)) {
        throw new Error('Invalid designTokens format');
      }
      const dtStr = JSON.stringify(dt);
      if (dtStr.length > 20 * 1024) {
        throw new Error('designTokens exceeds 20KB limit');
      }
      // Validate each value is a safe primitive (string, number, or boolean)
      const dangerousTokenPatterns = [
        /javascript:/i,
        /expression\s*\(/i,
        /behavior\s*:/i,
        /-moz-binding/i,
        /<script/i,
        /@import/i,
      ];
      // SECURITY: Same url() allowlist used for customCSS — prevents external
      // resource loading (tracking pixels, data exfiltration) via design tokens
      const tokenAllowedUrlPrefixes = ['/api/css-assets/', '/api/wallpaper/', '/api/icon/'];
      for (const [key, value] of Object.entries(dt)) {
        // Keys must be dot-path identifiers (alphanumeric + dots)
        if (!/^[a-zA-Z][a-zA-Z0-9.]*$/.test(key) || key.length > 100) {
          throw new Error(`Invalid designToken key: ${key}`);
        }
        // Values must be string, number, or boolean
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(`Invalid designToken value type for ${key}`);
        }
        // String values: check for dangerous patterns, url() references, and enforce length
        if (typeof value === 'string') {
          if (value.length > 500) {
            throw new Error(`designToken value too long for ${key}`);
          }
          for (const pattern of dangerousTokenPatterns) {
            if (pattern.test(value)) {
              throw new Error(`designToken value contains disallowed pattern for ${key}`);
            }
          }
          // Validate url() references — only allow first-party asset paths
          const tokenUrlPattern = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
          let tokenUrlMatch: RegExpExecArray | null;
          while ((tokenUrlMatch = tokenUrlPattern.exec(value)) !== null) {
            const rawUrl = tokenUrlMatch[2];
            const decodedUrl = decodeURIComponent(rawUrl).replace(/\\/g, '/');
            const isAllowed = tokenAllowedUrlPrefixes.some(prefix => decodedUrl.startsWith(prefix));
            if (!isAllowed) {
              throw new Error(`designToken url() must reference first-party assets for ${key}`);
            }
            // Block path traversal in allowed URLs
            if (decodedUrl.includes('..')) {
              throw new Error(`designToken url() contains path traversal for ${key}`);
            }
          }
        }
      }
    }

    // Server-side validation for customCSS
    if (typeof filteredUpdates.customCSS === 'string') {
      const css = filteredUpdates.customCSS;

      // Enforce 50KB limit
      if (css.length > 50 * 1024) {
        throw new Error('Custom CSS exceeds maximum size of 50KB');
      }

      // Block dangerous patterns
      const dangerousPatterns = [
        /@import/i,
        /expression\s*\(/i,
        /javascript:/i,
        /behavior\s*:/i,
        /-moz-binding/i,
        /<script/i,
        /<\/script/i,
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(css)) {
          throw new Error('Custom CSS contains disallowed patterns');
        }
      }

      // Validate url() references — only allow first-party asset paths
      // Normalize (decode) paths before validation to prevent encoded bypasses
      const allowedUrlPrefixes = ['/api/css-assets/', '/api/wallpaper/', '/api/icon/'];
      const urlPattern = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlPattern.exec(css)) !== null) {
        let urlValue = urlMatch[2];
        // Decode percent-encoded characters to prevent bypass via encoding
        try { urlValue = decodeURIComponent(urlValue); } catch { /* use as-is */ }
        // Block path traversal in url() values
        if (urlValue.includes('..') || urlValue.includes('\\')) {
          throw new Error('Custom CSS contains disallowed url() references');
        }
        // Normalize the URL path using URL parsing to resolve any remaining traversal segments
        try {
          const normalized = new URL(urlValue, 'http://localhost').pathname;
          if (!allowedUrlPrefixes.some((prefix) => normalized.startsWith(prefix))) {
            throw new Error('Custom CSS contains disallowed url() references');
          }
        } catch {
          throw new Error('Custom CSS contains disallowed url() references');
        }
      }
    }

    // Validate bio (max 500 chars)
    if (typeof filteredUpdates.bio === 'string') {
      if (filteredUpdates.bio.length > 500) {
        throw new Error('Bio exceeds maximum length of 500 characters');
      }
    }

    // Validate shareDescription (max 200 chars)
    if (typeof filteredUpdates.shareDescription === 'string') {
      if (filteredUpdates.shareDescription.length > 200) {
        throw new Error('Share description exceeds maximum length of 200 characters');
      }
    }

    // Validate profileLinks (max 5, valid URLs)
    if (Array.isArray(filteredUpdates.profileLinks)) {
      if (filteredUpdates.profileLinks.length > 5) {
        throw new Error('Maximum 5 profile links allowed');
      }
      for (const link of filteredUpdates.profileLinks) {
        if (!link.title || typeof link.title !== 'string' || link.title.length > 100) {
          throw new Error('Profile link title must be 1-100 characters');
        }
        if (!link.url || typeof link.url !== 'string') {
          throw new Error('Profile link URL is required');
        }
        try {
          const parsed = new URL(link.url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`Profile link URL must use http or https protocol: ${link.url}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith('Profile link URL must use')) {
            throw e;
          }
          throw new Error(`Invalid profile link URL: ${link.url}`);
        }
      }
    }

    this.profile = {
      ...this.profile,
      ...filteredUpdates,
    };

    await this.state.storage.put('profile', this.profile);
    if (typeof filteredUpdates.customCSS === 'string' && filteredUpdates.customCSS !== currentCustomCSS) {
      await this.recordCustomCSSVersion(filteredUpdates.customCSS, 'manual');
    }
    await this.syncPublicSnapshot();
    this.broadcastProfile();
    return this.profile;
  }

  private async persistCSSHistory(): Promise<void> {
    await this.state.storage.put('css-history', this.cssHistory);
  }

  private async recordCustomCSSVersion(
    css: string,
    source: CustomCSSVersion['source'],
    summary?: string
  ): Promise<void> {
    if (this.cssHistory[0]?.css === css) {
      return;
    }

    this.cssHistory = [
      {
        id: crypto.randomUUID(),
        css,
        createdAt: Date.now(),
        source,
        summary,
      },
      ...this.cssHistory,
    ].slice(0, 20);

    await this.persistCSSHistory();
  }

  private async saveCustomCSSVersion(
    css: string,
    source: CustomCSSVersion['source'],
    summary?: string
  ): Promise<UserProfile | null> {
    const updatedProfile = await this.updateProfile({ customCSS: css });
    if (!updatedProfile) {
      return null;
    }

    if (source !== 'manual') {
      if (this.cssHistory[0]?.source === 'manual' && this.cssHistory[0]?.css === css) {
        this.cssHistory[0] = {
          ...this.cssHistory[0],
          source,
          summary,
        };
      } else {
        await this.recordCustomCSSVersion(css, source, summary);
      }
      await this.persistCSSHistory();
    }

    return updatedProfile;
  }

  private async restoreCustomCSSVersion(versionId: string): Promise<UserProfile | null> {
    const version = this.cssHistory.find((entry) => entry.id === versionId);
    if (!version) {
      throw new Error('Custom CSS version not found');
    }

    const updatedProfile = await this.updateProfile({ customCSS: version.css });
    if (!updatedProfile) {
      return null;
    }

    if (this.cssHistory[0]?.css === version.css) {
      this.cssHistory[0] = {
        ...this.cssHistory[0],
        source: 'revert',
        summary: `Restored from ${version.id}`,
      };
      await this.persistCSSHistory();
    } else {
      await this.recordCustomCSSVersion(version.css, 'revert', `Restored from ${version.id}`);
    }

    return updatedProfile;
  }

  /**
   * Persist items to DO storage
   */
  private async saveItems(): Promise<void> {
    const itemsArray = Array.from(this.items.values());
    await this.state.storage.put('items', itemsArray);
    await this.syncPublicSnapshot();
  }

  /**
   * Save window state to DO storage
   * Only stores essential fields, max 20 windows to prevent abuse.
   */
  private async saveWindows(windowData: SavedWindowState[]): Promise<void> {
    // Limit to 20 windows to prevent storage abuse
    this.windows = windowData.slice(0, 20).map((w) => ({
      id: w.id,
      title: String(w.title || '').slice(0, 200),
      position: { x: Number(w.position?.x) || 0, y: Number(w.position?.y) || 0 },
      size: { width: Number(w.size?.width) || 300, height: Number(w.size?.height) || 200 },
      zIndex: Number(w.zIndex) || 1,
      minimized: Boolean(w.minimized),
      maximized: Boolean(w.maximized),
      collapsed: w.collapsed ? true : undefined,
      contentType: String(w.contentType || 'folder'),
      contentId: w.contentId ? String(w.contentId) : undefined,
    }));
    await this.state.storage.put('windows', this.windows);
    await this.syncPublicSnapshot();
    this.broadcastWindows();
  }

  /**
   * Get all trashed items
   */
  private async getTrashedItems(): Promise<DesktopItem[]> {
    return Array.from(this.items.values()).filter((item) => item.isTrashed === true);
  }

  /**
   * Restore an item from trash
   */
  private async restoreFromTrash(id: string): Promise<{ restored: boolean; item?: DesktopItem }> {
    const item = this.items.get(id);
    if (!item || !item.isTrashed) {
      return { restored: false };
    }

    const restoredItem: DesktopItem = {
      ...item,
      isTrashed: false,
      trashedAt: undefined,
      updatedAt: Date.now(),
    };

    this.items.set(id, restoredItem);
    await this.saveItems();
    this.broadcastItems();

    return { restored: true, item: restoredItem };
  }

  /**
   * Empty trash - permanently delete all trashed items and return r2Keys for cleanup
   */
  private async emptyTrash(): Promise<{ deleted: number; r2Keys: string[] }> {
    const trashedItems = Array.from(this.items.values()).filter((item) => item.isTrashed === true);
    const r2Keys: string[] = [];
    let deletedCount = 0;

    for (const item of trashedItems) {
      if (item.r2Key) {
        r2Keys.push(item.r2Key);
      }
      this.items.delete(item.id);
      deletedCount++;
    }

    if (deletedCount > 0) {
      await this.saveItems();
      this.broadcastItems();
    }

    return { deleted: deletedCount, r2Keys };
  }

  /**
   * Cleanup old trashed items - permanently delete items trashed more than 30 days ago
   */
  private async cleanupOldTrash(): Promise<{ deleted: number; r2Keys: string[] }> {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const oldTrashedItems = Array.from(this.items.values()).filter(
      (item) => item.isTrashed === true && item.trashedAt && item.trashedAt < thirtyDaysAgo
    );

    const r2Keys: string[] = [];
    let deletedCount = 0;

    for (const item of oldTrashedItems) {
      if (item.r2Key) {
        r2Keys.push(item.r2Key);
      }
      this.items.delete(item.id);
      deletedCount++;
    }

    if (deletedCount > 0) {
      await this.saveItems();
      this.broadcastItems();
    }

    return { deleted: deletedCount, r2Keys };
  }

  /**
   * Get storage quota usage
   * Calculates total bytes used by summing fileSize of ALL items (including trashed).
   * Trashed items still consume R2 storage until permanently deleted, so they must
   * count toward the quota to prevent the trash-cycling bypass.
   */
  private async getQuota(): Promise<QuotaInfo> {
    if (this.profile?.uid) {
      let usedBytes = 0;
      let itemCount = 0;
      let cursor: string | undefined;

      do {
        const result = await this.env.ETERNALOS_FILES.list({
          prefix: `${this.profile.uid}/`,
          cursor,
        });

        for (const object of result.objects) {
          usedBytes += object.size;
          itemCount++;
        }

        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);

      return {
        used: usedBytes,
        limit: DEFAULT_QUOTA_BYTES,
        remaining: Math.max(0, DEFAULT_QUOTA_BYTES - usedBytes),
        itemCount,
      };
    }

    let usedBytes = 0;
    let itemCount = 0;

    for (const item of this.items.values()) {
      if (item.fileSize) {
        usedBytes += item.fileSize;
        itemCount++;
      }
    }

    return {
      used: usedBytes,
      limit: DEFAULT_QUOTA_BYTES,
      remaining: Math.max(0, DEFAULT_QUOTA_BYTES - usedBytes),
      itemCount,
    };
  }

  /**
   * Check if there's enough quota for a file of the given size.
   * Includes bytes reserved by concurrent in-flight uploads to prevent
   * the quota-check race condition.
   */
  public async checkQuota(fileSize: number): Promise<{ allowed: boolean; quota: QuotaInfo }> {
    const quota = await this.getQuota();
    // Include pending (in-flight) upload bytes in the usage check
    const effectiveUsed = quota.used + this.pendingUploadBytes;
    const allowed = (effectiveUsed + fileSize) <= quota.limit;
    return { allowed, quota: { ...quota, used: effectiveUsed } };
  }

  /**
   * Reserve quota for an in-flight upload. Called before R2 upload begins.
   * Returns true if reservation succeeded, false if it would exceed quota.
   */
  public async reserveQuota(fileSize: number): Promise<{ reserved: boolean; quota: QuotaInfo }> {
    const quota = await this.getQuota();
    const effectiveUsed = quota.used + this.pendingUploadBytes;
    if (effectiveUsed + fileSize > quota.limit) {
      return { reserved: false, quota: { ...quota, used: effectiveUsed } };
    }
    this.pendingUploadBytes += fileSize;
    return { reserved: true, quota: { ...quota, used: effectiveUsed } };
  }

  /**
   * Release reserved quota (called after upload completes or fails).
   */
  public releaseQuota(fileSize: number): void {
    this.pendingUploadBytes = Math.max(0, this.pendingUploadBytes - fileSize);
  }

  /**
   * Add a guestbook entry to a widget
   */
  private async addGuestbookEntry(
    itemId: string,
    entry: { name: string; message: string }
  ): Promise<{ success: boolean; error?: string; entries?: GuestbookEntry[] }> {
    const item = this.items.get(itemId);

    if (!item) {
      return { success: false, error: 'Widget not found' };
    }

    if (item.type !== 'widget' || item.widgetType !== 'guestbook') {
      return { success: false, error: 'Item is not a guestbook widget' };
    }

    if (!item.isPublic) {
      return { success: false, error: 'Guestbook is not public' };
    }

    // Get current config
    const currentConfig = (item.widgetConfig || { entries: [] }) as GuestbookConfig;
    const entries = currentConfig.entries || [];

    // Add new entry — sanitize on write to prevent stored XSS
    const newEntry: GuestbookEntry = {
      name: sanitizeText(entry.name, 50),
      message: sanitizeText(entry.message, 500),
      timestamp: Date.now(),
    };

    const updatedEntries = [...entries, newEntry];

    // Keep max 100 entries to prevent unbounded growth
    const trimmedEntries = updatedEntries.slice(-100);

    // Update item
    const updatedConfig: GuestbookConfig = { entries: trimmedEntries };
    const updatedItem: DesktopItem = {
      ...item,
      widgetConfig: updatedConfig,
      updatedAt: Date.now(),
    };

    this.items.set(itemId, updatedItem);
    await this.saveItems();
    this.broadcastItems();

    return { success: true, entries: trimmedEntries };
  }

  // --- WebSocket live-sync broadcast helpers ---

  /** Send a JSON message to all connected visitor WebSockets */
  private broadcastToVisitors(data: Record<string, unknown>): void {
    const message = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // WebSocket already closed, will be cleaned up
      }
    }
  }

  /** Broadcast current public items to all visitors */
  private broadcastItems(): void {
    if (this.state.getWebSockets().length === 0) return;
    const items = this.getPublicItemsFiltered();
    this.broadcastToVisitors({ type: 'items', items });
  }

  /** Broadcast current public windows to all visitors */
  private broadcastWindows(): void {
    if (this.state.getWebSockets().length === 0) return;
    const publicItems = this.getPublicItemsFiltered();
    const publicItemIds = new Set(publicItems.map((i) => i.id));
    const windows = this.windows.filter(
      (w) => !w.contentId || publicItemIds.has(w.contentId)
    );
    this.broadcastToVisitors({ type: 'windows', windows });
  }

  /** Broadcast profile to all visitors */
  private broadcastProfile(): void {
    if (this.state.getWebSockets().length === 0) return;
    this.broadcastToVisitors({ type: 'profile', profile: this.profile });
  }

  // --- WebSocket hibernation handlers ---

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Handle ping/pong heartbeat to detect dead connections
    if (typeof message === 'string' && message === 'ping') {
      try { ws.send('pong'); } catch { /* already closed */ }
      return;
    }
    // Visitors are read-only, ignore all other incoming messages
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, 'Connection closed');
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Error will trigger close, handled by webSocketClose
  }
}
