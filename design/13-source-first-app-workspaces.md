# 13 — Source-First App Workspaces

> Updated 2026-04-22
>
> Parent docs: [12-orchestrator-v2.md](12-orchestrator-v2.md), [01-apps-interop.md](01-apps-interop.md), [ROADMAP.md](ROADMAP.md)
>
> This doc defines how EternalOS should support a real coding agent that builds
> desktop-runnable apps while keeping the code readable, editable by hand, and
> versionable over time.

## Executive summary

The current app platform is pointed in the right direction but still stops one
layer too early.

Today, EternalOS already does two important things correctly:

1. it stores both **source** and **derived bundle** artifacts for apps, and
2. it runs generated apps in **Dynamic Workers** with a constrained
   `window.eternal` bridge.

But the current builder still treats app generation as "produce a set of files,
assemble a runtime wrapper, then hope the app works". That is not enough for a
general-purpose coding agent.

The missing abstraction is:

- **the source workspace is the product**
- **the runnable desktop bundle is a derived artifact**
- **the agent edits files inside a workspace**
- **the human can edit the same files directly**
- **install/publish just snapshots a validated workspace revision**

This is the architecture used, implicitly or explicitly, by the strongest
open-source systems in adjacent spaces:

- **OpenHands** for tool-driven file editing in a real workspace,
- **Aider** for diff/review/undo discipline,
- **Continue** for deterministic targeted edits instead of whole-file rewrites,
- **Onlook** for "visual changes must write back to source",
- **Sandpack** for editor + live preview separation,
- **OS.js** for desktop package structure,
- **Tauri/Electron** for permissioned host bridges.

## Goals

1. Apps created by the agent remain **plain source code** that a user can open
   and edit by hand.
2. The agent edits the same source tree that the human sees, not an internal
   builder-only representation.
3. Apps run on the EternalOS desktop as first-class installed apps.
4. Apps can use desktop data through the existing permissioned `window.eternal`
   bridge from [01-apps-interop.md](01-apps-interop.md).
5. The build/install path is deterministic enough that failures are inspectable,
   repairable, and testable.
6. The platform supports a broad range of apps without collapsing back into a
   library of canned templates.

## Non-goals

- Supporting arbitrary backend stacks in v1 workspaces.
- Letting apps run arbitrary native processes.
- Turning EternalOS into a full cloud IDE clone.
- Supporting every frontend framework on day one.
- Keeping the current "one HTML + one CSS + one JS" assembly trick as the long
  term architecture.

## Current repo state

The codebase is already closer to source-first than the UI suggests:

- App creation persists both `bundle.json` and `source.json` in R2 at
  [`packages/worker/src/agents/tools/appTools.ts:1180`](../packages/worker/src/agents/tools/appTools.ts:1180).
- The current serving path launches the compiled app from `bundle.json` as a
  Dynamic Worker.
- The app runtime injects the `window.eternal` bridge and validates bridge use
  against declared permissions.

That is the good part.

The weak part is the current source packaging model:

- `assembleWorkerFiles()` still privileges one HTML file, one CSS file, and one
  JS entrypoint, with a few hard-coded fallback names, at
  [`packages/worker/src/agents/tools/appTools.ts:1392`](../packages/worker/src/agents/tools/appTools.ts:1392).
- This is enough for simple apps and fixtures, but it is not the right
  substrate for a general-purpose app coding agent.
- The roadmap already acknowledges an "In-OS code editor" as future platform
  work in [ROADMAP.md](ROADMAP.md).

So the main product gap is no longer "can EternalOS run generated apps?".
It is "can EternalOS treat generated apps like real editable software projects?".

## Research distilled into product rules

### Rule 1: The agent must edit real files in a real workspace

OpenHands is the clearest reference here. Its SDK model is:

- agent receives a task,
- model calls a file editor tool,
- tool validates the action,
- workspace is mutated,
- observation comes back into the agent loop.

