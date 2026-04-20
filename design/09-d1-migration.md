# 09 — KV → D1 migration plan

> Concrete, zero-downtime migration from the current KV-blob indexes (bazaar packs, author indexes, type indexes) to D1. Unblocks [02-social-v1.md](02-social-v1.md) (which also uses D1 as its spine) and scales bazaar past ~5k packs.
> Parent: [ROADMAP.md](ROADMAP.md) §P2 #22–23, social-v1 phase A.

## Why now

The current bazaar indexes are JSON blobs in KV:

- `bazaar:pack:{packId}` — one pack record (BazaarPack JSON).
- `bazaar:type:{type}` — single JSON array of packIds of that type, rewritten on every publish/install/delete.
- `bazaar:author:{uid}` — single JSON array of packIds by author.

Evidence from the research agent: this pattern breaks at ~5k packs per author or per type. KV value size cap is 25 MB but reads grow linear; writes are not atomic (concurrent publishes race); secondary indexes (by tag, by date) require scanning every pack; no aggregate queries. Bazaar grows every day; every day we're deeper in this hole.

D1 fixes all of it for free on the paid plan (10 GB / DB, 50k DBs / account, SQLite FTS5, global read replication). [02-social-v1.md](02-social-v1.md) already depends on D1 for follows / posts / forums; migrating bazaar at the same time keeps the schema coherent.

## Goals

1. Bazaar data moved to D1 with **zero downtime** — no read or write hole during cutover.
2. Existing clients keep working without frontend changes (API contracts unchanged).
3. Old KV keys remain readable for 30 days post-cutover as a rollback path.
4. A single migration script that is safe to re-run.
5. Social v1 tables land in the same D1 database alongside bazaar — one binding, one schema namespace.

## Non-goals

- Migrating away from KV globally. Auth/session data stays in KV — it's the right tool for that workload.
- Migrating R2 content. Bazaar blobs stay at `bazaar/{packId}/*` in R2, unchanged.
- Enabling D1 read replicas manually. It's automatic per CF docs.

## Schema (bazaar subset, per [02-social-v1.md](02-social-v1.md))

```sql
CREATE TABLE packs (
  pack_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                    -- 'cursor' | 'icon' | 'sound' | 'effect' | 'skin' | 'app'
  name TEXT NOT NULL,
  description TEXT,
  author_uid TEXT NOT NULL,
  author_username TEXT NOT NULL,          -- denormalized for quick browse rendering
  version TEXT NOT NULL,
  parent_pack_id TEXT,                    -- for forks
  preview_url TEXT,
  installs INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  manifest_version INTEGER,               -- 1 for .estheme packs, null for legacy
  moderation_status TEXT NOT NULL DEFAULT 'approved',  -- legacy packs default approved; new ones go through moderation pipeline
  FOREIGN KEY (parent_pack_id) REFERENCES packs(pack_id)
);

CREATE INDEX idx_packs_type_installs ON packs(type, installs DESC, created_at DESC);
CREATE INDEX idx_packs_author_created ON packs(author_uid, created_at DESC);
CREATE INDEX idx_packs_parent ON packs(parent_pack_id);

CREATE TABLE pack_tags (
  pack_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (pack_id, tag),
  FOREIGN KEY (pack_id) REFERENCES packs(pack_id) ON DELETE CASCADE
);

CREATE INDEX idx_pack_tags_tag ON pack_tags(tag);

CREATE VIRTUAL TABLE packs_fts USING fts5(
  pack_id UNINDEXED,
  name,
  description,
  author_username,
  tags_joined,                            -- space-separated tags (rebuilt on tag changes)
  content='packs',
  content_rowid='rowid'
);
```

Keep D1 bindings named generally — the same DB will later hold `users`, `follows`, `posts`, `threads`, etc. per social v1.

```toml
# wrangler.toml
[[d1_databases]]
binding = "SOCIAL_DB"
database_name = "eternalos-social"
database_id = "<...>"
```

## Phases

### Phase 0 — preparation (day 1, no user impact)

1. Create D1 database:
   ```bash
   wrangler d1 create eternalos-social
   # record the ID; update wrangler.toml
   ```
