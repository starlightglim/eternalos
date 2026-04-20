# 05 — UserDesktop as an MCP server

> Expose every user's desktop as a remote, OAuth-scoped Model Context Protocol (MCP) server. Claude Desktop, Cursor, Codex, and the user's own agents can query and act on their desktop as a first-class data source.
> Parent: [ROADMAP.md](ROADMAP.md). Related: [02-social-v1.md](02-social-v1.md) (tools overlap), [01-apps-interop.md](01-apps-interop.md) (permission model patterns).

## Goals

1. A user can connect Claude Desktop (or any MCP client) to `https://eternalos.app/.well-known/mcp/@{username}` and authorize specific scopes.
2. The agent can read the desktop, search it, add items, post to the feed, install packs, and call `Ask Eternal` — each gated by scope.
3. Tokens are long-lived (30-day rolling) but revocable from Preferences → Connections.
4. The server runs entirely on Cloudflare Workers + the current `UserDesktop` DO — no new infra.
5. Zero trust: scope grants are explicit, per-tool checks are server-enforced, tokens can be individually revoked.

## Non-goals

- **Multi-user queries via MCP** (i.e., "search alice's desktop from bob's client"). If bob wants alice's public desktop, he uses the visitor view or the public feed API.
- **Streaming multi-step agent loops initiated server-side.** The server is a tool surface, not an agent orchestrator. Users agentify via their own client.
- **Scopes for bazaar publishing of other people's content.** Bazaar writes are self-only.
- **Service-account / bot tokens** (no human OAuth consent). Possibly a later phase.

## Why this matters

- It is the single biggest product wedge for the "personal desktop on the open web" positioning. Everyone else has an app; we have an API + agent.
- Ricer/dev audience overlap is high — they already use Cursor, Claude Desktop, and similar.
- It dogfoods: our own `OrchestratorAgent` can call MCP tools over the same interface, simplifying the agent code path.
- The Cloudflare Agents SDK now has an `McpAgent` primitive plus modern RPC transport, connection lifecycle helpers, and better observability. This is no longer "just expose an SSE route" plumbing.

## Architecture

```
┌───────────────────────────────┐
│ Client (Claude Desktop,       │
│ Cursor, Codex, user agent)    │
└────────────┬──────────────────┘
             │ (Streamable HTTP transport, OAuth-scoped)
             ▼
┌───────────────────────────────────────┐
│ eternalos.app                         │
│   /.well-known/mcp/@{username}        │  ← discovery (points at SSE endpoint)
│   /mcp/@{username}/sse                │  ← Streamable HTTP transport
│   /mcp-auth/authorize                 │  ← OAuth consent UI
│   /mcp-auth/token                     │  ← token exchange
│                                       │
│ workers-oauth-provider (issuer)       │
│                                       │
│ McpAgent (per-user DO)                │
│   ├─ getDesktop / getItem             │
│   ├─ searchDesktop                    │
│   ├─ createItem / updateItem          │
│   ├─ installPack / forkPack           │
│   ├─ readFeed / postToFeed            │
│   ├─ readInbox / markRead             │
│   └─ askAssistant                     │
└────────────┬──────────────────────────┘
             │
             ├─ same-Worker RPC transport for internal agents
             │
             ▼
      UserDesktop DO (state of record)
             │
             ▼
        KV / R2 / D1
```

Key piece: `McpAgent` (from the `agents` package) is instantiated per user, with the user's uid as the instance name — identical pattern to `OrchestratorAgent` today. External clients still speak streamable HTTP. Internal consumers should prefer the newer same-Worker RPC transport rather than simulating an outside client.

## Discovery — the MCP well-known endpoint

An MCP client configured with the URL `eternalos.app` should be able to bootstrap. Follow the proposed MCP well-known convention:

`GET /.well-known/mcp` (no username) returns:

```json
{
  "version": "1.0",
  "server_info": {
    "name": "EternalOS",
    "description": "Personal desktops as MCP servers — one per user.",
    "homepage": "https://eternalos.app"
  },
  "discovery": {
    "per_user": "https://eternalos.app/.well-known/mcp/@{username}"
  }
}
```

`GET /.well-known/mcp/@{username}` returns the specific user's MCP config:

