# EternalOS Core Roadmap

> Authored 2026-11-11. **Authoritative plan — supersedes `RELEASE-READINESS.md`** (now a reference appendix) and the archived `ROADMAP.md`.
>
> **Principle: get the core product right before adding new surfaces.** "Core" here is the product people actually touch every day — the desktop and files, how they customize it, how they create apps, and how they talk to the agent. Platform expansion (social, a mobile rebuild, MCP publishing, a marketplace v2, federation) is explicitly **parked** until these four are solid.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started · 🔎 Needs a reliability pass (works, under-tested or rough).

> **Security + reliability hardening pass (2026-11-12 → 13, branch `cursor/w2-css-sanitizer`).** A sweep of the auth, app-bridge, bazaar, upload, visitor, and customization surfaces. Real bugs found and fixed, each with a regression test where the harness can drive it (the Worker-Loader app/game bridge reads a separate DO namespace under `unstable_dev`, so a few bridge-only fixes are covered by reasoning + adjacent tests):
> - **App fs scope escape (write):** `EternalService.write` authorized the claimed `path` while an out-of-scope `parentId` decided placement → an app could write into any folder whose id it knew. Now authorizes the real target path.
> - **App privilege passthrough (patch):** `EternalService.patch` forwarded `updates` to the owner-facing DO allowlist → an app could set `isPublic` / `parentId` / `grantedPermissions` on items it can write. Now filtered to benign content fields.
> - **SSRF false-positive:** the app-fetch guard treated any DNS host starting with `fc`/`fd` (fcc.gov, fdic.gov) as a private IPv6 address and blocked granted fetches. Gated the IPv6 ULA check on the host being an IPv6 literal.
> - **dev-deploy status codes:** external-import and IPC declaration errors mapped to 500 instead of 400.
> - **Game-save lockout:** the rate limiter re-set its TTL every write, locking out an actively-saving player mid-session; switched to a fixed window.
> - **Variants never persisted:** the profile allowlist dropped `variants`, so window-chrome selections were lost on reload/new device and never reached visitors. Added + validated the field.
> - **Visitor appearance lost from cache:** `handleVisit`'s cache path returned the nested `{items,profile,windows}` snapshot while the client reads flat appearance fields, so a cached visit (populated on every mutation) dropped ALL custom appearance. Both paths now flatten through one builder.
> - **Username normalization:** signup/change-username validated the raw input but stored the normalized one (`"___"` → empty handle, `"_bob"` → `bob`). Now re-validates the normalized value.
> - **OAuth CSRF fail-open:** `verifyOAuthState` returned `null === null` → true with no stored state; now fails closed (it is the sole CSRF guard — the server callback never sees the state).
> - **Link-item stored XSS:** item `url` was stored unvalidated and rendered as an `<a href>` / opened in the website viewer, so a public `javascript:` link item was stored XSS against any visitor who clicked it. Now restricted to http(s) on write (matching profileLinks), with an inert-text render guard in GetInfo as defense in depth.
> - **Secret in GDPR export:** the data export stripped `passwordHash` but left `recoveryCodesHashed` (password-equivalent). Now stripped too.
> - **Agent thread titles:** user-supplied create/rename titles were uncapped (auto titles cap at 60); bounded to 100 to keep the per-user thread-list KV value under its size limit.
> - **Defense in depth:** `nosniff` on all upload serve paths; DOM-apply guards so the appearance store is testable; de-flaked the worker suite against transient non-JSON runtime errors.
>
> New integration coverage: the full auth lifecycle (recovery-code login + regeneration, change-password session invalidation, change-username normalization/uniqueness, cancel-deletion, GDPR export secret-stripping), agent thread CRUD + per-user isolation, fs-scope + patch-field + SSRF boundaries, profile variants round-trip, and the link-URL XSS guard. Frontend: appearance store actions, the visitor transform, and the OAuth state check. Worker suite 20 → 34, frontend 44 → ~310.
>
> Audited and found clean (no bug): bazaar publish/install + estheme, the designTokens/customCSS validators, app storage (KV) sandboxing, profile field filtering, game cross-isolation + sandbox grant, `fsPolicy` glob matching, `getPublicItemsFiltered` (fails closed), the cartridge validator, og:image escaping, the refresh-token rotation + reuse detection, recovery-code entropy, agent chat capability tokens (purpose-bound), analytics dedup, and the sound/cursor serve routes.
>
> **Test harness:** the worker integration suite now runs against a fresh ephemeral `persistTo` temp dir per run (not the shared `.wrangler/state`), so it is hermetic — no state leaks between runs, no dev-account pollution, and the previously flaky/slow `hard-deletes an account…` test (which scanned a KV bloated by accumulated test signups) now runs in ~0.25s and is stable. Note: a large `.wrangler/state` from earlier runs can be cleared; it is no longer written to by tests.

