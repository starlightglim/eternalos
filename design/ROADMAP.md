# EternalOS — Improvement Roadmap

> Authored 2026-04-18 by Claude (Opus 4.7, 1M context) during a research + design session.
> Refreshed 2026-04-20 to incorporate current repo state and Cloudflare platform releases through 2026-04-20.
> Companion design docs: [01-apps-interop.md](01-apps-interop.md), [02-social-v1.md](02-social-v1.md), [03-mobile.md](03-mobile.md), [04-skin-format.md](04-skin-format.md).

---

## Executive summary

EternalOS is structurally sound as a small personal-desktop app on Cloudflare. It is not yet structurally ready to be a **platform** — apps, social, mobile, and skinning are each one design-pass away from being good, not ten features away. The most leveraged moves are:

1. Finish the remaining beta hardening work instead of re-solving problems the repo already fixed.
2. Upgrade the AI stack around a **hosted-vs-proxied split**: hosted Workers AI models for core product flows, proxied premium models behind AI Gateway where they materially help.
3. Publish each user's desktop as an OAuth-scoped MCP server.
4. Migrate bazaar indexes and all social data to D1 before adding follows/forums.
5. Design a real skin bundle format (`.estheme`) and make bazaar packs forkable.
6. Rebuild mobile as a native paradigm (grid PWA with gestures), not a stripped desktop.
7. Give user-created apps a scoped permission model on top of **Dynamic Workers** as the default runtime substrate.

Everything else ladders off those seven.

## Current state — honest assessment

**What is solid:**

- Auth primitives (JWT + refresh rotation, bcrypt, file tokens with 5-min TTL, password-change invalidation).
- Per-user Durable Object with SQLite already uses `state.acceptWebSocket()` ([UserDesktop.ts:148](../packages/worker/src/durable-objects/UserDesktop.ts:148)) — hibernation-correct.
- File upload pipeline with magic-byte validation ([upload.ts:801](../packages/worker/src/routes/upload.ts:801)).
- CSP is strict, HSTS set, CORS environment-aware ([index.ts:70-135](../packages/worker/src/index.ts:70)).
- Workers AI image analysis with graceful model fallbacks, including Llama 4 Scout in the fallback chain.
- Dynamic Workers (`WorkerLoader`) already wired for sandboxed user apps ([index.ts:252-282](../packages/worker/src/index.ts:252)); this should remain the primary runtime for user apps.
- `codemode` integration — the LLM can write and run TypeScript.
- `compatibility_date` is current in [wrangler.toml](../packages/worker/wrangler.toml), though the Dynamic Worker loader path should still be kept in sync.
- `OrchestratorAgent` defaults are materially fresher than the original draft assumed.
- Turnstile and Cloudflare Email fallbacks are already wired in the codebase.

**What is wrong or brittle:**

- Public/private defaults were fixed in code, but the surrounding docs and rollout notes still talk as if the old behavior is live. That mismatch is now a documentation risk.
- `ALLOWED_ORIGINS` includes `eternalos.app`, but the roadmap still describes that as unresolved.
- Public asset endpoints (`/api/files`, `/api/wallpaper`, `/api/css-assets`, `/api/sounds`, `/api/cursors`, `/api/bazaar/assets`) skip rate limiting — R2 egress DoS vector.
- WebSocket visitor endpoint has no rate limit or auth.
- Bazaar indexes are JSON blobs in KV (`bazaar:type:{type}`, `bazaar:author:{uid}`); non-atomic, linear reads, breaks at ~5k packs.
- Frontend has zero tests; no CI. Worker has minimal `node --test` files.
- `temp-app/` junk Vite starter committed at repo root.
- Mobile experience strips out all customization — half the product's personality is gone on phones.
- `.ralph/fix_plan.md` claims "production-ready, no issues" as of Feb 21 2026, but cross-user image leak was fixed April 14. Doc is misleading; delete or mark obsolete.
- The design docs still assume the older AI Search / AutoRAG-on-R2 model and older Agents SDK transport patterns. Those are now behind Cloudflare's current platform.

