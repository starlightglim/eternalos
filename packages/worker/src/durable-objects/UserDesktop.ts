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
  StickerConfig,
  SoundAssetMeta,
  CursorAssetMeta,
} from '../types';
import type { CSSAssetMeta } from '../routes/upload';
import { sanitizeText, isFirstPartyAssetUrl } from '../utils/sanitize';
import { HttpError } from '../utils/httpError';

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

/**
 * Profile fields a PATCH may explicitly clear by sending `null`.
 *
 * Mirrors the frontend reset payload (APPEARANCE_PROFILE_KEYS plus the
 * designTokens/variants blobs in packages/frontend/src/stores/appearanceStore.ts):
 * exactly the appearance/customization fields the Appearance "Reset" is meant
 * to clear. `null` for any other allowlisted field (username, wallpaper, bio,
 * soundPack, …) is rejected with 400 — identity and account fields must never
 * be clearable — and fields outside the allowlist entirely keep today's
 * behavior (silently ignored, like any unknown field).
 */
const CLEARABLE_APPEARANCE_FIELDS: ReadonlySet<keyof UserProfile> = new Set([
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
  'customCSS',
  'designTokens',
  'variants',
]);

/**
 * The only item `type` transition an item PATCH may perform: turning an
 * uploaded image into a freely placed sticker — the "Add Sticker..."
 * command (packages/frontend/src/components/desktop/stickerUpload.ts)
 * PATCHes the uploaded image with `type: 'sticker'` plus a stickerConfig.
 * `type` used to sit outside ALLOWED_UPDATE_FIELDS and was silently
 * stripped, so an applied sticker reverted to a plain image on the next
 * reconcile.
 *
 * The reverse transition (sticker -> image) stays impossible: the frontend
 * has no convert-back action — its "Remove Sticker" context command trashes
 * the item — and every other transition crosses into types (app, folder,
 * widget, ...) whose create paths carry server-managed semantics a client
 * PATCH must never switch in or out of. Re-asserting an item's current type
 * is not a transition and stays a harmless no-op.
 */
const ALLOWED_TYPE_TRANSITIONS: ReadonlySet<string> = new Set(['image->sticker']);

/**
 * The profile fields a visitor may see — the same public surface the HTTP
 * visit route (buildVisitorResponse in routes/visit.ts) exposes, plus the
 * remaining appearance fields the visitor page renders. Everything else on
 * UserProfile is account data that never leaves the owner's session:
 * `createdAt`, `isNewUser`, `analyticsEnabled`. An allowlist (not a
 * denylist) so a field added to UserProfile later stays private until it is
 * deliberately listed here.
 *
 * `uid` stays visible: it is the owner key in the public guestbook route
 * (POST /api/guestbook/:uid/:itemId) and the visitor page learns it only
 * from this live-sync profile — dropping it would break every visitor's
 * guestbook signing.
 */
const VISITOR_PROFILE_FIELDS = [
  'uid',
  'username',
  'displayName',
  'wallpaper',
  'wallpaperMode',
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
  'variants',
  'customCSS',
  'hideWatermark',
  'bio',
  'profileLinks',
  'shareDescription',
  'soundPack',
] as const satisfies readonly (keyof UserProfile)[];

export type VisitorProfile = Pick<UserProfile, (typeof VISITOR_PROFILE_FIELDS)[number]>;

/** Strip a profile down to what visitors may see (see VISITOR_PROFILE_FIELDS). */
export function toVisitorProfile(profile: UserProfile | null): VisitorProfile | null {
  if (!profile) return null;
  const visible: Record<string, unknown> = {};
  for (const field of VISITOR_PROFILE_FIELDS) {
    if (profile[field] !== undefined) visible[field] = profile[field];
  }
  return visible as VisitorProfile;
}

/**
 * Running storage-usage counter (bytes + object count under `${uid}/` in R2),
 * persisted under QUOTA_USAGE_KEY so quota reads and upload reservations no
 * longer list every R2 object.
 *
 * The DO adjusts it exactly for the writes it can size itself — committed
 * uploads (/items-internal with r2Key + fileSize) and item deletes/trash
 * empties. Other uid-scoped R2 writes (wallpaper, uploaded icons, CSS/sound/
 * cursor assets) are done by the upload routes, which only tell the DO about
 * them indirectly (a profile/item/asset-metadata write without the byte
 * delta), so those events invalidate the counter and the next read rebuilds
 * it from R2 once. QUOTA_RECOMPUTE_MS is a backstop for anything else the
 * DO never sees (a failed R2 cleanup, an orphaned object): a counter older
 * than that is rebuilt on the next read.
 */
const QUOTA_USAGE_KEY = 'quota-usage';
export const QUOTA_RECOMPUTE_MS = 10 * 60 * 1000;
/** How long after a delete/invalidate an R2 listing is treated as unsettled. */
const QUOTA_SETTLE_MS = 30 * 1000;

interface QuotaUsage {
  used: number;
  objects: number;
  computedAt: number;
}

/** Saved window state is capped to prevent storage abuse. */
const MAX_WINDOWS = 20;