```json
{
  "version": "1.0",
  "endpoint": "https://eternalos.app/mcp/@alice/sse",
  "transport": "streamable-http",
  "auth": {
    "type": "oauth2",
    "authorization_url": "https://eternalos.app/mcp-auth/authorize",
    "token_url": "https://eternalos.app/mcp-auth/token",
    "scopes_supported": [
      "profile:read",
      "desktop:read",
      "desktop:write",
      "feed:read",
      "feed:write",
      "bazaar:read",
      "bazaar:write",
      "inbox:read",
      "inbox:notify",
      "ai:invoke"
    ]
  },
  "server_info": {
    "display_name": "@alice's EternalOS",
    "username": "alice",
    "avatar_url": "https://eternalos.app/api/og/alice.png"
  }
}
```

This is metadata only — no auth required. Public.

## OAuth flow

Uses the **`workers-oauth-provider` OAuth server** (Cloudflare-maintained). The flow:

1. **Client initiates**: `GET /mcp-auth/authorize?response_type=code&client_id=<client>&redirect_uri=<client_redirect>&scope=<requested>&state=<client_state>&code_challenge=<pkce>&code_challenge_method=S256`
2. **User must be logged in** to eternalos.app. If not, redirect to `/login?returnTo=/mcp-auth/authorize?...`.
3. **Consent screen**: EternalOS UI page showing:
   - Which client is connecting (name, homepage).
   - Which scopes they're asking for — plain-English descriptions + a toggle per scope.
   - A "Remember this app" checkbox (creates a persistent grant).
   - **Deny** / **Approve** buttons.
4. **On approve**: OAuth server issues an authorization code with a short TTL (5 min), redirects to `redirect_uri?code=<code>&state=<state>`.
5. **Client exchanges**: `POST /mcp-auth/token` with `code` + PKCE verifier → receives `{ access_token, refresh_token, expires_in, scope }`.
6. **Tokens**:
   - Access token: JWT-style, 1 hour TTL, scoped. Contains uid + granted scopes.
   - Refresh token: opaque, 30 days, stored in KV. Rotatable.
7. **Revoke**: Preferences → Connections shows granted clients; user can revoke (deletes refresh token + adds access-token jti to a short-TTL denylist).

Storage:

- KV `oauth:client:{client_id}` — client metadata (name, redirect URIs).
- KV `oauth:grant:{uid}:{client_id}` — user's grant record (scopes, created_at, last_used_at).
- KV `oauth:refresh:{refresh_token}` — refresh token record (uid, client_id, scopes, exp).
- KV `oauth:denylist:{jti}` — revoked access-token jids with TTL matching token lifetime.

## Scopes

