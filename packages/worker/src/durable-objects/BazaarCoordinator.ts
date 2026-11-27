/**
 * BazaarCoordinator — the Bazaar catalogue.
 *
 * One instance (name {@link BAZAAR_CATALOG_NAME}) owns everything that used to
 * be read-modify-written in KV:
 *   - a compact summary row per listed pack (what browse / my-packs show),
 *   - the per-author and per-type listings (SQL indexes over those rows),
 *   - install counts, deduplicated per user,
 *   - tombstones for deleted packs, so a late install or republish can never
 *     bring a deleted pack back.
 *
 * Every mutation is a synchronous SQLite statement inside this single object,
 * so concurrent publishes / deletes / installs are serialized for free.
 * Full pack records (config, assets) stay in KV at `bazaar:pack:{id}`; this
 * object never writes them.
 *
 * Migration: on first start the catalogue is built once from the legacy KV
 * type indexes (`bazaar:type:{type}`) and pack records. Those legacy keys are
 * left in place but are no longer updated.
 */

import type { Env } from '../index';

export const BAZAAR_CATALOG_NAME = 'catalog';

/** Pack types the legacy KV indexes were kept for (migration source). */
const LEGACY_INDEX_TYPES = ['cursor', 'icon', 'sound', 'effect', 'skin', 'game'];

export const BROWSE_DEFAULT_LIMIT = 20;
export const BROWSE_MAX_LIMIT = 50;

/** What browse and my-packs return per pack: the pack minus config/assets. */
export interface BazaarPackSummary {
  packId: string;
  type: string;
  name: string;
  description: string;
  authorUid: string;
  authorUsername: string;
  version: string;
  previewUrl: string;
  createdAt: number;
  updatedAt: number;
  installs: number;
  tags: string[];
  manifestVersion?: number;
  parentPackId?: string;
}

type SummaryInput = Omit<BazaarPackSummary, 'installs'> & { installs?: number };

interface BrowseResult {
  packs: BazaarPackSummary[];
  total: number;
  nextCursor?: string;
}

type Row = Record<string, SqlStorageValue>;

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Keep only summary fields, with safe types. Returns null if unusable. */
export function toSummary(raw: unknown): SummaryInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const packId = str(p.packId);
  const type = str(p.type);
  const authorUid = str(p.authorUid);
  if (!packId || !type || !authorUid) return null;
  const summary: SummaryInput = {
    packId,
    type,
    name: str(p.name),
    description: str(p.description),
    authorUid,
    authorUsername: str(p.authorUsername),
    version: str(p.version),
    previewUrl: str(p.previewUrl),
    createdAt: num(p.createdAt),
    updatedAt: num(p.updatedAt),
    tags: Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : [],
  };
  if (typeof p.installs === 'number' && Number.isFinite(p.installs) && p.installs >= 0) {
    summary.installs = Math.floor(p.installs);
  }
  if (typeof p.manifestVersion === 'number') summary.manifestVersion = p.manifestVersion;
  if (typeof p.parentPackId === 'string') summary.parentPackId = p.parentPackId;
  return summary;
}

function searchText(s: SummaryInput): string {
  // \u0001 separates fields so a query can't match across a boundary.
  return [s.name, s.description, s.authorUsername, ...s.tags].join('\u0001').toLowerCase();
}

/** Cursor = position after the last row of a page, in browse order. */
export function encodeCursor(installs: number, createdAt: number, packId: string): string {
  return btoa(JSON.stringify([installs, createdAt, packId]));
}

