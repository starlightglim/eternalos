# 02 — Social v1

> The social layer for EternalOS: follows, feed, forums, comments, reactions, moderation, notifications, search, MCP.
> Parent doc: [ROADMAP.md](ROADMAP.md). Related: [04-skin-format.md](04-skin-format.md) (bazaar v2 shares the D1 spine).

## Goals

1. Follow other users; see a chronological feed of their public activity (new items, new bazaar packs, new forum posts).
2. Forums with threaded comments that scale past 10k users without re-architecting.
3. In-OS notifications (new follower, new guestbook entry, @mention, reply) with low idle cost.
4. Semantic + exact search across profiles, posts, and bazaar.
5. AI-assisted moderation with clear human-in-the-loop.
6. Each user's desktop is exposable as an OAuth-scoped MCP server.
7. Per-profile RSS / JSON Feed / WebFinger for federation-adjacent interop.

## Non-goals (v1)

- DMs. Use Stream/Ably if required, or defer to v2.
- Full ActivityPub federation. Fork `wildebeest` later if ever.
- Quote-post / retweet. Save for v2.
- Paid/subscriber-only content. Post-monetization feature.
- Live audio/video rooms. Explicit no.

## Architecture: D1 spine + per-user DO + hot-thread DO

```
                    ┌─────────────────┐
                    │     Workers     │ ← routing, auth, rate limits
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
  ┌─────▼─────┐      ┌───────▼───────┐     ┌──────▼──────┐
  │    D1     │      │  UserDesktop  │     │   KV        │
  │           │      │  (per user)   │     │  (snapshots,│
  │ Social    │      │               │     │   feed cache│
  │ graph,    │      │  + Inbox DO   │     │   public    │
  │ posts,    │      │  (WS hiber-   │     │   :uid)     │
  │ threads,  │      │   nation)     │     │             │
  │ comments, │      │               │     └─────────────┘
  │ reports   │      └───────┬───────┘
  └───────────┘              │
                             │ (WS to visitors)
                             ▼
                    ┌────────────────┐     ┌──────────────┐
                    │ ThreadRoom DO  │◄────┤  R2          │
                    │ (only when     │     │  (post bodies │
                    │  subscribers>0)│     │   >1KB,       │
                    └────────────────┘     │   images)     │
                                           └──────────────┘
                                           ┌──────────────┐
                                           │  Vectorize   │
                                           │  (via AI     │
                                           │   Search)    │
                                           └──────────────┘
```

**Why this mix:**
- D1 is the right place for "who follows whom" (many-to-many) and "show me all posts by people I follow" (fanout on read with a join). SQLite-at-edge with read replication, 10 GB per DB on paid.
- UserDesktop DO stays the authoritative per-user state. Add a sibling Inbox DO (or merge into UserDesktop via an `/inbox` path) for realtime notifications.
- KV for rendered feed pages with short TTL (30-60s) — proven cache layer.
- R2 for post bodies >1KB and user uploads — already in use.
- AI Search for semantic search, with exact search still handled by D1 FTS5.
- ThreadRoom DO only spawns when there are live WebSocket subscribers; otherwise threads render from D1 directly.

## D1 schema

Add a new binding `SOCIAL_DB` in [wrangler.toml](../packages/worker/wrangler.toml).

