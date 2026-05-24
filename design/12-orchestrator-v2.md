# 12 — Orchestrator v2: General App Builder + Desktop-Aware Runtime

> Updated 2026-04-22
>
> Parent docs: [01-apps-interop.md](01-apps-interop.md), [13-source-first-app-workspaces.md](13-source-first-app-workspaces.md), [ROADMAP.md](ROADMAP.md)
>
> This doc is the current architecture for EternalOS app generation. The goal is
> not a library of cute templates. The goal is a real app-builder that can:
>
> 1. generate many kinds of apps from natural language,
> 2. install them as Dynamic Worker apps on the desktop,
> 3. let them read relevant desktop data such as photos, notes, audio, and
>    profile fields through a constrained runtime bridge,
> 4. and evolve toward persistence and richer capabilities without changing the
>    core runtime model.

## Executive summary

The old failure mode was architectural, not purely model-quality:

- The top-level chat model was being asked to serialize entire HTML/CSS/JS apps
  into a tool call.
- That breaks in exactly the way we observed: JSON parsing failures, malformed
  payloads, inconsistent asset wiring, and poor app quality.
- A handful of curated templates can mask this for demos, but they do not solve
  the general problem.

The correct architecture is:

1. Keep **Dynamic Workers** as the app runtime.
2. Keep apps **sandboxed by default**.
3. Pass desktop access into each app through a **same-origin bridge** backed by
   a **service binding with `ctx.props`**, not by asking the iframe to hold
   capability tokens on the hot path.
4. Move app generation behind a **server-side pipeline**:
   brief -> spec -> permissions -> files -> bundle -> validate -> repair -> install.
5. Treat curated apps only as acceptance fixtures and regression tests, not as
   the product architecture.

This aligns with current Cloudflare primitives and with how the strongest
text-to-app systems are structured today.

Implementation note, 2026-04-22:
this doc defines the orchestration and runtime pipeline. The editable-project
model for generated apps now lives in [13-source-first-app-workspaces.md](13-source-first-app-workspaces.md).

## What current research says

### 1. Dynamic Workers are the right runtime substrate

Cloudflare's current Dynamic Workers docs describe them as the low-level
primitive for securely executing runtime-defined code and explicitly call out
AI "Code Mode" and AI-generated applications as primary use cases.

Why that matters for EternalOS:

- We already want untrusted, generated, per-user app code.
- We need isolation, low cold-start overhead, and strong control over network
  access.
- We do not want to run containers or full browser-hosted development
  environments for every small app.

Key current capability from the docs:

- Dynamic Workers can receive **custom bindings**.
- Those bindings can be created from **loopback `ctx.exports` service
  bindings**.
- Those bindings can be parameterized with **per-instance `ctx.props`**.

That is the exact primitive needed for "this gallery app can read this user's
photos with these grants".

Primary sources:

- [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Dynamic Workers API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)
- [Workers `ctx.props` / `ctx.exports`](https://developers.cloudflare.com/workers/runtime-apis/context/)
- [Worker Loader docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)

### 2. Durable Object Facets are the correct future persistence model

Cloudflare's new Durable Object Facets let dynamic code run with its own
isolated SQLite database under a supervisor Durable Object.

That matters because "generated apps with persistence" should not force us to
expose a raw Durable Object namespace or invent a separate app database model.
Facets give us the long-term path for apps that need isolated server-side state
while preserving platform control.

This is not required for the initial desktop-aware runtime, but it is the
correct extension point for:

- gallery metadata caches,
- app-local settings,
- saved views,
- task/history state that should survive browser-local storage loss,
- richer multi-window app state.

Primary source:

- [Durable Object Facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)

### 3. Strong app builders use a pipeline, not one giant code blob

Vercel's current v0 materials are the clearest public articulation of this.
Their platform API exposes a lifecycle around prompt -> project -> code files ->
deployment, and their composite model write-up describes a layered architecture
that combines retrieval, reasoning, and post-generation error fixing.

The lesson for EternalOS is not "copy v0's product". The lesson is:

- do not rely on one raw prompt to produce the final app artifact,
- split planning from file generation,
- run validation,
- and have a repair loop.

Primary sources:

- [v0 Platform API](https://vercel.com/blog/build-your-own-ai-app-builder-with-the-v0-platform-api)
- [v0 composite model family](https://vercel.com/blog/v0-composite-model-family)

### 4. Claude Artifacts validates the UX expectation, not the backend architecture

Anthropic's Artifacts product proves a user expectation we should copy:
"describe the thing and immediately get a working interactive app".

Artifacts also reinforce two constraints that matter here:

- apps should feel self-contained,
- and the platform should inject the runtime capabilities rather than forcing
  the user to wire infrastructure manually.

But Artifacts are intentionally more constrained than EternalOS:

- no general external network access,
- no durable app storage,
- no arbitrary desktop data surface.

So the right use of Artifacts as prior art is on **UX and iteration model**,
not runtime architecture.

Primary sources:

- [What are Artifacts?](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Prototype AI-powered apps with Claude artifacts](https://support.anthropic.com/en/articles/11649438-prototype-ai-powered-apps-with-claude-artifacts)

### 5. Structured outputs should be first-class in the build pipeline

Workers AI supports structured JSON outputs, and the AI SDK can generate typed
objects from a schema. That is the right primitive for app specs, permissions,
and file bundles because it reduces brittle string parsing and gives us a place
to validate before installation.

Primary sources:

- [Workers AI structured JSON outputs](https://developers.cloudflare.com/changelog/2025-02-25-json-mode/)
- [Workers AI with AI SDK](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/)

### 6. Agents SDK improvements matter for observability and internal tool wiring

The current Agents SDK adds `keepAlive()`, `waitForMcpConnections`, structured
diagnostics, and better request correlation. Those matter because app
generation is not a single inference anymore; it becomes a multi-step pipeline
that needs observability and durable execution semantics.

Primary source:

- [Agents SDK v0.7.0 changelog](https://developers.cloudflare.com/changelog/post/2026-03-02-agents-sdk-v070/)

## What exists in the repo today

This repo is already past the "purely hermetic app" stage:

- `buildAppFromPrompt` exists in
  [`packages/worker/src/agents/tools/appTools.ts`](../packages/worker/src/agents/tools/appTools.ts)
  and already performs server-side structured generation instead of forcing the
  top-level model to inline the entire app.
- `EternalService` exists in
  [`packages/worker/src/services/EternalService.ts`](../packages/worker/src/services/EternalService.ts)
  as a `WorkerEntrypoint` that exposes policy-checked desktop reads.
- the Dynamic Worker app route in
  [`packages/worker/src/index.ts`](../packages/worker/src/index.ts) already
  injects `ETERNAL` via `ctx.exports.EternalService({ props: { uid, appId,
  granted } })`.
- the app runtime injected in `appTools.ts` already exposes
  `window.eternal.fs.list()`, `read()`, `readText()`, `readJson()`, `urlFor()`,
  and `profile.get()`.

That means the architectural question is no longer "should we add a bridge?"
It is:

- how should the generator decide what to build,
- how should permissions be inferred and granted,
- how do we validate and repair apps reliably,
- and what is the clean extension path for persistence and richer interop?

## Design decisions

### Decision 1: Keep Dynamic Workers as the only runtime for generated apps

Generated apps should continue to run as Dynamic Workers rendered in iframes.

Why:

- isolation is strong,
- cold-starts are acceptable,
- outbound network can stay blocked by default with `globalOutbound: null`,
- bindings and `ctx.props` give us a clean capability injection mechanism,
- and the current codebase is already built around this.

We should not switch the default generated-app runtime to:

- browser-hosted build sandboxes,
- containers,
- or raw script execution in the parent frame.

Those may be useful for development tools later, but not for the default app
runtime.

### Decision 2: Desktop access should flow through same-origin `/_eternal/*`

Apps should consume desktop data like this:

1. The app calls `window.eternal.fs.list({ mimeType: 'image/*' })`.
2. The runtime shim performs a same-origin fetch to `/_eternal/fs/list`.
3. The Dynamic Worker handles that route.
4. The worker calls `env.ETERNAL.list(...)` through a service binding.
5. `EternalService` enforces grants from `ctx.props` and reads from the
   `UserDesktop` DO / R2.

This is better than a postMessage-first bridge because:

- the parent frame is not on the hot path for data fetches,
- the iframe never needs to hold or rotate a capability token for normal reads,
- grants are bound to the app instance rather than shipped around manually,
- and auditability is much better because the permission check lives in one
  server-side class.

PostMessage still has a role for:

- window chrome control,
- launch intents,
- and future host-driven events.

But it should not be the main desktop data transport.

### Decision 3: The builder should be a multi-stage pipeline

The app-builder pipeline should be:

1. **Intent classification**
   - Is this a new app, an edit, a repair, or an inspection request?

2. **Spec generation**
   - Produce a typed `AppSpec` object:
     - name
     - description
     - user-visible goals
     - interaction model
     - data dependencies
     - permissions requested
     - default window size
     - acceptance checklist

3. **Permission inference**
   - Translate requested data access into platform permissions.
   - Example:
     - photo gallery -> `fs.mimeTypes: ['image/*']`
     - notes browser -> `fs.mimeTypes: ['text/*']`
     - profile badge -> `profile.read: ['displayName', 'avatar']`

4. **Code generation**
   - Generate files from the approved spec, not directly from the user's raw
     prose.

5. **Bundle validation**
   - Assemble the Dynamic Worker bundle.
   - Reject missing entrypoints, asset path mismatches, invalid permissions,
     or broken HTML/CSS/JS packaging.

6. **Behavior validation**
   - Run static checks on the generated files:
     - references to `window.eternal` match declared permissions,
     - external CDN/network calls are absent,
     - empty/loading/error states exist,
     - files referenced by HTML are actually present.

7. **Repair**
   - If generation or bundling fails, feed the exact error back into the model
     and regenerate or patch.

8. **Install**
   - Persist source, bundle, metadata, grants, and desktop item.

This is the minimum architecture for "general app builder". Anything simpler is
just hoping the model gets lucky.

### Decision 4: Desktop awareness should happen in two layers

There are two distinct kinds of "desktop awareness", and they should not be
confused.

#### Planning-time awareness

The builder should see a compact desktop summary before generation.

That summary should answer questions like:

- does the user have photos?
- are there audio files?
- how many text notes exist?
- what are the major folders?
- what tags or captions exist?

This lets the model choose the right default UX and the narrowest reasonable
permissions. A photo gallery should infer `image/*`, not `['**']`.

#### Runtime awareness

The app itself should only receive the data it has been granted, through
`window.eternal`.

This distinction is important:

- planning-time context helps the model build the right app,
- runtime permissions decide what the app is actually allowed to read.

### Decision 5: Permissions should be declared by the build pipeline, then granted by policy

The generator may propose permissions, but the platform owns the grant policy.

Recommended grant policy:

- **Hermetic default** for apps that do not require desktop data.
- **Auto-grant** only for narrow, low-risk permissions on self-authored apps
  initiated by the owner in chat:
  - `image/*`
  - `audio/*`
  - `text/*`
  - specific profile fields
- **Require confirmation** for broad or sensitive permissions:
  - `fs.read: ['**']`
  - mixed read scopes across many file categories
  - future write/delete/network permissions

The generator should also be required to include a rationale whenever it asks
for a wide scope.

### Decision 6: Curated templates are fixtures, not architecture

Curated templates still have value, but only for:

- smoke tests,
- acceptance tests,
- regression fixtures,
- and demo quality control.

They should not be the main product path.

That means:

- `createCuratedApp()` is acceptable as a short-term fixture surface,
- but the real product path should be `buildAppFromPrompt()` and its eventual
  spec/validate/repair pipeline.

### Decision 7: Persistence should split into local-first and facet-backed

There are two persistence classes:

#### Local-first persistence

Use browser storage for:

- to-do lists,
- timers,
- simple draft state,
- ephemeral UI settings.

This keeps the first version fast and cheap.

#### Facet-backed persistence

Use Durable Object Facets when an app genuinely needs server-backed state:

- per-app libraries and indexes,
- multi-device synchronization,
- caches derived from desktop items,
- persistent app documents not already modeled as desktop items.

We should not make every generated app a facet by default. That increases
complexity too early. But the design should preserve that upgrade path.

## Proposed architecture

```text
user request
  -> OrchestratorAgent routes to app-build
  -> buildAppFromPrompt(prompt)
     -> buildSpecFromPrompt(prompt, desktopSummary)
     -> inferPermissions(spec)
     -> maybe ask for approval if permissions are broad
     -> generateFiles(spec)
     -> assemble Dynamic Worker bundle
     -> validate bundle + runtime contract
     -> repair on failure
     -> install app + persist source + persist grants
  -> desktop icon/window
  -> app runtime uses window.eternal
  -> /_eternal/* inside Dynamic Worker
  -> env.ETERNAL service binding
  -> EternalService enforces ctx.props.granted
  -> UserDesktop DO / R2
```

### Core types

```ts
type AppSpec = {
  name: string;
  description: string;
  kind: 'viewer' | 'editor' | 'utility' | 'dashboard' | 'game' | 'other';
  goals: string[];
  dataDependencies: Array<'images' | 'audio' | 'video' | 'text' | 'profile' | 'none'>;
  permissions?: AppPermissions;
  window: { width: number; height: number };
  acceptance: string[];
};

type AppPermissions = {
  fs?: {
    read?: string[];
    mimeTypes?: string[];
  };
  profile?: {
    read?: Array<'username' | 'displayName' | 'bio' | 'avatar'>;
  };
  rationale?: string;
};
```

### Runtime contract for generated apps

Generated apps should be taught this exact contract:

```ts
window.eternal = {
  appId: string;
  hostVersion: string;
  fs: {
    list(opts?: { path?: string; mimeType?: string; limit?: number }): Promise<{ items: Item[] }>;
    read(itemId: string): Promise<Blob>;
    readText(itemId: string): Promise<string>;
    readJson<T = unknown>(itemId: string): Promise<T>;
    urlFor(itemId: string): string;
  };
  profile: {
    get(): Promise<{ username?: string; displayName?: string; bio?: string; avatar?: string }>;
  };
  window: {
    setTitle(title: string): void;
    close(): void;
    requestFocus(): void;
  };
  onIntent(cb: (intent: unknown) => void): () => void;
};
```

The builder should prefer:

- `fs.list({ mimeType: 'image/*' })` for gallery-type apps,
- `fs.list({ mimeType: 'audio/*' })` for music apps,
- `fs.list({ mimeType: 'text/*' })` or path scopes for notes readers,
- and should gracefully handle empty arrays and permission denials.

## Validation requirements

Every generated app should satisfy these checks before install:

1. Has a valid HTML entrypoint.
2. All referenced local assets exist.
3. No external network/CDN references.
4. If it uses `window.eternal.fs`, it declares matching `fs` permissions.
5. If it uses `window.eternal.profile`, it declares matching `profile` fields.
6. It has loading, empty, and error states for data-driven UIs.
7. It does not crash when `fs.list()` returns an empty array.
8. It does not assume desktop data exists until the promise resolves.

This can start as static validation and repair. Later, it should include a
visual/runtime smoke test harness.

## Rollout plan

### Phase A — Clean up the current builder

- Keep `buildAppFromPrompt` as the main path.
- Add an explicit `AppSpec` generation phase.
- Add validation for permissions, asset references, and empty states.
- Improve repair prompts with compiler/bundler/runtime errors.

### Phase B — Harden install and permission mediation

- Separate "declared permissions" from "granted permissions".
- Add approval UI for broad scopes.
- Store grant rationale and approval metadata.

### Phase C — Better validation and app repair

- Add a deterministic app validation pass after bundling.
- Add targeted repair for runtime contract mismatches.
- Add a reference acceptance app such as "Photo Grid" for regression testing.

### Phase D — Persistent apps

- Introduce facet-backed mode for apps that need server-side persistence.
- Keep hermetic/local-first apps on the simpler path.

## Open questions

1. Should self-authored low-risk apps auto-grant `image/*` or always show a
   confirmation dialog?
2. Should the desktop summary include sampled item names, or only aggregate
   metadata, before grants are approved?
3. Do we want a distinct "repair app" tool for fixing an already-created app
   without changing permissions?
4. When we add write support, do we expose it directly on `window.eternal.fs`
   or through a separate mutation namespace to make approvals more explicit?

## Recommended next implementation steps

1. Add an explicit `buildSpecFromPrompt()` stage ahead of file generation.
2. Make validation rules first-class instead of relying only on bundle errors.
3. Deprecate the curated path from the main user flow; keep it only for test
   fixtures.
4. Add grant mediation for broad scopes.
5. Add one end-to-end regression story:
   "Build me a gallery app for my photos" -> app installs -> reads actual photos
   via `window.eternal`.

## Sources

- Cloudflare Dynamic Workers:
  [developers.cloudflare.com/dynamic-workers](https://developers.cloudflare.com/dynamic-workers/)
- Dynamic Workers API reference:
  [developers.cloudflare.com/dynamic-workers/api-reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)
- Workers `ctx.props` / `ctx.exports`:
  [developers.cloudflare.com/workers/runtime-apis/context](https://developers.cloudflare.com/workers/runtime-apis/context/)
- Worker Loader docs:
  [developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/)
- Durable Object Facets:
  [developers.cloudflare.com/dynamic-workers/usage/durable-object-facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
- Workers AI structured outputs:
  [developers.cloudflare.com/changelog/2025-02-25-json-mode](https://developers.cloudflare.com/changelog/2025-02-25-json-mode/)
- Workers AI with AI SDK:
  [developers.cloudflare.com/workers-ai/configuration/ai-sdk](https://developers.cloudflare.com/workers-ai/configuration/ai-sdk/)
- Agents SDK v0.7.0:
  [developers.cloudflare.com/changelog/post/2026-03-02-agents-sdk-v070](https://developers.cloudflare.com/changelog/post/2026-03-02-agents-sdk-v070/)
- Vercel v0 Platform API:
  [vercel.com/blog/build-your-own-ai-app-builder-with-the-v0-platform-api](https://vercel.com/blog/build-your-own-ai-app-builder-with-the-v0-platform-api)
- Vercel v0 composite model family:
  [vercel.com/blog/v0-composite-model-family](https://vercel.com/blog/v0-composite-model-family)
- Anthropic Artifacts overview:
  [support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- Anthropic Artifacts app-building guide:
  [support.anthropic.com/en/articles/11649438-prototype-ai-powered-apps-with-claude-artifacts](https://support.anthropic.com/en/articles/11649438-prototype-ai-powered-apps-with-claude-artifacts)
