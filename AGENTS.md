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
  (moves with the repo). Existing local test account: `<local-test-username>` /
  `<local-test-password>` (local KV only).
- After restarting the Vite server, browser tabs can keep serving stale
  CSS/JS modules — hard reload (Cmd+Shift+R) before debugging "broken" UI.
- Pre-existing lint failures (not ours): `Desktop.tsx` (react-compiler memo),
  `AppViewer.tsx` (`any`), `DeveloperStudio.tsx` (unused `e`).
  `npm run typecheck --workspace=@eternalos/frontend` should stay clean.

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

## Git / repo facts

- Repo root: `<repo-root>` (its own project — NOT inside
  pelna-radio). npm workspaces: `packages/frontend` (React 19 + Vite + CSS
  modules + Zustand), `packages/worker` (Workers + DO + KV + R2 + Workers AI).
- Branch naming: `cursor/<short-description>`.
- Never commit: `wrangler.toml` AI-binding workaround, `package-lock.json`
  churn from local installs, `.dev.vars`, `.env.local`.
