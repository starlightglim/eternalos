# EternalOS

Cloudflare-native personal desktop environment with grounded AI chat, persistent per-user state, live visitor views, per-user custom CSS, and AI-enriched image metadata.

Deployed frontend: [https://eternalos.app](https://eternalos.app)  
Deployed API: [https://eternalos-api.wubny31.workers.dev](https://eternalos-api.wubny31.workers.dev)

## Submission Checklist

- Repository name should be prefixed as `cf_ai_...`
- Includes this `README.md` with project overview and running instructions
- Includes [PROMPTS.md](PROMPTS.md) documenting AI prompts/workflows used during development

## Assignment Fit

This project is intentionally structured to match the Cloudflare AI application assignment:

- **LLM**
  - Uses **Workers AI**
  - Chat agent defaults to `@cf/zai-org/glm-4.7-flash`
  - Image understanding uses Workers AI vision models for captions, tags, and OCR-style text extraction
  - Chat model is configurable through `AGENT_CHAT_MODEL`

- **Workflow / coordination**
  - Uses **Cloudflare Workers** and **Durable Objects**
  - One `UserDesktop` Durable Object stores each user’s canonical desktop state
  - One `DesktopChatAgent` Durable Object stores chat history and agent state

- **User input via chat**
  - Includes an in-product chat window: **Ask Eternal**
  - Built on **Cloudflare Agents** + `AIChatAgent`
  - Runs inside the deployed app, not as a separate demo

- **Memory / state**
  - Durable Objects persist:
    - desktop items
    - windows
    - profile / appearance
    - chat history
    - last matched search set for follow-up agent actions

## What It Does

EternalOS is a browser-based desktop where a user can upload, arrange, tag, and share files in a retro UI. The AI layer is grounded in that desktop state instead of being a generic chatbot.

Core flows:

- Sign up and log in through a Cloudflare Worker auth system
- Persist sessions and username lookups in Cloudflare KV
- Upload images and files onto a desktop
- Persist per-user state with Durable Objects
- Customize the desktop with:
  - wallpaper and wallpaper mode
  - color controls for chrome, labels, buttons, and windows
  - border radius and shadow controls
  - per-user custom CSS
- Share a public visitor desktop view
- Enrich uploaded images with:
  - captions
  - tags
  - OCR-style detected text
  - deterministic dominant colors
- Search by:
  - filename
  - tags
  - captions
  - OCR text
  - colors
- Ask the AI questions like:
  - `What is on my desktop right now?`
  - `How many anime images are there?`
  - `Which recent images contain text?`
  - `Find images related to roads`
- Approve structured follow-up actions like:
  - creating a folder from current matches

## Project Overview

EternalOS is meant to feel more like a personal place than a profile page.

Instead of posting into a feed, a user builds a desktop:

- folders
- images
- text files
- links
- audio and video files
- widgets
- stickers

Each user gets:

- a private editing view
- a public visitor view
- persistent window state
- persistent appearance settings
- persistent file organization

The project combines product/UI work and Cloudflare systems work:

- a retro desktop UI
- file uploads and asset serving
- public sharing
- search and metadata enrichment
- stateful chat over real user data
- custom CSS and appearance controls

## Cloudflare Architecture

```text
Pages (React frontend)
  -> Worker API
    -> Durable Object: UserDesktop
    -> Durable Object: DesktopChatAgent
    -> KV: auth/session/public snapshot indices
    -> R2: uploaded files, thumbnails, assets
    -> Workers AI: chat + image analysis
```

Main Cloudflare components:

- **Pages**
  - frontend hosting
- **Workers**
  - API routing
  - login / signup / JWT issuing
  - refresh token rotation
  - uploads
  - image analysis kickoff
- **Durable Objects**
  - `UserDesktop`: authoritative per-user desktop state
  - `DesktopChatAgent`: persistent agent conversation + follow-up context
- **KV**
  - auth/session lookup
  - username -> uid lookup
  - public desktop snapshot caching
- **R2**
  - uploaded user files and assets
- **Workers AI**
  - grounded chat responses
  - image caption/tag/text extraction

## Product Features

### Desktop System

- draggable desktop icons and folders
- resizable windows
- folder browsing
- file viewers for images, text, audio, video, PDFs, and links
- public/visitor mode for shared desktops

### Appearance Customization

- direct appearance controls for colors, borders, and window chrome
- wallpaper customization
- per-user custom CSS editor
- CSS asset support
- live preview and saved versions for custom CSS

### Image Organization

- automatic image metadata enrichment
- user-editable tags
- searchable captions, OCR text, and colors
- search UI with previews

### AI Features

- grounded desktop/image chat via Ask Eternal
- stateful agent memory per user
- structured search over desktop items
- approval-based folder creation from current matches

## AI Design

The AI portion is intentionally narrow and grounded.

### 1. Ask Eternal

`Ask Eternal` is a stateful chat agent built with Cloudflare Agents and `AIChatAgent`.

It uses structured server tools instead of free-text action parsing:

- `getDesktopOverview`
- `searchDesktop`
- `createFolderFromMatches`

Mutation tools use approval before execution.

### 2. Image Metadata Enrichment

When an image is uploaded:

- upload completes immediately
- analysis runs asynchronously in the worker
- metadata is attached back to the desktop item

Stored metadata includes:

- caption
- tags
- detected text
- dominant colors
- analysis status
- model info

### 3. Search

Search uses both deterministic and AI-generated metadata.

It supports:

- synonym-aware matching
- OCR text search
- tag search
- color search
- image previews in results

### 4. Custom CSS

Customization is not limited to preset themes. Users can directly style their own desktop.

That layer includes:

- stored `customCSS` per user
- CSS asset storage
- CSS history / revert support
- appearance controls that complement, rather than replace, direct CSS editing

This is important to the project because it turns the desktop into something users can actually shape, not just populate.

## Tech Stack

### Frontend

- React 19
- TypeScript
- Vite
- Zustand

### Backend

- Cloudflare Workers
- Durable Objects
- KV
- R2
- Workers AI
- Cloudflare Agents / `@cloudflare/ai-chat`
- JWT auth and refresh flow on the Worker

## Repo Layout

```text
packages/
  frontend/
    src/
      components/
      hooks/
      pages/
      services/
      stores/
      types/
  worker/
    src/
      agents/
      durable-objects/
      middleware/
      routes/
      utils/
```

## Local Development

From repo root:

```bash
npm install
```

Start frontend:

```bash
npm run dev --workspace=@eternalos/frontend
```

Start worker:

```bash
npm run dev --workspace=@eternalos/worker
```

Important local env in [packages/worker/.dev.vars](packages/worker/.dev.vars):

```env
JWT_SECRET=dev-secret-change-in-production-abc123xyz
IMAGE_ANALYSIS_MODEL=@cf/meta/llama-3.2-11b-vision-instruct
AGENT_CHAT_MODEL=@cf/zai-org/glm-4.7-flash
```

Important frontend env in [packages/frontend/.env.local](packages/frontend/.env.local):

```env
VITE_API_URL=https://eternalos-api.wubny31.workers.dev
```

Then open:

- frontend: [http://localhost:5173](http://localhost:5173)
- worker: [http://localhost:8787/api/health](http://localhost:8787/api/health)

## Build / Checks

```bash
npm run typecheck --workspace=@eternalos/frontend
npm run typecheck --workspace=@eternalos/worker
npm run lint --workspace=@eternalos/frontend
npm run build --workspace=@eternalos/frontend
```

## Deployment

### Worker

```bash
cd packages/worker
npm run deploy
```

### Frontend

From repo root:

```bash
npm run build --workspace=@eternalos/frontend
npx wrangler pages deploy packages/frontend/dist --project-name=eternal
```

Or from [packages/frontend](packages/frontend):

```bash
npm run build
npx wrangler pages deploy dist --project-name=eternal
```

## Demo Prompts

Good prompts for reviewing the AI portion:

- `What is on my desktop right now?`
- `How many anime images are there?`
- `Find images related to roads`
- `Which recent images contain text?`
- `Create a folder from those matches called Anime`

## Why This Is A Good Cloudflare Project

This is not just a chat wrapper. The project demonstrates:

- **Durable Object data modeling**
  - canonical user desktop state
  - separate persistent agent state
- **Cloudflare-native auth and storage**
  - Worker-issued auth
  - KV-backed session and username indexing
  - R2-backed file storage
- **Workers AI used in product context**
  - grounded retrieval over real app data
  - image metadata enrichment for search and organization
- **Real-time / edge architecture**
  - visitor sync
  - public snapshot caching
- **A concrete user product**
  - desktop UI
  - uploads
  - search
  - AI chat
  - public sharing

## Notes

- The AI is intentionally grounded to desktop/file/image workflows rather than open-ended general chat.
- Dominant colors are extracted deterministically in the worker instead of being guessed by the model.
- The chat agent uses structured tools and approval for mutations instead of free-text action parsing.
