# EternalOS release readiness

> **Reference appendix — not the current plan.** Superseded 2026-11-11 by **[CORE-ROADMAP.md](CORE-ROADMAP.md)**, which is the authoritative core-first product plan. This document is kept for the detailed, verified R1–R6 blocker evidence that CORE-ROADMAP's "Foundations" section links to. Read CORE-ROADMAP.md first; come here for the specifics.

Originally reviewed 2026-09-14. Re-verified 2026-11-11 against the current working tree (143 uncommitted files), re-running each gate and re-reading the evidence line for every blocker. Status markers below reflect the 2026-11-11 pass.

Status legend: ✅ Done · 🟡 Partial · ❌ Open.

## Decision

Keep the current React / Zustand frontend and Cloudflare backend. The product already has enough breadth for a first release. Freeze feature expansion and finish a release-hardening milestone focused on privacy, persistence, account lifecycle, and repeatable verification.

This review does not certify production readiness. Code findings below are distinguished from executed checks. Live production configuration, email delivery, AI providers, migration behavior, and full browser journeys remain unverified.

## Blocker status at a glance (2026-11-11)

| Item | Status | Remaining work |
| --- | --- | --- |
| R1 — File caching vs. permissions | ✅ Done | None; regression tests in place |
| R2 — Account deletion purge | ✅ Done | Resumable idempotent purge + integration test |
| R3 — Failed writes / false local state | ✅ Done | Position-save rollback + tests; status-UI nice-to-have remains |
| R4 — Cross-tab session refresh | ✅ Done | Web Locks + storage-event propagation; full acceptance tested |
| R5 — Reproducible verification | ✅ Done | Minor: no browser smoke step or clean-install gate |
| R6 — Dependency advisory triage | 🟡 Partial | Critical + reachable sanitizer fixed (0 critical, 20 high); rest deferred behind `agents 0.8`/`zod 4` |

Of six original blockers, two are fully open (R2, R6) and two are partially done (R3, R4). R1 and R5 are complete.

## Verified baseline

Re-run 2026-11-11 (Node 25.6.1 locally; CI pins 22.23.2 via `.nvmrc`):

| Check | Result |
| --- | --- |
| Frontend production build (`npm run build`) | Passed, including `tsc -b` (~1.6s) |
| Frontend lint (`npm run lint`) | Passed clean (the `Desktop.tsx` / `AppViewer.tsx` / `DeveloperStudio.tsx` failures noted in AGENTS.md are resolved) |
| Frontend typecheck (`tsc -b --force`) | Passed |
| Worker typecheck (`tsc --noEmit`) | Passed |
| Worker integration suite | 19/19 passed (~5.6s) — the `source-map` import that previously blocked it is now a declared dependency |
| Frontend automated tests | 21 passed (4 `node --test` cache tests + 17 vitest), via new `vitest.config.ts` and `test/` setup |
| Consolidated release check (`npm run check:release`) | Exists and is what CI runs; covers typecheck + lint + tests + both builds. Does NOT yet run a browser smoke step |
| Dependency audit (`npm audit --omit=dev`) | 31 advisories: 20 high, 4 moderate, 7 low, **0 critical** (after R6 triage — down from 33/1-critical). Critical `proxy-addr` and reachable `dompurify` fixed; the rest are dev-tooling, unused transports, or blocked behind an `agents 0.8`/`zod 4` major bump |
| CI | `.github/workflows/ci.yml` runs `npm ci` then `npm run check:release` on `.nvmrc` Node |
| Browser smoke check | Not automated; manual landing / Try Demo / open-file still the only coverage |

The build already separates routes and heavier viewers into lazy chunks. No wholesale frontend rewrite is justified by this review. The backend already has an authoritative desktop Durable Object, scoped app permissions, mutation approval tools, coordinated auth operations, and rate limiting for public assets and visitor WebSocket connections.

## Release blockers

### R1 — File caching does not respect changing permissions — ✅ Done (2026-11-11)

Original evidence: `upload.ts:1074`/`:1096` served `Cache-Control: public, max-age=31536000, immutable` for authorized private reads, and `sw.js` cached `/api/files/` responses without an authorization check.

Resolution verified in the working tree:

- `packages/worker/src/routes/upload.ts:1074` and `:1096` now set `Cache-Control: private, no-store` for permission-controlled reads. `immutable` survives only on the intentionally public assets at `:1396`, `:1588`, `:1778` (the separate public-asset policy this blocker asked for).
- `packages/frontend/public/sw.js` is now `CACHE_VERSION = 'v2'` and precaches only the app shell (`['/', '/index.html', '/manifest.webmanifest']`); activation deletes older `eternalos-*` caches. It no longer caches `/api/files/`.
- Regression coverage exists: `packages/frontend/test/*.test.mjs` asserts that permission-controlled requests bypass stale HTTP and SW caches, that offline requests cannot fall back to previously authorized bytes, and that activation purges legacy file caches. The worker suite adds "never caches file bytes and rechecks visibility for full, conditional, and range requests" and "removes newly-private items / blocks trashed public files immediately."

Acceptance met for application-controlled caches. Note still standing: bytes already downloaded to a client cannot be remotely erased and must not be represented to users as revocable.

### R2 — Account deletion purge — ✅ Done (2026-11-11)

Soft-delete now writes a `pending-deletion:{uid}` index (`routes/auth.ts`) that the scheduled handler enumerates (`index.ts`), purging every account past its `hardDeleteAt`. The purge (`utils/accountPurge.ts`) is idempotent and resumable — anchor keys (user record, uid/username indexes, pending marker) are deleted last, so a crash mid-run is re-purged next cron. It covers AUTH_KV account keys + OAuth index, DESKTOP_KV (public snapshot, agent threads, app storage, bazaar author + packs + type indexes, app/game registries), R2 (`{uid}/`, `apps/{uid}/`, `app-previews/{uid}/`, bazaar assets), the `UserDesktop` DO (new `/purge` → `storage.deleteAll()`), and per-thread `OrchestratorAgent` DOs (new `purgeThreadData()` clearing messages + state).

Retention policy (chosen 2026-11): **published content is deleted** — the user's bazaar packs, listings, and R2 assets go too, breaking installs for others. Documented residuals: session/refresh tokens (token-keyed, no uid index — already invalidated at soft-delete and TTL-expiring) and per-game saves (`gamesave:{gameId}:{uid}`, uid-suffixed, orphaned).

The grace period is env-overridable (`ACCOUNT_DELETION_GRACE_DAYS`, default 14) so the integration test sets it to 0, soft-deletes, triggers the scheduled handler, and verifies the account is gone, its email/username are reusable, and a second run is a no-op.

Required work:

- Implement resumable, idempotent account purge covering account indices, sessions, desktop state, uploaded assets, apps, games, chat threads, memory, and marketplace ownership according to an explicit retention policy.
- Define and enforce public desktop/file visibility during the grace period.
- Make cancellation behavior and the UI's promise agree with the actual lifecycle.
- Test deadline boundaries, partial failures, retry, cancellation, and OAuth-only accounts with a controllable clock.

Acceptance: an integration test advances beyond the deadline and verifies the documented data disposition across all stores, including public access paths.

### R3 — Failed writes can leave a false local state — ✅ Done (2026-11-11)

`packages/frontend/src/stores/desktopStore.ts` has a per-item serialized mutation queue (`persistItemMutation` / `itemWriteQueues`), a `sessionVersion` guard so stale responses can't write into a newer account session, acknowledgement-aware update handling (`requiresAcknowledgement`, optimistic-item reconciliation), and a cache-purge path that cancels pending writes on sign-out.

The last gap — the position-save path — is now closed: `moveItem` runs its debounced save through `persistItemMutation` and, on failure, rolls back to the **last server-known position** (captured once per save cycle via `positionRollback`, so a rapid drag reverts to the pre-drag position, not an intermediate one), caches the reverted state, and surfaces a "Sync Failed" alert. A stale failure can't clobber a newer move (guarded by a position + `sessionVersion` check). Covered by four new tests in `desktopStore.test.ts` (success persists; failure reverts; rapid-drag reverts to pre-drag; stale failure doesn't clobber).

Remaining nice-to-have (not a blocker): a visible saved/saving/failed status indicator for editors/settings — tracked under Workstream 4.