## Integrated research findings

### From the Cloudflare platform research

**Top 5 wins (use these, in order):**

1. **Dynamic Workers (open beta)** — keep them as the default runtime for EternalOS apps. They are the correct substrate for untrusted user-created apps and codemode outputs.
2. **AI Search namespaces / built-in storage / cross-instance search** — replace the older "AutoRAG on an R2 prefix" mental model. Use namespace-bound AI Search with metadata filters for multi-tenant search.
3. **Agents SDK 0.6+ / 0.7+ primitives** — same-Worker `Agent` to `McpAgent` transport, `waitForMcpConnections`, `keepAlive()`, and better observability materially improve the MCP design.
4. **Remote MCP server per user** — `McpAgent` + `workers-oauth-provider`. Claude Desktop / Cursor / any MCP client can query a user's desktop with OAuth-scoped tools. This is still the "personal desktop on the open web" wedge.
5. **Hosted-vs-proxied AI model split** — use hosted `@cf/...` models for core product paths; use proxied provider models via AI Gateway only where frontier quality is worth the cost/complexity.

**Other confirmed wins:**

- **Workers Rate Limiting binding** (GA 2024) → replace hand-rolled KV counters in [rateLimit.ts](../packages/worker/src/middleware/rateLimit.ts).
- **Cloudflare Email Service** (public beta) — replace Resend, auto-configured SPF/DKIM/DMARC, no API key (just a binding).
- **Turnstile** — invisible CAPTCHA, free, unlimited; add to signup/login/forgot-password.
- **Queues on free tier** (10K ops/day) — notification fan-out, deferred image analysis.
- **D1 GA with free read replication** — global read replicas auto-created per traffic. 10GB/DB on paid plan. Use as the social-graph spine.
- **Workflows** (GA April 2025) — durable execution for multi-step jobs. Use for: batch image analysis, app-publish pipeline, bulk CSS regeneration.
- **DO Facets (preview)** — each dynamic app can have its own isolated SQLite DO. Unlocks "apps with persistent state" for codemode apps.
- **Workers Logs / Traces / Query Builder** — make first-party observability the baseline and treat Sentry as supplemental, not the whole worker observability story.
- **`secrets.required` in Wrangler** — tighten deployment safety around required secrets and env hygiene.
- **Image Transformations on R2** — stay on R2 + `/cdn-cgi/image/...` URL transforms; do **not** move to paid Cloudflare Images storage.
- **Browser Run** — skip for OG images (overkill at $0.09/browser-hour). Reserve for future "screenshot a live desktop" social feature.
- **Smart Placement** — skip. All origins (DO, R2, KV, Workers AI) are already on-Cloudflare; requests already run at the DO's colo.

### AI strategy update

Cloudflare's AI catalog now mixes two very different execution models:

- **Hosted Workers AI models** (`@cf/...`) — best for always-on product paths where we want predictable deployment and tight Cloudflare integration.
- **Proxied provider models** (OpenAI, Anthropic, Google, ByteDance, etc.) — useful behind AI Gateway for premium or optional flows, but they should not silently become the product default.

Recommended split for EternalOS:

- **Core assistant / search / enrichment / moderation:** hosted Workers AI first.
- **Premium image/video generation or opt-in "best model" flows:** proxied provider models via AI Gateway.
- **Architecture rule:** no doc should say "Workers AI" when it really means "Cloudflare AI catalog including proxied models." Those have different cost, latency, and lock-in implications.

### From the social architecture research

**The idiomatic 2026 CF pattern for social:**