export function decodeCursor(cursor: string): [number, number, string] | null {
  try {
    const value = JSON.parse(atob(cursor)) as unknown;
    if (
      Array.isArray(value) && value.length === 3
      && Number.isFinite(value[0]) && Number.isFinite(value[1]) && typeof value[2] === 'string'
    ) {
      return [value[0] as number, value[1] as number, value[2] as string];
    }
  } catch {
    // fall through
  }
  return null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class BazaarCoordinator {
  private state: DurableObjectState;
  private env: Env;
  private sql: SqlStorage;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    void state.blockConcurrencyWhile(async () => {
      this.createSchema();
      await this.migrateFromKv();
    });
  }

  private createSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS packs (
      pack_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      author_uid TEXT NOT NULL,
      installs INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      search TEXT NOT NULL,
      data TEXT NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS packs_by_rank ON packs (installs DESC, created_at DESC, pack_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS packs_by_type ON packs (type, installs DESC, created_at DESC, pack_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS packs_by_author ON packs (author_uid, created_at DESC)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS installs (
      pack_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      installed_at INTEGER NOT NULL,
      PRIMARY KEY (pack_id, uid)
    )`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS deleted (pack_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  /** Build the catalogue once from the legacy KV type indexes. */
  private async migrateFromKv(): Promise<void> {
    const done = this.sql.exec("SELECT value FROM meta WHERE key = 'migrated'").toArray();
    if (done.length > 0) return;

    const ids = new Set<string>();
    for (const type of LEGACY_INDEX_TYPES) {
      const indexStr = await this.env.DESKTOP_KV.get(`bazaar:type:${type}`);
      if (!indexStr) continue;
      try {
        const parsed = JSON.parse(indexStr) as unknown;
        if (Array.isArray(parsed)) {
          for (const id of parsed) if (typeof id === 'string' && id) ids.add(id);
        }
      } catch {
        // Corrupt legacy index: skip it.
      }
    }

    const all = [...ids];
    const BATCH = 25;
    for (let i = 0; i < all.length; i += BATCH) {
      const batch = all.slice(i, i + BATCH);
      const records = await Promise.all(batch.map((id) => this.env.DESKTOP_KV.get(`bazaar:pack:${id}`)));
      for (const record of records) {
        if (!record) continue;
        let summary: SummaryInput | null = null;
        try { summary = toSummary(JSON.parse(record)); } catch { summary = null; }
        if (summary) this.insertSummary(summary);
      }
    }

    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated', ?)", String(Date.now()));
  }

  private insertSummary(summary: SummaryInput): void {
    const { installs = 0, ...data } = summary;
    this.sql.exec(
      `INSERT OR IGNORE INTO packs (pack_id, type, author_uid, installs, created_at, search, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      summary.packId, summary.type, summary.authorUid, installs, summary.createdAt,
      searchText(summary), JSON.stringify(data),
    );
  }

  private rowToSummary(row: Row): BazaarPackSummary {
    const data = JSON.parse(String(row.data)) as Omit<BazaarPackSummary, 'installs'>;
    return { ...data, installs: Number(row.installs) };
  }

  private isDeleted(packId: string): boolean {
    return this.sql.exec('SELECT 1 FROM deleted WHERE pack_id = ?', packId).toArray().length > 0;
  }

  private authorCount(uid: string): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM packs WHERE author_uid = ?', uid).one().n);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET') {
        switch (url.pathname) {
          case '/browse': return Response.json(this.browse(url.searchParams));
          case '/author': return Response.json({ packs: this.byAuthor(url.searchParams.get('uid') ?? '') });
          case '/count': return Response.json({ count: this.authorCount(url.searchParams.get('uid') ?? '') });
          case '/state': return Response.json(this.packState(url.searchParams.get('packId') ?? ''));
        }
      } else if (request.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = await request.json() as Record<string, unknown>;
        } catch {
          return Response.json({ error: 'Invalid request' }, { status: 400 });
        }
        switch (url.pathname) {
          case '/add': return this.add(body);
          case '/update': return this.update(body);
          case '/remove': return this.remove(body);
          case '/remove-author': return this.removeAuthor(body);
          case '/install': return this.install(body);
        }
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('BazaarCoordinator error:', error);
      return Response.json({ error: 'Bazaar catalogue error' }, { status: 500 });
    }
  }

  private browse(params: URLSearchParams): BrowseResult {
    const type = params.get('type');
    // Strip the field separator so it can't be used to match across fields.
    const query = (params.get('q') ?? '').replace(/\u0001/g, '').trim().toLowerCase();
    const rawLimit = parseInt(params.get('limit') ?? '', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, BROWSE_MAX_LIMIT)
      : BROWSE_DEFAULT_LIMIT;
    const rawOffset = parseInt(params.get('offset') ?? '0', 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const cursor = params.get('cursor') ? decodeCursor(params.get('cursor') ?? '') : null;

    const where: string[] = [];
    const bindings: SqlStorageValue[] = [];
    if (type) { where.push('type = ?'); bindings.push(type); }
    if (query) { where.push("search LIKE ? ESCAPE '\\'"); bindings.push(`%${escapeLike(query)}%`); }

    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM packs ${filter}`, ...bindings).one().n);

    const pageWhere = [...where];
    const pageBindings = [...bindings];
    if (cursor) {
      const [installs, createdAt, packId] = cursor;
      pageWhere.push('(installs < ? OR (installs = ? AND (created_at < ? OR (created_at = ? AND pack_id > ?))))');
      pageBindings.push(installs, installs, createdAt, createdAt, packId);
    }
    const pageFilter = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
    // Fetch one extra row to know whether another page exists.
    const rows = this.sql.exec(
      `SELECT pack_id, installs, created_at, data FROM packs ${pageFilter}
       ORDER BY installs DESC, created_at DESC, pack_id ASC LIMIT ? OFFSET ?`,
      ...pageBindings, limit + 1, cursor ? 0 : offset,
    ).toArray();

    const pageRows = rows.slice(0, limit);
    const result: BrowseResult = { packs: pageRows.map((row) => this.rowToSummary(row)), total };
    if (rows.length > limit) {
      const last = pageRows[pageRows.length - 1];
      result.nextCursor = encodeCursor(Number(last.installs), Number(last.created_at), String(last.pack_id));
    }
    return result;
  }

  private byAuthor(uid: string): BazaarPackSummary[] {
    return this.sql.exec(
      'SELECT installs, data FROM packs WHERE author_uid = ? ORDER BY created_at DESC, pack_id ASC',
      uid,
    ).toArray().map((row) => this.rowToSummary(row));
  }

  private packState(packId: string): { listed: boolean; deleted: boolean; installs?: number } {
    const row = this.sql.exec('SELECT installs FROM packs WHERE pack_id = ?', packId).toArray()[0];
    if (row) return { listed: true, deleted: false, installs: Number(row.installs) };
    return { listed: false, deleted: this.isDeleted(packId) };
  }

  /** List a new pack. `maxPerAuthor` is enforced atomically. */
  private add(body: Record<string, unknown>): Response {
    const summary = toSummary(body.summary);
    if (!summary) return Response.json({ error: 'Invalid pack summary' }, { status: 400 });
    if (this.isDeleted(summary.packId)) {
      return Response.json({ error: 'Pack not found' }, { status: 404 });
    }
    const maxPerAuthor = num(body.maxPerAuthor, Infinity);
    if (this.authorCount(summary.authorUid) >= maxPerAuthor) {
      return Response.json({ error: `Max ${maxPerAuthor} packs per user`, code: 'pack_limit' }, { status: 409 });
    }
    this.insertSummary({ ...summary, installs: 0 });
    return Response.json({ ok: true });
  }

  /** Refresh a listed pack's display fields (republish). Installs are kept. */
  private update(body: Record<string, unknown>): Response {
    const summary = toSummary(body.summary);
    if (!summary) return Response.json({ error: 'Invalid pack summary' }, { status: 400 });
    const existing = this.sql.exec(
      'SELECT author_uid, created_at, installs FROM packs WHERE pack_id = ?', summary.packId,
    ).toArray()[0];
    if (!existing) {
      return Response.json(
        { error: 'Pack not found', deleted: this.isDeleted(summary.packId) },
        { status: 404 },
      );
    }
    if (existing.author_uid !== summary.authorUid) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }
    const data: SummaryInput = { ...summary, createdAt: Number(existing.created_at) };
    delete data.installs;
    this.sql.exec(
      'UPDATE packs SET search = ?, data = ? WHERE pack_id = ?',
      searchText(data), JSON.stringify(data), summary.packId,
    );
    return Response.json({ ok: true, installs: Number(existing.installs) });
  }

  /** Unlist + tombstone a pack. With `authorUid`, only that author may. */
  private remove(body: Record<string, unknown>): Response {
    const packId = str(body.packId);
    if (!packId) return Response.json({ error: 'Invalid request' }, { status: 400 });
    const authorUid = typeof body.authorUid === 'string' ? body.authorUid : null;
    const row = this.sql.exec('SELECT author_uid FROM packs WHERE pack_id = ?', packId).toArray()[0];
    if (row && authorUid !== null && row.author_uid !== authorUid) {
      return Response.json({ error: 'Not authorized' }, { status: 403 });
    }
    this.tombstone(packId);
    return Response.json({ removed: Boolean(row) });
  }

  private tombstone(packId: string): void {
    this.sql.exec('DELETE FROM packs WHERE pack_id = ?', packId);
    this.sql.exec('DELETE FROM installs WHERE pack_id = ?', packId);
    this.sql.exec('INSERT OR IGNORE INTO deleted (pack_id, deleted_at) VALUES (?, ?)', packId, Date.now());
  }

  /** Account purge: unlist every pack by an author; returns their ids. */
  private removeAuthor(body: Record<string, unknown>): Response {
    const uid = str(body.uid);
    if (!uid) return Response.json({ error: 'Invalid request' }, { status: 400 });
    const ids = this.sql.exec('SELECT pack_id FROM packs WHERE author_uid = ?', uid)
      .toArray().map((row) => String(row.pack_id));
    for (const id of ids) this.tombstone(id);
    return Response.json({ packIds: ids });
  }

  /** Count an install once per user. Deleted / unlisted packs are 404. */
  private install(body: Record<string, unknown>): Response {
    const packId = str(body.packId);
    const uid = str(body.uid);
    if (!packId || !uid) return Response.json({ error: 'Invalid install request' }, { status: 400 });
    const row = this.sql.exec('SELECT installs FROM packs WHERE pack_id = ?', packId).toArray()[0];
    if (!row) return Response.json({ error: 'Pack not found' }, { status: 404 });

    const seen = this.sql.exec('SELECT 1 FROM installs WHERE pack_id = ? AND uid = ?', packId, uid).toArray();
    if (seen.length > 0) {
      return Response.json({ installs: Number(row.installs), counted: false });
    }
    this.sql.exec('INSERT INTO installs (pack_id, uid, installed_at) VALUES (?, ?, ?)', packId, uid, Date.now());
    this.sql.exec('UPDATE packs SET installs = installs + 1 WHERE pack_id = ?', packId);
    return Response.json({ installs: Number(row.installs) + 1, counted: true });
  }
}