```sql
-- ---------------------------------------------------------------------------
-- Identity (mirrors KV but in queryable form)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  uid TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  bio TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  trust_score INTEGER NOT NULL DEFAULT 0,     -- 0-100, higher = more visible
  suspended INTEGER NOT NULL DEFAULT 0,       -- 0 = active; 1 = soft suspended
  email_verified INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_trust ON users(trust_score DESC);

-- ---------------------------------------------------------------------------
-- Follows
-- ---------------------------------------------------------------------------

CREATE TABLE follows (
  follower_uid TEXT NOT NULL,
  followee_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_uid, followee_uid),
  FOREIGN KEY (follower_uid) REFERENCES users(uid),
  FOREIGN KEY (followee_uid) REFERENCES users(uid)
);

CREATE INDEX idx_follows_followee ON follows(followee_uid, created_at DESC);
CREATE INDEX idx_follows_follower ON follows(follower_uid, created_at DESC);

-- ---------------------------------------------------------------------------
-- Posts (short activity items)
-- ---------------------------------------------------------------------------

CREATE TABLE posts (
  post_id TEXT PRIMARY KEY,                    -- UUID v7 for time-sortable IDs
  author_uid TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- 'text' | 'photo' | 'bazaar_publish' | 'item_public' | 'profile_rice'
  body TEXT,                                   -- short body; longer in R2 with body_r2_key
  body_r2_key TEXT,                            -- for posts > 2KB
  media_json TEXT,                             -- JSON array of { r2Key, mimeType, width, height }
  ref_json TEXT,                               -- JSON { kind, id } — what this post references (bazaar pack, item, etc.)
  reply_to TEXT,                               -- post_id if a reply
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'held' | 'removed'
  moderation_score REAL,                       -- 0-1, from llama-guard
  reaction_counts_json TEXT,                   -- cached count: {"heart":12,"fire":5}
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

CREATE INDEX idx_posts_author_created ON posts(author_uid, created_at DESC);
CREATE INDEX idx_posts_moderation ON posts(moderation_status, created_at DESC);
CREATE INDEX idx_posts_reply_to ON posts(reply_to, created_at);

-- Full-text search (SQLite FTS5)
CREATE VIRTUAL TABLE posts_fts USING fts5(
  post_id UNINDEXED,
  body,
  content='posts',
  content_rowid='rowid'
);

-- Keep FTS in sync
CREATE TRIGGER posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(post_id, body) VALUES (new.post_id, new.body);
END;
CREATE TRIGGER posts_ad AFTER DELETE ON posts BEGIN
  DELETE FROM posts_fts WHERE post_id = old.post_id;
END;
CREATE TRIGGER posts_au AFTER UPDATE ON posts BEGIN
  UPDATE posts_fts SET body = new.body WHERE post_id = new.post_id;
END;

-- ---------------------------------------------------------------------------
-- Reactions
-- ---------------------------------------------------------------------------

CREATE TABLE reactions (
  post_id TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  emoji TEXT NOT NULL,                         -- 'heart' | 'fire' | 'eye' | 'mushroom' | 'palette' | 'sparkle'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_uid, emoji),
  FOREIGN KEY (post_id) REFERENCES posts(post_id),
  FOREIGN KEY (user_uid) REFERENCES users(uid)
);

CREATE INDEX idx_reactions_post ON reactions(post_id);

-- ---------------------------------------------------------------------------
-- Forum: threads + comments
-- ---------------------------------------------------------------------------

CREATE TABLE threads (
  thread_id TEXT PRIMARY KEY,
  board TEXT NOT NULL,                         -- 'showcase' | 'help' | 'ricing' | 'bazaar-chat' | 'bugs' | 'off-topic'
  title TEXT NOT NULL,
  author_uid TEXT NOT NULL,
  body TEXT,                                   -- first post body
  body_r2_key TEXT,                            -- if > 2KB
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,           -- for sort
  comment_count INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

CREATE INDEX idx_threads_board_activity ON threads(board, last_activity_at DESC);
CREATE INDEX idx_threads_author ON threads(author_uid, created_at DESC);

CREATE TABLE comments (
  comment_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  parent_comment_id TEXT,                      -- null for top-level
  path TEXT NOT NULL,                          -- materialized path, e.g. "0001/0003/0002"
  depth INTEGER NOT NULL,                      -- 0 = top-level; max 3
  author_uid TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  moderation_score REAL,
  FOREIGN KEY (thread_id) REFERENCES threads(thread_id),
  FOREIGN KEY (parent_comment_id) REFERENCES comments(comment_id),
  FOREIGN KEY (author_uid) REFERENCES users(uid)
);

-- For efficient thread render: all comments in a thread in path order
CREATE INDEX idx_comments_thread_path ON comments(thread_id, path);

-- ---------------------------------------------------------------------------
-- Reports & moderation
-- ---------------------------------------------------------------------------

CREATE TABLE reports (
  report_id TEXT PRIMARY KEY,
  reporter_uid TEXT NOT NULL,
  target_kind TEXT NOT NULL,                   -- 'post' | 'comment' | 'thread' | 'user' | 'pack' | 'app'
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,                        -- 'spam' | 'harassment' | 'nsfw' | 'scam' | 'other'
  notes TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',         -- 'open' | 'reviewing' | 'actioned' | 'dismissed'
  reviewed_at INTEGER,
  reviewed_by TEXT
);

CREATE INDEX idx_reports_target ON reports(target_kind, target_id);
CREATE INDEX idx_reports_status ON reports(status, created_at);

-- ---------------------------------------------------------------------------
-- Blocks & mutes
-- ---------------------------------------------------------------------------

CREATE TABLE blocks (
  blocker_uid TEXT NOT NULL,
  blocked_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_uid, blocked_uid)
);

CREATE TABLE muted_words (
  user_uid TEXT NOT NULL,
  word TEXT NOT NULL,
  PRIMARY KEY (user_uid, word)
);

-- ---------------------------------------------------------------------------
-- Bazaar v2 (migrated from KV)
-- ---------------------------------------------------------------------------

CREATE TABLE packs (
  pack_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                          -- 'cursor' | 'icon' | 'sound' | 'effect' | 'skin' | 'app'
  name TEXT NOT NULL,
  description TEXT,
  author_uid TEXT NOT NULL,
  version TEXT NOT NULL,
  parent_pack_id TEXT,                         -- for forks
  preview_url TEXT,
  installs INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  manifest_r2_key TEXT NOT NULL,
  moderation_status TEXT NOT NULL DEFAULT 'pending',
  FOREIGN KEY (author_uid) REFERENCES users(uid),
  FOREIGN KEY (parent_pack_id) REFERENCES packs(pack_id)
);

CREATE INDEX idx_packs_type_installs ON packs(type, installs DESC, created_at DESC);
CREATE INDEX idx_packs_author ON packs(author_uid, created_at DESC);
CREATE INDEX idx_packs_parent ON packs(parent_pack_id);

CREATE TABLE pack_tags (
  pack_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (pack_id, tag),
  FOREIGN KEY (pack_id) REFERENCES packs(pack_id)
);

CREATE INDEX idx_pack_tags_tag ON pack_tags(tag);

CREATE VIRTUAL TABLE packs_fts USING fts5(
  pack_id UNINDEXED,
  name,
  description,
  author_username,
  tags_joined,
  content='packs',
  content_rowid='rowid'
);

-- ---------------------------------------------------------------------------
-- Inbox events (notifications)
-- ---------------------------------------------------------------------------

-- Note: inbox lives in per-user DO for realtime delivery; this table is an
-- optional long-term archive for "show me old notifications". Keep slim.

CREATE TABLE inbox_archive (
  event_id TEXT PRIMARY KEY,
  user_uid TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- 'follow' | 'reply' | 'mention' | 'reaction' | 'guestbook' | 'report_action'
  actor_uid TEXT,
  ref_json TEXT,                               -- JSON { post_id | thread_id | comment_id | ... }
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

CREATE INDEX idx_inbox_user_created ON inbox_archive(user_uid, created_at DESC);
```