export class UserDesktop {
  private state: DurableObjectState;
  private env: Env;
  private items: Map<string, DesktopItem> = new Map();
  private profile: UserProfile | null = null;
  private windows: SavedWindowState[] = [];
  private cssAssets: CSSAssetMeta[] = [];
  private cssHistory: CustomCSSVersion[] = [];
  private soundAssets: SoundAssetMeta[] = [];
  private cursorAssets: CursorAssetMeta[] = [];
  private initialized = false;
  // Track bytes reserved by in-flight uploads (not yet committed as items)
  // to prevent quota bypass via concurrent uploads.
  private pendingUploadBytes = 0;
  // Running R2 usage counter (see QUOTA_USAGE_KEY). null = must be rebuilt
  // from R2 on the next quota read.
  private quotaUsage: QuotaUsage | null = null;
  // Bumped by every adjust/invalidate so an R2 rebuild that raced with a
  // write never persists a stale total.
  private quotaGeneration = 0;
  private quotaRebuild: Promise<QuotaUsage> | null = null;
  // Until this time an R2 listing may still include objects the routes are
  // about to delete (the DO forgets an item before the route removes its
  // file, and the wallpaper route deletes the old file after the profile
  // write) — rebuilds started before then answer their read but aren't saved.
  private quotaSettleAt = 0;

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

    // Load sound and cursor assets (skin system)
    this.soundAssets = await this.state.storage.get<SoundAssetMeta[]>('sound-assets') ?? [];
    this.cursorAssets = await this.state.storage.get<CursorAssetMeta[]>('cursor-assets') ?? [];

    // Running quota counter (absent on old desktops: rebuilt on first read)
    this.quotaUsage = await this.state.storage.get<QuotaUsage>(QUOTA_USAGE_KEY) ?? null;

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

        // Send initial snapshot to the new visitor (visitor-safe profile:
        // getVisitorData never carries uid/createdAt/isNewUser/analytics)
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