Acceptance met: forced offline / 401 / 429 / 500 no longer leave a successful-looking unsaved item or privacy setting, including positions.

### R4 — Session refresh lacks coordination between tabs — ✅ Done (2026-11-11)

All four sub-items are implemented (an earlier pass mis-marked this partial because the Web Locks call was missed in a truncated search):

- ✅ **Cross-tab serialization** — refresh runs inside `navigator.locks.request('eternalos-session-refresh', …)` (`api.ts:386`), falling back to the module-local promise where Web Locks is unavailable.
- ✅ **"Another tab already rotated" adoption** — inside the lock, the refresh re-reads the stored session and, if another tab has already rotated the token, adopts the new tokens instead of re-rotating (`api.ts:330`–`:341`) — which is what prevents a legitimate second refresh from looking like token theft.
- ✅ **Login/logout/token propagation** — a `storage` listener in `authStore.ts` (`:495`–`:521`) reloads on cross-tab logout / account switch and adopts rotated tokens in-memory for an idle tab.
- ✅ **Transient-vs-invalid** (`RefreshUnavailableError`) and **backend replay protection** (untouched) as before.

Acceptance met, with tests in `api.test.ts`: "two tabs rotate a shared refresh token only once," temporary failures (offline/429/500/503) keep credentials, a delayed refresh cannot restore a session after logout, and a rejected refresh expires the session.

### R5 — Release verification is not reproducible yet — ✅ Done (2026-11-11), with two minor gaps

Resolution verified:

- ✅ Node pinned via `.nvmrc` (22.23.2) and root `package.json` `engines` (`>=22.23.2 <23`); CI uses `node-version-file: '.nvmrc'`.
- ✅ Test dependencies declared in `packages/worker/package.json` (`source-map` 0.8.0, `undici` 7.29.1, `ws` 8.21.3). The worker suite runs cleanly (19/19).
- ✅ Frontend typecheck is `tsc -b --force` (traverses the project references); the production build still backstops it.
- ✅ One consolidated command exists: `check:release` = typecheck + lint + test + build + build:worker, and CI runs exactly that.
- ✅ Deploy is separated: root `build:worker` now builds (not deploys); `deploy:worker` is distinct.

Remaining minor gaps (do not block, but close before calling the gate complete):

- `check:release` has **no browser smoke step** — the end-to-end journey this doc asks for is still manual.
- There is **no clean-install gate**: CI relies on `npm ci`, but nothing runs the full check from a pristine checkout locally. Note: local runs are on Node 25 while CI pins 22 — keep local on `.nvmrc`.

Acceptance: largely met for a clean CI checkout; add the browser smoke step to fully satisfy it. A separate staging integration suite for external integrations is still required.

### R6 — Dependency advisory triage — 🟡 Partial (2026-11-11)

Triaged and reduced from **33 (1 critical, 21 high)** to **31 (0 critical, 20 high)**:

- **Critical fixed:** `proxy-addr` (GHSA-jqcg-44mw-7w3h, IPv4-mapped IPv6 trust spoofing) was pinned to the patched `2.0.8` via a root `overrides`. It reaches the tree only through `agents → @modelcontextprotocol/sdk → express` — the MCP HTTP-server transport, which this app never runs (verified: no `express`/`proxy-addr` import in source). Pinned defensively regardless.
- **Reachable high fixed:** `dompurify` (FORBID_TAGS bypass) bumped `^3.3.3 → ^3.4.17` (in-range, no major bump). This one is genuinely reachable — it sanitizes rendered markdown in `MarkdownViewer.tsx`.

Reachability triage of the remaining 20 highs:

- **Not reachable** — `react-router`/`react-router-dom` (turbo-stream RCE needs data-router/SSR APIs; the app uses none), `hono` (no `hono` import — the worker hand-rolls its router), `lodash` (`_.template` not used), and the `express` subtree (`body-parser`, `path-to-regexp`, `fast-uri` — MCP server transport, not run).
- **Dev/build tooling** (not in the deployed Worker or browser bundle) — `vite`, `rollup`, `postcss`, `browserslist`, `source-map-js`.
- **Blocked behind a major bump** — the remaining fixes want `agents 0.7 → 0.8`, which peer-requires `zod ^4` (a major bump). Deferred deliberately: the chat transport and app-builder ride on `agents`, and the roadmap forbids a blanket major-version update without a transport regression pass. Candidates here include `zod` (oversized-collection DoS), `@modelcontextprotocol/sdk`, `@cloudflare/ai-chat`, `nanoid` (negative-size loop — not called with negative size).