## Feed — fanout-on-read until it hurts

**Core query.**

```sql
SELECT p.post_id, p.author_uid, u.username, u.display_name, u.avatar_url,
       p.kind, p.body, p.body_r2_key, p.media_json, p.ref_json,
       p.created_at, p.reaction_counts_json
FROM posts p
JOIN follows f ON f.followee_uid = p.author_uid
JOIN users u   ON u.uid = p.author_uid
WHERE f.follower_uid = ?
  AND p.moderation_status = 'approved'
  AND p.created_at < ?                         -- cursor (created_at of last seen)
  AND NOT EXISTS (
    SELECT 1 FROM blocks b
    WHERE b.blocker_uid = ? AND b.blocked_uid = p.author_uid
  )
ORDER BY p.created_at DESC
LIMIT 50;
```

With an index on `posts(author_uid, created_at DESC)` and `follows(follower_uid, created_at DESC)` this is a few ms in D1 even at 10k users and millions of posts.

**Caching.** Cache rendered feed page in KV at `feed:{uid}:{cursor}` with 30-60s TTL. On any write by someone the user follows, invalidate `feed:{uid}:*` (no, don't — KV doesn't support prefix invalidation cheaply). Instead: cache by `cursor`, and when a user opens the feed, always fetch the page [latest…cursor]. If cursor is null, fetch from KV if present (else D1). That gives you freshness at page-load + cache hits for paging deeper.

**Fanout on write — when to switch.** Only flip to home-timeline-per-user if a user crosses ~2k followers AND the feed cost becomes a dominant bill line. Right now, skip it. The research was explicit: "Cohost's feed reads were their cost center."

## Forum — D1 with adjacency-list + materialized path

**Thread render.**