## How to read this

Four core workstreams, each with: where it stands, what to do (ordered), and what "good" looks like. Underneath them sits **Foundations** — cross-cutting reliability that every workstream depends on. A surface is not "done" until its acceptance bullets have recorded evidence (a test or a logged manual run), not just a passing build.

Verification baseline that already holds (re-run 2026-11-11): both typechecks, frontend build, lint, and all tests pass (21 frontend + 19 worker). The solid substrate — JWT + refresh rotation, bcrypt, per-user `UserDesktop` Durable Object on SQLite, magic-byte upload validation, strict CSP/HSTS/env-aware CORS, public-asset + visitor-WS rate limiting, and Dynamic Workers as the sandboxed app runtime — is real and should not be rewritten.

---

## Foundations — reliability that holds under every surface

These are the former release blockers (full evidence in [RELEASE-READINESS.md](RELEASE-READINESS.md)). They are not features, but no core surface is trustworthy until they hold.

| Id | Area | Status | Remaining |
| --- | --- | --- | --- |
| R1 | File cache vs. changing permissions | ✅ Done | — |
| R5 | Reproducible verification (CI, pinned Node, `check:release`) | ✅ Done | Add a browser smoke step |
| R3 | Failed writes / false local state | ✅ Done | Position-save now queues through `persistItemMutation` with rollback to the last server-known position + failure surfaced; covered by tests |
| R4 | Cross-tab session refresh | ✅ Done | `navigator.locks` serialization + "another tab already rotated" adoption (`api.ts`) + cross-tab logout/token propagation via `storage` listener (`authStore.ts`); full acceptance covered in `api.test.ts` |
| R2 | Account-deletion purge | ✅ Done | Resumable, idempotent purge in the cron (`utils/accountPurge.ts`), covering AUTH_KV/DESKTOP_KV/R2/UserDesktop DO/agent threads + published content; integration test past the deadline |
| R6 | Dependency advisory triage | 🟡 Partial | Critical (`proxy-addr`) and reachable sanitizer (`dompurify`) fixed → 0 critical, 20 high. Remaining highs are dev/build tooling or unused transports; the rest need the `agents 0.8` + `zod 4` major bump (deferred — chat-transport risk) |

**Accessibility correctness debt — ✅ fixed (2026-11-11):** `ContextMenu.tsx` is now a proper ARIA menu (`role="menu"`/`menuitem`/`menuitemcheckbox`, roving-tabindex arrow/Home/End navigation, Enter/Space activation, visible keyboard focus). `AlertDialog.tsx` now has a focus trap, `aria-labelledby`/`aria-describedby`, focus restoration to the opener on close, and — critically — the dangerous document-wide Enter handler was removed so Enter activates the *focused* button instead of always firing the primary (destructive) action. Recommended follow-up: a manual keyboard pass in-browser to confirm feel; the static gates (typecheck/lint/build/tests) pass.

---

## Workstream 1 — Core functionality (desktop, windows, files)

The thing EternalOS *is*: a draggable desktop of windows, icons, folders, files, and widgets that survives reload and connection loss.

**Where it stands** — 🔎 Mature but under-tested. `Desktop.tsx` (~2,000 lines) and the desktop store (~1,100 lines) carry interaction, rendering, and server-sync state together. The body-drag/click-swallow bug is fixed and must stay fixed. Viewers exist for text, code, markdown, PDF, image, audio, video, and websites; widgets for sticky notes, link boards, music, pixel canvas, and a guestbook.

