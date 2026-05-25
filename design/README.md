# EternalOS design docs

Companion specifications for the EternalOS improvement roadmap. Each numbered doc is a standalone deep-dive on one surface area. The roadmap ties them together with priorities and sequencing.

## Read in this order

1. **[ROADMAP.md](ROADMAP.md)** — prioritized 50-item plan, research integrated (Cloudflare platform + social architecture), dependency graph, phased rollout. Start here.
2. **[01-apps-interop.md](01-apps-interop.md)** — user apps × files × apps. Manifest v2, capability tokens, `window.eternal` bridge, IPC, mime handlers, virtual folders, network allowlist.
3. **[12-orchestrator-v2.md](12-orchestrator-v2.md)** — general app-builder architecture. Dynamic Workers runtime, app-generation pipeline, desktop-aware bridge, permission inference, validation and repair loop.
4. **[13-source-first-app-workspaces.md](13-source-first-app-workspaces.md)** — editable app source trees, workspace profiles, editor/preview/install flow, and how the agent should patch code without degrading it.
5. **[02-social-v1.md](02-social-v1.md)** — D1 schema for follows / posts / forums / comments / reports / bazaar, fanout-on-read feed, Inbox DO with WS hibernation, Workers AI moderation, Vectorize search, RSS / JSON Feed.
6. **[03-mobile.md](03-mobile.md)** — PWA scaffold, grid home screen, gestures, sheet-based UI, tablet layout, full customization parity on phones.
7. **[04-skin-format.md](04-skin-format.md)** — `.estheme` zip bundle spec, manifest v1, export / import / fork / extend, bazaar integration, safety rules.
8. **[05-mcp-server.md](05-mcp-server.md)** — every user's desktop as an OAuth-scoped MCP server. Tool schemas, consent UI, scope model, preferences → connections.
9. **[06-moderation-trust.md](06-moderation-trust.md)** — Workers AI classification pipeline (llama-guard + vision), trust score, reports, admin app, bans, appeals, CSAM + DMCA legal posture.
10. **[07-observability-ops.md](07-observability-ops.md)** — Sentry wiring, Analytics Engine, Logpush, staging env, CI/CD with manual prod gate, incident runbook, cost alerts, status page.
11. **[08-onboarding.md](08-onboarding.md)** — demo mode, progressive signup, goal-based wizard, example desktops, empty-feed bootstrap, command palette, inline help, ricer vs beginner paths.
12. **[09-d1-migration.md](09-d1-migration.md)** — zero-downtime KV → D1 migration plan for bazaar indexes. Phased dual-write, backfill, cutover, rollback. Unblocks social v1.
13. **[14-hyperevm-assets.md](14-hyperevm-assets.md)** — optional HyperEVM wallet linking and asset provenance model. Keeps NFTs as verification/ownership metadata, not storage or mandatory login.
13. **[10-privacy-tos.md](10-privacy-tos.md)** — legal posture, data we collect / don't, retention, sub-processors, draft privacy policy + ToS + AUP + DMCA, signup consent, age gating, breach response.

## Format

Each doc follows the same shape:

- **Goals / non-goals** up top.
- **Current state** — what exists, what's broken, with file path citations.
- **Architecture** — diagrams + code sketches where useful.
- **Data model / API surface** — concrete.
- **Security model** — threat analysis, mitigation.
- **Migration / adoption plan** — phased by week.
- **Open questions** — product calls deliberately left to the owner.
- **Success metrics** — what "working" looks like in production.

## Status

As of 2026-04-22, implementation has landed a subset of the items in the roadmap:

- Config hygiene, model bumps, CORS fix, `temp-app/` removed, stale audit doc obsoleted (ticks 1–4).
- Privacy: `isPublic` default flipped to `false`, visitor filter tightened to require explicit `true` (tick 2).
- Rate limits on public asset paths + WebSocket endpoint (tick 3).
- CI workflow on PR + push (tick 4).
- `.estheme` manifest validator (worker-side) + mirrored frontend schema + builder + parser (ticks 5–6).
- "Export current theme" helper with canvas-generated placeholder preview (tick 7).
- Account delete (14-day soft-delete) + cancel + GDPR JSON export (tick 8).
- PWA scaffold: manifest, service worker (stale-while-revalidate shell, cache-first R2 assets), registration helper, iOS meta (tick 9).
- `.estheme` publish endpoint + embedded manifest on `GET /api/bazaar/pack/:id` (tick 10).
- Recovery codes at signup + use-recovery-code + regenerate endpoints (tick 11).
- Client-side `installTheme` + `previewTheme` (tick 12).
- Turnstile React widget + script loader + `TURNSTILE_ENABLED` flag (tick 13).

The docs were refreshed on 2026-04-20 to account for:

- Current repo state where some originally proposed hardening items are already implemented.
- Dynamic Workers as the default app runtime.
- AI Search namespace-based design replacing the older AutoRAG-on-R2 mental model.
- Modern Agents SDK / MCP transport guidance.
- First-party Cloudflare observability becoming the default worker ops story.

The docs were extended on 2026-04-22 to add a source-first workspace model for
editable agent-built apps in [13-source-first-app-workspaces.md](13-source-first-app-workspaces.md).

Everything in `design/` is blueprint material; actual shipping work is tracked by ticks and by TodoWrite during active /loop runs.

## Conventions

- File paths use relative links so they resolve in GitHub / VS Code / the eternalos in-browser editor.
- Line-number references (`file.ts:123`) link to exact lines at the time of writing. They rot — treat as starting points, not gospel.
- Product calls left for the owner are marked "**Open question**". Don't infer answers from the doc's silence.
- Changes to a design doc should bump the "Last updated" line (when I add one) and describe the change in the PR.

## Who this is for

- The codebase owner (primary audience) — for sequencing work, explaining decisions to future collaborators, and sanity-checking AI assistant output against the plan.
- Future AI assistants (secondary audience) — for orienting before a session and avoiding re-discovering decisions already made.
- New contributors (tertiary audience) — for onboarding without a meeting.
