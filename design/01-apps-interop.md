# 01 — User Apps × Files × Apps Interop

> Design for the app platform layer of EternalOS.
> Parent doc: [ROADMAP.md](ROADMAP.md). Related: [04-skin-format.md](04-skin-format.md).

## Goals

1. A user-created app can **read the user's own desktop files** with explicit, revocable permission.
2. A user-created app can **write back** (create a new item, update a widget's config) under the same permission model.
3. Apps can **talk to each other** via a simple event bus, enabling composed experiences (visualizer listens to music player's "now playing").
4. Apps can **register as handlers** for mime types so "double-click a `.md` file" opens the user's preferred markdown app, not the built-in viewer.
5. Apps can **mount virtual folders** backed by their own state, appearing on the desktop like first-class items.
6. The system has a **manifest-based permission model** users understand on install, with per-permission grant/revoke.
7. Apps can optionally **make outbound network calls** to user-approved domains only.
8. Nothing cross-user. An app belongs to one user and only ever sees that user's data.

## Non-goals (for v1)

- Cross-user app sharing at runtime (one user's app reading another user's files). Covered by the social layer later.
- Persistent per-app databases. Deferred until DO Facets lands in GA (then each app gets its own SQLite DO).
- App-to-external-service auth (app wants to post to the user's GitHub). Deferred; will need a credential broker.
- Background apps. Apps run only while their window is open. No service workers, no cron.

## Current state

- Apps live at `apps/{uid}/{appId}/` in R2 — `bundle.json` (compiled Worker modules) and `source.json` (original files).
- Registry: OrchestratorAgent's SQLite table `apps(id, name, r2_prefix, desktop_item_id, version, width, height, created_at, updated_at)` ([appTools.ts:24](../packages/worker/src/agents/tools/appTools.ts:24)).
- KV `app:{appId}` → `{uid, version}` for the serving route.
- DesktopItem of `type: 'app'` with `appManifest: { name, description, version, windowConfig, appId }` ([types.ts:199](../packages/worker/src/types.ts:199)).
- Runtime: Dynamic Worker loaded via `env.LOADER.get(...)` at [index.ts:272](../packages/worker/src/index.ts:272). Served at `/api/apps/:appId`.
- `globalOutbound: null` — apps have **no network access of any kind**. Not even to eternalos.app itself.
- The frontend renders apps in an iframe (window content). There is currently no `postMessage` bridge.

Result: an app today is a hermetic, purely presentational bundle that can run a clock, a game, or a calculator, but cannot see or modify any user data.

## Runtime choice update

Cloudflare's **Dynamic Workers** are now the right default runtime for EternalOS apps. They are already integrated in the repo, they fit untrusted/generated code well, and they give us a clean path for per-app egress control and warm reusable runtimes.

What they are good for here:

- User-created HTML/JS/CSS apps.
- Codemode-generated app bundles.
- Per-app network allowlists via `globalOutbound`.
- Fast cold-starts compared to heavier container-style runtimes.

What they are **not** the answer for:

- Linux-process workloads, PTYs, Python notebooks, or anything that needs a real filesystem.
- Long-lived hidden helper processes.
- Durable per-app server-side state beyond what the current app runtime should own.

For those cases, use a separate runtime tier later (Containers/Sandboxes or DO-backed services). Do not drag that complexity into v1 app interop.

## Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Parent Frame                             │
│  (eternalos.app)                                                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  AppBridge (window.eternal.*)                            │   │
│  │  ─ intercepts iframe postMessage                          │   │
│  │  ─ checks app permissions                                 │   │
│  │  ─ prompts user on first use                              │   │
│  │  ─ calls Worker API with capability token                 │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌───────────── iframe srcdoc or /api/apps/:appId ────────┐     │
│  │  User app HTML/CSS/JS                                   │     │
│  │  window.eternal.fs.read("/Photos/IMG.jpg")              │     │
│  │    └─► postMessage('fs.read', { path, nonce })          │     │
│  │  window.eternal.ipc.emit('now_playing', { track })      │     │
│  │    └─► postMessage('ipc.emit', { topic, payload })      │     │
│  └────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                             │
                             │ (fetch with capability token)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Worker API                                  │
│  POST /api/apps/:appId/capability        ← mint token            │
│  GET  /api/apps/:appId/fs/list            ← list items            │
│  GET  /api/apps/:appId/fs/read/:itemId    ← read item             │
│  POST /api/apps/:appId/fs/write           ← create item           │
│  PATCH /api/apps/:appId/fs/patch/:itemId  ← update                │
│  DELETE /api/apps/:appId/fs/delete/:itemId                        │
│  (all require app capability token in header)                    │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
                    UserDesktop DO (authoritative state)
```

## Manifest v2

Replace the current lean `AppManifest` with a richer, versioned schema.

```typescript
export interface AppManifest {
  // Identity
  appId: string;
  name: string;                    // display name
  slug: string;                    // kebab-case, unique per user
  description?: string;            // shown at install prompt
  version: string;                 // semver
  author: string;                  // username
  icon?: string;                   // R2 key or data URL, 64x64 recommended

  // Windowing
  windowConfig: AppWindowConfig;

  // Permissions — declared up front, granted by user at install
  permissions: {
    fs?: FsPermission;             // file system access
    ipc?: IpcPermission;           // inter-app messaging
    network?: NetworkPermission;   // outbound http
    handlers?: HandlerPermission;  // register as mime-type handler
    virtualFolders?: VirtualFolderPermission;
    profile?: ProfilePermission;   // read user's profile (bio, avatar, username)
    ai?: AiPermission;             // call the assistant on the user's behalf
  };

  // Runtime
  entrypoint: string;              // path within bundle: "index.html" or "worker.js"
  contentSecurityPolicy?: string;  // app-declared CSP (intersected with platform CSP)

  // Metadata
  tags?: string[];                 // for bazaar
  homepageUrl?: string;
  repoUrl?: string;
  license?: string;                // SPDX identifier
  minHostVersion?: string;         // require EternalOS X.Y.Z or later
}

interface FsPermission {
  read?: FsPath[];                 // [] = none; ['**'] = all; ['/Photos/**']
  write?: FsPath[];                // same pattern
  delete?: FsPath[];
  // Mime types the app can read/write regardless of path
  mimeTypes?: string[];            // ['image/*', 'text/markdown']
}

type FsPath = string;              // supports globs: /Photos/**, *.jpg, etc.

interface IpcPermission {
  listen: string[];                // topics this app subscribes to
  emit: string[];                  // topics this app can publish
}

interface NetworkPermission {
  outbound: string[];              // domain patterns: ['api.weather.gov', '*.openweathermap.org']
}

interface HandlerPermission {
  mimeTypes: string[];             // ['text/markdown'] — declares "open-with" capability
  extensions?: string[];           // alternative to mimeTypes for non-mime-typed files
}

interface VirtualFolderPermission {
  mountAt: string[];               // ['/Notes'] — folders the app controls
}

interface ProfilePermission {
  read: Array<'username' | 'displayName' | 'bio' | 'avatar'>;
}

interface AiPermission {
  modes: Array<'ask' | 'search' | 'enrich'>;  // which assistant capabilities
}
```

**Install UX.** On install (or publish to own desktop from code editor), the user sees a dialog:

```
┌─ Install: Wavepad 1.2.0 by @alice ────────────────┐
│ A retro audio visualizer.                         │
│                                                   │
│ This app wants to:                                │
│   • Read audio files in /Music/**                 │
│   • Listen for "now_playing" events from any app  │
│   • Connect to api.last.fm                        │
│                                                   │
│ [ Deny ]  [ Customize… ]  [ Install ]             │
└───────────────────────────────────────────────────┘
```

"Customize" lets the user toggle individual permissions and narrow paths. Permissions are stored on the `DesktopItem` for the installed app:

```typescript
interface DesktopItem {
  // ...existing...
  appManifest?: AppManifest;
  grantedPermissions?: GrantedPermissions;  // what the user approved
  permissionGrantedAt?: number;
}
```

Users can revoke or narrow later from the app's context menu → "App permissions".

## Capability tokens

Each time an app frame wants to make an authenticated Worker call, the parent mints a short-lived capability token.

```typescript
// Worker endpoint called by the parent frame (not the iframe).
// POST /api/apps/:appId/capability
// Authorization: Bearer <user JWT>
// body: { grantedPermissions, ttlSeconds }
// returns: { token, expiresAt }

interface AppCapabilityPayload {
  uid: string;
  appId: string;
  // Full permission subset — server enforces against this
  granted: GrantedPermissions;
  // Token metadata
  iat: number;
  exp: number;   // default 5 minutes, max 15
  jti: string;
}
```

Tokens are HMAC-signed like the existing file-tokens ([jwt.ts:86](../packages/worker/src/utils/jwt.ts:86)). The iframe never sees the user's root JWT. Parent holds the root, mints app-scoped tokens, passes them to the iframe over postMessage on a per-call basis (or caches short-lived).

**Why not just check the app's manifest on each request?** Because the Worker needs to verify without a KV round-trip per call. Embedding the granted permissions in the token lets the Worker do stateless enforcement. Revocation happens at next token issue (tokens are ≤5min, so revocation latency is bounded).

## `window.eternal` — the bridge API

Exposed on the iframe's `window` via a host-provided bridge module and parent-frame message channel.

```typescript
window.eternal = {
  // Filesystem
  fs: {
    list(path: string, opts?: { recursive?: boolean }): Promise<DesktopItem[]>;
    read(itemIdOrPath: string): Promise<Blob>;
    readText(itemIdOrPath: string): Promise<string>;
    readJson<T = unknown>(itemIdOrPath: string): Promise<T>;
    write(opts: { path: string; content: Blob | string; mimeType?: string }): Promise<DesktopItem>;
    patch(itemId: string, updates: Partial<DesktopItem>): Promise<DesktopItem>;
    delete(itemId: string): Promise<void>;
    watch(path: string, callback: (event: FsEvent) => void): () => void;   // unsubscribe
  },

  // Inter-process communication
  ipc: {
    emit(topic: string, payload: unknown): void;
    on(topic: string, callback: (payload: unknown, sender: { appId: string }) => void): () => void;
    request(targetAppId: string, topic: string, payload: unknown): Promise<unknown>;
  },

  // User profile (read-only)
  profile: {
    get(): Promise<Partial<UserProfile>>;  // only the fields the app was granted
  },

  // AI assistant
  ai: {
    ask(prompt: string): Promise<string>;
    search(query: string): Promise<SearchResult[]>;
    enrich(item: DesktopItem): Promise<ImageAnalysisMetadata>;
  },

  // Virtual folder registration — apps can own a mount point
  virtualFolder: {
    register(path: string, provider: VirtualFolderProvider): void;
    unregister(path: string): void;
  },

  // Window controls
  window: {
    setTitle(title: string): void;
    close(): void;
    resize(width: number, height: number): void;
    requestFocus(): void;
  },

  // Network fetch — proxied through parent, allowlisted domains only
  fetch: typeof fetch;  // same signature; throws if domain not granted

  // Metadata
  appId: string;
  hostVersion: string;
};
```

## Runtime

Today: app runs as a Dynamic Worker at `/api/apps/:appId` and returns HTML. Iframe embeds that URL.

Proposed change: the Worker serves the app together with a **host-owned bridge module** that wires up `window.eternal` by listening for messages from the parent. Do not normalize arbitrary inline script injection as a platform primitive.

```html
<!-- provided by the platform runtime -->
<meta name="eternal-app-id" content="{{APP_ID}}">
<meta name="eternal-host-version" content="{{HOST_VERSION}}">
<meta name="eternal-parent-origin" content="{{PARENT_ORIGIN}}">
<script type="module" src="/app-runtime/bootstrap.js"></script>
```

`/app-runtime/bootstrap.js` reads the host-provided metadata, establishes the message channel, and exposes `window.eternal`.

**Why use a host-owned bridge module?** Because it keeps the trust boundary legible. The bridge is platform code, versioned by the host, and can be loaded under a strict CSP. User HTML should not get a free pass to rely on unsafe inline execution just because the host wants to expose APIs.

**CSP posture for the iframe:**

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://<eternalos-api>;
  connect-src https://<eternalos-api>;  // bridge calls
  frame-ancestors 'self' https://<eternalos-frontend>;
```

The iframe runs sandbox-style: it cannot navigate its parent, cannot escape the sandbox, cannot fetch arbitrary origins (connect-src restricts). Permissions for network go through the bridge's `window.eternal.fetch` or a Dynamic Worker `globalOutbound` allowlist.

## Inter-app messaging (IPC)

Apps communicate via a parent-mediated pub-sub bus. All messages go through the parent frame; apps never talk to each other directly.

**Topics.**

- Topics are free-form strings. Suggested namespace convention: `<domain>.<event>` — `music.now_playing`, `weather.location_changed`, `clock.tick`.
- Parent maintains a subscription table: topic → set of appIds. Apps declare which topics they subscribe to and which they emit in their manifest. Unauthorized publishes/subscribes are rejected.

**Request/reply.** Apps can call another app by ID with `window.eternal.ipc.request(targetAppId, topic, payload)`. Target app handles via `ipc.on(topic, ...)` and returns a value (the bridge auto-correlates with a request ID). Request returns null if the target app is not running.

**Scope.** All IPC is local to one user's session. Apps from different users never share a bus.

**Example.** A "Now Playing" audio player emits:

```javascript
// inside audio-player app
audio.addEventListener('play', () => {
  window.eternal.ipc.emit('music.now_playing', {
    title: currentTrack.title,
    artist: currentTrack.artist,
    durationMs: audio.duration * 1000,
  });
});
```

And a visualizer subscribes:

```javascript
// inside visualizer app
window.eternal.ipc.on('music.now_playing', (payload) => {
  title.textContent = payload.title;
});
```

Both apps must declare the topic in their manifest (`emit` / `listen`).

## Mime-type handlers (open-with)

Apps can declare they handle specific mime types or extensions. Users can set a default handler per type.

**Registration.** Handlers declared in the app manifest (`permissions.handlers.mimeTypes`). On install, user can choose to set this app as the default handler for those types.

**Resolution.** When the user double-clicks a file, the OS:

1. Looks up the user's preferred handler for that mime type (stored in `UserProfile.mimeHandlers: Record<string, string>` — mime → appId).
2. If no preference, checks for a single registered handler; if so, uses it.
3. If multiple handlers, shows a picker.
4. If none, falls back to the built-in viewer (ImageViewer, MarkdownViewer, etc.).

**Invocation.** Parent opens the app's window and sends a startup message:

```typescript
parent.postMessage({ method: 'launch', args: { intent: { action: 'open', itemId: '...' } } }, origin);
```

App handles via `window.eternal.onIntent((intent) => { ... })`.

**Alternative: drop-to-open.** Dragging a desktop icon onto an open app window triggers the same intent flow.

## Virtual folders

Apps can "mount" a folder on the desktop whose contents come from the app, not from R2.

**Use case.** A "Notes" app mounts `/Notes`. Contents of `/Notes` look like regular desktop items, but the system of record must still be durable and multi-device-safe.

**API.**

```typescript
window.eternal.virtualFolder.register('/Notes', {
  list: () => Promise<DesktopItem[]>,
  read: (itemId: string) => Promise<Blob>,
  write: (item: Partial<DesktopItem>) => Promise<DesktopItem>,
  delete: (itemId: string) => Promise<void>,
});
```

**Rendering.** The parent's desktop renderer, when navigating into `/Notes`, calls the app's `list()` and displays its items.

**Trade-off.** The old idea of backing this with app-local IndexedDB plus hidden iframes is not robust enough for EternalOS. It is single-device, hard to reason about, and creates "phantom app" lifecycle problems.

**Decision update.** Defer virtual folders to v1.1. When they land, they should sit on top of a durable server-side state model, not just browser-local storage.

## Network access

Today: `globalOutbound: null` means no network.

Proposed: allow the app manifest to declare outbound domains, and the Dynamic Worker loader configures `globalOutbound` to a per-app filter.

```typescript
// at worker load time
const worker = env.LOADER.get(`app-${appId}@v${version}`, async () => ({
  compatibilityDate: '2026-04-15',
  mainModule: bundle.mainModule,
  modules: bundle.modules,
  globalOutbound: buildAllowlistOutbound(grantedPermissions.network?.outbound ?? []),
}));

function buildAllowlistOutbound(allowedDomains: string[]): Fetcher {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const allowed = allowedDomains.some(pattern => matchDomain(url.hostname, pattern));
      if (!allowed) {
        return new Response(`Domain ${url.hostname} not in app's network allowlist`, { status: 403 });
      }
      return fetch(request);
    },
  };
}
```

**Alternative: route through a proxy.** Apps call `window.eternal.fetch(url)`, parent proxies to a Worker endpoint that checks the domain and forwards. Pros: visible in Worker logs and easier policy enforcement. Cons: parent is in the hot path.

**Recommendation update.** Use Dynamic Worker `globalOutbound` as the default for straightforward per-app egress restrictions. Use the proxy path only when we need centralized request shaping, AI Gateway attachment, or stronger audit controls.

## Publishing apps (bazaar extension)

Extend `BazaarPack`'s `type` enum with `'app'`:

```typescript
export type PackType = 'cursor' | 'icon' | 'sound' | 'effect' | 'skin' | 'app';
```

An app pack bundles:

- `manifest.json` (the AppManifest — all permissions, etc., declared)
- `source/` (the original files: `index.html`, `styles.css`, `app.js`, plus any other assets)
- `preview.png` (screenshot)

On install from the bazaar, the installing user's desktop creates a new DesktopItem with `type: 'app'`. The source is re-bundled into their own Dynamic Worker instance — each user has their own app instance, not a shared one. Version updates bump the installer's local copy independently.

**Fork.** Any app in the bazaar can be forked — creates a copy in the forker's account with `forkedFrom: originalPackId` stored. Enables remix lineage. See [04-skin-format.md](04-skin-format.md) §5 for the pattern.

**Trust tiers** (as with other bazaar packs):

- **Unverified**: default; full sandbox; no elevated permissions granted at install.
- **Verified**: author has verified email and account > 7 days old. Shows badge. Permissions installable normally.
- **Featured**: human-reviewed. Shows badge and priority in browse.

## Security model — threat analysis

**Threat: hostile app exfiltrates user files.**
- Mitigation: explicit fs read permission, path-scoped. User sees at install what paths are accessible. Revocable.
- Residual risk: user grants `/**` on an app they didn't scrutinize. Mitigation: "requests access to all your files" red-warning in install dialog. Trust tier affects this.

**Threat: hostile app exfiltrates via network.**
- Mitigation: outbound allowlist enforced by Dynamic Worker's `globalOutbound`.
- Residual risk: user grants `*` outbound. Same mitigation.

**Threat: hostile app hijacks parent frame via postMessage.**
- Mitigation: parent checks `e.origin === expectedAppOrigin` on all messages. App cannot inject scripts into parent due to CSP `frame-ancestors` and iframe sandbox.
- Residual risk: low; enforced by browser.

**Threat: hostile app reads another app's IPC messages.**
- Mitigation: parent enforces topic allowlist per app manifest. App cannot subscribe to a topic it didn't declare.
- Residual risk: user could grant an app access to all topics. Mitigation: install UI lists specific topics, requires explicit consent.

**Threat: capability token theft via DOM exfiltration.**
- Mitigation: tokens short-lived (≤5min). Parent caches per-call; does not store long-term in iframe DOM.
- Residual risk: low.

**Threat: manifest tampering at install.**
- Mitigation: manifest is stored in R2 at publish time, content-hashed. On install, bundle+manifest signature verified.
- Residual risk: requires author key compromise; out of scope for v1.

**Threat: permission fatigue (users click-through).**
- Mitigation: install UX emphasizes scope ("All files" vs "/Photos/**"). Permissions grouped, not listed as a wall of checkboxes.

## Migration plan

Existing apps (created via current `appTools.createApp`) have no manifest v2. They remain fully sandboxed (no file access, no network, no IPC) until the user opens them in the new editor and adds permissions.

**Steps:**

1. Add `manifest.json` to R2 at `apps/{uid}/{appId}/manifest.json` with a minimal default (no permissions granted).
2. Update `DesktopItem.appManifest` schema to the new shape; old apps default to zero permissions.
3. Ship the host-owned bridge module in the serving route/runtime.
4. Add the `/api/apps/:appId/capability` endpoint and `/api/apps/:appId/fs/*` endpoints.
5. Update OrchestratorAgent's `createApp` tool to accept permission declarations.
6. Update app install UX in the frontend.

No existing app is forced to adopt v2. Users can "upgrade" an app by going to its settings and re-granting permissions.

## API surface — Worker endpoints

All require the capability token.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/apps/:appId/capability` | Mint capability token for this app session (user JWT required) |
| GET | `/api/apps/:appId/fs/list?path=/Photos` | List items matching app's read scope |
| GET | `/api/apps/:appId/fs/read/:itemId` | Read file content (returns blob) |
| POST | `/api/apps/:appId/fs/write` | Create new desktop item |
| PATCH | `/api/apps/:appId/fs/patch/:itemId` | Update existing item (must be in write scope) |
| DELETE | `/api/apps/:appId/fs/delete/:itemId` | Delete item (must be in delete scope) |
| GET | `/api/apps/:appId/profile` | Read profile fields the app was granted |
| POST | `/api/apps/:appId/ai/ask` | Assistant query on behalf of user |
| POST | `/api/apps/:appId/proxy-fetch` | Network proxy (alternative to Dynamic Worker allowlist) |

Enforcement: each endpoint decodes the capability token, checks the path/permission against `granted`, then forwards to the UserDesktop DO via the existing internal interface.

## Open questions

- **Should virtual folders be a v1 feature or punt?** They're the coolest part but also the most complex. I'd punt to v1.1.
- **Should we build the permission prompt UI as a system dialog or as an in-OS window?** An in-OS window feels more at-home but may lead to spoof-able prompts (app creates its own "permission request" window). System-level dialog (rendered outside any iframe) is safer.
- **Code editor quickstart.** Should the in-OS code editor write a full manifest skeleton for new apps, or ask only for name and capabilities? Former is more discoverable; latter is faster.
- **Rate limits on bridge calls.** An app could spam `fs.list`. Add per-app + per-token call rate limit (100/min default?).
- **Bridge versioning.** `window.eternal` will evolve. Apps should declare `hostVersion` they're built against; bridge provides backwards-compat shims for older schemas.

## Phased delivery

**Phase A (1 week) — foundations.**
- Host-owned bridge module.
- Capability token mint + verify.
- `fs.list` and `fs.read` endpoints.
- Manifest v2 schema + install dialog.
- One reference app: "Photo Browser" that uses fs.list + fs.read on `/Photos/**`.

**Phase B (1 week) — write + IPC.**
- `fs.write`, `fs.patch`, `fs.delete`.
- IPC emit/listen + manifest declarations.
- Reference app: "Audio Player" that emits `music.now_playing`; "Visualizer" that listens.

**Phase C (1 week) — network + handlers.**
- `globalOutbound` allowlist integration.
- Mime-type handler registration + resolution.
- "Default app for X" preference.
- Reference app: "Markdown Studio" that reads `.md` files and becomes the default handler.

**Virtual folders** deferred to a v1.1 pass and explicitly blocked on durable app state.

## Success metrics

- Number of apps with >0 permissions granted (vs default sandboxed).
- Fraction of published bazaar apps that are installed with at least one permission grant.
- App-to-app IPC messages per user per session.
- User reports of "permission surprised me" (should trend to zero after install UX tuning).