- **D1** for global relational data (follows, posts, forum threads, comments, reports, bazaar listings).
- **Durable Objects** for per-user state + realtime + hot write paths (Inbox DO, hot ThreadRoom DO).
- **KV** for read-optimized snapshots (rendered feed page TTL 30-60s).
- **R2** for blobs (post bodies >1KB, images).
- **AI Search** for semantic search, with metadata filters / namespaces according to privacy boundary.

**Hard-earned advice from the research:**

- **Fanout-on-read** for feeds until a user crosses ~2k followers. Simple D1 query with index on `(author_uid, created_at DESC)` + short-TTL KV caching. Do not build fanout-on-write yet.
- **Forums as D1 adjacency-list + materialized `path` column** (`0001/0003/0002`). Single `WHERE path LIKE 'x%' ORDER BY path` renders a 1k-comment thread.
- **Hot-thread DO only when WS subscribers > 0**; cold threads hit D1 directly.
- **Moderation pipeline**: `@cf/meta/llama-guard-3-8b` for text; vision model already bound for images. High-confidence unsafe → auto-hold; mid-confidence → review queue; low-confidence → publish.
- **Don't build DMs from scratch.** Use Stream Chat / Ably, or punt to post-beta. A ConversationDO per pair is a 3-month tarpit.
- **Remix / fork culture = moat.** Forkable bazaar packs with lineage. Attribution chain visible.
- **Skip ActivityPub** — `wildebeest` is unmaintained. Ship RSS + WebFinger per profile and call it federation-adjacent.
- **Cohost warning**: their feed reads were their cost center. Budget accordingly.

## Priority tiers

### P0 — Ship blockers for beta

Things that either break the product, leak data, or cost money. Each is small and concrete.

1. **Add Workers Rate Limiting** to `/api/files`, `/api/wallpaper`, `/api/css-assets`, `/api/sounds`, `/api/cursors`, `/api/bazaar/assets` (currently all skip limits at [index.ts:315](../packages/worker/src/index.ts:315)). R2 egress DoS vector otherwise.
2. **Auth + rate limit `/api/ws/:username`** WebSocket handler. Anonymous unlimited connections today.
3. **Delete `temp-app/`** at repo root (Vite starter junk).
4. **Delete or mark obsolete `.ralph/fix_plan.md`** (misleading).
5. **Invalidate `public:{uid}` KV cache when a user toggles an item's `isPublic`** — otherwise stale-public items persist up to 5 min after going private. ([visit.ts:146](../packages/worker/src/routes/visit.ts:146))
6. **Refresh the docs to match code reality** — the design set currently misstates security posture and platform version in a few critical places.

### P1 — High-value next

Upgrades that materially improve quality or open new capability.

7. **AI policy refresh**: benchmark current hosted models instead of hard-coding one "winner", and route premium provider models through AI Gateway deliberately.
8. **Bump `agents` SDK** across frontend and worker packages to the modern MCP/RPC transport era.
9. **Queues binding** + deferred image-analysis pipeline.
10. **AI Search namespaces** for semantic search over user uploads and social corpus.
11. **GitHub Actions CI**: typecheck + lint on PR; test on PR; manual-approval deploy to staging.
12. **Staging environment**: separate Worker + Pages + KV + R2 + D1.
13. **Observability refresh**: Workers Logs/Traces baseline, Sentry supplemental, Mission Control on top.
14. **`secrets.required` in Wrangler** for deploy safety.
15. **Passkeys (WebAuthn)** as second login option.

### P2 — Platform plays

The big bets. Each has a companion design doc.

