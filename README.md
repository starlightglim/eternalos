# EternalOS

EternalOS is a personal desktop for the web: a place to arrange files, build a
profile, customize an interface, publish creations, and work with an AI that is
grounded in the contents of your desktop.

It combines a React desktop shell with Cloudflare Workers, Durable Objects, KV,
R2, Workers AI, and Dynamic Workers. The result feels like a small operating
system rather than a conventional profile page: users open files in windows,
organize folders, install themes, build sandboxed apps and games, and share a
read-only version of their desktop at `/@username`.

- App: [eternalos.me](https://eternalos.me)
- API health check:
  [eternalos-api.wubny31.workers.dev/api/health](https://eternalos-api.wubny31.workers.dev/api/health)
- Sandboxed app handbook: [docs/developer_handbook.md](./docs/developer_handbook.md)

## Table of contents

- [What the app does](#what-the-app-does)
- [Major features](#major-features)
- [How the system works](#how-the-system-works)
- [Technology](#technology)
- [Run locally](#run-locally)
- [Configuration reference](#configuration-reference)
- [Useful commands](#useful-commands)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)

## What the app does

EternalOS gives every account a persistent browser desktop. The owner can edit
it; visitors can browse the items that owner has made public.

Instead of posting into a feed, a user builds a space out of:

- folders and uploaded files
- images, text, Markdown, code, audio, video, and PDFs
- website links
- widgets such as sticky notes, guestbooks, music players, pixel canvases, and
  link boards
- decorative stickers
- user-built sandboxed apps
- fantasy-console game cartridges

Desktop items, icon positions, open-window state, profile details, appearance,
and chat history persist between sessions. Uploaded files live in object
storage, while per-user desktop state is serialized through a Durable Object.

The product is deliberately personal and user-controlled: there are no feeds,
followers, or recommendation algorithms. Public sharing exposes a curated
visitor view, not the owner's editing controls.

## Major features

### Desktop and file management

- Drag desktop icons and windows, resize windows, and preserve their positions.
- Create folders and text files, upload files, duplicate items, and use
  cut/copy/paste.
- Sort or clean up a desktop and move deleted items through a recoverable Trash.
- Browse nested folders and inspect item metadata with Get Info.
- Open common file formats in built-in viewers:
  - images
  - plain text and Markdown
  - syntax-highlighted source code
  - audio and video
  - PDFs
  - website links
- Use a mobile-specific browser interface on smaller screens.

### Search and image understanding

Uploaded images can be enriched asynchronously with Workers AI. EternalOS
stores a caption, tags, detected text, dominant colors, model information, and
analysis status on the corresponding desktop item.

Search can use:

- filenames and user-authored tags
- AI-generated captions and tags
- OCR-style detected text
- dominant colors
- basic synonym-aware matching

Dominant colors are computed deterministically; they are not guessed by the
language model.

### Ask Eternal

Ask Eternal is the built-in, stateful AI workspace. It uses persistent threads
and is grounded in the current user's desktop rather than acting as an
unrestricted general-purpose chatbot.

The orchestrator can:

- summarize the desktop and inspect its contents
- search files and read text documents
- remember useful facts across a conversation
- create folders and notes or move matching items
- help design and build EternalOS apps
- preview and install generated apps after the user reviews them

Read operations and mutations are exposed to the model as structured tools.
Actions that change user data go through explicit tool paths instead of being
inferred from free-form text.

Example prompts:

```text
What is on my desktop right now?
Find the recent images that contain text.
Create a folder called Road Trip and move the road photos into it.
Read my project notes and summarize the open tasks.
Build me a small pomodoro timer app.
```

### Appearance and personalization

The appearance system ranges from quick presets to low-level design control:

- preset themes, wallpaper, and cover/tile/center wallpaper modes
- colors, typography, borders, radii, opacity, and window shadows
- interchangeable window chrome, title-bar, and resize-control variants
- custom icons, cursors, sound packs, and visual effects
- a scoped custom-CSS editor with history and revert support
- uploaded CSS assets served from first-party storage

Custom CSS is sanitized and scoped to the user's desktop. Remote `url()` values
and global font injection are restricted so a theme cannot freely escape into
the surrounding application.

### Profiles and public desktops

- Each user has a public route at `/@username`.
- Items are private until the owner marks them public.
- Visitors get a read-only desktop and can open public files and folders.
- Owners can add a display name, bio, profile links, and a custom share
  description.
- Optional visitor analytics and guestbook widgets add lightweight interaction
  without turning the product into a social feed.

### Bazaar

The Bazaar is the community exchange for EternalOS creations. Users can browse,
publish, install, and remove packs such as:

- themes and full `.estheme` bundles
- cursor, icon, sound, and effect packs
- fantasy-console games

Published assets are validated before storage, and installations flow through
server-side pack metadata rather than injecting arbitrary remote resources.

### Developer Studio and sandboxed apps

EternalOS can host user-created apps as desktop items. App source is bundled
into a Cloudflare Dynamic Worker and displayed in a sandboxed iframe. The app
does not receive direct access to the EternalOS page or the user's credentials.

Instead, apps use a capability-controlled `window.eternal` bridge for:

- allowlisted desktop file reads and writes
- app-private key/value storage
- selected profile fields
- allowlisted outbound network requests
- inter-app messages
- window title, resize, focus, and close controls
- custom file handlers

Permissions are declared in each app manifest, granted by the user, encoded in
short-lived capability tokens, and checked again by the backend. See the
[developer handbook](./docs/developer_handbook.md) for the manifest format,
bridge API, and local app CLI.

### Game Console and Cartridge Studio

The built-in fantasy console runs compact EternalOS cartridges. Cartridge
Studio supports editing game code, sprites, palettes, and metadata; finished
games can be installed on the desktop or published to the Bazaar. Game saves
are isolated by both game and player.

## How the system works

```text
Browser
  React + Vite desktop shell
          |
          | HTTP / WebSocket
          v
Cloudflare Worker API
  |-- UserDesktop Durable Object      canonical per-user desktop state
  |-- OrchestratorAgent Durable Object persistent AI threads and memory
  |-- AuthCoordinator Durable Object   coordinated account operations
  |-- RateLimiter Durable Object       distributed request limits
  |-- BazaarCoordinator Durable Object coordinated marketplace operations
  |-- KV                               users, sessions, indices, snapshots
  |-- R2                               uploads, themes, sounds, and assets
  |-- Workers AI                       chat, app building, image analysis
  `-- Dynamic Worker loader            sandboxed user apps and games
```

### Request and persistence flow

1. The React frontend calls the Worker through `VITE_API_URL`.
2. The Worker validates the origin, applies security headers and rate limits,
   and authenticates protected requests with a Worker-issued JWT.
3. Desktop reads and writes are forwarded to the `UserDesktop` Durable Object
   named for that user's ID. That object is the authoritative state owner.
4. Uploaded binary data is stored in R2; desktop items retain the relevant R2
   keys and metadata.
5. KV stores account/session indices and cacheable public lookup data.
6. Ask Eternal connects over WebSocket to a per-user, per-thread
   `OrchestratorAgent` Durable Object.
7. Public visitor requests receive only the profile and items that the owner
   has exposed.

### Authentication and account lifecycle

The Worker owns signup, login, refresh-token rotation, logout, password reset,
email verification, recovery codes, username changes, data export, and account
deletion. Google OAuth, Turnstile, and outbound email are optional integrations;
ordinary local username/password development does not require them.

### Local data versus production data

By default, `wrangler dev` simulates KV, R2, and Durable Objects locally. Its
state is stored under `packages/worker/.wrangler/state`, so local accounts and
files survive Worker restarts but remain separate from production. An account
created on the deployed site will not automatically exist in local development.

## Technology

### Frontend

- React 19 and TypeScript
- Vite 7
- React Router
- Zustand state stores
- Cloudflare Agents chat client
- CSS Modules plus a token compiler for user appearance settings

### Backend

- Cloudflare Workers
- Cloudflare Durable Objects
- Cloudflare KV and R2
- Workers AI
- Cloudflare Agents and `@cloudflare/ai-chat`
- Dynamic Worker loaders for sandboxed user code
- TypeScript, Zod, and Worker-native WebSockets

## Run locally

### Prerequisites

- Node.js 22 or newer
- npm (included with Node.js)
- Git
- Optional: a Cloudflare account if you want live Workers AI during local
  development

The repository is an npm-workspaces monorepo. Run the following commands from
the repository root unless a step says otherwise.

### 1. Install dependencies

```bash
npm install
```

### 2. Create the Worker development variables

Create `packages/worker/.dev.vars`:

```env
ENVIRONMENT=development
JWT_SECRET=dev-secret-change-in-production-abc123xyz
IMAGE_ANALYSIS_MODEL=@cf/meta/llama-3.2-11b-vision-instruct
AGENT_CHAT_MODEL=@cf/zai-org/glm-4.7-flash
```

`ENVIRONMENT=development` is required. The checked-in Worker configuration
defaults to production, whose CORS policy rejects the local Vite origin.

The example JWT secret is only for local development. Never reuse it in a
deployed environment.

### 3. Point the frontend at the local API

Create `packages/frontend/.env.local`:

```env
VITE_API_URL=http://localhost:8787
```

Both files are ignored by Git and must not be committed.

### 4. Choose an AI setup

#### Option A: full local development with Workers AI

Authenticate Wrangler once:

```bash
npx wrangler login
```

The `[ai]` binding in `packages/worker/wrangler.toml` uses remote Workers AI,
while KV, R2, and Durable Objects continue to run in local simulation. This
enables Ask Eternal, app generation, and image analysis.

#### Option B: run without Cloudflare credentials

Temporarily comment out this block in `packages/worker/wrangler.toml`:

```toml
# [ai]
# binding = "AI"
# remote = true
```

Do not commit that temporary change. The core desktop, accounts, storage,
uploads, public views, widgets, and most customization features work against
local simulations. Ask Eternal can open, but AI replies, AI app generation,
and image analysis require the missing binding and will fail if invoked.

### 5. Start the Worker

In the first terminal:

```bash
npm run dev:worker
```

Wait until Wrangler reports that the Worker is listening on port `8787`, then
verify it:

```bash
curl http://localhost:8787/api/health
```

The response should contain `"status":"ok"`.

### 6. Start the frontend

In a second terminal:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), create a local account,
and complete the quick-start wizard. The API is available at
[http://localhost:8787](http://localhost:8787).

### Quick-start summary

After the two environment files exist, the normal startup sequence is:

```bash
# terminal 1
npm run dev:worker

# terminal 2
npm run dev
```

## Configuration reference

### Frontend variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | Yes for the full local app | Worker base URL, such as `http://localhost:8787` |
| `VITE_GOOGLE_CLIENT_ID` | No | Shows and configures Google sign-in when the backend OAuth credentials are also present |
| `VITE_TURNSTILE_SITE_KEY` | No | Enables the client-side Turnstile challenge |

### Worker variables and secrets

| Variable | Required | Purpose |
| --- | --- | --- |
| `ENVIRONMENT` | Yes locally | Use `development` to allow local browser origins |
| `JWT_SECRET` | Yes | Signs access, refresh, file, chat, app, and game capability tokens |
| `IMAGE_ANALYSIS_MODEL` | No | Overrides the Workers AI vision model |
| `AGENT_CHAT_MODEL` | No | Overrides the Workers AI chat model |
| `APP_BUILDER_MODEL` | No | Overrides the model used to generate sandboxed apps |
| `ALLOWED_ORIGINS` | Production | Comma-separated frontend origins accepted by CORS |
| `GOOGLE_CLIENT_ID` | No | Enables Google OAuth when paired with its secret |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth secret |
| `TURNSTILE_SECRET` | No | Verifies Turnstile tokens; verification is bypassed when unset |
| `FROM_EMAIL` | No | Sender used for verification and password-reset messages |
| `APP_URL` | No | Public app URL used when constructing email links |
| `RESEND_API_KEY` | No | Fallback email provider when the Cloudflare email binding is absent |

Production secrets should be added with `wrangler secret put`; do not place
them directly in `wrangler.toml`.

### Cloudflare bindings

The Worker expects these bindings:

| Binding | Type | Responsibility |
| --- | --- | --- |
| `AUTH_KV` | KV | Account, session, username, and auth indices |
| `DESKTOP_KV` | KV | Public snapshots, metadata indices, and Bazaar metadata |
| `ETERNALOS_FILES` | R2 | User uploads and generated/customization assets |
| `USER_DESKTOP` | Durable Object | Canonical desktop state per user |
| `OrchestratorAgent` | Durable Object | Stateful AI threads and tool context |
| `AUTH_COORDINATOR` | Durable Object | Serialized account coordination |
| `RATE_LIMITER` | Durable Object | Request-rate accounting |
| `BAZAAR_COORDINATOR` | Durable Object | Marketplace coordination |
| `AI` | Workers AI | Chat, generation, and vision inference |
| `LOADER` | Dynamic Worker loader | Isolated runtime for apps and games |

## Useful commands

Run these from the repository root.

| Command | What it does |
| --- | --- |
| `npm run dev` | Starts the Vite frontend on port 5173 |
| `npm run dev:worker` | Starts the local Worker on port 8787 |
| `npm run build` | Type-checks and builds the frontend |
| `npm run preview` | Serves the production frontend build locally |
| `npm run lint` | Lints the frontend |
| `npm run test:worker` | Runs Worker integration tests |
| `npm run coverage:worker` | Runs Worker tests with coverage enabled |
| `npm run typecheck --workspace=@eternalos/frontend` | Type-checks the frontend only |
| `npm run typecheck --workspace=@eternalos/worker` | Type-checks the Worker only |

A useful pre-commit verification set is:

```bash
npm run typecheck --workspace=@eternalos/frontend
npm run typecheck --workspace=@eternalos/worker
npm run test:worker
npm run build
```

## Project structure

```text
.
|-- packages/
|   |-- frontend/
|   |   |-- functions/          Cloudflare Pages middleware
|   |   |-- public/             fonts, manifest, service worker, headers
|   |   `-- src/
|   |       |-- components/     desktop, windows, viewers, widgets, console
|   |       |-- effects/        desktop visual effects
|   |       |-- hooks/          synchronization and responsive behavior
|   |       |-- pages/          auth, landing, visitor, and error routes
|   |       |-- services/       typed Worker API client
|   |       |-- stores/         Zustand state and persistence coordination
|   |       |-- tokens/         appearance schema and CSS compiler
|   |       |-- variants/       swappable window/chrome implementations
|   |       `-- utils/          themes, CSS aliases, installers, helpers
|   `-- worker/
|       |-- src/
|       |   |-- agents/         Ask Eternal orchestrator and structured tools
|       |   |-- durable-objects/ state and coordination classes
|       |   |-- middleware/     authentication and rate limiting
|       |   |-- routes/         auth, upload, apps, games, Bazaar, visitors
|       |   |-- services/       capability-scoped app/game service bridge
|       |   `-- utils/          JWTs, validation, email, file policies
|       |-- test/               Worker integration tests
|       `-- wrangler.toml       Worker bindings, migrations, and deployment
|-- scripts/
|   `-- eternal-app.mjs         local CLI for sandboxed EternalOS apps
|-- docs/                       developer documentation
|-- design/                     architecture and product design notes
`-- package.json                workspace scripts
```

The main frontend entry points are `packages/frontend/src/App.tsx` and
`packages/frontend/src/components/desktop/Desktop.tsx`. The Worker route table
starts in `packages/worker/src/index.ts`.

## API surface

The frontend is the intended API client, but the Worker routes fall into these
groups:

- `/api/auth/*` — accounts, sessions, email verification, OAuth, recovery, and
  data lifecycle
- `/api/desktop/*` — desktop items and window state
- `/api/upload`, `/api/files/*`, `/api/wallpaper/*`, `/api/icon/*` — files and
  user assets
- `/api/profile`, `/api/visit/*`, `/api/og/*`, `/api/analytics` — profiles and
  public desktops
- `/api/agent/*` — chat WebSockets, thread management, and short-lived tokens
- `/api/apps/*`, `/api/app-previews/*` — sandboxed app deployment and bridge
  capabilities
- `/api/games/*` — cartridge drafts, runtime capabilities, and game serving
- `/api/bazaar/*` — publish, browse, install, and serve community packs
- `/api/css-assets/*`, `/api/css-history/*`, `/api/sounds/*`, `/api/cursors/*`
  — customization assets and history
- `/api/trash/*` and `/api/quota` — lifecycle and storage management
- `/api/health` — unauthenticated health check

## Deployment

The checked-in `wrangler.toml` describes the production Worker, including its
Durable Object migrations, bindings, scheduled trash cleanup, and allowed
origins. If deploying a fork, create your own KV namespaces and R2 bucket, then
replace the checked-in resource IDs and domain values with resources from your
Cloudflare account.

### Deploy the Worker

Authenticate Wrangler, configure the required bindings, set a strong production
JWT secret, and deploy:

```bash
npx wrangler login
cd packages/worker
npx wrangler secret put JWT_SECRET
npm run deploy
```

Add optional OAuth, Turnstile, or email secrets only when those integrations
are configured.

### Deploy the frontend

Set `VITE_API_URL` to the deployed Worker URL before building. The frontend can
be connected to a Cloudflare Pages Git project or deployed from the command
line. From the repository root:

```bash
npm run build
npx wrangler pages deploy packages/frontend/dist --project-name=eternal
```

For a fork, replace `eternal` with your Pages project name. Configure the same
frontend origin in the Worker's `ALLOWED_ORIGINS`, and configure Pages to route
all application paths to the React entry point.

## Troubleshooting

### Signup fails with `Failed to fetch` or a CORS error

Confirm that `packages/worker/.dev.vars` contains:

```env
ENVIRONMENT=development
```

Restart the Worker after changing the file. The production default intentionally
rejects `http://localhost:5173`.

### Wrangler asks for `CLOUDFLARE_API_TOKEN`

The Workers AI binding is remote. Either authenticate with `npx wrangler login`
or use the credential-free setup above by temporarily commenting out the `[ai]`
block. Keep that edit out of commits.

### The desktop loads but AI replies or image analysis fail

Check that Wrangler is authenticated, the `[ai]` binding is enabled, and the
configured model names are available to the Cloudflare account. The rest of the
local desktop can work without the AI binding.

### A production account cannot log in locally

Local Wrangler state is separate from production. Create a new local account.
To reset only the local backend, stop the Worker and deliberately remove the
relevant data under `packages/worker/.wrangler/state`; this permanently deletes
local accounts and files, so back it up first if needed.

### Changes appear not to load

After restarting Vite, perform a hard refresh (`Cmd+Shift+R` on macOS or
`Ctrl+Shift+R` on Windows/Linux). An existing tab can retain stale CSS or
JavaScript modules.

### Port 5173 or 8787 is already in use

Stop the process using the port, or start the corresponding development server
on a different port. If the frontend port changes, add that origin to the local
CORS allowlist in `getCorsHeaders` and restart the Worker.

### The frontend starts but API actions fail

Check all three conditions:

1. `VITE_API_URL` is `http://localhost:8787`.
2. The Worker health endpoint returns `{"status":"ok", ...}`.
3. Both development servers were restarted after their environment files were
   created or changed.

## Additional documentation

- [Sandbox App Developer Handbook](./docs/developer_handbook.md)
- [Design and architecture notes](./design/README.md)
- [App interoperability design](./design/01-apps-interop.md)
- [Orchestrator architecture](./design/12-orchestrator-v2.md)
- [Security review](./design/11-security-audit-2026-04-20.md)