Remaining work: schedule the `agents 0.8` + `zod 4` upgrade as its own task with a chat/app-builder regression pass, then re-audit. Acceptance (no unaddressed *reachable* high/critical) is met for everything except that deferred, non-reachable set.

Acceptance: no unaddressed reachable high/critical issue, and sanitizer, app sandbox, and chat transport regressions pass after upgrades.

## Finish the existing features

| Feature | Required release acceptance |
| --- | --- |
| Signup and onboarding | New account, verification delivery, recovery codes, theme choice, first upload, and refresh preserve the expected result; failures give a usable recovery path |
| Login and account settings | Password/OAuth login, reset, recovery, multi-tab refresh, logout, export, deletion, and cancellation work end to end |
| Desktop and windows | Drag does not swallow clicks; selection, rename, folders, cut/copy/paste, duplicate, trash, restore, resize, and window restoration survive reload and connection loss |
| Files and search | Upload validation, quota boundaries, failed upload cleanup, public/private access, media seeking, AI enrichment failure, and deterministic search results have coverage |
| Appearance | Every shipped preset is readable across windows, menus, dialogs, editors, and widgets; save/reload, reset, CSS sanitization, CSS history, and theme import/export work |
| Sharing | Fresh and returning visitors see only authorized items; nested folders, direct links, deleted accounts, and cached assets obey the same policy |
| Ask Eternal | First message, streaming, stop, reconnect, thread history, approval rejection/acceptance, provider failure, and repeated requests produce coherent outcomes; impose per-account usage/concurrency controls |
| Developer Studio | Source edit, preview, permission grant/revoke, install, upgrade, and rollback work; adversarial apps cannot escape file/network/storage scope |
| Games | Edit, run, save, reload, publish, install, upgrade, and per-player save isolation work |
| Bazaar | Publish, republish, install, uninstall, validation failure, duplicate requests, and asset failure behave consistently; define report/takedown and operator recovery workflows |
| Mobile | Define a supported feature list and expose it clearly; test actual phone-sized navigation, touch interaction, upload, viewers, sharing, keyboard occlusion, and orientation changes |
| Accessibility | Keyboard access to core actions, named dialogs, focus containment/return, visible focus, zoom, reduced motion, and readable contrast across presets |

Specific accessibility debt — ✅ fixed (2026-11-11): `ContextMenu.tsx` is now a proper ARIA menu (menu/menuitem roles, roving-tabindex arrow/Home/End navigation, Enter/Space activation, visible focus). `AlertDialog.tsx` now has a focus trap, `aria-labelledby`/`aria-describedby`, and focus restoration; the document-wide Enter handler that fired the primary action regardless of focus was removed (Enter now activates the focused button), closing the "Enter confirms a destructive action from another control" hazard. A manual in-browser keyboard pass is still recommended before shipping destructive flows.

For browser coverage, prioritize complete user journeys over tests that mirror component internals. Start with account creation → customize → upload → reload → share → revoke → trash/restore, then add failure and security boundary cases. Include Chromium, Firefox, and WebKit; verify touch behavior on real iOS/Android devices before claiming broad mobile support.

## Structure: improve boundaries while fixing behavior

Keep the two deployable workspaces. Make focused extractions alongside the fixes above:

1. Add a small shared contracts workspace for API request/response schemas and common domain types. `DesktopItem` and `UserProfile` are independently declared in frontend and worker today. Runtime validation belongs at network boundaries, not just TypeScript casts.
2. Split the 1,678-line frontend API client into transport/session handling and domain clients. Make auth transitions and refresh coordination independently testable.
3. Extract desktop commands and persistence from the 2,077-line `Desktop.tsx` and 1,109-line desktop store. Keep interaction/rendering state distinct from acknowledged server state.
4. Split the 2,144-line chat window into conversation rendering, thread navigation, approval UI, inspector, and transport handling.
5. Separate route dispatch from middleware in the 1,531-line worker entrypoint. Several agent routes return before the general rate-limit block; give each route an explicit auth, validation, rate-limit, and error policy.
6. Keep `UserDesktop` as the per-user consistency boundary while extracting internal domain operations. Do not split it into new services merely to reduce file size.
7. Consider a feature registry shared by menus, desktop/mobile launchers, and viewer dispatch so feature availability and open behavior have one definition.

Line counts describe review hotspots, not automatic defects. Avoid a folder-wide reorganization until behavior is covered. No new database, microservice split, or frontend framework migration is necessary to address the blockers above.

## Operational release gates

- Dedicated staging with separate data bindings, secrets, domains, and third-party test configuration. The test Wrangler config is useful but is not a production-equivalent staging environment.
- Verify required API URL, email, OAuth, Turnstile, AI model access, and sandbox bindings before promotion. Production must not silently fall back to mock mode when the API URL is absent.
- Enable structured logs and useful request correlation; monitor auth failures, save failures, WebSocket reconnects, AI errors/cost, quota failures, and background job completion. Redact credentials and user content. No observability block is present in the checked-in production Wrangler config; dashboard settings were not inspected.
- Exercise backup/export and restore for one account, including files and desktop state. Document rollback across frontend, Worker version, and Durable Object schema changes.
- Make background cleanup resumable. The current cron enumerates all users and processes batches within the same invocation; batching alone does not split execution budgets or provide a durable retry checkpoint.
- Publish accurate product policies and support/report routes. A policy design document exists, but no privacy/terms routes were found in the app router. Final wording and operational practices need a separate review.
- Validate new-deploy behavior with an already-open tab and dirty editor. Wire a controlled update experience and cache cleanup rather than assuming a page reload is harmless.
- Establish a launch capacity target and test that load in staging, including file-heavy visitor desktops and concurrent AI usage.

Platform recommendations are informed by [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), retrieved during this review. Production account settings were not audited.

## Suggested implementation sequence

Original sequence, annotated with 2026-11-11 progress:

1. **Make the baseline reproducible:** ✅ mostly done (R5) — supported runtime, test deps, real typecheck, and `check:release` all landed. Still add a browser smoke step to the consolidated check.
2. **Protect trust and data:** caching/privacy ✅ (R1) and most mutation acknowledgement/recovery ✅ (R3) are done. **Remaining here is the priority queue:** account purge (R2, fully open), cross-tab sessions (R4, cross-tab piece open), and the position-save reconciliation (R3 tail). Add regression tests with each fix.
3. **Complete feature journeys:** use the acceptance matrix below; fix failed journeys and unify shared interaction behavior as needed.
4. **Polish the supported surface:** preset matrix, accessibility, mobile behavior, empty/loading/error states, and update handling.
5. **Rehearse launch:** production-equivalent staging, external integrations, load test, restore drill, rollback drill, then a limited beta on a frozen candidate.

Dependency triage (R6, regressed to 1 critical) runs alongside step 2 — triage the critical advisory before any promotion.

**Suggested next concrete step:** implement R2 (account purge) — it is the largest fully-open blocker and has no partial work to build on, so it unblocks the "protect trust and data" milestone the most.

Release only when all blockers are closed, the acceptance matrix has recorded evidence, the exact candidate passes CI, and staging integration/restore/rollback checks pass. Defer social features, MCP expansion, new themes, and other platform additions until this milestone is complete.

The older `design/ROADMAP.md` is now actively stale and must not be used as a release checklist. Verified 2026-11-11, it still asserts things the current code contradicts: "Frontend has zero tests; no CI" (line 45), and that `/api/files`, `/api/wallpaper`, `/api/css-assets`, `/api/sounds`, `/api/cursors`, and `/api/bazaar/assets` "skip rate limiting" (lines 42, 118–119) — all false today (CI exists; the backend has public-asset and visitor-WebSocket rate limiting). Treat ROADMAP.md as a deferred-ideas backlog only, or retire it; this document (RELEASE-READINESS.md) is the authoritative release checklist.
