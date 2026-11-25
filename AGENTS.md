# Agent Notes — EternalOS

Condensed operational knowledge for working on this repo. Read this before
exploring; it answers most setup and architecture questions.

## Local dev (no Cloudflare credentials)

```bash
npm install                 # from repo root (npm workspaces)
npm run dev:worker          # wrangler dev → http://localhost:8787
npm run dev                 # vite → http://localhost:5173
```

Required local files (gitignored, create if missing):

`packages/worker/.dev.vars`:

```env
ENVIRONMENT=development
JWT_SECRET=dev-secret-change-in-production-abc123xyz
IMAGE_ANALYSIS_MODEL=@cf/meta/llama-3.2-11b-vision-instruct
AGENT_CHAT_MODEL=@cf/zai-org/glm-4.7-flash
```

`packages/frontend/.env.local`:

```env
VITE_API_URL=http://localhost:8787
```

Gotchas:

- `ENVIRONMENT=development` is REQUIRED locally: wrangler.toml hardcodes
  `ENVIRONMENT=production`, which makes CORS reject `http://localhost:5173`
  (signup fails with "Failed to fetch"). Dev mode allowlists localhost
  (see `getCorsHeaders` in `packages/worker/src/index.ts`).
- The `[ai]` binding in `packages/worker/wrangler.toml` requires a logged-in
  Cloudflare account even for `wrangler dev` (errors with "set
  CLOUDFLARE_API_TOKEN" in non-interactive shells). For credential-less dev,
  comment out the `[ai]` block — everything except AI chat / image analysis
  works (KV, R2, DOs are local simulations). DO NOT commit that change.
- `env.AI` is only referenced at call time (OrchestratorAgent, upload routes,
  appTools), so removing the binding doesn't crash the worker at startup.
- Local accounts/desktop state live in `packages/worker/.wrangler/state`
  (moves with the repo). Create disposable local test accounts as needed; do
  not document their credentials here.
- After restarting the Vite server, browser tabs can keep serving stale
  CSS/JS modules — hard reload (Cmd+Shift+R) before debugging "broken" UI.
- `npm run lint` and `npm run typecheck --workspace=@eternalos/frontend`
  should both stay clean. (Earlier revisions listed pre-existing lint
  failures in `Desktop.tsx`, `AppViewer.tsx`, and `DeveloperStudio.tsx`;
  those no longer reproduce.)

## Theme / appearance system

Pipeline: `CustomAppearance` → `resolveTokensFromAppearance` →
`compileTokensToCSS` → DOM (`packages/frontend/src/stores/appearanceStore.ts`,
`src/tokens/tokenCompiler.ts`, `src/tokens/tokenSchema.ts` = single source of
truth for all tokens).

- Theme presets live in `src/utils/onboardingPresets.ts` (`THEME_PRESETS`).
  Used by both the signup QuickStartWizard and Appearance panel → Themes tab
  (which calls `updateAppearance(preset.appearance)` — wallpaper only applies
  via the wizard).
- Preset `appearance` fields accept arbitrary CSS strings (gradients, rgba) —
  see the XP and Frutiger Aero presets. Derived text-color transforms only run
  on 6-digit hex values and are silently skipped otherwise.
- Presets may include `customCSS` (applied via the user-CSS pipeline) and
  `designTokens` (extended token paths like `menuBar.background`,
  `window.titleBar.stripes`, `scrollbar.thumb` — these compile to CSS vars
  such as `--eos-menubar-bg`).
- Custom CSS is sanitized + scoped: every selector gets prefixed with
  `.user-desktop` (`:root`/`body`/`html` map to `.user-desktop` itself, which
  IS the desktop element). `url()` values must hit first-party `/api/...`
  prefixes; everything else becomes `url(about:blank)`. `@font-face` is
  stripped.
- Reliable selectors for theme CSS: `.window` (global class), `.windowContent`,
  `[eos-part="titlebar"|"title"|"label"|"close"|"zoom"|"collapse"|"content"]`,
  plus kebab-case aliases from `src/utils/cssSelectorAliases.ts`
  (`.title-bar`, `.menu-bar`, ...). Most other class names are hashed CSS
  modules — don't target them.
- Global palette vars (`:root` in `src/styles/global.css`): `--platinum`,
  `--white`, `--black`, `--shadow`, `--highlight`, `--selection`,
  `--selection-text`, `--window-bg`. Viewer toolbars/scrollbars/bevels all use
  them — overriding these inside `.user-desktop` re-skins all inner chrome at
  once (the Frutiger Aero preset does this for its glass look).
- Theme-set vars available to components: `--accent`, `--window-text-color`,
  `--window-text-secondary`, `--appearance-button-bg/-text/-border`,
  `--appearance-label-color`, `--appearance-title-text`. Only set when a theme
  defines them → always provide fallbacks.
- Token-compiled button rules use
  `.user-desktop button:not([data-theme-immune] *)` etc. Wrap UI in a
  `data-theme-immune` container to keep component-controlled button styling
  (used by AgentChatWindow's composer, segmented control, and sidebar).

### Frutiger Aero preset (ours)

`id: 'frutigerAero'` in `THEME_PRESETS`. Glass = translucent `rgba` surfaces +
`backdrop-filter` in its `customCSS`, plus a `--platinum`/`--white`/
`--highlight`/`--shadow` override block. Sky/bubbles are pure CSS gradients on
`.user-desktop`.

## Window system

`src/components/window/Window.tsx`:

- Title-bar drag, body drag (drag window by its content background), resize.
- Body drag uses a 5px movement threshold (`bodyDragPending` ref) — it must
  NOT capture the pointer or preventDefault on pointerdown, or clicks on
  non-interactive elements (plain divs with onClick: tabs, list rows) get
  swallowed. This was a real bug; don't regress it.
- `isInteractiveTarget` walk: interactive tags, `role=`, contentEditable,
  draggable, `data-no-drag` attr (any ancestor), and classes in
  `INTERACTIVE_CONTAINERS`. Viewers that are click-heavy should put
  `data-no-drag` on their root: DeveloperStudio and CartridgeEditor do.
- Window content classes: outer `.window` (global) → `.windowInner` (hashed
  module class — NOT targetable from injected CSS) → `.windowContent`/
  `[eos-part="content"]`.
- Viewers are registered in `src/components/window/WindowManager.tsx`
  (`contentType` switch); menu entries in `src/components/menubar/MenuBar.tsx`
  (Special menu: Ask Eternal, Appearance, Developer Studio, Cartridge Studio,
  Game Console...).

## Ask Eternal chat (`src/components/viewers/AgentChatWindow.tsx`)

- Codex-style 3-pane layout: toolbar (New Thread / Clear, functional
  Chat|History segmented control, status dot), threads sidebar, main chat,
  right inspector. `mainView` state toggles chat vs history in the main pane.
- ALL colors in `AgentChatWindow.module.css` derive from theme vars via
  `color-mix()` (`--chat-*` locals defined on `.chatWindow`). Keep it that
  way — no hardcoded chrome colors.
- Transport: `useAgent` + `useAgentChat` over WebSocket to
  `OrchestratorAgent` DO; threads via REST (`listAgentThreads` etc.).
  Locally (AI binding disabled) the UI/transport works but replies error.
- Responsive: inspector hides < 1100px, sidebar hides < 760px.

## App runtime (Dynamic Workers) and Code Mode

- Every app is compiled with `@cloudflare/worker-bundler` and served from a
  Dynamic Worker (`env.LOADER.get`) at `/api/apps/:appId/` (previews:
  `/api/app-previews/:id/`). The iframe is `sandbox="allow-scripts"` (origin
  `null`), so the `app-iframe-preflight` route in `routeTable.ts` answers
  preflights for `/_eternal/*` and `/api/*` before the global CORS handler.
  Don't remove it: without it every capability-carrying bridge call fails.
- Full-stack apps: an optional `server.js` (+ helpers under `server/`) is
  bundled as the `AppBackend` class (`__eternal_backend__.js` wrapper in
  `appTools.ts`) and runs as a **Durable Object Facet** under the
  `AppRunner` supervisor DO (`src/durable-objects/AppRunner.ts`), so each
  app gets its own SQLite (`env.sql`, `env.storage`, `env.kv`, plus
  grant-checked `env.desktop`). Requests to `/api/apps/:id/api/*` are routed
  to it (capability-gated for installed apps). Outbound `fetch()` goes
  through `AppOutbound` (granted `network.outbound` hosts only, else no
  network). Console/exception output is tailed via `AppLogTail` into
  `GET /api/apps/:id/backend/logs`. Frontend calls it with
  `window.eternal.api.get/post/put/patch/delete`.
- A new release or grant change bumps the facet's code id → the facet is
  aborted and restarted on the new class; its SQLite data survives. App
  deletion / account purge calls `AppRunner.purge()` (`facets.delete`).
  Don't call `storage.deleteAll()` on the supervisor: it fails once facets
  exist.
- Build-time backend probe: agent builds (`generateAppWithRepairLoop`) run
  a generated `server.js` before install via `AppRunner.probe()` on a
  throwaway `probe:{uuid}` instance (fresh SQLite, no network): a cold-start
  request plus every parameter-free `GET` route from `spec.backend.routes`.
  5xx/crash/timeout → `runtime/backend-error` issue on `server.js` → the
  targeted repair loop patches it. Failures caused only by the no-network
  sandbox are ignored. Dev-deploy does not probe.
- Live sync: when the assistant changes an app's data (`callAppApi`, or a
  Code Mode run — the code tool returns `changedApps`), the chat calls
  `notifyAppDataChanged` (`src/utils/appWindowBus.ts`) and open windows get
  `eternal:data:changed`; the runtime runs `eternal.api.onChange` handlers or
  reloads the app. `updateApp`/`installAppPreview` remount open windows.
- `ETERNAL_RUNTIME_JS` and the worker entry are emitted from TS template
  literals: regex/backslash escapes need doubling. The backend integration
  test parses the served runtime with `vm.Script` to catch this.
- Code Mode (`src/agents/tools/codeModeTools.ts`): `@cloudflare/codemode`'s
  `createCodeTool` + `DynamicWorkerExecutor` (no network). Each chat route
  exposes its own tools as `desktop.*` / `apps.*`; mutating variants strip
  inner `needsApproval` (codemode drops such tools otherwise) and gate the
  whole code tool behind one approval.
- Code Mode runs are previewed, legible and reversible
  (`codeModeRuns.ts` = pure helpers, `codeModeTools.ts` = run engine):
  - Preview: a run that names a write tool first runs as a practice run
    inside `needsApproval` (real reads; writes recorded and answered with
    stand-in results). The approval card lists the writes in plain words
    (`data-codemode-preview`). No writes → no approval at all.
  - The approved run (a later request) is held to that preview: each write's
    signature (tool, target incl. record id/query, body minus top-level
    timestamps; ids the run created read as `<new>`) must have been shown,
    at most as many times. Signatures live in the agent's SQLite
    (`code_previews`); a missing preview means no writes (fail closed). A
    write outside an active run is refused.
  - Steps stream as `data-codemode-steps`; every successful write records
    its inverse (state read just before it) → `code_runs` + the
    `data-codemode-undo` part → Undo via `POST /api/agent/runs/:id/undo`
    (`applyUndoPlan` remaps ids when a deleted record is re-added).
  - Every tool route's Code Mode has BOTH `desktop.*` and `apps.*`.
  - Routines (`saveRoutine`/`listRoutines`/`deleteRoutine`, table
    `routines`): approved Code Mode code run by `this.schedule` →
    `runRoutine` with `preApproved` (no AI calls, no per-run approval), each
    run posted into the thread as a `data-routine-run` part with steps and
    Undo. Daily-at-time uses the browser time zone sent in the chat body.
    REST: `GET/POST/DELETE /api/agent/routines[...]?threadId=`.
- Chat replies render through `ChatMarkdown` (safe subset → React nodes,
  incl. pipe tables).
- "Try the 30-second demo" (chat empty state, `src/services/agentDemo.ts`):
  installs a "Reading List" app (own backend, seeds once via a `meta`
  table) through the normal dev-deploy route plus a "Books to read.txt"
  note, opens the app beside the chat, then sends `DEMO_PROMPT` (one Code
  Mode run across the note and the app). Idempotent: reuses both by name.
  The app flashes rows that changed, so approve/Undo is visible live.
- Read-only Code Mode runs fold into the activity line
  (`readOnlyRunSteps`); finished runs show "Open <app>" for changed apps
  that aren't open. Undone runs reach the model as a note
  (`modelNoteForDataPart` via `convertDataPart`).
- The built-in browser pane blocks the sandboxed app iframe
  (`ERR_BLOCKED_BY_CLIENT`), even through a same-origin proxy; check app UI
  in a normal browser, with `test/appBrowser.test.mjs`, or read its data
  through the API.
- Desktop theme in apps: AppViewer sends `eternal:theme` (on the runtime's
  `eternal:theme:request`, on load, and on every appearance change) built
  by `readAppTheme` (`src/utils/appTheme.ts`) from the window's computed
  CSS variables: solid/rgba colors and font stacks only (gradients, url()
  and anything odd dropped on both sides). The runtime sets `--eternal-*`
  vars + `data-eternal-scheme` on the app's `<html>`, exposes
  `eternal.theme.get/onChange`, and `class="eternal-themed"` turns on
  zero-specificity themed defaults. The builder prompt tells generated apps
  to use them.
- Apps load the CURRENT runtime: `appServe` answers every app's (and
  preview's) `eternal-runtime.js` with `currentAppRuntime()`, not the copy
  compiled into the app's bundle, so runtime features reach old installs.

## App skins (`.eskin`)

Winamp-style skins per app. Format + validation: `worker/src/utils/appSkin.ts`
(the authority; strict for user skins, `lenient` for assistant skins).
Storage/designer/tools: `agents/tools/skinTools.ts`; REST:
`routes/appSkins.ts` (`/api/apps/:id/skins[/generate|/active|/:skinId]`,
owner only, R2 under `apps/{uid}/{appId}/skins/` so app delete/purge
removes them). Runtime: `agents/tools/skinRuntime.ts` (String.raw: never a
backtick or dollar-brace in it), spliced into `ETERNAL_RUNTIME_JS`.

- Parts: apps mark them in markup — `data-skin="play"` (+ optional
  `data-skin-states`, `data-skin-frames` with `data-skin-frame="n"`,
  `data-skin-label`). Universal parts every app has: app, button, field,
  link, heading, scrollbar. The runtime reports parts (sizes from the live
  DOM) on `eternal:skin:describe`; the worker scans source for the designer.
- A part is a sprite (cells left→right per state/frame, optional 9-slice
  `slice`) and/or a style (fill, gradient, texture, border, radius, bevel,
  text, font, weight, shadow) with per-state overrides. Skin colors override
  `--eternal-*` (and set `--skin-*`). All CSS is `!important` (the skin is the
  user's override) and built only from re-checked values.
- Sprite cells are cut with `canvas.toDataURL`, NOT `toBlob`: toBlob is
  throttled in out-of-process iframes and a skin with ~20 cells never
  finished applying (real bug, found in headless Chrome with site isolation).
- AI skins: `designSkin` = one structured model call (style recipe, system
  fonts only) + up to 3 textures from `IMAGE_GEN_MODEL` (default
  `@cf/black-forest-labs/flux-1-schnell`), each charged to the AI budget.
  Generated textures are marked `blend` and made seamless in the runtime
  (two-pass half-offset blend). Missing theme colors are derived from styles.
- Shaped windows (`skin.window`): `frameless`, `shape` (rounded / ellipse /
  polygon in % / PNG `mask` region), fixed `size`, and part names for
  `drag` ("app" = empty areas) / `close` / `minimize`. The DESKTOP draws it:
  AppViewer → `skinWindowChrome()` → `useWindowSkinStore` → Window hides the
  title bar, clips `.windowContent`, and the outer `.window` gets
  `pointer-events: none` so clicks outside the shape fall through. A
  frameless window always keeps the skin handle (app name, ×, drag,
  right-click for skins) — don't remove it: it's what stops a shaped window
  from posing as system UI or trapping the user. The runtime reports drags
  as `eternal:window:dragStart/Move/End` (iframe client coords; AppViewer
  maps them through the iframe's live rect, so no drift) and only frameless
  windows act on them. The Skins panel portals to the outer `.window` when
  frameless (the clip would cut it). Templates can add a window-shape layer
  (alpha = shape); the AI designer adds shapes only when asked.
- Visitors: `GET /api/apps/:id/public-skin` (no auth) returns the active
  skin only when the app's desktop item is public and not trashed (404
  otherwise); AppViewer uses it when `isVisitor` and hides the panel/drop.
- Frontend: `AppViewer` sends the active skin (`eternal:skin`), takes `.eskin`
  drops (overlay over the iframe), hosts `AppSkinsPanel` (right-click an app's
  title bar, or Special → App Skins...). `utils/appSkins.ts` = .eskin zip
  read/write (JSZip; load from ArrayBuffer), template layout + drawing,
  paint-to-skin. Chat: `designAppSkin` / `useAppSkin` (app-build route; skin
  words and "look" requests naming an app route there), skin card with Undo.
- Tests: `test/appSkins.test.mjs` (format, hostile values, CSS builder via
  vm), `test/appBrowser.test.mjs` (real Chrome: sprites, states, frames,
  styles, colors, describe, real-mouse drag/close of a frameless skin),
  `src/utils/appSkins.test.ts`, evals `skin-app`, `skin-shaped-window` and
  `skin-switch-back`.
- `test/appBackend.integration.test.mjs` exercises facets end to end under
  `unstable_dev`; it works without Cloudflare credentials.
- `test/appBrowser.test.mjs` loads an app in real headless Chrome the way
  the desktop does (sandboxed iframe, origin `null`, capability by
  postMessage): module script runs, `eternal.api` reads the backend,
  `eternal.fs.write` saves a canvas PNG. Skips without Chrome (`CHROME_PATH`).
  It exists because app files once lacked `Access-Control-Allow-Origin` and
  no installed app ran its code in production while every other test passed
  (`allowOpaqueOriginAssets` in `utils/appFraming.ts`).
- `eternal.fs.write` saves images/audio/video given a Blob or data URL
  (type checked from the bytes, 10MB, quota, stored in R2 like an upload);
  new items and auto-created folders take the first free grid cell
  (`utils/desktopGrid.ts`).
- `editApp`/`updateApp` accept `permissions` (the app's full declared set).
  Grants never widen on an update: AppViewer re-checks on reload and asks.
- Shipping: `AppRunner` is a new DO class (migration `v8`) — per the
  DO-migration deploy note, run `wrangler deploy` once before relying on
  Workers Builds (`versions upload`).

## Web reading (`readWebPage`)

- Pure helpers in `packages/worker/src/utils/webPage.ts` (URL rules, text
  extraction), tool in `src/agents/tools/webTools.ts`, offered on every chat
  route (not inside Code Mode). Read-only, so no approval.
- The assistant may open ONLY URLs the user wrote in the thread (exact
  path + query match), plus at most 3 links per message found on pages it
  read, and only on the same site as a URL the user wrote
  (`allowedWebUrls` in OrchestratorAgent). This stops a page or note from
  getting the model to leak data through a URL or through which link it
  picks. Don't loosen it to "any public URL".
- Once a thread has page text, `rememberMemory`/`forgetMemory` are paused
  unless the user's latest message mentions remember/memory/forget
  (`memoryWritesPausedReason`): page text must not plant memories.
- Page HTML is hostile: `extractPage` parses at most 512KB with forward
  scans only (no backtracking `[\s\S]*?…<\/\1>` regexes); the test feeds
  it 3MB of unclosed tags. Keep new parsing steps linear.
- Public hosts only (no localhost/private IPs/odd ports/EternalOS hosts),
  every redirect re-checked, 3MB / 12s / 8 reads per turn, 15k chars of text.
  Results carry an "untrusted data" note; PDFs aren't read yet.
- The router replaces web addresses with "link" so words inside a URL
  ("…/build-a-todo-app") don't pick the route.
- Local `wrangler dev` can't fetch some HTTPS sites (`https://example.com`
  → "internal error"); Wikipedia, iana.org and cloudflare.com work. The
  evals use those.

## Agent quality: eval suite (`scripts/agent-eval.mjs`)

Ask Eternal changes (prompts, tools, routing, models) are judged by
`npm run eval:agent`, not by eyeballing a chat. It drives real turns over the
agent WebSocket against a running dev worker, auto-approves every approval
card, and scores each scenario by checking real app state afterwards.

```bash
EVAL_EMAIL=... EVAL_PASSWORD=... npm run eval:agent -- --api http://localhost:8789 [--build] [--repeat 2] [--only id,id]
```

- Needs `wrangler dev` with the AI binding and a local account. Each run
  deploys fixture apps (Evalog, Tally, Ledger, Scores) with known data and
  known bugs, then deletes them.
- Scenarios come from real failures: app data without the word "app", batch
  writes, small fixes in a big file, backend logic bugs, diagnosing from
  backend logs, honesty when a write is rejected or no app exists — plus
  Code Mode features: one preview for two writes, REST undo, a desktop file
  imported into an app, and saving a routine — plus web reading (page into an
  app, page into a note, no reads of links the user never gave).
- Compare models without editing config: start extra workers with
  `--var AGENT_CHAT_MODEL:<model> --persist-to <dir>` (separate state, separate
  account) and point `--api` at each.
- DON'T edit `packages/worker/src` while an eval runs: every dev worker
  hot-reloads and in-flight turns fail.
- Nov 2026 result that picked the chat model: deepseek-v4.1-flash passed
  (12/12 on the previously failing scenarios after the fixes); glm-4.7-flash
  wrote invalid Code Mode JS and needed up to 5 approvals for one write;
  gpt-oss-120b missed backend diagnosis; glm-5.3 got app ids wrong.
- `InferenceUpstreamError: Network connection lost` mid-turn is the local
  remote-AI proxy dropping long streams, not a model failure; re-run.

## Git / repo facts

- This is a standalone npm-workspaces project. The workspaces are
  `packages/frontend` (React 19 + Vite + CSS modules + Zustand),
  `packages/worker` (Workers + DO + KV + R2 + Workers AI), and
  `packages/contracts` (types-only shared domain models, re-exported by both
  — see its README).
- Branch naming: `cursor/<short-description>`.
- Never commit: `wrangler.toml` AI-binding workaround, `package-lock.json`
  churn from local installs, `.dev.vars`, `.env.local`.