```sql
-- All comments in a thread in render order (parent before children, left-to-right)
SELECT c.comment_id, c.parent_comment_id, c.path, c.depth,
       c.body, c.created_at, c.author_uid,
       u.username, u.display_name, u.avatar_url
FROM comments c
JOIN users u ON u.uid = c.author_uid
WHERE c.thread_id = ?
  AND c.moderation_status = 'approved'
ORDER BY c.path ASC;
```

**Path construction.** When inserting a new comment, find the next free sibling slot under the parent and append to the parent's path:

```typescript
// pseudo
async function insertComment(threadId, parentCommentId, body, authorUid) {
  const siblings = await db.all(
    `SELECT path FROM comments WHERE thread_id = ? AND parent_comment_id IS ? ORDER BY path DESC LIMIT 1`,
    threadId,
    parentCommentId,
  );
  const parent = parentCommentId
    ? await db.first(`SELECT path, depth FROM comments WHERE comment_id = ?`, parentCommentId)
    : { path: '', depth: -1 };

  const nextSlot = siblings.length ? incrementBase36(siblings[0].path.slice(-4)) : '0001';
  const path = (parent.path ? parent.path + '/' : '') + nextSlot;
  const depth = parent.depth + 1;

  if (depth > 3) throw new Error('Max nesting depth reached');

  const commentId = crypto.randomUUID();
  await db.run(
    `INSERT INTO comments (comment_id, thread_id, parent_comment_id, path, depth, author_uid, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    commentId, threadId, parentCommentId, path, depth, authorUid, body, Date.now(),
  );
}
```

**Hot-thread DO.** When a user opens a thread in the browser, open a WebSocket to `/api/ws/thread/:threadId`. That creates (or attaches to) a `ThreadRoom` DO for this thread. The DO:
- Subscribes to the D1 comment stream via a tailing Worker (or recent-posts polling).
- Broadcasts new comments to all attached sockets.
- Hibernates when zero attached sockets.

For v1 simplicity, skip the DO entirely and poll D1 from the client every 5s when the thread is open. Add the DO only when poll traffic justifies.

## Notifications — Inbox DO with hibernation + Web Push

**Per-user Inbox DO.** One DO instance per user. Tracks:
- Open WebSocket sessions (via `state.acceptWebSocket()` — hibernation).
- Unread count (persisted).
- Recent unread events in memory; older events paged in from `inbox_archive` D1 table.

**Flow.**

1. Anywhere in the codebase, when something inbox-worthy happens (new follower, reply, mention, reaction, guestbook):
   ```typescript
   await notifyUser(env, recipientUid, {
     kind: 'follow',
     actorUid: followerUid,
     ref: { follow_id: followId },
   });
   ```
2. `notifyUser`:
   - Enqueues the event to `env.NOTIFICATIONS` queue.
3. Queue consumer Worker:
   - Writes to `inbox_archive` D1 table.
   - Forwards to the user's Inbox DO via stub.fetch.
4. Inbox DO:
   - If any WebSocket sessions, broadcast to them.
   - Else, invoke Web Push API with the user's push subscription (if they've enabled it).
   - Update persisted unread count.

**Web Push.** Use the `web-push` library (works on Workers per research). VAPID keys stored as secrets. Subscription stored per-user in KV `push:{uid}`.

**Email digest.** A scheduled Worker runs hourly: finds users with unread count > 5 and `digest_email_enabled`, sends a consolidated email via Cloudflare Email Service.

## Moderation pipeline

**Three-tier classification.** Every post, comment, pack, or bio runs through:

1. **Text (llama-guard-3-8b).** Returns `safe` / `unsafe:category` per Meta's schema. Store `moderation_score` (0 = unsafe; 1 = safe).
2. **Image (vision model already bound).** If content includes images, check with the same model used for desktop-item image analysis. Score for NSFW / violence / sadness.
3. **Rule-based filters.** Hard deny: CSAM markers (perceptual hash match if we ever wire PhotoDNA/Thorn), scam phrases, banned domains.

**Decision table.**

| Tier | Score / match | Action |
|---|---|---|
| Hard deny | CSAM, banned domain | Auto-remove, flag account for review, ban-pending |
| llama-guard unsafe, high confidence | score < 0.2 | Hold — not visible until review |
| llama-guard unsafe, mid confidence | 0.2 ≤ score < 0.5 | Queue for review; visible but shadow-hidden from explore/feed |
| Safe or low-confidence unsafe | score ≥ 0.5 | Approve immediately |
| From low-trust user | any | Always shadow-hidden for 24h post-approval, then surface |

**Trust score** per user (stored in `users.trust_score`):
- Account age (days since `created_at`): +10 per day up to +30.
- Email verified: +20.
- Successful posts: +1 per approved post (max +30).
- Reports against: -10 each (capped at -50).
- Positive reactions: +0.1 each (capped at +20).

Trust score under 30 → content is shadow-hidden from explore and non-follower feeds until human review or time-based promotion.

**Human review queue.** A simple internal app (built on EternalOS itself, natch) shows queued items, lets mods approve/remove/ban. Actions logged for audit trail.

**Escalation for bans.** Soft suspend (`users.suspended = 1`) first — user can still log in but cannot post, follow, install. Hard ban for repeat offenses — account disabled, R2 prefix retained for 30 days per legal hold.

## Search — AI Search namespaces + D1 FTS5 for exact

Two surfaces:

1. **Exact search.** FTS5 over `posts_fts` and `packs_fts`. Fast, covers usernames, titles, tags. No embed cost.
2. **Semantic search.** Use **AI Search namespace bindings** instead of the older "AutoRAG over a raw R2 prefix" approach. On post/pack create, write a searchable document into the appropriate AI Search namespace with metadata like `{ tenantUid, kind, id, authorUid, visibility }`.

**Query UX.** `/explore?q=cyberpunk` runs both in parallel and merges:
- FTS hits with exact matches (boost).
- AI Search top-K semantic matches.
- Dedup by ID; re-rank by combined score.

**Multi-tenant rule.** Do not treat AI Search like one global bag of embeddings. Use metadata filters or separate namespaces for product surfaces where privacy boundaries matter:

- Public social corpus.
- Bazaar packs.
- Per-user desktop/search corpus.

**Cost budget.** AI Search is now a first-class product surface with built-in storage and cross-instance search. Design around namespaces/filters first; do not preserve old R2-ingestion assumptions just because they are in the earlier docs.

## Remote MCP server per user

Each user's desktop exposed as an MCP endpoint at `https://eternalos.app/.well-known/mcp/@{username}`. Authenticated via `workers-oauth-provider`.