| Scope | Tools it gates |
|---|---|
| `profile:read` | `getProfile` (public fields + bio + links) |
| `desktop:read` | `getDesktop`, `getItem`, `searchDesktop` (private items) |
| `desktop:write` | `createItem`, `updateItem`, `deleteItem`, `moveItems`, `createFolder` |
| `feed:read` | `readFeed`, `getPost` |
| `feed:write` | `postToFeed`, `deletePost`, `react` |
| `bazaar:read` | `listMyPacks`, `getPack`, `searchBazaar` |
| `bazaar:write` | `publishPack`, `installPack`, `forkPack`, `deletePack` |
| `inbox:read` | `readInbox`, `getUnreadCount` |
| `inbox:notify` | `markAsRead`, `markAllRead` |
| `ai:invoke` | `askAssistant` (runs `OrchestratorAgent` on user's behalf) |

**Principle of least privilege.** A coding agent might only need `desktop:read` + `desktop:write`. A Claude Desktop chatbot might want `ai:invoke` + `desktop:read`. The consent screen surfaces exactly what each client asks for.

## Tool schemas (MCP shape)

Each tool follows the MCP tool convention: `{ name, description, inputSchema (JSON Schema) }`. Below is the v1 tool set — JSON Schema shown inline for conciseness.

### Desktop tools (`desktop:*`)

```typescript
{
  name: "getDesktop",
  description: "List all items on the user's desktop. Supports filtering.",
  inputSchema: {
    type: "object",
    properties: {
      parentId: { type: "string", description: "null = root; or folder id" },
      includeTrashed: { type: "boolean", default: false },
      limit: { type: "number", default: 100, maximum: 500 },
    }
  }
}

{
  name: "getItem",
  description: "Get a single item by id.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
}

{
  name: "searchDesktop",
  description: "Semantic + exact search over the user's desktop. Combines D1 FTS5 and Vectorize.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      kinds: { type: "array", items: { type: "string", enum: ["folder","image","text","video","audio","pdf","link","widget","app"] } },
      limit: { type: "number", default: 20, maximum: 100 },
    },
    required: ["query"]
  }
}

{
  name: "createItem",
  description: "Create a new item on the desktop. Folders, text notes, links, widgets supported. File uploads go through the upload REST endpoint.",
  inputSchema: {
    type: "object",
    properties: {
      type: { enum: ["folder","text","link","widget"] },
      name: { type: "string", maxLength: 255 },
      parentId: { type: ["string","null"] },
      isPublic: { type: "boolean", default: false },
      textContent: { type: "string", description: "for text type" },
      url: { type: "string", description: "for link type" },
      widgetType: { enum: ["sticky-note","guestbook","music-player","pixel-canvas","link-board"] },
    },
    required: ["type","name"]
  }
}

{
  name: "updateItem",
  description: "Update fields on an existing item.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      updates: {
        type: "object",
        properties: {
          name: { type: "string" },
          parentId: { type: ["string","null"] },
          isPublic: { type: "boolean" },
          position: { type: "object", properties: { x: { type:"number" }, y: { type:"number" } } },
          textContent: { type: "string" },
        }
      }
    },
    required: ["id","updates"]
  }
}

{
  name: "deleteItem",
  description: "Move an item to trash (soft delete). Use permanently=true to skip trash.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, permanently: { type: "boolean", default: false } },
    required: ["id"]
  }
}
```

### Feed tools (`feed:*`)

```typescript
{
  name: "readFeed",
  description: "Read the user's chronological feed of posts from people they follow.",
  inputSchema: {
    type: "object",
    properties: {
      cursor: { type: "string", description: "Opaque cursor from a previous response" },
      limit: { type: "number", default: 50, maximum: 100 },
    }
  }
}

{
  name: "postToFeed",
  description: "Create a new post.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { enum: ["text","photo","bazaar_publish","item_public","profile_rice"] },
      body: { type: "string", maxLength: 4000 },
      ref: { type: "object", properties: { kind: { type:"string" }, id: { type:"string" } } },
    },
    required: ["kind"]
  }
}
```

### Bazaar tools (`bazaar:*`)

```typescript
{ name: "searchBazaar", description: "Search community packs.", inputSchema: { /* query + type filter */ } }
{ name: "installPack", description: "Install a bazaar pack onto the user's own desktop.", inputSchema: { /* packId + optional preview=true */ } }
{ name: "forkPack", description: "Fork a bazaar pack into the user's own packs.", inputSchema: { /* packId + new name */ } }
```

### Inbox tools (`inbox:*`)

```typescript
{ name: "readInbox", description: "Read recent notification events." }
{ name: "markAsRead", description: "Mark one or more events as read." }
```

### AI tool (`ai:invoke`)

```typescript
{
  name: "askAssistant",
  description: "Ask the EternalOS assistant (Ask Eternal) a question, grounded in the user's desktop state.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string" },
      mode: { enum: ["search","enrich","chat"], default: "chat" }
    },
    required: ["prompt"]
  }
}
```

The `askAssistant` tool forwards to `OrchestratorAgent` — the same agent that powers the in-app `Ask Eternal` chat — so every client gets consistent behavior.

## Server implementation

Use `McpAgent` from the `agents` package + `workers-oauth-provider`:

```typescript
// packages/worker/src/agents/UserDesktopMcpAgent.ts (new)
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import type { Env } from '../index';

export class UserDesktopMcpAgent extends McpAgent<Env> {
  serverInfo = {
    name: 'EternalOS Desktop',
    version: '1.0.0',
  };

  async onStart() {
    // Tool registration — MCP-style with zod-validated inputs.
    this.tool('getDesktop', {
      inputSchema: z.object({
        parentId: z.string().nullable().optional(),
        includeTrashed: z.boolean().default(false),
        limit: z.number().max(500).default(100),
      }),
      handler: async (input) => {
        this.requireScope('desktop:read');
        const doId = this.env.USER_DESKTOP.idFromName(this.name);
        const stub = this.env.USER_DESKTOP.get(doId);
        const res = await stub.fetch(new Request('http://internal/items'));
        const data = await res.json();
        // Apply filters, shape response
        return { items: data.items.slice(0, input.limit) };
      },
    });

    // ... register all other tools
  }

  private requireScope(scope: string): void {
    if (!this.ctx.scopes?.includes(scope)) {
      throw new Error(`Missing scope: ${scope}`);
    }
  }
}
```

Routing in `index.ts`:

```typescript
// Discovery
if (path === '/.well-known/mcp' && request.method === 'GET') {
  return Response.json({ /* server info */ });
}
if (path.startsWith('/.well-known/mcp/@') && request.method === 'GET') {
  const username = path.slice('/.well-known/mcp/@'.length);
  return handleMcpDiscovery(env, username);
}

// Streamable HTTP transport for external clients
if (path.startsWith('/mcp/@') && path.endsWith('/sse')) {
  const username = path.slice('/mcp/@'.length, -'/sse'.length);
  const uid = await resolveUsername(env, username);
  if (!uid) return new Response('User not found', { status: 404 });

  // Verify OAuth Bearer token from Authorization header
  const authResult = await verifyOAuthToken(request, env);
  if (!authResult) return new Response('Unauthorized', { status: 401 });
  if (authResult.uid !== uid) return new Response('Token does not match user', { status: 403 });

  // Forward to the per-user McpAgent
  const stub = getAgentByName(env.USER_DESKTOP_MCP, uid);
  return stub.handleRequest(request, { scopes: authResult.scopes });
}

// OAuth endpoints — handled by workers-oauth-provider
if (path.startsWith('/mcp-auth/')) {
  return oauthProvider.handleRequest(request, env);
}
```

For **internal** consumers such as `OrchestratorAgent`, prefer the same-Worker transport added in the modern Agents SDK rather than routing through the external streamable HTTP path. That keeps authorization explicit while avoiding unnecessary HTTP-shaped hops inside the same deployment.

Runtime guidance:

- Use `waitForMcpConnections` for clients that need predictable startup behavior.
- Use `keepAlive()` for sessions that should not be re-established on every tiny burst of activity.
- Emit MCP diagnostics into the app's broader observability stack rather than treating MCP like a black box.

## Consent UI

A dedicated route `/mcp-auth/authorize` renders a React page (not a desktop window — it's the auth flow UI, always on top). The user sees:

```
┌─ Authorize "Claude Desktop" ─────────────────────┐
│ Claude Desktop wants to connect to your          │
│ EternalOS desktop.                                │
│                                                   │
│ It's asking for:                                  │
│   ☑ Read your desktop                             │
│   ☑ Create and edit items                         │
│   ☐ Read your feed                                │
│   ☐ Post to your feed                             │
│   ☑ Ask your assistant                            │
│                                                   │
│ You can turn individual permissions on/off, or    │
│ revoke access any time in Preferences → Connections.
│                                                   │
│ ☑ Remember this app (skip this screen next time)  │
│                                                   │
│ [ Deny ]                          [ Authorize ]   │
└───────────────────────────────────────────────────┘
```

If `Remember this app` is checked, a row is created in `oauth:grant:{uid}:{client_id}` with the approved scopes. Next time this client with the same (or subset of) scopes, the consent screen is auto-approved and the code is issued immediately.

## Client registration

For v1, **manual client registration only** — a human reviewer adds a client to KV before it can request tokens. This keeps scope creep under control.

- An "Apps that can connect to EternalOS" page in settings lists built-in clients (Claude Desktop, Cursor) that are pre-registered.
- For custom clients, docs direct users to email / file an issue to get a `client_id`.
- v2: public dynamic client registration (RFC 7591) with automatic rate limits.

## Security

**Token theft.** Access tokens are short-lived (1h). Refresh tokens are opaque random strings stored KV-side. Reuse detection on refresh (same as existing refresh-token family pattern in auth.ts).

**Scope confusion.** Each tool's `requireScope` check runs against the token's decoded scopes. The scope list is frozen at token issue time — a user revoking a scope mid-session requires a fresh grant.

**Cross-user.** The URL structure ties a token to one uid. Server-side, the request handler verifies `token.uid === requestedUid` before forwarding to the DO.

**MCP-level abuse.** MCP clients can call tools in rapid succession. Rate-limit per token (e.g., 100 tool calls per minute per access token).

**Consent UX attacks.** The consent page is a top-level route (not embeddable), same-origin cookie-based session. Nothing inside a user-controlled iframe can spoof it.

**Audit log.** Every tool call emits an entry in the user's audit log: `{ timestamp, clientId, tool, scopesUsed }`. Shown in Preferences → Connections → Activity.

## Preferences → Connections UI

A new tab in the existing Preferences window:

```
┌─ Connections ─────────────────────────────────────┐
│                                                   │
│  ◆ Claude Desktop                 [Revoke]        │
│    Connected 3 days ago                           │
│    Last used 2h ago                               │
│    Permissions:                                   │
│      • Read desktop                               │
│      • Create and edit items                      │
│      • Ask assistant                              │
│    [ View activity ]                              │
│                                                   │
│  ◆ Cursor                          [Revoke]        │
│    Connected last week                            │
│    Last used 15m ago                              │
│    Permissions:                                   │
│      • Read desktop                               │
│      • Create and edit items                      │
│                                                   │
│  ──────────────────────────────────────────────   │
│                                                   │
│  + Connect a new app                              │
│    Paste a URL or browse featured clients.        │
│                                                   │
└───────────────────────────────────────────────────┘
```

Revoke = DELETE `oauth:grant:{uid}:{client_id}` + invalidate any cached refresh token for this client + add their JTIs to the denylist.

Activity log tab shows every tool call with timestamp, tool name, input summary, success/error. Last 1000 calls, rolling.

## MCP for our own `OrchestratorAgent`

A nice follow-on: refactor `OrchestratorAgent` to call the MCP surface internally rather than the current direct `getUserDesktopStub()` pattern. With the newer Agents SDK this no longer has to mean "pretend to be an external HTTP client."

Trade-offs:

- **Pro**: one surface for everyone; consistent authorization; easier to test.
- **Con**: still some indirection and more scope/accounting code.

Recommendation: **yes**, after the external MCP surface is stable. Use internal RPC transport, not the public streamable HTTP route, for in-cluster consumers.

## Federation / interop

- MCP is a proposed standard with active tooling. By shipping MCP, EternalOS is automatically a citizen of any "federation of MCP servers" future.
- ActivityPub: out of scope per the social-v1 research. RSS / JSON Feed per profile complements MCP (MCP = machines, RSS = humans-via-agents).
- Future: when the agent ecosystem has a "discovery directory" (think DNS for MCP servers), EternalOS profiles should announce themselves.

## Migration / adoption plan

**Week 0 (research spike, 2 days).** Get `workers-oauth-provider` working end-to-end with a hello-world MCP server locally. Confirm Claude Desktop can connect.

**Phase A (1 week).** Discovery endpoint + OAuth server + `UserDesktopMcpAgent` with read-only scopes (`profile:read`, `desktop:read`, `feed:read`, `bazaar:read`, `inbox:read`). Preferences → Connections skeleton UI. Manual client allowlist.

**Phase B (1 week).** Write scopes (`desktop:write`, `feed:write`, `bazaar:write`, `inbox:notify`) + `ai:invoke`. Audit log.

**Phase C (0.5 weeks).** Public dynamic client registration (v2 of the auth spec). Rate limiting. Bot-token flow (if needed for integrations).

**Phase D (0.5 weeks).** Internal refactor: `OrchestratorAgent` calls itself via MCP.

Total ≈ 3 weeks calendar time.

## Success metrics

- Number of users with ≥ 1 active MCP connection.
- MCP tool calls per DAU.
- Median time between consent and first successful tool call (funnel health).
- Fraction of active MCP users who use the assistant (`ai:invoke`) — proxy for agent-first usage.
- Revocations / grants ratio (high = user distrust; low = healthy).

## Open questions

- **Is per-user OAuth too ceremonial for beta?** Alternative: PAT-style (user generates a token in settings, pastes into MCP client). Simpler UX, weaker security. Start with OAuth; offer PATs as a later escape hatch for power users with dev tools.
- **Should `ai:invoke` cost real money from the user's account?** The Workers AI calls have cost. For beta, free; at scale, per-user quota.
- **Should publicly-public desktops expose a read-only MCP endpoint with no auth at all?** Tempting — an agent could query `@alice` for her public items without consent. Privacy-wise OK since the data is already public via visitor mode, but feels surprising. Decision: no, require OAuth for MCP even for public reads. Use RSS/JSON Feed for no-auth public access.
- **Dogfooding: when should OrchestratorAgent use MCP internally?** Covered above; after phase C.
- **Renaming.** "UserDesktopMcpAgent" is awkward. "DesktopBridge"? "PersonalAgent"? Naming is cheap and can change.

## Appendix — hello world client-side snippet

```bash
# Claude Desktop's claude_desktop_config.json
{
  "mcpServers": {
    "eternalos-alice": {
      "transport": "streamable-http",
      "url": "https://eternalos.app/.well-known/mcp/@alice",
      "oauth": true
    }
  }
}
```

After first launch, Claude Desktop opens the consent flow in a browser window, user approves, returns, and tool calls just work.

```typescript
// user's own agent (via `ai` SDK with MCP support)
import { createMcpClient } from 'ai/mcp';

const client = await createMcpClient({
  transport: { url: 'https://eternalos.app/.well-known/mcp/@alice', type: 'streamable-http' },
  oauth: { clientId: 'my-custom-agent', scopes: ['desktop:read', 'ai:invoke'] },
});

const desktop = await client.callTool('getDesktop', { parentId: null });
const answer = await client.callTool('askAssistant', { prompt: 'What is on my desktop?' });
```