**Do (ordered):**
1. ✅ **Done — R3 closed:** the position-save path now queues through `persistItemMutation`, rolls back to the last server-known position on failure (even across a rapid drag), and surfaces a "Sync Failed" error. A broader saved/saving/failed *status indicator* for editors/settings is still a nice-to-have, tracked under Workstream 4's save-status work.
2. **Fix the accessibility bugs above** (ContextMenu keyboard nav + menu roles; AlertDialog focus trap, title linkage, and scoped Enter) — correctness, not polish. ✅ **ContextMenu half (2026-11-19):** roles + roving keyboard nav landed with the 2026-11-11 pass; the remaining gaps are now closed — Escape restores focus to the element that had focus before the menu opened, and Tab closes the menu — and the full contract is pinned by `ContextMenu.test.ts` (real component render under the repo's node-env test DOM): `menu`/`menuitem`/`menuitemcheckbox`/`separator` roles with `aria-disabled`/`aria-checked`, initial focus on the first enabled item, ArrowUp/ArrowDown wrap skipping disabled items, Home/End, Enter/Space activation, Escape close + focus restore, Tab close, plus mouse-click activation guards. The menu API has no submenus, so `aria-haspopup`/`aria-expanded` has nothing to apply to. AlertDialog half still open.
3. ✅ **Harden the reliability matrix with tests** (substantially done): create/delete/update/position, **trash/restore**, and **cut/paste** (`pasteItems`) have optimistic-write rollback + failure surfacing with tests (`desktopStore.test.ts`) — a failed move/trash/restore no longer leaves an item looking moved/(un)trashed when the server never recorded it. **Window restoration** across reload / connection-loss is now covered (`windowStore.test.ts`): restores from localStorage, falls back to server windows on a new device / cleared cache, drops windows whose item was deleted, discards corrupt state, and clamps off-screen windows into the viewport. **Deterministic search** is now done: the ranking was extracted from `SearchWindow` into a pure `utils/search.ts` (`searchItems`) and given a total-order tiebreak (score → recency → **id**), so equal scores/timestamps no longer produce non-deterministic ordering; covered by `search.test.ts` (determinism, AND semantics, synonym vs exact ranking, trashed exclusion, limit). **Upload reliability** is covered (`desktopStore.test.ts`): a successful upload adds the item and completes its progress entry; a failed upload leaves no phantom item and marks the entry errored; a late upload after an account switch can't populate the next account. (Worker-side upload validation + quota accounting already have integration coverage.) **Folder creation** goes through `addItem` (a folder is just `type: 'folder'`), so it's covered by the failed-create rollback test. **Resize persistence** is covered (`windowStore.test.ts`): a resize enforces the 200×150 minimum and round-trips through localStorage to survive reload. Rename rides on `updateItem` (partially covered). **The W1 reliability matrix is now substantially complete.**
4. **Separate acknowledged server state from interaction state** in the store (prerequisite for the above being testable); extract desktop commands/persistence from `Desktop.tsx` only as far as the tests need.

**Good when:** forced offline, 401, 429, and 500 never leave a successful-looking unsaved item or privacy setting; reconnect converges to one consistent result with no duplicates; core actions are keyboard-reachable; the drag never swallows a click on a list row or tab.

---

## Workstream 2 — Customization

Half the product's personality. Today it spans custom CSS, color tokens, typography, variants, wallpaper, cursors, sounds, sprites, icons, and CSS assets.

**Where it stands** — 🟡 Rich but fragmented. The token pipeline (`CustomAppearance` → `resolveTokensFromAppearance` → `compileTokensToCSS` → DOM) works; CSS is sanitized and scoped to `.user-desktop`; CSS history/restore exists; presets live in `onboardingPresets.ts`. The `.estheme` single-file skin format (export/import/fork/nest) is **designed and partially built** — manifest validator, mirrored frontend schema, builder, parser, and an export helper exist — but bazaar still publishes a flat token blob, not CSS + cursors + sounds + wallpaper as one unit.

**Do (ordered):**
1. ✅ **Preset readability matrix (automated floor done):** every shipped preset is now guarded by `onboardingPresets.test.ts` — structural shape, valid-hex ink colors, a 3.0:1 contrast floor on the authored text/background pairs (title/button/label), a clean token-pipeline compile, and customCSS that sanitizes scoped + remote-free. This caught + fixed a real one (Y2K: white title text on hot pink, 2.65:1 → dark-magenta `#8B0040`, 3.65:1). **Follow-up (optional):** an in-browser manual pass for the gradient/glass surfaces (XP, Frutiger Aero) whose text contrast can't be computed from hex.
2. **Lock down the customization round-trip:** save/reload, reset, CSS sanitization, CSS history restore, and theme import/export each need a test. Sanitizer regressions are a security surface, not just cosmetics. ✅ **Done:** the CSS sanitizer was extracted from `appearanceStore` into a pure, unit-tested `utils/cssSanitizer.ts` (url() allowlisting, `@font-face` stripping, `.user-desktop` scoping — covered by `cssSanitizer.test.ts`), and the save/reload round-trip (`profileToAppearance` ↔ `appearanceToProfileFields`, `buildTokenUpdate`/`getTokenValue` token routing) is covered by `appearanceStore.test.ts`. The init-time `applyAppearance` paint is now DOM-guarded. The `.estheme` theme import/export round-trip is now covered (`estheme.test.ts`): `validateManifest` (good/malformed/strict/path-traversal), `validateManifestAgainstFiles`, and a full `buildEsthemeBundle` → `parseEsthemeBundle` round-trip incl. tamper rejection. **This surfaced + fixed a real bug:** the frontend manifest schema (zod 4) used `z.record(z.enum(...))`, which is *exhaustive* in zod 4, so any theme overriding only some cursor/sound/icon slots was wrongly rejected — switched those layers to `z.partialRecord` (the worker mirror is on zod 3 and was unaffected). The token compiler itself (`resolveTokensFromAppearance` → `compileTokensToCSS`, the pipeline core) is now directly covered by `tokenCompiler.test.ts` — var mapping, derived text colors (and their hex-only guard), font smoothing, window opacity clamps, title-bar rules, and the custom-cursor-URL security allowlist. **CSS history restore is now covered end to end** (2026-11-19): the worker suite pins the `/api/css-history` revert contract (full-profile preservation, history recording, unknown-version rejection) and the frontend restore path (`applyCSSRevertProfile`) re-applies the whole profile through `profileToAppearance`. **This surfaced + fixed a real bug:** the CSSEditor restore hand-rolled its field list and silently dropped typography, `windowOpacity`, `designTokens`, and `variants` — restoring an old CSS version wiped them from the session and localStorage until the next full sync. `resetAppearance` is now covered too: extended state (tokens/variants/fonts/opacity) is dropped, an unsaved reset leaves the last saved appearance in localStorage, and reset+save persists `{}` locally while sending no stale fields. **Known gap (deliberately not fixed here):** the profile PATCH protocol has no field-tombstone mechanism, so a reset (or a preset switch away from a themed rice) does not clear previously saved appearance fields **on the server** — reload restores them. Fixing it means teaching `updateProfile` an explicit clear semantic; deferred as its own protocol change.
3. **Unify `.estheme`:** finish the single-bundle path so a theme carries CSS + cursors + sounds + wallpaper + variants together, with preview-before-install ("Keep"/"Revert") and fork lineage. Keep it drag-and-drop.
4. **Editors pass:** CSSEditor, CursorEditor/Creator, SpriteEditor, WallpaperPicker, VariantPicker — confirm each writes back through the token pipeline and survives reload. ✅ **Done (2026-11-19), per editor:**
   - **CSSEditor** — writes via `setCustomCSS` (sanitized, alias-normalized) + `saveAppearance` → profile; survives reload. **Fixed:** the History → Restore path hand-rolled its field list from the revert response, dropping typography, `windowOpacity`, `designTokens`, and `variants` — it now flows through `profileToAppearance` (`applyCSSRevertProfile`), with worker + store tests pinning the full-profile revert contract.
   - **CursorEditor / CursorCreator** — clean: both write `cursor.image.*` values through `buildTokenUpdate` → `updateAppearance` (registry tokens routed into the `designTokens` blob; Creator merges/clears slots then saves). The `url|x|y` hotspot format they persist is compile-tested (hotspot parsing + fallback, plus the first-party-URL allowlist tests). Cursor upload/serve routes already had worker coverage.
   - **SpriteEditor** — **was entirely broken, now fixed:** its token paths (`chrome.sprite.*`, `titlebar.sprite.url`, `buttons.sprite.*`, `resize.sprite.url`) are *conditional tokens* registered by variants, not `TOKEN_REGISTRY` entries — so `buildTokenUpdate`/`getTokenValue` no-oped every upload/remove/slice write (asset uploaded, nothing applied or saved), and the compiler never emitted the sprite CSS vars even for values that did reach `designTokens`. Pipeline lookups, the compile loop, and var clearance now include conditional tokens (compiled only while their variant is active); routing/merge/remove semantics and sprite/gradient compile are regression-tested.
   - **WallpaperPicker** — clean: wallpaper is a profile field by design (not a design token); `setWallpaper`/`setWallpaperMode` PATCH the profile and `useDesktopSync` restores on boot. Worker test now pins the `wallpaper`/`wallpaperMode` round-trip and the uid-hijack guard on `custom:` values.
   - **VariantPicker** — clean: variant selections write through `updateAppearance` → `variants` blob (the "variants never persisted" fix from the hardening pass covers reload), and variant `defaults` merge into `designTokens`; with the SpriteEditor fix those defaults now actually compile (gradient stops tested).

**Good when:** a user can export their whole rice as one `.estheme`, hand it to someone else, and have it install and apply identically; no preset renders unreadable chrome; malformed CSS/manifests are rejected safely with a usable error.

---

## Workstream 3 — App creation

The platform bet: generate real, editable, sandboxed apps from natural language. Architecture is settled (see [12-orchestrator-v2.md](12-orchestrator-v2.md), [13-source-first-app-workspaces.md](13-source-first-app-workspaces.md), [01-apps-interop.md](01-apps-interop.md)); execution stops one layer short.

**Where it stands** — 🟡 Strong substrate, thin pipeline. `buildAppFromPrompt` already does server-side structured generation; apps run as Dynamic Workers with a constrained `window.eternal` bridge (`fs.list/read/readText/readJson/urlFor`, `profile.get`); both `source.json` and `bundle.json` are persisted. But `assembleWorkerFiles()` still privileges one HTML/one CSS/one JS entrypoint, generation is brief→files (no explicit spec stage), validation leans on bundle errors, and declared vs. granted permissions aren't separated.

**Do (ordered — maps to the orchestrator rollout):**
1. **Phase A — builder shape:** add an explicit `buildSpecFromPrompt()` stage ahead of file generation; make validation rules first-class (permissions, asset references, empty states) instead of relying on bundle errors; improve repair prompts with the actual compiler/runtime errors. Demote curated templates to test fixtures only. 🟡 **Partial:** `validateGeneratedApp` (the source gate the dev-deploy and AI-build paths share) now has adversarial coverage via `/api/apps/dev-deploy` in `worker.integration.test.mjs` — external script/stylesheet links, external dynamic + static imports, fs-read/profile/network/ipc usage without the matching declared permission, missing local asset refs, missing HTML entrypoint, and a positive declared-permission control. **This surfaced + fixed a real bug:** the dev-deploy catch block mapped thrown validation messages to HTTP status by prefix, but the prefixes for external imports (`Dynamic imports…`, `Imports from…`) and IPC declaration errors (`App emits/listens…`) were missing, so those client-supplied bad bundles returned **500** (server fault, trips 5xx alarms) instead of **400** — fixed in `routes/apps.ts`.
2. **Phase B — permission mediation:** separate declared from granted permissions; add approval UI for broad scopes; store grant rationale + approval metadata.
3. **Phase C — validation & repair:** deterministic post-bundle validation pass; targeted repair for runtime-contract mismatches; one reference acceptance app ("Photo Grid") as a regression fixture.
4. **Source-first editor:** treat the source workspace as the product and the bundle as derived — move Developer Studio toward editing real files with diff/undo, separate live preview from source editing.
5. **Sandbox adversarial tests:** a generated/edited app cannot escape its declared file/network/storage scope.

**Good when:** "Build me a gallery app for my photos" produces an app that installs, reads the user's actual photos through `window.eternal`, and survives edit → preview → reinstall; an adversarial app provably cannot read outside its grant.

---

## Workstream 4 — Agent (Ask Eternal)

The conversational front door to everything above. `OrchestratorAgent` (DO) over WebSocket, 3-pane chat UI, tools for apps, desktop, and memory.

**Where it stands** — 🔎 Works, needs a reliability + controls pass. Transport is `useAgent`/`useAgentChat` over WebSocket; threads via REST. Intent routing (build-app vs. chat) is regex-based in `OrchestratorAgent.ts`. Chat colors derive from theme vars via `color-mix()`. Locally (AI binding off) the UI works but replies error.

**Do (ordered):**
1. **Transport reliability:** first message, streaming, stop, reconnect, and thread-history reload must all produce coherent outcomes; a dropped socket mid-stream recovers without duplicate or orphaned messages.
2. **Tool-call correctness:** exercise `appTools`, `desktopTools`, `memoryTools` end to end, including the mutation **approval** flow — rejection and acceptance both reconcile correctly, and a rejected approval never half-applies.
3. **Per-account controls:** usage and concurrency limits so one account can't exhaust AI budget or pin the DO; graceful, legible handling of provider failure.
4. **Intent routing robustness:** the regex router is brittle; give it clearer boundaries or a lightweight classifier, and make "edit my app" vs. "build an app" vs. "chat" unambiguous.

**Good when:** streaming/stop/reconnect/history never corrupt a thread; every tool and the approval flow have coverage; provider or budget failure degrades to a clear message, not a stuck spinner.

---

## Parked until core is solid (do NOT start yet)

From the archived [ROADMAP.md](ROADMAP.md) P2/P3 tiers — real work, deliberately deferred so it builds on a solid core:

- **Social v1** (D1 spine, follows, feed, forums, moderation) — [02-social-v1.md](02-social-v1.md)
- **Mobile as a new paradigm** (PWA grid, gestures) beyond the current responsive shell — [03-mobile.md](03-mobile.md)
- **Per-user MCP server** (OAuth-scoped desktop tools) — [05-mcp-server.md](05-mcp-server.md)
- **Bazaar / marketplace v2** (forkable packs, lineage, report/takedown) and **D1 migration** of bazaar indexes — [09-d1-migration.md](09-d1-migration.md)
- **Federation** (RSS + WebFinger), **DMs**, passkeys, command palette, DO Facets per app, terminal widget, and the P3 "ricer" polish backlog.

Exception: pull a parked item forward only when a core workstream genuinely needs it (e.g. a slice of D1 if KV indexing blocks app-creation at scale). Otherwise, parked means parked.

---

## Suggested sequence

1. **Close Foundations.** R1/R2/R3/R4/R5 ✅ done. Remaining: R6 (critical + reachable high fixed; the rest deferred behind the `agents 0.8`/`zod 4` bump) and the two accessibility bugs (ship with Workstream 1). This is the floor everything stands on.
2. **Reliability pass per surface, with tests.** Walk each workstream's "Do" list far enough to satisfy its acceptance bullets. Prioritize the surfaces by what users hit most: functionality → customization → agent → app creation.
3. **Mature app creation and the agent together** (Workstreams 3 + 4) — they share the orchestrator and are the product's differentiation.
4. **Unify customization (`.estheme`)** once the appearance round-trip is test-covered.
5. **Only then** revisit the parked feature set, re-scoping against whatever the core work changed.

Add a regression test with every fix. Keep `check:release` green on the exact commit before promoting anything.

---

## Appendix — superseded docs

- **[RELEASE-READINESS.md](RELEASE-READINESS.md)** — detailed verified evidence for the R1–R6 foundations; kept as reference, no longer the plan.
- **[ROADMAP.md](ROADMAP.md)** — archived 2026-04 feature backlog; P2/P3 vision only.