**Tools exposed:**
- `getDesktop` — profile + public items (or full if OAuth-scoped for self).
- `searchDesktop` — by query string, semantic or exact.
- `getItem` — by id.
- `listPacks` — bazaar packs by this user.
- `postToFeed` — create a post (requires `feed:write` scope).
- `installPack` — install a bazaar pack (requires `bazaar:write` scope).
- `readInbox` — recent notifications (requires `inbox:read` scope).

**OAuth scopes.**

| Scope | What it grants |
|---|---|
| `profile:read` | read profile + public items |
| `desktop:read` | read all items (including private) |
| `desktop:write` | create/modify items |
| `feed:read` | read user's feed |
| `feed:write` | post to feed |
| `bazaar:read` / `bazaar:write` | read/install packs |
| `inbox:read` / `inbox:notify` | notifications |
| `ai:invoke` | call the assistant |

**Implementation.** Use `McpAgent` from the updated Agents SDK. The agent instance name is the user's uid. OAuth flow bounces through `workers-oauth-provider`, redirecting to `/mcp-auth/authorize` for consent. Prefer the modern Agents RPC transport for internal agent-to-agent calls instead of routing everything back through external HTTP semantics.

**Why this matters.** Claude Desktop, Cursor, Codex, VS Code agents, and the user's own agents can query / update their desktop like a first-class data source. This is the product moat the research identified: "personal desktop on the open web."

## Rate limiting — Workers Rate Limiting binding

Replace [rateLimit.ts](../packages/worker/src/middleware/rateLimit.ts) KV-counter approach with the native binding (GA 2024). Define in wrangler:

```toml
[[ratelimit]]
binding = "RL_AUTH"
namespace_id = "0"
simple = { limit = 60, period = 60 }

[[ratelimit]]
binding = "RL_API"
namespace_id = "1"
simple = { limit = 300, period = 60 }

[[ratelimit]]
binding = "RL_POST"
namespace_id = "2"
simple = { limit = 10, period = 60 }      # 10 posts/min per user

[[ratelimit]]
binding = "RL_FOLLOW"
namespace_id = "3"
simple = { limit = 100, period = 3600 }   # 100 follow actions/hour per user

[[ratelimit]]
binding = "RL_REPORT"
namespace_id = "4"
simple = { limit = 20, period = 3600 }
```