16. **Apps ↔ Files interop** — scoped permission model, capability tokens, network allowlist, inter-app messaging, Dynamic Worker runtime hardening. See [01-apps-interop.md](01-apps-interop.md).
17. **Social v1** — D1 spine, follows, feed (fanout-on-read), forums (adjacency-list + path), Inbox DO with hibernation + Web Push, AI Search-backed semantic search, moderation pipeline. See [02-social-v1.md](02-social-v1.md).
24. **Mobile redesign** — PWA, grid home screen, gestures, camera upload, share-target, offline-first shell. See [03-mobile.md](03-mobile.md).
25. **`.estheme` skin format** — single bundle, drag-drop install, versioning, fork lineage, nested/extending themes. See [04-skin-format.md](04-skin-format.md).
20. **Publish each UserDesktop as a remote MCP server** — `McpAgent` + `workers-oauth-provider` + modern Agents RPC transport. Wins #4 from CF research.
21. **In-OS code editor** — Monaco/CodeMirror window for hand-editing codemode apps.
22. **Command palette (`Cmd/Ctrl+K`)** — unified search across files, settings, packs, users, forum threads.
23. **DO Facets per app** (when mature enough) — persistent state for user-created apps.
24. **Terminal widget** — real-ish terminal with agent + codemode + pack install commands.

### P3 — Polish and personality

Things that make the product lovable but aren't structural.

31. Keybinding editor (Vim mode for navigation).
32. Workspaces / multiple desktops per user (`Ctrl+1..9`).
33. Tree / tiling window-manager mode (experimental flag). r/unixporn bait.
34. Music visualizer widget (WebGL).
35. Public RSS + JSON Feed per profile (`/@user/feed.json`).
36. Webhook outbound on guestbook / follower events.
37. API tokens (PATs) for scripting a desktop from outside.
38. "Desktop of the day" staff-pick on landing.
39. Random-desktop button (StumbleUpon).
40. Daily prompts ("decorate in your current mood").
41. Follow-from-command-palette, follow-from-visitor-page.
42. Reactions (❤️ 🔥 👁️ 🍄 🎨 ✨) instead of upvotes, per research.
43. Collab desktops (two-user shared DO).
44. Direct-send-to-desktop gifts.
45. Accessibility audit (screen-reader / ARIA labels / focus traps / reduced-motion).
46. i18n scaffold.
47. Changelog window (in-OS, shown on login if new entries).
48. Bug-report widget (auto-fills console + state).
49. Public roadmap page (`/roadmap`), KV-backed, upvotable.
50. JS hooks in custom CSS (sandboxed, signed, behind dev-mode flag).

## Dependency graph (high-level)

```
P0 blockers ────┐
                ├─► beta
P1 upgrades ────┤
                │
                └─► P2 platform plays
                      ├─► Apps interop ──┐
                      ├─► Skin format ───┼─► Bazaar v2 (forkable, lineage)
                      ├─► MCP server ────┤
                      ├─► Social v1 ─────┼─► Forum + feed + moderation
                      └─► Mobile ────────┘
                          │
                          └─► P3 polish (each item independent)
```

**Critical path for "platform" identity:** P0 blockers → D1 migration (bazaar + social) → skin format → apps interop → social v1. That is the ~10-week product arc.

## Effort estimates (calibrated to one engineer, full-time)