That is the right mental model for EternalOS too.

Primary sources:

- [OpenHands SDK architecture](https://docs.openhands.dev/sdk/arch/sdk)
- [OpenHands](https://openhands.dev/)

### Rule 2: Human review, diff, and undo are first-class

Aider's strongest design choice is not "terminal UX", it is that edits are
easy to inspect, undo, and separate from the user's own changes. That matters
even more inside EternalOS because the agent will sometimes be acting on
desktop-installed apps, not throwaway code.

Primary sources:

- [Aider git integration](https://aider.chat/docs/git.html)
- [Aider README](https://gist.github.com/yb-pavi/b760ef1138e1cd55a3976b0862742539)

### Rule 3: Avoid full-file rewrites whenever possible

Continue's 2025 agent-mode improvements explicitly moved toward AST-based,
deterministic targeted apply to avoid costly and brittle full-file rewrites.

That matters because EternalOS will otherwise degrade code quality every time
the agent makes a small change to a medium-sized app.

Primary source:

- [Continue changelog](https://changelog.continue.dev/)

### Rule 4: Visual editing only counts if it writes back to code

Onlook is the best proof point for this. A visual layer can be valuable, but
only if it edits the underlying project instead of inventing a hidden design
representation that later has to be exported back to source.

Primary source:

- [Onlook docs](https://docs.onlook.com/)

### Rule 5: Live preview and source editing should be separate concerns

Sandpack is useful here, not because EternalOS should become CodeSandbox, but
because it gets the editor/preview split right:

- one system manages code files and models,
- another system runs a preview/runtime surface.

That maps well to EternalOS:

- **workspace** = source of truth,
- **preview** = validation / live iteration surface,
- **desktop install** = publish compiled artifact.

Primary source:

- [Introducing Sandpack](https://codesandbox.io/blog/sandpack-announcement)

### Rule 6: Host capabilities need explicit scopes

Tauri and Electron both reinforce the same lesson:

- expose a narrow bridge,
- scope permissions tightly,
- do not hand broad raw host APIs to untrusted app code.

Primary sources:

- [Tauri permissions](https://v2.tauri.app/es/security/permissions/)
- [Using plugin permissions in Tauri](https://v2.tauri.app/learn/security/using-plugin-permissions/)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)

### Rule 7: Package metadata still matters

OS.js is relevant because it treats desktop apps as discoverable packages with
metadata and application registration rather than loose code blobs.

Primary sources:

- [OS.js application tutorial](https://manual.os-js.org/tutorial/application/)
- [OS.js overview](https://www.os-js.org/)

## Core design

### Decision 1: Introduce a first-class app workspace

Every app should have a canonical source workspace with:

- stable file paths,
- stable metadata,
- stable permissions,
- optional tests,
- and an edit history.

The workspace becomes the thing the agent edits and the human opens.

The installed desktop app should be built from a workspace revision, not from a
one-off transient tool call.

### Decision 2: Separate source, preview, and installed runtime

There are three distinct artifacts:

1. **Workspace source**
   - editable, readable, versioned
2. **Preview build**
   - transient, for validation and live iteration
3. **Installed desktop bundle**
   - derived artifact used by `/api/apps/:appId`

Today, source and installed bundle already exist. The missing layer is a formal
preview/build lifecycle that the editor and agent can both rely on.

### Decision 3: Support a small number of runtime profiles

Do not let the agent invent the build system from scratch on each request.

Instead support a small set of profiles:

#### `static-html`

Use for:

- simple utilities,
- dashboards,
- document viewers,
- image/audio browsers,
- small games,
- low-complexity widgets.

Shape:

- `index.html`
- plain CSS/JS/TS modules
- no npm
- zero or minimal bundling

#### `vite-spa`

Use for:

- React/Preact/Svelte/Vanilla TS apps,
- multi-file UI,
- richer state,
- component-driven apps,
- apps likely to evolve over time.

Shape:

- standard `src/`
- standard `package.json`
- standard bundling
- controlled dependency policy

#### `desktop-data-app`

This is not a framework. It is a capability class layered on top of one of the
above profiles.

Use for apps that need:

- `window.eternal.fs.*`
- `window.eternal.profile.*`
- future intents, write APIs, or event APIs

### Decision 4: The workspace should have explicit metadata

Recommended workspace root:

```text
workspace/
  eternal.app.json
  README.md
  package.json              # profile-dependent
  src/
  public/
  assets/
  tests/
```

`eternal.app.json` is the platform-owned workspace manifest:

```json
{
  "schemaVersion": 1,
  "appId": "uuid",
  "name": "Photo Gallery",
  "profile": "vite-spa",
  "entry": "src/main.tsx",
  "permissions": {
    "fs": {
      "mimeTypes": ["image/*"]
    }
  },
  "window": {
    "defaultWidth": 960,
    "defaultHeight": 680
  }
}
```

Important distinction:

- `eternal.app.json` is for EternalOS build/install/editor behavior
- the app may still have its own framework metadata (`package.json`, config
  files, etc.)

### Decision 5: Readability beats magical generation

The default generated code should optimize for:

- descriptive file names,
- conventional folder layout,
- standard framework patterns,
- comments only when they clarify something non-obvious,
- no giant minified one-file output,
- no proprietary DSL.

If a human opens the generated project and cannot orient themselves quickly, the
system has failed.

## Agent workflow

### Recommended loop

1. User describes the app.
2. Builder generates an `AppSpec`.
3. Platform chooses a profile.
4. Agent creates or patches workspace files.
5. Validation runs:
   - parse / typecheck
   - dependency policy
   - permission scan
   - bridge usage scan
   - bundle
   - preview smoke test
6. If validation fails, the agent receives structured errors and patches the
   workspace.
7. Once valid, the user can:
   - preview,
   - inspect files,
   - manually edit,
   - or install/publish.

### Editing strategy

The agent should prefer:

1. targeted patch/diff edits,
2. structured file creation,
3. only then whole-file replacement.

This is where the product should borrow directly from Aider/Continue-style
discipline rather than trusting raw whole-file regeneration on every turn.

### Workspace context

The model context should include:

- selected files,
- a repo/workspace map,
- current validation errors,
- current permissions,
- the app profile,
- and a compact desktop summary when the app is desktop-aware.

It should not require the model to reconstruct the project structure from one
giant serialized `source.json` blob on every step.

## Editor and preview model

### In-product editor

The in-OS editor should be built around Monaco models keyed by stable virtual
file URIs.

Why:

- Monaco already models files and edit history this way,
- it makes multi-file editing natural,
- and it aligns well with agent patches landing into named files.

Primary source:

- [Monaco editor README](https://github.com/microsoft/monaco-editor)

### Layout

Recommended default editing layout:

1. left pane: file tree
2. center pane: chat + task log
3. right pane: code editor or preview
4. bottom rail: build/test/permission diagnostics

This does not need to become a full IDE. It just needs to make the app's
source, preview, and agent actions legible.

### Preview

Preview should run from the workspace build output, not from the installed app.

That matters because:

- previews may be dirty or invalid,
- users need to test before installing,
- and the installed desktop app should remain a stable published revision.

### Install / publish

Install should mean:

1. freeze a validated workspace revision,
2. derive the runtime bundle,
3. update registry metadata,
4. create or update the desktop item.

This makes install a release action, not just "the latest half-working source".

## Data model additions

### Proposed storage shape

Current state:

- `source.json`
- `bundle.json`

Recommended evolution:

```text
apps/{uid}/{appId}/
  workspace/
    manifest.json
    files.json                # temporary if object-per-file is not ready yet
  revisions/
    {revisionId}/
      manifest.json
      files.json
      build.json
      diagnostics.json
  installed/
    current.json
  bundle/
    bundle.json
```

Near-term pragmatic option:

- keep `source.json` for now,
- but treat it as the serialization format for a workspace,
- not as the product abstraction itself.

Longer term better option:

- move to object-per-file storage for better patching, diffs, and partial loads.

### Suggested registry additions

Add workspace-aware metadata to the app registry:

- `profile`
- `current_revision`
- `last_valid_revision`
- `last_preview_status`
- `source_updated_at`
- `bundle_updated_at`

## Security model

### Principle 1: Workspace code is untrusted until built and validated

The editing workspace is not the runtime boundary.

The runtime boundary is still:

- Dynamic Worker isolation,
- constrained `window.eternal` bridge,
- explicit granted permissions.

### Principle 2: Bridge permissions live above the workspace

The workspace may request permissions in `eternal.app.json`, but the platform
must remain the authority on granted permissions at install time.

The app code must never be able to widen its own grants by editing its manifest.

### Principle 3: Dependency policy must be explicit

For `vite-spa` style profiles, do not allow arbitrary package installation in
v1.

Recommended policy:

- allow a small curated baseline,
- optionally allow vetted packages later,
- disallow native packages,
- disallow packages that imply arbitrary network or host execution.

This is where EternalOS should be opinionated. "General purpose" does not mean
"run arbitrary npm from a user prompt without review".

## Migration plan

### Phase 1: Formalize the source-first model in docs and metadata

- Add `eternal.app.json`
- Treat current `source.json` as workspace state
- Keep `bundle.json` as installed artifact

### Phase 2: Replace HTML/CSS/JS trio assumptions

- Remove the core assumption in `assembleWorkerFiles()` that a project reduces
  to one HTML + one CSS + one JS path
- Support arbitrary source trees within a selected profile

### Phase 3: Add preview builds

- Build workspace revisions without automatically installing them
- Surface diagnostics in the UI

### Phase 4: Add in-OS code editing

- file tree
- Monaco editor
- preview pane
- install/publish action

### Phase 5: Add richer agent patching

- targeted edits
- structured repairs
- revision history
- eventually visual editing that writes back to source

## Open questions

- Should v1 workspaces allow React immediately, or should the first editable
  profile be `static-html` only with `vite-spa` following right after?
- Should revisions be git-backed, SQLite-backed, or just R2 snapshots in the
  first implementation?
- Should install auto-publish after validation, or should preview and install
  be separate user actions by default?
- Should desktop-created apps open directly into a "builder" window when first
  generated, instead of immediately appearing only as a regular installed app?

## Recommendation

The right short version is:

1. keep Dynamic Workers,
2. keep the permissioned `window.eternal` bridge,
3. stop thinking of generated apps as blobs,
4. introduce source-first workspaces with profiles,
5. make the agent edit the workspace,
6. make install a validated publish step.

That is the architecture that gives EternalOS a real coding agent instead of a
template gimmick.

## Sources

- [OpenHands](https://openhands.dev/)
- [OpenHands SDK architecture](https://docs.openhands.dev/sdk/arch/sdk)
- [Aider git integration](https://aider.chat/docs/git.html)
- [Aider README](https://gist.github.com/yb-pavi/b760ef1138e1cd55a3976b0862742539)
- [Continue changelog](https://changelog.continue.dev/)
- [Onlook docs](https://docs.onlook.com/)
- [Introducing Sandpack](https://codesandbox.io/blog/sandpack-announcement)
- [Monaco editor README](https://github.com/microsoft/monaco-editor)
- [OS.js application tutorial](https://manual.os-js.org/tutorial/application/)
- [OS.js overview](https://www.os-js.org/)
- [Tauri permissions](https://v2.tauri.app/es/security/permissions/)
- [Using plugin permissions in Tauri](https://v2.tauri.app/learn/security/using-plugin-permissions/)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