Keys are `uid:action` (for per-user) or `ip` (for pre-auth). The binding is atomic, sub-ms, and billed as regular Worker use.

## RSS / JSON Feed / WebFinger

**Per-profile feeds.**

- `GET /@{username}.rss` — RSS 2.0 of the user's public posts.
- `GET /@{username}/feed.json` — JSON Feed 1.1 spec.
- `GET /.well-known/webfinger?resource=acct:{username}@eternalos.app` — WebFinger for federation-adjacent interop.

Build from D1: `SELECT ... FROM posts WHERE author_uid = ? AND moderation_status = 'approved' ORDER BY created_at DESC LIMIT 50`. Cache in KV `feed:profile:{uid}` for 5 min.

## Bazaar v2 — D1 migration + forks

**Migration.** Write a one-shot script that walks KV keys `bazaar:pack:*`, `bazaar:type:*`, `bazaar:author:*` and populates D1 `packs` + `pack_tags`. Pass through `created_at` and `updated_at`. Drop `bazaar:type:*` and `bazaar:author:*` after verification (kept for 30 days fallback).

**New behavior:**
- `GET /api/bazaar/browse` queries `packs` with FTS5 + Vectorize. Pagination via `(last_created_at, last_pack_id)` cursor.
- `POST /api/bazaar/fork/:packId` — forks the pack: copies manifest, assets, creates a new pack with `parent_pack_id = original`. Forker gets full ownership.
- Lineage shown on pack page: "Forked from @alice's Cyberpunk. 4 further forks."
- `GET /api/bazaar/lineage/:packId` — tree walk via CTE: parent + descendants.

```sql
-- Lineage via recursive CTE
WITH RECURSIVE ancestors AS (
  SELECT pack_id, name, author_uid, parent_pack_id, 0 AS depth
  FROM packs WHERE pack_id = ?
  UNION ALL
  SELECT p.pack_id, p.name, p.author_uid, p.parent_pack_id, a.depth + 1
  FROM packs p JOIN ancestors a ON p.pack_id = a.parent_pack_id
  WHERE a.depth < 10
)
SELECT * FROM ancestors;
```

## Guestbook → Wall

Current guestbook is a widget ([types.ts:116](../packages/worker/src/types.ts:116)) with 100-entry cap and no threading. v2 "wall":

- Backed by `posts` table with `kind = 'wall_message'` and `ref_json = { target_uid }`.
- Allows threaded replies (depth 1 only — "reply to one comment").
- Subject to standard moderation pipeline.
- Wall rendering on profile page: `SELECT FROM posts WHERE kind = 'wall_message' AND ref_json->>'target_uid' = ? ORDER BY created_at DESC`.
- Existing guestbook widgets keep working for back-compat — they migrate entries into posts on first access.

## Mentions

`@username` in post or comment body is detected at write time with a regex `/@([a-z0-9_]{3,20})\b/g`. For each unique mention:
1. Look up `username` → `uid` in D1.
2. Write an inbox event of kind `mention`.

Rendering: replace `@username` with a link to `/@username`. No prefetch, no preview card in v1.

## DMs

**Decision: do not build in v1.** Options surveyed:

- **Stream Chat** — polished, SaaS, generous free tier (2k MAU), would plug in cleanly.
- **Ably Chat** — similar, edge-native, also SaaS.
- **ConversationDO per pair (build it ourselves)** — three-month tarpit per research. Features like read receipts, typing, delivery, push, multi-device sync are all nontrivial.

Recommendation: ship no DMs for beta. If users ask for them, integrate Stream Chat as a gated feature for verified users in a later phase.

## Privacy knobs per user

Stored in `UserProfile`:

- `profileVisibility: 'public' | 'followers' | 'private'` — who sees the profile at all.
- `feedVisibility: 'public' | 'followers'` — who sees posts.
- `allowGuestbook: boolean`.
- `allowMentions: 'anyone' | 'followers' | 'nobody'`.
- `searchIndexable: boolean` — opt out of search entirely.

