# EternalOS Core Roadmap

> Authored 2026-11-11. **Authoritative plan — supersedes `RELEASE-READINESS.md`** (now a reference appendix) and the archived `ROADMAP.md`.
>
> **Principle: get the core product right before adding new surfaces.** "Core" here is the product people actually touch every day — the desktop and files, how they customize it, how they create apps, and how they talk to the agent. Platform expansion (social, a mobile rebuild, MCP publishing, a marketplace v2, federation) is explicitly **parked** until these four are solid.

Status legend: ✅ Done · 🟡 Partial · ❌ Not started · 🔎 Needs a reliability pass (works, under-tested or rough).

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
| R3 | Failed writes / false local state | 🟡 Partial | Position-save path still fire-and-forget (`desktopStore.ts:486`); no saved/saving/failed UI |
| R4 | Cross-tab session refresh | 🟡 Partial | No cross-tab coordination yet (`navigator.locks` + `BroadcastChannel`); logout propagation |
| R2 | Account-deletion purge | ✅ Done | Resumable, idempotent purge in the cron (`utils/accountPurge.ts`), covering AUTH_KV/DESKTOP_KV/R2/UserDesktop DO/agent threads + published content; integration test past the deadline |
| R6 | Dependency advisory triage | 🟡 Partial | Critical (`proxy-addr`) and reachable sanitizer (`dompurify`) fixed → 0 critical, 20 high. Remaining highs are dev/build tooling or unused transports; the rest need the `agents 0.8` + `zod 4` major bump (deferred — chat-transport risk) |

**Accessibility correctness debt (ships with the surfaces it touches):** `ContextMenu.tsx` renders clickable `div`s with no keyboard/menu semantics; `AlertDialog.tsx` has no focus trap, no accessible title linkage, and a document-wide Enter handler that fires the primary action even when another control is focused — dangerous before destructive confirmations. Fix these as part of Workstream 1.

---

## Workstream 1 — Core functionality (desktop, windows, files)

The thing EternalOS *is*: a draggable desktop of windows, icons, folders, files, and widgets that survives reload and connection loss.

**Where it stands** — 🔎 Mature but under-tested. `Desktop.tsx` (~2,000 lines) and the desktop store (~1,100 lines) carry interaction, rendering, and server-sync state together. The body-drag/click-swallow bug is fixed and must stay fixed. Viewers exist for text, code, markdown, PDF, image, audio, video, and websites; widgets for sticky notes, link boards, music, pixel canvas, and a guestbook.

**Do (ordered):**
1. **Close R3's tail:** give the position-save path the same queue/rollback the item mutations now have, and surface a saved/saving/failed signal for editable content and settings.
2. **Fix the accessibility bugs above** (ContextMenu keyboard nav + menu roles; AlertDialog focus trap, title linkage, and scoped Enter) — correctness, not polish.
3. **Harden the reliability matrix with tests:** selection, rename, folders, cut/copy/paste, duplicate, trash/restore, resize, and window restoration must survive reload and offline. Add deterministic search results and upload validation / quota-boundary / failed-upload-cleanup coverage.
4. **Separate acknowledged server state from interaction state** in the store (prerequisite for the above being testable); extract desktop commands/persistence from `Desktop.tsx` only as far as the tests need.

**Good when:** forced offline, 401, 429, and 500 never leave a successful-looking unsaved item or privacy setting; reconnect converges to one consistent result with no duplicates; core actions are keyboard-reachable; the drag never swallows a click on a list row or tab.

---

## Workstream 2 — Customization

Half the product's personality. Today it spans custom CSS, color tokens, typography, variants, wallpaper, cursors, sounds, sprites, icons, and CSS assets.

**Where it stands** — 🟡 Rich but fragmented. The token pipeline (`CustomAppearance` → `resolveTokensFromAppearance` → `compileTokensToCSS` → DOM) works; CSS is sanitized and scoped to `.user-desktop`; CSS history/restore exists; presets live in `onboardingPresets.ts`. The `.estheme` single-file skin format (export/import/fork/nest) is **designed and partially built** — manifest validator, mirrored frontend schema, builder, parser, and an export helper exist — but bazaar still publishes a flat token blob, not CSS + cursors + sounds + wallpaper as one unit.

**Do (ordered):**
1. **Preset readability matrix:** verify every shipped preset is legible across windows, menus, dialogs, editors, and widgets (XP, Frutiger Aero, and friends). This is the most visible quality signal and the cheapest to regress.
2. **Lock down the customization round-trip:** save/reload, reset, CSS sanitization, CSS history restore, and theme import/export each need a test. Sanitizer regressions are a security surface, not just cosmetics.
3. **Unify `.estheme`:** finish the single-bundle path so a theme carries CSS + cursors + sounds + wallpaper + variants together, with preview-before-install ("Keep"/"Revert") and fork lineage. Keep it drag-and-drop.
4. **Editors pass:** CSSEditor, CursorEditor/Creator, SpriteEditor, WallpaperPicker, VariantPicker — confirm each writes back through the token pipeline and survives reload.

**Good when:** a user can export their whole rice as one `.estheme`, hand it to someone else, and have it install and apply identically; no preset renders unreadable chrome; malformed CSS/manifests are rejected safely with a usable error.

---

## Workstream 3 — App creation

The platform bet: generate real, editable, sandboxed apps from natural language. Architecture is settled (see [12-orchestrator-v2.md](12-orchestrator-v2.md), [13-source-first-app-workspaces.md](13-source-first-app-workspaces.md), [01-apps-interop.md](01-apps-interop.md)); execution stops one layer short.

**Where it stands** — 🟡 Strong substrate, thin pipeline. `buildAppFromPrompt` already does server-side structured generation; apps run as Dynamic Workers with a constrained `window.eternal` bridge (`fs.list/read/readText/readJson/urlFor`, `profile.get`); both `source.json` and `bundle.json` are persisted. But `assembleWorkerFiles()` still privileges one HTML/one CSS/one JS entrypoint, generation is brief→files (no explicit spec stage), validation leans on bundle errors, and declared vs. granted permissions aren't separated.

**Do (ordered — maps to the orchestrator rollout):**
1. **Phase A — builder shape:** add an explicit `buildSpecFromPrompt()` stage ahead of file generation; make validation rules first-class (permissions, asset references, empty states) instead of relying on bundle errors; improve repair prompts with the actual compiler/runtime errors. Demote curated templates to test fixtures only.
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

1. **Close Foundations.** R2 (account purge) ✅ done; remaining: R6 (triage the 1 critical advisory), R3 tail and R4 cross-tab, and the two accessibility bugs. This is the floor everything stands on.
2. **Reliability pass per surface, with tests.** Walk each workstream's "Do" list far enough to satisfy its acceptance bullets. Prioritize the surfaces by what users hit most: functionality → customization → agent → app creation.
3. **Mature app creation and the agent together** (Workstreams 3 + 4) — they share the orchestrator and are the product's differentiation.
4. **Unify customization (`.estheme`)** once the appearance round-trip is test-covered.
5. **Only then** revisit the parked feature set, re-scoping against whatever the core work changed.

Add a regression test with every fix. Keep `check:release` green on the exact commit before promoting anything.

---

## Appendix — superseded docs

- **[RELEASE-READINESS.md](RELEASE-READINESS.md)** — detailed verified evidence for the R1–R6 foundations; kept as reference, no longer the plan.
- **[ROADMAP.md](ROADMAP.md)** — archived 2026-04 feature backlog; P2/P3 vision only.
