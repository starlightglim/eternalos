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
- `test/appBackend.integration.test.mjs` exercises facets end to end under
  `unstable_dev`; it works without Cloudflare credentials.
- Shipping: `AppRunner` is a new DO class (migration `v8`) — per the
  DO-migration deploy note, run `wrangler deploy` once before relying on
  Workers Builds (`versions upload`).

## Git / repo facts

- This is a standalone npm-workspaces project. The workspaces are
  `packages/frontend` (React 19 + Vite + CSS modules + Zustand),
  `packages/worker` (Workers + DO + KV + R2 + Workers AI), and
  `packages/contracts` (types-only shared domain models, re-exported by both
  — see its README).
- Branch naming: `cursor/<short-description>`.
- Never commit: `wrangler.toml` AI-binding workaround, `package-lock.json`
  churn from local installs, `.dev.vars`, `.env.local`.