      // POST /items - Create new item (client-facing, strips r2Key/fileSize/mimeType;
      // a body that isn't a JSON object is rejected with a 400 by createItem)
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
        // A committed upload: its bytes are already in R2, so they move from
        // the in-flight reservation into the running usage counter.
        const committedBytes = this.countedFileBytes(newItem);
        if (committedBytes !== null) {
          await this.adjustQuotaUsage(committedBytes, 1);
        }
        return Response.json(newItem);
      }

      // PATCH /items - Batch update items
      if (path === '/items' && method === 'PATCH') {
        // The body is untrusted (the public route forwards it verbatim):
        // updateItems validates every entry — shape, id, field validators —
        // before mutating anything, and answers bad input with a 400 that
        // names the offending entry.
        const patches = await request.json();
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
        // The DO never sees the real request; callers proxying a client
        // request pass the API's own origin so appearance URL validation
        // can accept same-origin absolute URLs (CursorEditor stores those).
        // Without the header only relative /api/... paths are accepted.
        const updatedProfile = await this.updateProfile(updates, request.headers.get('X-API-Origin'));
        return Response.json({ success: true, profile: updatedProfile });
      }

      // GET /profile - Get profile
      if (path === '/profile' && method === 'GET') {
        return Response.json({ profile: this.profile });
      }

      // PUT /windows - Save window state
      if (path === '/windows' && method === 'PUT') {
        const windowData: unknown = await request.json();
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

      // POST /purge - Account hard-deletion. Wipes ALL desktop state from this
      // DO. The caller (utils/accountPurge.purgeAccount) separately sweeps the
      // user's uid-scoped R2 objects, so this only clears DO storage.
      if (path === '/purge' && method === 'POST') {
        const result = await this.purgeAll();
        return Response.json(result);
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

      // POST /quota/invalidate - Drop the running usage counter (a route's
      // R2 cleanup failed, so the counter no longer matches R2)
      if (path === '/quota/invalidate' && method === 'POST') {
        await this.invalidateQuotaUsage();
        return Response.json({ success: true });
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
        await this.invalidateQuotaUsage();
        return Response.json({ success: true });
      }

      // DELETE /css-assets/:assetId - Remove CSS asset metadata
      if (path.startsWith('/css-assets/') && method === 'DELETE') {
        const assetId = path.slice('/css-assets/'.length);
        this.cssAssets = this.cssAssets.filter(a => a.assetId !== assetId);
        await this.state.storage.put('css-assets', this.cssAssets);
        await this.invalidateQuotaUsage();
        return Response.json({ success: true });
      }

      // GET /sounds - List sound assets
      if (path === '/sounds' && method === 'GET') {
        return Response.json({ assets: this.soundAssets });
      }

      // POST /sounds - Add sound asset metadata
      if (path === '/sounds' && method === 'POST') {
        const meta = await request.json() as SoundAssetMeta;
        this.soundAssets.push(meta);
        await this.state.storage.put('sound-assets', this.soundAssets);
        await this.invalidateQuotaUsage();
        return Response.json({ success: true });
      }

      // DELETE /sounds/:soundId - Remove sound asset metadata
      if (path.startsWith('/sounds/') && method === 'DELETE') {
        const soundId = path.slice('/sounds/'.length);
        this.soundAssets = this.soundAssets.filter(a => a.soundId !== soundId);
        await this.state.storage.put('sound-assets', this.soundAssets);
        await this.invalidateQuotaUsage();
        return Response.json({ success: true });
      }

      // GET /cursors - List cursor assets
      if (path === '/cursors' && method === 'GET') {
        return Response.json({ assets: this.cursorAssets });
      }

      // POST /cursors - Add cursor asset metadata
      if (path === '/cursors' && method === 'POST') {
        const meta = await request.json() as CursorAssetMeta;
        this.cursorAssets.push(meta);
        await this.state.storage.put('cursor-assets', this.cursorAssets);
        await this.invalidateQuotaUsage();
        return Response.json({ success: true });
      }

      // DELETE /cursors/:cursorId - Remove cursor asset metadata
      if (path.startsWith('/cursors/') && method === 'DELETE') {
        const cursorId = path.slice('/cursors/'.length);
        this.cursorAssets = this.cursorAssets.filter(a => a.cursorId !== cursorId);
        await this.state.storage.put('cursor-assets', this.cursorAssets);
        await this.invalidateQuotaUsage();
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
          payload.summary,
          request.headers.get('X-API-Origin')
        );
        return Response.json({ success: true, profile: updatedProfile, versions: this.cssHistory });
      }

      // POST /css-history/:versionId/revert - Restore a previous CSS version
      if (path.startsWith('/css-history/') && path.endsWith('/revert') && method === 'POST') {
        const versionId = path.slice('/css-history/'.length, -'/revert'.length);
        const updatedProfile = await this.restoreCustomCSSVersion(
          versionId,
          request.headers.get('X-API-Origin')
        );
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
      // Validation/not-found failures carry their own status; anything else
      // is a genuine server fault and stays a 500.
      const status = error instanceof HttpError ? error.status : 500;
      return Response.json(
        { error: error instanceof Error ? error.message : 'Internal error' },
        { status }
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
    // The client-facing create must be a JSON object: a primitive, array, or
    // null would spread into nothing below and silently create a default
    // "Untitled" folder (POST /api/desktop/items with `42`, `[]`, or `"x"`).
    // Trusted internal creates go through createItemInternal and are
    // unaffected.
    if (typeof partial !== 'object' || partial === null || Array.isArray(partial)) {
      throw new HttpError(400, 'Item body must be a JSON object');
    }
    // A client create may only nest the item inside one of this desktop's
    // folders (or at the root) — a dangling or non-folder parent orphans it.
    this.assertValidParent(partial.parentId);
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
  /**
   * SECURITY: Link items render their `url` as an <a href> / are opened via the
   * website viewer. An unvalidated `javascript:` (or other non-web) scheme on a
   * PUBLIC item is stored XSS against any visitor who clicks it. Restrict item
   * URLs to http(s), the same rule profileLinks already enforce.
   *
   * A bad URL is client-supplied bad input, so it rejects with HttpError(400)
   * — never a plain Error that the fetch catch-all would answer with a 500.
   */
  private assertSafeItemUrl(url: unknown): void {
    if (url === undefined || url === null || url === '') return;
    if (typeof url !== 'string' || url.length > 2048) {
      throw new HttpError(400, 'Invalid item URL');
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HttpError(400, 'Invalid item URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, 'Item URL must use http(s)');
    }
  }

  /**
   * Validate a PATCH's requested item `type`. Re-asserting the current type
   * is a no-op; `image -> sticker` is the one allowlisted transition (see
   * ALLOWED_TYPE_TRANSITIONS); every other requested type is a client error
   * and is rejected with a 400 naming the transition instead of being
   * silently stripped — the old strip made an applied sticker look saved
   * while the server kept the plain image.
   */
  private assertValidTypeTransition(item: DesktopItem, requestedType: unknown): void {
    if (requestedType === undefined) return;
    if (requestedType === item.type) return;
    if (ALLOWED_TYPE_TRANSITIONS.has(`${item.type}->${requestedType}`)) return;
    throw new HttpError(
      400,
      `Cannot change item type from '${item.type}' to '${String(requestedType)}' (only image -> sticker is allowed)`
    );
  }

  /**
   * Shape validation for a client-supplied stickerConfig blob (see
   * StickerConfig in @eternalos/contracts). None existed before: any JSON
   * value was stored verbatim and echoed back to every visitor. Accept
   * exactly the shape the frontend writes (stickerUpload.ts and the
   * sticker context menu): a plain object holding the four numeric fields
   * below — unknown keys are rejected so junk never round-trips through
   * the DO snapshot.
   *
   * width/height carry no upper bound: the resize gesture compounds with
   * no natural ceiling, and a stored number is inert (client-rendered
   * pixels, no injection surface). rotation is bounded to ±360 degrees and
   * opacity to its documented 0..1 range — the UI only ever produces
   * values inside both.
   */
  private assertValidStickerConfig(config: unknown): void {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new HttpError(
        400,
        'Invalid stickerConfig: expected an object with width, height, rotation, and opacity'
      );
    }
    const record = config as Record<string, unknown>;
    const expectedKeys = new Set<keyof StickerConfig>(['width', 'height', 'rotation', 'opacity']);
    for (const key of Object.keys(record)) {
      if (!expectedKeys.has(key as keyof StickerConfig)) {
        throw new HttpError(400, `Invalid stickerConfig: unknown field "${key}"`);
      }
    }
    const bounds: Array<{ field: keyof StickerConfig; min: number; max?: number }> = [
      { field: 'width', min: 1 },
      { field: 'height', min: 1 },
      { field: 'rotation', min: -360, max: 360 },
      { field: 'opacity', min: 0, max: 1 },
    ];
    for (const { field, min, max } of bounds) {
      const value = record[field];
      if (
        typeof value !== 'number' || !Number.isFinite(value) ||
        value < min || (max !== undefined && value > max)
      ) {
        const range = max === undefined ? `at least ${min}` : `between ${min} and ${max}`;
        throw new HttpError(400, `Invalid stickerConfig.${field}: must be a finite number ${range}`);
      }
    }
  }

  /**
   * A client-supplied parentId must be null/undefined (the desktop root) or
   * the id of an existing folder on this desktop. Anything else — a missing
   * id, a non-folder item, a non-string — is a 400 rather than a silently
   * orphaned item that no window can ever show.
   */
  private assertValidParent(parentId: unknown): void {
    if (parentId === undefined || parentId === null) return;
    if (typeof parentId !== 'string') {
      throw new HttpError(400, 'parentId must be a folder id or null');
    }
    const parent = this.items.get(parentId);
    if (!parent) {
      throw new HttpError(400, `parentId '${parentId}' does not exist`);
    }
    if (parent.type !== 'folder') {
      throw new HttpError(400, `parentId '${parentId}' is not a folder`);
    }
  }

  private async createItemInternal(partial: Partial<DesktopItem>): Promise<DesktopItem> {
    const now = Date.now();
    const id = partial.id || crypto.randomUUID();

    // Prevent overwriting existing items
    if (this.items.has(id)) {
      throw new Error('Item with this ID already exists');
    }

    this.assertSafeItemUrl(partial.url);
    // Shape-check the sticker config on create too — the PATCH path
    // validates the same blob, so create must not be the bypass that
    // stores (and echoes to visitors) an arbitrary JSON value.
    if (partial.stickerConfig !== undefined) {
      this.assertValidStickerConfig(partial.stickerConfig);
    }

    const item: DesktopItem = {
      id,
      type: partial.type ?? 'folder',
      name: partial.name ?? 'Untitled',
      parentId: partial.parentId ?? null,
      position: partial.position ?? { x: 0, y: 0 },
      // SECURITY: default to private. Users must explicitly opt items into public
      // visibility via "Make Public" in the UI. Historical items stored with
      // isPublic: true keep their visibility; only new items without an explicit
      // flag start private.
      isPublic: partial.isPublic ?? false,
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
      appManifest: partial.appManifest,
      cartridgeRef: partial.cartridgeRef,
      grantedPermissions: partial.grantedPermissions,
      permissionGrantedAt: partial.permissionGrantedAt,
      grantedPermissionApprovals: partial.grantedPermissionApprovals,
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
   *
   * All-or-nothing: the whole batch is validated (entry shape, string id,
   * and every field validator — type transitions, stickerConfig, URL
   * safety) before the first item is touched, then all surviving entries
   * are applied and persisted together. A rejected batch answers 400 naming
   * the entry index and reason and applies nothing, so the in-memory map
   * can never disagree with storage through a half-applied batch (the old
   * mid-loop URL check applied earlier entries in memory, answered 500,
   * and never persisted them). Unknown IDs keep today's skip semantics:
   * their entries are silently ignored.
   */
  private async updateItems(patches: unknown): Promise<DesktopItem[]> {
    // The public route already refuses non-array patch bodies; this also
    // guards the DO's own endpoint for any other caller.
    if (!Array.isArray(patches)) {
      throw new HttpError(400, 'Patch body must be a JSON array of { id, updates } entries');
    }

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
      'appManifest',
      'grantedPermissions',
      'permissionGrantedAt',
      'grantedPermissionApprovals',
      'isTrashed',
      'trashedAt',
      'originalParentId',
    ];

    // Validation pass: shape-check every entry, filter its updates to the
    // allowlist, and run every field validator BEFORE any mutation. Only
    // entries that pass (and target an existing item) are planned for the
    // apply pass below — the same all-or-nothing contract the route-level
    // server-managed-fields gate upholds.
    const planned: Array<{ id: string; updates: Partial<DesktopItem> }> = [];
    for (let index = 0; index < patches.length; index++) {
      const entry: unknown = patches[index];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new HttpError(
          400,
          `Patch entry ${index}: expected an object with "id" and "updates" fields`,
        );
      }
      const record = entry as Record<string, unknown>;
      const { id, updates } = record;
      if (typeof id !== 'string') {
        throw new HttpError(400, `Patch entry ${index}: "id" must be a string`);
      }
      if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
        throw new HttpError(400, `Patch entry ${index}: "updates" must be an object`);
      }
      const updatesRecord = updates as Record<string, unknown>;

      // Unknown IDs keep today's skip semantics (silently ignored below).
      const item = this.items.get(id);
      if (!item) continue;

      // Filter updates to only allowed fields — the exact values the apply
      // pass will store, so the validators below see precisely what would
      // be persisted.
      const filteredUpdates: Partial<DesktopItem> = {};
      for (const field of ALLOWED_UPDATE_FIELDS) {
        if (updatesRecord[field] !== undefined) {
          (filteredUpdates as Record<string, unknown>)[field] =
            field === 'userTags'
              ? this.normalizeUserTags(updatesRecord[field])
              : updatesRecord[field];
        }
      }

      // `type` is deliberately not in ALLOWED_UPDATE_FIELDS: the validator
      // below only admits re-assertions of the current type or the
      // image -> sticker transition, so applying it cannot smuggle in any
      // other type change.
      if (updatesRecord.type !== undefined) {
        (filteredUpdates as Record<string, unknown>).type = updatesRecord.type;
      }

      try {
        if (filteredUpdates.parentId !== undefined) {
          this.assertValidParent(filteredUpdates.parentId);
        }
        this.assertValidTypeTransition(item, updatesRecord.type);
        if (updatesRecord.stickerConfig !== undefined) {
          this.assertValidStickerConfig(updatesRecord.stickerConfig);
        }
        // SECURITY: reject dangerous link URLs on edit too (see
        // createItemInternal).
        this.assertSafeItemUrl(filteredUpdates.url);
      } catch (error) {
        // The field validators reject with HttpError(400) — re-throw with
        // the entry index so the client knows which entry to fix. Anything
        // else is a genuine server fault and stays a 500.
        if (error instanceof HttpError) {
          throw new HttpError(400, `Patch entry ${index}: ${error.message}`);
        }
        throw error;
      }

      planned.push({ id, updates: filteredUpdates });
    }

    // Folder-cycle check against the state the whole batch would produce
    // (a batch can move A into B and B into A in two entries — each entry
    // alone looks fine against the current map). Any cycle rejects the whole
    // batch with a 400: the old per-entry check silently skipped the move
    // and still answered 200, so the client thought it was saved.
    const projectedParent = new Map<string, string | null | undefined>();
    for (const { id, updates } of planned) {
      if (updates.parentId !== undefined) projectedParent.set(id, updates.parentId);
    }
    if (projectedParent.size > 0) {
      const parentOf = (itemId: string): string | null | undefined =>
        projectedParent.has(itemId) ? projectedParent.get(itemId) : this.items.get(itemId)?.parentId;
      for (const [index, entry] of planned.entries()) {
        const { id, updates } = entry;
        if (updates.parentId === undefined || updates.parentId === null) continue;
        let ancestor: string | null | undefined = updates.parentId;
        const visited = new Set<string>();
        while (ancestor) {
          if (ancestor === id) {
            throw new HttpError(
              400,
              `Patch entry ${index}: cannot move folder '${id}' into itself or one of its subfolders`,
            );
          }
          if (visited.has(ancestor)) break; // pre-existing cycle elsewhere: stop walking
          visited.add(ancestor);
          ancestor = parentOf(ancestor);
        }
      }
    }

    // Uploaded custom icons are R2 objects the upload route writes without
    // telling the DO their size; a patch that points customIcon at one means
    // the stored usage total is stale.
    const touchesUploadedIcon = planned.some(({ id, updates }) =>
      updates.customIcon !== undefined && (
        String(updates.customIcon).startsWith('upload:') ||
        String(this.items.get(id)?.customIcon ?? '').startsWith('upload:')
      )
    );

    // Apply pass: every client-input validator has already run, so nothing
    // below can throw between the first and last mutation.
    const updated: DesktopItem[] = [];

    for (const { id, updates: filteredUpdates } of planned) {
      const item = this.items.get(id);
      if (!item) continue;

      const updatedItem = {
        ...item,
        ...filteredUpdates,
        updatedAt: Date.now(),
      };
      this.items.set(id, updatedItem);
      updated.push(updatedItem);
    }

    if (updated.length > 0) {
      await this.saveItems();
      this.broadcastItems();
    }
    if (touchesUploadedIcon) {
      await this.invalidateQuotaUsage();
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
    const removed: DesktopItem[] = [item];

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
          removed.push(child);
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
    await this.releaseItemsFromQuota(removed);
    this.broadcastItems();
    this.broadcastWindows();

    return { deleted: true, r2Key: item.r2Key, r2Keys };
  }

  /**
   * Compute public items (non-trashed, explicitly public).
   * SECURITY: requires isPublic === true. Items with undefined/null isPublic
   * are treated as private — only items a user has explicitly opted into
   * sharing appear in visitor mode.
   */
  private getPublicItemsFiltered(): DesktopItem[] {
    return Array.from(this.items.values()).filter(
      (item) => item.isPublic === true && !item.isTrashed
    );
  }

  /**
   * Compute visitor-visible data (items, windows, profile) without side effects
   */
  private getVisitorData(): { items: DesktopItem[]; windows: SavedWindowState[]; profile: VisitorProfile | null } {
    const items = this.getPublicItemsFiltered();
    const publicItemIds = new Set(items.map((i) => i.id));
    const windows = this.windows.filter(
      (w) => !w.contentId || publicItemIds.has(w.contentId)
    );
    // SECURITY: visitors (WebSocket snapshot, KV public snapshot,
    // /public-snapshot) only ever get the visitor-safe profile — never uid,
    // createdAt, isNewUser, or analyticsEnabled. Owners read the full
    // profile through GET /items and GET /profile.
    return { items, windows, profile: toVisitorProfile(this.profile) };
  }

  /**
   * Get visitor-visible items (for visitor mode).
   * Items must be explicitly public (isPublic === true) and not trashed to
   * appear in visitor mode. Users opt items IN to public visibility via the
   * UI's "Make Public" toggle.
   */
  private async getPublicSnapshot(): Promise<{
    items: DesktopItem[];
    profile: VisitorProfile | null;
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
    const wallpaperChanged = this.profile?.wallpaper !== profile.wallpaper;
    this.profile = profile;
    if (wallpaperChanged) await this.invalidateQuotaUsage();
    await this.state.storage.put('profile', profile);
    await this.syncPublicSnapshot();
    this.broadcastProfile();
  }

  /**
   * Update user profile (partial update)
   *
   * `apiOrigin` is the API's own origin, forwarded by routes that proxy a
   * client request (see the fetch handler). Appearance URL validation uses
   * it to accept same-origin absolute URLs (CursorEditor stores those);
   * without it only relative /api/... paths are accepted.
   */
  private async updateProfile(
    updates: Partial<UserProfile>,
    apiOrigin?: string | null
  ): Promise<UserProfile | null> {
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
      'variants',
      'customCSS',
      'isNewUser',
      'hideWatermark',
      'wallpaperMode',
      'bio',
      'profileLinks',
      'shareDescription',
      'analyticsEnabled',
      'soundPack',
    ];
    const filteredUpdates: Partial<UserProfile> = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        (filteredUpdates as Record<string, unknown>)[field] = updates[field];
      }
    }

    // Explicit clear semantics: a field sent as `null` means "remove this
    // saved field" — but ONLY for the appearance/customization fields the
    // frontend reset is meant to clear (CLEARABLE_APPEARANCE_FIELDS). `null`
    // for any other allowlisted field is a client error, so identity and
    // account fields can never be cleared; fields that never passed the
    // allowlist (uid, email, auth-related, unknown fields) keep today's
    // behavior of being silently ignored.
    for (const field of Object.keys(filteredUpdates) as (keyof UserProfile)[]) {
      if ((filteredUpdates as Record<string, unknown>)[field] === null
        && !CLEARABLE_APPEARANCE_FIELDS.has(field)) {
        throw new HttpError(400, `Field "${field}" cannot be cleared (null is only allowed for appearance fields)`);
      }
    }

    // SECURITY: Validate the `wallpaper` field. The string is stored as-is and
    // later parsed by handleWallpaperUpload to derive an R2 key for cleanup.
    // If we allowed an attacker to store a custom:<victim-uid>/... value here,
    // their next wallpaper upload would delete the victim's R2 object. The uid
    // segment MUST match this profile's own uid.
    if (typeof filteredUpdates.wallpaper === 'string') {
      const w = filteredUpdates.wallpaper;
      if (w.length > 200) {
        throw new Error('Invalid wallpaper value');
      }
      if (w.startsWith('custom:')) {
        const parts = w.slice('custom:'.length).split('/');
        const [storedUid, wallpaperId, filename] = parts;
        const segmentOk = (s: string | undefined) =>
          typeof s === 'string' && s.length > 0 && !s.includes('..') && !s.includes('\\');
        if (
          parts.length !== 3 ||
          storedUid !== this.profile.uid ||
          !segmentOk(wallpaperId) ||
          !segmentOk(filename) ||
          !/^[A-Za-z0-9._-]+$/.test(wallpaperId) ||
          !/^wallpaper\.(jpg|jpeg|png)$/i.test(filename)
        ) {
          throw new Error('Invalid wallpaper value');
        }
      } else if (!/^[A-Za-z0-9_-]{0,50}$/.test(w)) {
        // Non-custom wallpapers are built-in preset identifiers (e.g., "blue",
        // "classic") or the empty string. No slashes, colons, or URL schemes.
        throw new Error('Invalid wallpaper value');
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
            if (!urlValue.startsWith('/api/css-assets/') && !urlValue.startsWith('/api/wallpaper/') && !urlValue.startsWith('/api/icon/') && !urlValue.startsWith('/api/sounds/') && !urlValue.startsWith('/api/cursors/')) {
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
      // `null` is the explicit clear semantic (gated above to clearable
      // fields); every non-null value must still be a number in range.
      if (value !== undefined && value !== null) {
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

    // Server-side validation for designTokens blob. `null` (the clear
    // semantic) skips the shape checks below and removes the field.
    if (filteredUpdates.designTokens !== undefined && filteredUpdates.designTokens !== null) {
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
      // SECURITY: Same url() allowlist used for customCSS — only relative
      // /api/... paths or absolute URLs on the API's own origin are
      // accepted, preventing external resource loading (tracking pixels,
      // data exfiltration) via design tokens. See isFirstPartyAssetUrl.
      for (const [key, value] of Object.entries(dt)) {
        // Keys must be dot-path identifiers (alphanumeric + dots + hyphens)
        if (!/^[a-zA-Z][a-zA-Z0-9.\-]*$/.test(key) || key.length > 100) {
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
          // SECURITY: Reject CSS rule-terminating characters. The client
          // compiler interpolates token values into rule bodies
          // (`selector { prop: ${value}; }`), so `}` or `;` break out and let
          // an attacker inject arbitrary top-level CSS (UI redressing, fake
          // overlays). No registered token legitimately uses these chars.
          if (/[{};]/.test(value)) {
            throw new Error(`designToken value contains disallowed CSS punctuation for ${key}`);
          }
          // SECURITY: For keys whose compiler wraps the value in url(...)
          // (cursor.image.*), the value is a bare URL so the url() scan below
          // never sees it. Enforce the first-party allowlist directly so a
          // bare `https://evil.com/beacon.gif` can't become a stored beacon.
          if (key.startsWith('cursor.image.') && value.trim().length > 0) {
            // Cursor values may carry a hotspot suffix: "url|hotX|hotY"
            const bareUrl = value.split('|')[0].trim();
            if (!isFirstPartyAssetUrl(bareUrl, apiOrigin)) {
              throw new HttpError(400, `designToken ${key}: URL must reference first-party assets`);
            }
          }
          // Validate url() references — only first-party asset paths or
          // same-origin absolute URLs are accepted.
          const tokenUrlPattern = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
          let tokenUrlMatch: RegExpExecArray | null;
          while ((tokenUrlMatch = tokenUrlPattern.exec(value)) !== null) {
            const rawUrl = tokenUrlMatch[2];
            if (!isFirstPartyAssetUrl(rawUrl, apiOrigin)) {
              throw new HttpError(400, `designToken url() must reference first-party assets for ${key}`);
            }
          }
        }
      }
    }

    // Server-side validation for the variants blob. Variant selections pick
    // which conditional tokens apply (compiled client-side); the server only
    // stores and echoes them, so bound the shape to prevent an oversized or
    // malformed blob from being persisted and served to visitors. `null` (the
    // clear semantic) skips the shape checks and removes the field.
    if (filteredUpdates.variants !== undefined && filteredUpdates.variants !== null) {
      const v = filteredUpdates.variants;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error('Invalid variants format');
      }
      const entries = Object.entries(v);
      if (entries.length > 50) {
        throw new Error('Too many variant selections (max 50)');
      }
      for (const [key, value] of entries) {
        if (!/^[a-zA-Z][a-zA-Z0-9.\-_]*$/.test(key) || key.length > 64) {
          throw new Error(`Invalid variant key: ${key}`);
        }
        if (typeof value !== 'string' || value.length > 128) {
          throw new Error(`Invalid variant value for ${key}`);
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

      // Validate url() references — only relative first-party asset paths or
      // absolute URLs on the API's own origin are allowed.
      // NOTE: must stay in sync with the designTokens allowlist above and
      // the client sanitizer's ALLOWED_CSS_URL_PREFIXES — `/api/bazaar/assets/`
      // was previously missing here, so customCSS that referenced an installed
      // bazaar theme's assets passed the client but was rejected on save.
      const urlPattern = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlPattern.exec(css)) !== null) {
        // SECURITY: the old check compared only the base-parsed *pathname*
        // against the allowlist, so a cross-origin URL with an allowlisted-
        // path (https://evil.example/api/cursors/beacon.png) passed and was
        // stored. isFirstPartyAssetUrl makes origin equality authoritative.
        if (!isFirstPartyAssetUrl(urlMatch[2], apiOrigin)) {
          throw new HttpError(400, 'Custom CSS contains disallowed url() references');
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

    // Validate soundPack
    if (filteredUpdates.soundPack !== undefined) {
      if (filteredUpdates.soundPack !== null && typeof filteredUpdates.soundPack === 'object') {
        const pack = filteredUpdates.soundPack;
        if (typeof pack.name !== 'string' || pack.name.length > 100) {
          throw new Error('Sound pack name must be a string of max 100 characters');
        }
        if (pack.sounds && typeof pack.sounds === 'object') {
          for (const [, url] of Object.entries(pack.sounds)) {
            if (typeof url !== 'string' || !url.startsWith('/api/sounds/')) {
              throw new Error('Sound pack URLs must start with /api/sounds/');
            }
          }
        }
      }
    }

    // Apply the update. `null` values (gated above to the clearable
    // appearance fields) REMOVE the field from the stored profile, so
    // GET /profile reports it gone rather than echoing a stored null.
    const previousWallpaper = this.profile.wallpaper;
    const nextProfile = { ...this.profile } as UserProfile & Record<string, unknown>;
    for (const [field, value] of Object.entries(filteredUpdates)) {
      if (value === null) {
        delete nextProfile[field];
      } else {
        nextProfile[field] = value;
      }
    }
    this.profile = nextProfile;

    await this.state.storage.put('profile', this.profile);
    // A custom wallpaper is an R2 object the upload route writes without
    // telling the DO its size: a wallpaper change makes the usage total stale.
    if (filteredUpdates.wallpaper !== undefined && filteredUpdates.wallpaper !== previousWallpaper) {
      await this.invalidateQuotaUsage();
    }
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
    summary?: string,
    apiOrigin?: string | null
  ): Promise<UserProfile | null> {
    const updatedProfile = await this.updateProfile({ customCSS: css }, apiOrigin);
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

  private async restoreCustomCSSVersion(
    versionId: string,
    apiOrigin?: string | null
  ): Promise<UserProfile | null> {
    const version = this.cssHistory.find((entry) => entry.id === versionId);
    if (!version) {
      // A missing version is a client error (bad/unknown ID), not a server
      // fault — answer 404 instead of the old blanket 500.
      throw new HttpError(404, 'Custom CSS version not found');
    }

    const updatedProfile = await this.updateProfile({ customCSS: version.css }, apiOrigin);
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
  private async saveWindows(windowData: unknown): Promise<void> {
    // The body is client input (the public route forwards it): anything but
    // an array of objects with a string id is a 400, never a 500 from
    // `.slice`/property access on a non-array.
    if (!Array.isArray(windowData)) {
      throw new HttpError(400, 'Window state must be a JSON array');
    }
    const entries = windowData.slice(0, MAX_WINDOWS);
    entries.forEach((w: unknown, index) => {
      if (typeof w !== 'object' || w === null || Array.isArray(w)) {
        throw new HttpError(400, `Window ${index}: expected an object`);
      }
      const id = (w as { id?: unknown }).id;
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
        throw new HttpError(400, `Window ${index}: "id" must be a non-empty string`);
      }
    });
    // Limit to MAX_WINDOWS windows to prevent storage abuse
    this.windows = (entries as SavedWindowState[]).map((w) => ({
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
      await this.releaseItemsFromQuota(trashedItems);
      this.broadcastItems();
    }

    return { deleted: deletedCount, r2Keys };
  }

  /**
   * Cleanup old trashed items - permanently delete items trashed more than 30 days ago
   */
  /**
   * Account hard-deletion. Clears every piece of persisted desktop state and
   * resets in-memory caches so a still-live instance cannot rewrite stale data.
   * Idempotent: safe to call on an already-empty desktop.
   */
  private async purgeAll(): Promise<{ purged: true; items: number }> {
    const itemCount = this.items.size;

    await this.state.storage.deleteAll();

    this.items.clear();
    this.profile = null;
    this.windows = [];
    this.cssAssets = [];
    this.cssHistory = [];
    this.soundAssets = [];
    this.cursorAssets = [];
    this.pendingUploadBytes = 0;
    this.quotaUsage = null;
    this.quotaGeneration++;
    // Keep `initialized = true`: storage is now authoritatively empty, so there
    // is nothing to re-read, and we must not resurrect state from a stale load.
    this.initialized = true;

    return { purged: true, items: itemCount };
  }

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
      await this.releaseItemsFromQuota(oldTrashedItems);
      this.broadcastItems();
    }

    return { deleted: deletedCount, r2Keys };
  }

  /**
   * Bytes an item's file counts for in the running usage counter: its
   * fileSize when it owns an R2 object under this user's prefix, else null.
   */
  private countedFileBytes(item: DesktopItem): number | null {
    const uid = this.profile?.uid;
    if (!uid || typeof item.r2Key !== 'string' || !item.r2Key.startsWith(`${uid}/`)) return null;
    return typeof item.fileSize === 'number' && Number.isFinite(item.fileSize) && item.fileSize >= 0
      ? item.fileSize
      : null;
  }

  /** Subtract permanently deleted items' files from the usage counter. */
  private async releaseItemsFromQuota(items: DesktopItem[]): Promise<void> {
    this.quotaSettleAt = Date.now() + QUOTA_SETTLE_MS;
    let bytes = 0;
    let objects = 0;
    for (const item of items) {
      const counted = this.countedFileBytes(item);
      if (counted === null) continue;
      bytes += counted;
      objects++;
    }
    if (objects > 0) await this.adjustQuotaUsage(-bytes, -objects);
  }

  /**
   * Apply an exact delta to the running usage counter. With no counter yet
   * there is nothing to adjust: the next read rebuilds it from R2.
   */
  private async adjustQuotaUsage(deltaBytes: number, deltaObjects: number): Promise<void> {
    this.quotaGeneration++;
    if (!this.quotaUsage) return;
    this.quotaUsage = {
      used: Math.max(0, this.quotaUsage.used + deltaBytes),
      objects: Math.max(0, this.quotaUsage.objects + deltaObjects),
      computedAt: this.quotaUsage.computedAt,
    };
    await this.state.storage.put(QUOTA_USAGE_KEY, this.quotaUsage);
  }

  /** Drop the counter so the next quota read rebuilds it from R2. */
  private async invalidateQuotaUsage(): Promise<void> {
    this.quotaGeneration++;
    this.quotaSettleAt = Date.now() + QUOTA_SETTLE_MS;
    if (!this.quotaUsage) return;
    this.quotaUsage = null;
    await this.state.storage.delete(QUOTA_USAGE_KEY);
  }

  /** Sum every R2 object under `${uid}/` (the one-off rebuild). */
  private async listR2Usage(uid: string): Promise<QuotaUsage> {
    let used = 0;
    let objects = 0;
    let cursor: string | undefined;
    do {
      const result = await this.env.ETERNALOS_FILES.list({ prefix: `${uid}/`, cursor });
      for (const object of result.objects) {
        used += object.size;
        objects++;
      }
      cursor = result.truncated ? result.cursor : undefined;
    } while (cursor);
    return { used, objects, computedAt: Date.now() };
  }

  /**
   * Current usage from the running counter, rebuilt from R2 when it is
   * missing or older than QUOTA_RECOMPUTE_MS. Concurrent rebuilds share one
   * listing. A rebuild is only persisted when nothing changed while it ran
   * (no adjust/invalidate — an R2 listing can't tell whether a racing write
   * landed before or after it) and no upload was in flight (its object may
   * already be in R2 while its commit, which adds the bytes again, is still
   * to come). Otherwise the result answers this read and the next read
   * rebuilds again.
   */
  private async currentQuotaUsage(uid: string): Promise<QuotaUsage> {
    const usage = this.quotaUsage;
    if (usage && Date.now() - usage.computedAt < QUOTA_RECOMPUTE_MS) return usage;
    if (!this.quotaRebuild) {
      const generation = this.quotaGeneration;
      const uploadsInFlight = this.pendingUploadBytes > 0;
      const unsettled = Date.now() < this.quotaSettleAt;
      this.quotaRebuild = (async () => {
        try {
          const rebuilt = await this.listR2Usage(uid);
          if (
            generation === this.quotaGeneration && !unsettled &&
            !uploadsInFlight && this.pendingUploadBytes === 0
          ) {
            this.quotaUsage = rebuilt;
            await this.state.storage.put(QUOTA_USAGE_KEY, rebuilt);
          }
          return rebuilt;
        } finally {
          this.quotaRebuild = null;
        }
      })();
    }
    return this.quotaRebuild;
  }

  /**
   * Get storage quota usage: every R2 object under the user's prefix —
   * item files (trashed ones included, they still occupy R2 until emptied,
   * which closes the trash-cycling bypass), wallpapers, icons, and assets —
   * read from the running counter (see QUOTA_USAGE_KEY).
   */
  private async getQuota(): Promise<QuotaInfo> {
    if (this.profile?.uid) {
      const usage = await this.currentQuotaUsage(this.profile.uid);
      return {
        used: usage.used,
        limit: DEFAULT_QUOTA_BYTES,
        remaining: Math.max(0, DEFAULT_QUOTA_BYTES - usage.used),
        itemCount: usage.objects,
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
    // Visitor-safe fields only (see getVisitorData).
    this.broadcastToVisitors({ type: 'profile', profile: toVisitorProfile(this.profile) });
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