Search and explore respect these. Block lists override everything (blocked users never see the blocker's content anywhere).

## Explore / discovery

- **`/explore/recent`** — chronological feed of public posts from high-trust users, newest first.
- **`/explore/popular`** — last-7-days posts sorted by `reaction_counts + installs + comment_count`.
- **`/explore/random`** — true random across approved users with `profileVisibility = 'public'`.
- **`/explore/vibe/:tag`** — tag-filtered explore. Tags inferred from custom CSS, bazaar packs installed, image analysis.
- **`/explore/fresh`** — users who joined in the last 7 days (helps bootstrap followers).

Algorithm choices kept simple and explainable. No ML re-ranking in v1.

## Data flow example: "alice posts a photo, bob sees it"

1. Alice uploads photo to her desktop → DesktopItem created (private by default).
2. Alice flips it public via UI → DO updates item.isPublic = true; invalidates `public:{alice_uid}` KV cache.
3. Frontend calls `POST /api/feed/post` with `{ kind: 'photo', body: '', media: [{ r2Key, mimeType }], ref: { itemId } }`.
4. Worker:
   - Rate limit check via `RL_POST`.
   - Run llama-guard-3-8b on body (empty → skip text). Run vision on photo.
   - Insert post with `moderation_status = 'approved'` (both safe).
   - Insert into `posts_fts`.
   - Write searchable document to AI Search namespace with metadata filters.
   - Enqueue fanout-light: for each follower of Alice, push "new post from alice" to their Inbox DO via Queue.
5. Bob (one of alice's followers) has an open Inbox WebSocket; receives the push event → browser badge updates.
6. Bob opens `/feed` → Worker queries D1 for recent followed posts → returns Alice's photo + older items.
7. Cache the rendered page in `feed:{bob_uid}:null` for 30s.

## Migration from KV bazaar

Script lives at `packages/worker/scripts/migrate-bazaar-to-d1.ts`. Run once via `wrangler deploy && wrangler cron trigger migrate` or invoked from a protected admin endpoint.

1. List KV keys with prefix `bazaar:pack:`.
2. For each, parse JSON, insert into D1 `packs`, split tags into `pack_tags`.
3. Insert into `packs_fts`.
4. Log count for verification.
5. After verification, delete `bazaar:type:*` and `bazaar:author:*` indexes.

## Open questions

- **Soft or hard pagination boundary on forum threads?** 1k comments per thread is fine with path-ordered queries. 100k is not. Add a "continue in new thread" link after N comments?
- **Shadow hiding UX.** Shadow-hidden users: should they see their own content as visible but others don't? Pro: less chance of them knowing they're hidden and switching accounts. Con: ethically iffy.
- **Follow approval for private profiles.** If profile is `followers`-visibility, following requires explicit approval. Adds complexity. Defer to v1.1.
- **Post edits.** Full rewrite history, or "edited (y/n)" indicator only? Latter for v1, former later.
- **Quote-post.** Pattern is ubiquitous on other platforms. Deferred but easy to add (`posts.ref_json = { quote_post_id }` + render inline).
- **DM vendor pick.** If/when we add DMs, Stream vs Ably. Stream seems stronger for our use case.

## Phased delivery

**Phase A (2 weeks) — foundations.**
- D1 schema + migration.
- Bazaar migrated to D1; bazaar v2 endpoints.
- FTS5 + AI Search namespace indexing.
- Workers Rate Limiting bindings.

**Phase B (2 weeks) — social graph + feed.**
- Follows CRUD.
- Posts + reactions.
- Feed endpoint (fanout-on-read + KV cache).
- Profile RSS / JSON Feed / WebFinger.
- Inbox DO with WS hibernation + Web Push.

**Phase C (2 weeks) — forums + moderation.**
- Threads + comments (adjacency-list + path).
- Thread viewing endpoint.
- Llama-guard moderation pipeline.
- Trust score + shadow hide logic.
- Report / block / mute.

**Phase D (1 week) — MCP + polish.**
- Remote MCP server per user.
- OAuth consent UI.
- `/explore` tabs.
- Email digest Worker.

**Phase E (optional) — DMs via Stream.**

## Success metrics

- DAU / MAU ratio ≥ 0.35 (sticky).
- % of users who follow at least 3 others within 7 days.
- % of users who make at least one post within 14 days.
- Thread-starts per DAU ≥ 0.02.
- Reports per 1k posts (leading indicator for moderation load).
- Median time to moderation decision.
- MCP server attachments per active user (bonus metric, proxy for platform-ness).