| Block | Items | Estimate |
|---|---|---|
| P0 blockers | 1–6 | 2 days |
| P1 upgrades | 7–15 | 1.5 weeks |
| Apps interop (P2 #16) | — | 3 weeks |
| Social v1 (P2 #17) | — | 4 weeks |
| Mobile redesign (P2 #18) | — | 3 weeks |
| Skin format (P2 #19) | — | 2 weeks |
| MCP publish (P2 #20) | — | 1 week |
| Code editor + command palette (P2 #21–22) | — | 1.5 weeks |
| P3 polish | 31–50 | ongoing |

Total to ship a "platform-ready" EternalOS from today: ~3.5 months with one engineer. Beta on just P0+P1 is feasible in ~2 weeks.

## Phased rollout proposal

**Phase 0 (week 0–1): Close the door.**
P0 blockers. Ship staging. Wire first-party observability. Tighten docs and deploy safety.

**Phase 1 (week 2–3): Polish beta.**
Model benchmarking. AI Search namespaces. GitHub Actions CI. Session device list. Delete `temp-app/`.

**Phase 2 (week 4–7): Mobile + skin format.**
Mobile PWA rebuild ([03-mobile.md](03-mobile.md)). `.estheme` format + forkable bazaar ([04-skin-format.md](04-skin-format.md)). These are parallelizable with a second contributor.

**Phase 3 (week 6–10): Apps ecosystem.**
Apps interop permission model on Dynamic Workers ([01-apps-interop.md](01-apps-interop.md)). In-OS code editor. DO Facets when viable. Publish MCP server.

**Phase 4 (week 9–14): Social.**
D1 migration, follows, feed, forum v1 ([02-social-v1.md](02-social-v1.md)). Ship to existing user base (opt-in).

**Phase 5: P3 polish iterations.**
Ricer features (keybindings, tiling, workspaces, terminal widget). Driven by community requests from Phase 4 feed.

## Open product questions — need your call

- **Default visibility.** Private-by-default is safe but may hurt the "explore neighbors" flywheel. Alternative: private by default for *files*, public by default for *widgets / links / text notes*. I lean toward that split.
- **Invite-only beta or open signup?** Research suggests curated first cohort reduces moderation load and produces better feed content for later users.
- **Monetization model.** Free tier is fine at beta scale, but bazaar creators deserve revenue if the marketplace works. Patreon-style tips? Pro tier with bigger quota + custom domain? This shapes the skin-format licensing section.
- **Federation scope.** Full ActivityPub (hard, forked `wildebeest`) vs. RSS + WebFinger (shipping is easy) vs. nothing. My default recommendation: RSS + WebFinger.
- **Authorship of the MCP server.** Ship as an EternalOS feature (we build + host), or let users self-host their own MCP server pointing at an API token? Former is easier, latter is truer to the "your data" ethos.
- **DMs.** Stream Chat integration vs. Ably vs. "no DMs until Phase 5". I lean no DMs for beta.

## What I did not include

- **Competitive positioning / marketing** — out of scope, product document only.
- **Pricing estimates for Cloudflare billing at 10k / 100k user scale** — deferred; the research has pricing pointers but real numbers need measurement.
- **Detailed UI mockups** — the four design docs include sketches and shape, not pixel-perfect designs. That's a separate designer-led pass.

## Sources

**Cloudflare platform:**
- [Dynamic Workers (open beta)](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/)
- [Dynamic Workers docs](https://developers.cloudflare.com/dynamic-workers/)
- [AI Search namespace bindings / built-in storage / cross-instance search](https://developers.cloudflare.com/changelog/post/2026-04-16-ai-search-namespace-binding/)
- [AI Search overview](https://developers.cloudflare.com/ai-search/)
- [Agents SDK v0.6.0](https://developers.cloudflare.com/changelog/post/2026-02-25-agents-sdk-v060/)
- [Agents SDK v0.7.0](https://developers.cloudflare.com/changelog/post/2026-03-02-agents-sdk-v070/)
- [Remote MCP servers on Cloudflare](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/)
- [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Cloudflare Email Service (public beta)](https://blog.cloudflare.com/email-for-agents/)
- [Turnstile GA](https://blog.cloudflare.com/turnstile-ga/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [`secrets.required` in Wrangler](https://developers.cloudflare.com/changelog/post/2026-03-24-secrets-config-property/)
- [Workers AI changelog](https://developers.cloudflare.com/workers-ai/changelog/)
- [Kimi K2.5 on Workers AI](https://developers.cloudflare.com/workers-ai/models/kimi-k2.5/)
- [Images pricing + R2 transforms](https://developers.cloudflare.com/images/pricing/)

**Social design references:**
- Cohost post-mortems on feed-read cost.
- Cloudflare's [`wildebeest`](https://github.com/cloudflare/wildebeest) (ActivityPub on Workers; unmaintained but instructive).
- MySpace Top 8 pattern; are.na collections; Neocities / Tilde.town / Windows98.city for identity-as-artifact.