2. Apply schema via migration file `packages/worker/migrations/001-bazaar.sql`:
   ```bash
   wrangler d1 migrations apply eternalos-social --local
   wrangler d1 migrations apply eternalos-social
   ```
3. Add `SOCIAL_DB` binding to `Env` type.
4. Deploy worker (no read/write code changes yet — binding is present but unused).

### Phase 1 — dual-write (day 2–3)

Every publish, install, and delete mutates **both** KV and D1. Reads still come from KV — D1 is silently populated for validation.

Edit `handleBazaarPublish` and `handleBazaarPublishEstheme`:

```typescript
// after KV writes, also write to D1
await env.SOCIAL_DB.batch([
  env.SOCIAL_DB.prepare(
    `INSERT OR REPLACE INTO packs
     (pack_id, type, name, description, author_uid, author_username, version,
      parent_pack_id, preview_url, installs, likes, created_at, updated_at,
      manifest_version, moderation_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    pack.packId, pack.type, pack.name, pack.description ?? '',
    pack.authorUid, pack.authorUsername, pack.version,
    pack.parentPackId ?? null, pack.previewUrl,
    pack.installs, pack.likes ?? 0,
    pack.createdAt, pack.updatedAt,
    pack.manifestVersion ?? null,
    pack.moderationStatus ?? 'approved'
  ),
  // Tag rows
  ...(pack.tags ?? []).map((tag) =>
    env.SOCIAL_DB.prepare(
      `INSERT OR IGNORE INTO pack_tags (pack_id, tag) VALUES (?, ?)`
    ).bind(pack.packId, tag)
  ),
]);
```

Same for `handleBazaarInstall` (bump install counter) and `handleBazaarDelete` (hard delete + CASCADE cleans tags).

**Invariant**: any mutation that writes to KV also writes to D1 **in the same handler, in the same request**. Both must succeed or we must fail the request.

To enforce: dual-write helper wraps both writes. On D1 failure, log + continue (don't fail user requests while dual-writing is experimental). Once Phase 3 cutover happens, reverse: D1 failures fail the request; KV writes are best-effort.

### Phase 2 — backfill (day 3)

A one-shot script walks the KV `bazaar:pack:` prefix and inserts into D1. Safe to re-run (uses `INSERT OR REPLACE` + tag dedup).

Location: `packages/worker/scripts/backfill-bazaar.ts`. Invoke from a protected admin endpoint or via `wrangler d1 execute` + a wrangler dev command.

```typescript
// Pseudocode
async function backfillBazaar(env: Env): Promise<{ migrated: number; errors: number }> {
  let cursor: string | undefined;
  let migrated = 0;
  let errors = 0;

  do {
    const list = await env.DESKTOP_KV.list({ prefix: 'bazaar:pack:', cursor });
    for (const key of list.keys) {
      try {
        const packJson = await env.DESKTOP_KV.get(key.name);
        if (!packJson) continue;
        const pack = JSON.parse(packJson) as BazaarPack;

        await env.SOCIAL_DB.batch([
          env.SOCIAL_DB.prepare(`INSERT OR REPLACE INTO packs /* ... */`).bind(/* ... */),
          ...pack.tags.map((tag) =>
            env.SOCIAL_DB.prepare(`INSERT OR IGNORE INTO pack_tags (pack_id, tag) VALUES (?, ?)`).bind(pack.packId, tag)
          ),
        ]);
        migrated++;
      } catch (e) {
        console.error('backfill error for', key.name, e);
        errors++;
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return { migrated, errors };
}
```

Run after Phase 1 lands so the write paths are already dual. Any packs created after Phase 1 are already in D1; the backfill covers pre-existing packs.

Rebuild FTS after backfill:

```sql
INSERT INTO packs_fts (rowid, pack_id, name, description, author_username, tags_joined)
SELECT p.rowid, p.pack_id, p.name, p.description, p.author_username,
       COALESCE((SELECT GROUP_CONCAT(tag, ' ') FROM pack_tags WHERE pack_id = p.pack_id), '')
FROM packs p;
```

Verify:
```bash
# KV count
wrangler kv:key list --prefix "bazaar:pack:" --namespace-id <id> | jq 'length'
# D1 count
wrangler d1 execute eternalos-social --command "SELECT COUNT(*) FROM packs"
# Should match.
```

### Phase 3 — cutover reads (day 4)

Flip `handleBazaarBrowse`, `handleBazaarGetPack`, `handleBazaarMyPacks` to read from D1. Keep KV reads as a fallback if D1 returns nothing — belt and suspenders for 24h post-cutover.

```typescript
export async function handleBazaarBrowse(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const query = url.searchParams.get('q');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const pageSize = 20;

  let sql = `SELECT * FROM packs WHERE moderation_status = 'approved'`;
  const params: unknown[] = [];

  if (type) { sql += ` AND type = ?`; params.push(type); }

  if (query) {
    // Use FTS5 for content search
    sql = `
      SELECT p.* FROM packs p
      JOIN packs_fts fts ON fts.rowid = p.rowid
      WHERE packs_fts MATCH ? AND p.moderation_status = 'approved'
      ${type ? 'AND p.type = ?' : ''}
    `;
    params.unshift(query);  // FTS query first
  }

  sql += ` ORDER BY installs DESC, created_at DESC LIMIT ? OFFSET ?`;
  params.push(pageSize, (page - 1) * pageSize);

  const result = await env.SOCIAL_DB.prepare(sql).bind(...params).all<PackRow>();
  const packs = await hydratePacks(env, result.results);

  return Response.json({ packs, page, pageSize, total: result.results.length });
}
```

Monitor Sentry for 24h. Any query that returns unexpectedly empty or errors: alarm fires → revert to KV reads while we investigate.

### Phase 4 — KV write deprecation (day 5, after verification)

Switch the dual-write to D1-primary:

- D1 write succeeds → proceed.
- D1 write fails → fail the request (user retries, no silent drops).
- KV write: best-effort, fire-and-forget. Shadow writes continue for 30 days as a rollback path.

### Phase 5 — KV key removal (day 30+)

After 30 days of stable D1 reads + writes, delete KV keys:

```bash
# Dry-run
wrangler kv:key list --prefix "bazaar:type:" | tee /tmp/to-delete.txt
# ...inspect...
# Actual delete (bulk)
wrangler kv:bulk delete --namespace-id <id> --filename /tmp/to-delete.txt
```

Delete in this order:
1. `bazaar:type:*` — derived index, safe to drop first.
2. `bazaar:author:*` — same.
3. `bazaar:pack:*` — last. Keep these 60 days minimum for full rollback safety.

Verify nothing breaks for 24h between each step.

## Rollback plan

**At any phase**:

- **Phase 1** (dual-write): Undo = revert code to KV-only. D1 data is orphaned but harmless.
- **Phase 2** (backfill): Undo = revert code. D1 rows are idempotent (INSERT OR REPLACE), so no corruption.
- **Phase 3** (read cutover): If a bug surfaces, flip a `READ_FROM_D1` env var off. Reads revert to KV (which is still authoritative from dual-write).
- **Phase 4** (D1-primary): Rollback requires replaying any D1-only writes back to KV. Keep a `bazaar_write_log` D1 table during Phase 4–5 recording every mutation; a replay script dumps it to KV. Ugly but always possible.
- **Phase 5** (KV key deletion): Irreversible. Hence the 60-day buffer.

A kill-switch env var `BAZAAR_BACKEND=kv|d1|dual` can be flipped via `wrangler secret put` without deploy. All handlers check it. Safer than feature flags for an emergency.

## Testing

Before any user-facing change:

1. **Schema apply works on a fresh DB and doesn't break on re-apply** (migrations are idempotent).
2. **Dual-write produces identical state in KV and D1** — write a test publish, read from both, assert deep equality.
3. **Backfill handles the largest current pack** without timeout (KV list paginates, D1 batch inserts are fast).
4. **FTS search returns expected results** on a fixture set of 100 packs with known tags.
5. **Read cutover fallback fires** when D1 returns empty for a known-existing pack — integration test with force-empty D1.
6. **Rollback kill-switch works**: toggle `BAZAAR_BACKEND=kv` mid-test, reads revert instantly.

Write these as `.test.mjs` files under `packages/worker/test/bazaar-migration/`.

## Code changes summary

| File | Phase | Change |
|---|---|---|
| `packages/worker/wrangler.toml` | 0 | Add D1 binding |
| `packages/worker/src/index.ts` | 0 | Add `SOCIAL_DB: D1Database` to Env |
| `packages/worker/migrations/001-bazaar.sql` | 0 | New — schema DDL |
| `packages/worker/src/routes/bazaar.ts` | 1 | Dual-write inserts/updates |
| `packages/worker/scripts/backfill-bazaar.ts` | 2 | New — one-shot backfill |
| `packages/worker/src/routes/bazaar.ts` | 3 | Read paths → D1 with KV fallback |
| `packages/worker/src/routes/bazaar.ts` | 4 | D1 primary, KV best-effort |
| `packages/worker/src/routes/bazaar.ts` | 5 | Remove KV write calls |
| `packages/worker/src/utils/d1-schema.ts` | 0 | Typed row interfaces |

All changes are in `bazaar.ts` + migrations + a backfill script. No frontend changes needed — API contracts unchanged.

## Dependencies

- D1 enabled on the account (free plan supports it; just needs creation).
- Wrangler CLI recent enough to handle migrations (any 3.80+).
- The worker's existing KV/R2 bindings keep working — not replacing them, just adding a new one.

## Cost impact

- D1 storage at ~1KB per pack, ~10k packs = 10 MB total. Negligible.
- D1 queries: bazaar browse is ~5 QPS peak; D1 charges `row reads` + `rows written`. Estimated $0.20/month at beta scale.
- No egress change (R2 blobs unchanged).

## Timeline — solo engineer, realistic

| Day | Phase | Deliverable |
|---|---|---|
| 1 | 0 | D1 database + schema applied + binding in wrangler |
| 2 | 1 | Dual-write in `bazaar.ts`, deployed behind no user-visible change |
| 3 | 2 | Backfill script written + run, counts verified |
| 4 | 3 | Read cutover + fallback + 24h monitoring |
| 5 | 4 | D1 primary, KV shadow |
| 5–35 | — | Soak, monitor, operational confidence |
| 35 | 5 | KV key deletion |

Full migration in a week of engineering time + 30-day soak. Social v1 phase A can start on Day 3 (Phase 2 complete).

## Open questions

- **Should we use Durable Object SQLite instead of D1?** DO SQL is free-tier, faster, and local-colo — but cross-user queries are a pain (each DO is isolated). For social graph (follows, posts across users), D1 is right. No reason to split bazaar vs social DBs.
- **FTS tokenizer.** Default `fts5` uses Unicode61 tokenizer — fine for English tags. Non-English names (Japanese, Arabic) will index character-by-character. For beta: accept. Consider `trigram` tokenizer if we see CJK traffic.
- **Pack deletion cascade.** `ON DELETE CASCADE` on `pack_tags.pack_id` — good. But `packs.parent_pack_id` references? Current schema uses `FOREIGN KEY (parent_pack_id) REFERENCES packs(pack_id)` with no cascade. Fork's parent getting hard-deleted → fork's `parent_pack_id` becomes a dangling reference. Decision: use `ON DELETE SET NULL` so forks survive with the lineage "lost but noted." Alternative: soft delete (add `deleted_at`) — cleaner but bigger schema change.
- **Backfill as scheduled job vs admin endpoint.** Running via `wrangler` directly is simplest. An admin endpoint is flexibly re-runnable but adds attack surface. Ship via `wrangler d1 execute` + wrangler dev pattern; don't expose an endpoint.
- **How much schema to land up front vs incrementally?** Tempting to drop the whole social schema at migration time. Safer: ship bazaar first, then social v1 additions as `002-social.sql`. D1 migrations compose.

## Success metrics

- Zero user-visible errors during the cutover window.
- Bazaar browse p95 latency < 200ms post-cutover (D1 with global replication should be faster than KV serialize/deserialize of large arrays).
- Backfill run completes in < 5 min for current state (scales linearly from there).
- No data divergence detected in the first 30 days (automated daily reconciliation: count packs in KV vs D1, compare).
- Post-cutover, `bazaar:type:*` KV value sizes stop growing.
