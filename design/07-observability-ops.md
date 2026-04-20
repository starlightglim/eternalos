# 07 — Observability and ops

> How we know the system is working, and how we fix it when it isn't. Monitoring, alerting, staging, CI/CD, incident response, cost guardrails.
> Parent: [ROADMAP.md](ROADMAP.md) (items 14, 15, 16, 115–118).

## Goals

1. Every production error is captured, searchable, and attributable to a user / request.
2. Latency regressions show up in a dashboard before users complain.
3. Cost spikes (Workers AI, R2 egress, DO duration) alert within an hour.
4. A staging environment that mirrors prod and is deployed to on every PR merge.
5. A CI pipeline that blocks merges with broken typecheck / lint / tests / build.
6. A simple runbook for the top 5 failure modes.
7. A solo-dev can absorb a Saturday incident without heroics.

## Non-goals (v1)

- PagerDuty + on-call rotation. It's a one-person team; a phone alert is enough.
- Distributed tracing (Jaeger, OpenTelemetry). Nice-to-have, not worth the setup cost at beta scale.
- Load testing beyond ad-hoc. k6 scripts live in the repo; no automated perf gates.
- Canary deploys / feature flags per-% rollout. Deferred; beta scale doesn't need it.

## The stack

| Concern | Tool | Why |
|---|---|---|
| Frontend errors | Sentry (free tier: 5k errors/mo) | Source maps, user replay optional, react error boundary integration |
| Worker errors | **Workers Logs / Traces first**, Sentry supplemental | First-party request/binding visibility plus exception aggregation where useful |
| Metrics / counters | Cloudflare Analytics Engine (free, 10M events/day) | Native to CF, no network hop |
| Request logs | Cloudflare Logpush → R2 bucket | Cheap, searchable later if needed |
| Uptime | UptimeRobot (free for 50 monitors / 5-min interval) | External; catches full-region CF outages |
| Dashboards | Internal EternalOS desktop item ("Mission Control" widget) | Dogfood our own product |
| Cost alerts | Cloudflare billing alerts (at 50/80/95% of budget) | First line of defense against runaway usage |
| Status page | Static page at `/status.html` + automated update via Upstash or a cron Worker | Users see what's going on during incidents |

No Datadog, no New Relic. The CF-native stack does 80% for 0% extra cost.

**Priority update.** Treat Cloudflare's first-party observability stack as the baseline for Workers. Sentry is still valuable, but it should not be the only place we look for worker failures, latency regressions, or binding-level issues.

## Frontend error monitoring

Install `@sentry/react` + `@sentry/vite-plugin`. Wire in `main.tsx`:

```typescript
import * as Sentry from '@sentry/react';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_COMMIT_SHA ?? 'dev',
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: import.meta.env.PROD ? 0.1 : 1.0,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,  // Only on error — cheap
  });
}

// User context once logged in
// inside authStore.setUser()
Sentry.setUser({ id: user.uid, username: user.username });
```

Wrap error boundary:

```typescript
<Sentry.ErrorBoundary fallback={<ErrorFallback />}>
  <App />
</Sentry.ErrorBoundary>
```

Scrub PII in `beforeSend`:

```typescript
beforeSend(event) {
  // Drop file contents, textarea values, etc.
  if (event.request?.data) delete event.request.data;
  if (event.extra?.fileContent) delete event.extra.fileContent;
  return event;
}
```

## Worker error monitoring

Primary path: Workers Logs, Traces, and dashboard query tools. Sentry stays as a supplemental exception sink for cross-surface aggregation and alerting.

Sentry Workers SDK can still wrap the `fetch` handler:

```typescript
import { Toucan } from 'toucan-js'; // Sentry for Workers

export default {
  async fetch(request, env, ctx) {
    const sentry = new Toucan({
      dsn: env.SENTRY_DSN,
      context: ctx,
      request,
      environment: env.ENVIRONMENT,
    });

    try {
      return await actualFetchHandler(request, env, ctx, sentry);
    } catch (error) {
      sentry.captureException(error);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  },
};
```

Add structured fields before throwing:

```typescript
sentry.setUser({ id: auth.uid });
sentry.setTag('route', '/api/bazaar/publish');
sentry.setExtra('packId', packId);
```

Budget: free Sentry tier gives 5k events / month. Alert thresholds → aim for < 100 new errors/day after beta stabilizes.

Cloudflare-native baseline:

- Enable Workers Logs and Query Builder for request/error inspection.
- Turn on traces for latency debugging on critical routes.
- Make sure AI/model identifiers, route ids, and request ids are included in worker-side logs.
- Export logs when needed, but debug in Cloudflare first.

## Metrics (Analytics Engine)

Cloudflare Analytics Engine is a wide-column time-series store billed per event. Perfect for app-level counters.

Emit events from the worker:

```typescript
// in index.ts
env.METRICS.writeDataPoint({
  blobs: [route, method],       // searchable dimensions
  doubles: [Date.now() - startMs, status],
  indexes: [auth?.uid ?? 'anonymous'],
});
```

Dimensions we care about:

- Route path + method → request counts + p50/p99 latency
- HTTP status → error rate
- UID → who is hitting what
- Model name (for Workers AI calls) → cost attribution
- Pack type (for bazaar ops)

Read via Workers Analytics Engine API for dashboards (SQL-ish query language).

## Logs (Logpush)

Enable Logpush on the `eternalos-api` worker → destination R2 bucket `eternalos-logs/`. Fields:

- `Outcome, ScriptName, Script, EventTimestamp, RequestHeaders.CF-Ray, ...`

Don't ship to a hosted log product (expensive at scale). For debugging, `wrangler tail` is live, Workers Logs covers the common path, and R2 parquet files remain the long-retention layer.

## Dashboards — "Mission Control"

An internal-only EternalOS desktop item (`type: 'admin-app'`, hidden unless mod/owner) that shows:

- **Traffic** — requests/min over last 24h, error rate, p50/p99.
- **Active users** — DAU, WAU, signups today, deletions today.
- **Content** — new posts today, new packs, new guestbook entries.
- **Moderation** — queue depth, median time to decision, holds triggered.
- **Cost** — estimated $/day across CF services, pulled from the billing API.
- **Alerts** — current firing alerts with acknowledgment buttons.

Implementation: a React component backed by a `/api/mod/mission-control` endpoint that does parallel Analytics Engine queries + CF billing API calls.

## Cost alerts

CF billing has built-in alerts at budget thresholds (50/80/95/100%). Set a monthly budget per service:

- Workers: $20/mo
- Workers AI: $50/mo (beta; will need tuning)
- R2: $10/mo
- KV: $5/mo
- Durable Objects: $10/mo

Alerts go to yassinelsarraf@gmail.com (user's email). Expect to tune these as beta grows.

Additional app-level alert: if Workers AI call count per hour exceeds $threshold$ (e.g., 10× normal), post to a Slack/Discord webhook. Cheap to implement: count via Analytics Engine + cron worker comparing to historical moving average.

## Staging environment

Everything prod has, but separate resources:

- **Worker**: `eternalos-api-staging`
- **Pages project**: `eternalos-staging` (maps to `staging.eternalos.app` via custom domain)
- **KV namespaces**: `AUTH_KV_STAGING`, `DESKTOP_KV_STAGING` (fresh IDs)
- **R2 bucket**: `eternalos-files-staging`
- **D1 database**: `eternalos-social-staging` (when D1 lands)

wrangler.toml supports environments:

```toml
[env.staging]
name = "eternalos-api-staging"

[[env.staging.kv_namespaces]]
binding = "AUTH_KV"
id = "<staging-id>"

# ... etc.
```

Deploy commands:

```bash
# staging
wrangler deploy --env staging
npm run build --workspace=@eternalos/frontend && \
  npx wrangler pages deploy dist --project-name=eternalos-staging

# production
wrangler deploy   # default env = production
npm run build --workspace=@eternalos/frontend && \
  npx wrangler pages deploy dist --project-name=eternal
```

Staging frontend env: `VITE_API_URL=https://eternalos-api-staging.wubny31.workers.dev`, `VITE_SENTRY_DSN=<staging dsn>`.

## CI/CD

Already shipped a basic CI workflow in tick 4. Extend:

```yaml
# .github/workflows/ci.yml — already exists. Extend with:

  deploy-staging:
    name: Deploy to staging
    needs: [typecheck, lint, test, build]
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci
      - run: npx wrangler deploy --env staging --workspace=@eternalos/worker
        env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN_STAGING }} }
      - run: npm run build --workspace=@eternalos/frontend
      - run: npx wrangler pages deploy packages/frontend/dist --project-name=eternalos-staging
        env: { CLOUDFLARE_API_TOKEN: ${{ secrets.CF_API_TOKEN_STAGING }} }

  deploy-production:
    name: Deploy to production (manual approval)
    needs: [deploy-staging]
    if: github.ref == 'refs/heads/main' && startsWith(github.event.head_commit.message, 'release:')
    runs-on: ubuntu-latest
    environment: production         # GitHub approval gate lives here
    steps:
      - uses: actions/checkout@v4
      # ... same as staging but without --env flag
```

Production deploy triggered by commits prefixed `release:`. GitHub Environments feature gates deploy on a manual approval click.

## Release process

1. Work on main (or a feature branch).
2. Open PR → CI runs typecheck + lint + test + build.
3. Review + merge to main.
4. Staging auto-deploys.
5. Manually test staging at `staging.eternalos.app`.
6. Cut a release: `git commit --allow-empty -m "release: 0.3.0 — mobile grid + estheme install"` → push.
7. Production deploy gate fires; user clicks approve in GitHub UI.
8. Post-deploy: watch Sentry and Mission Control for 10 min for error spikes.

No nightly deploys. No "automatic deploy to prod on green CI." Deploy when we decide.

## Incident response runbook

Top failure modes and their one-page responses:

### 1. Worker returning 500s

**Symptoms**: Sentry spike, error rate > 5% in dashboard.

**First moves**:
1. `wrangler tail eternalos-api --status error` (live stream).
2. Look at the deployed version: `wrangler deployments list`. If it's a recent deploy, consider rollback: `wrangler rollback <previous_deploy_id>`.
3. Check KV / R2 dashboards for degraded state (CF status page).

**If no obvious cause**: roll back anyway. Debug from a known-good state.

### 2. KV outage or limit hit

**Symptoms**: Most requests fail, not just one route.

**First moves**:
1. Check [cloudflarestatus.com](https://www.cloudflarestatus.com/) — wait out if partial.
2. Check `wrangler kv:namespace` list for storage limits (free tier: 1GB).
3. If limits: enable KV paid, or prune old data.

**Known risk**: `bazaar:type:*` indexes are JSON blobs; they can grow large. Migrate to D1 (tracked in ROADMAP) before beta scale.

### 3. Cross-user data leak detected

**Symptoms**: A user reports seeing another user's content, or an alert fires from automated testing.

**First moves**:
1. Take application-level action: flip `MAINTENANCE_MODE=true` secret → middleware returns "under maintenance" to everyone. Buys time.
2. Check git log for recent auth-related commits.
3. Audit the suspected code path (handleServeFile, handleVisit, DO item filters).
4. Restore after fix; write postmortem.

### 4. Workers AI quota exceeded

**Symptoms**: Image analysis + chat return errors. Users see "AI unavailable".

**First moves**:
1. Check CF dashboard → Workers AI usage.
2. Turn off image analysis (graceful degradation): set `IMAGE_ANALYSIS_MODEL=disabled` (handler checks and skips).
3. If chat is degraded: fallback to Claude via `ANTHROPIC_API_KEY` (handler already supports this).
4. File CF support if this is an account-level issue.

### 5. Traffic spike

**Symptoms**: Normal users but 10× traffic.

**First moves**:
1. Check origin: CF Firewall dashboard → top countries / user-agents / IPs.
2. If bot traffic: enable Bot Fight Mode (CF setting, no code change).
3. If legit traffic (e.g., a tweet went viral): verify DO free-tier limits are holding, adjust rate limits up temporarily.
4. If R2 egress is high: verify the `/api/files/` rate limit is doing its job.

## Status page

Static HTML at `/status.html`. A cron Worker runs every 5 min:

1. Ping `/api/health`.
2. Ping a sample user's DO via `GET /api/visit/alice`.
3. Ping Workers AI via a micro-call.
4. Write results to `status:current` KV key.

Static page reads this KV on load and renders green/yellow/red dots per service. Append to a ring buffer in KV for last-24h history.

If the Worker itself is down, `/status.html` won't load. For that, use a dedicated UptimeRobot monitor with a public status URL.

## Privacy and retention

- Sentry events: strip PII (no body contents, no file contents, no email addresses in extras).
- Analytics Engine: only stores uids we've indexed — fine. Can be correlated with users, but that's the whole point of the tool.
- Logs: Retain in R2 for 30 days, then rotate (cron Worker deletes older prefixes).
- User's mod history: retained indefinitely while account exists. Deleted on account hard-delete (14-day post-soft-delete).

## Implementation phases

**Phase A (2 days).** Sentry SDK wired to frontend + worker. Error context (uid, route, request id). Test with a synthetic error.

**Phase B (2 days).** Analytics Engine binding + write-points at key routes. Skeleton Mission Control window.

**Phase C (3 days).** Staging environment stood up. CI auto-deploys main → staging. Prod deploy gated by GitHub Environment approval.

**Phase D (3 days).** Logpush to R2. Mission Control queries Analytics Engine. Status page + cron checker.

**Phase E (ongoing).** Cost alerts tuning. Runbook expansion. Incident postmortems.

Total ~10 days for a solid baseline.

## Open questions

- **Is Sentry free tier enough?** Likely, for a single-digit error/day baseline at beta scale. If we blow past 5k/mo it means something else is broken.
- **Do we self-host Sentry?** No. The hours of ops work outweigh the $26/mo paid plan.
- **Datadog later?** Maybe. Not before 10k DAU.
- **Should "Mission Control" be public-read-only with anonymized metrics?** Tempting transparency move (like status.are.na). Would need careful PII scrubbing. Defer decision.
- **PagerDuty-like escalation when two people are involved.** Not now. When there are two engineers, one is primary on-call per week; secondary gets SMS only after 15 min no-ack.
- **Backup strategy.** KV has no built-in point-in-time restore. A cron Worker dumps critical KV prefixes to R2 nightly (users, sessions, bazaar). R2 has versioning if enabled. This is the DR plan.

## Success metrics

- Mean time to detection (MTTD) for production errors: < 15 min.
- Mean time to resolution (MTTR) for production errors: < 1 hour for P1, < 24h for P2.
- Error budget: < 0.5% of requests return 5xx over 30 days.
- Deploy frequency: ≥ 1 prod deploy/week during active development.
- Time from PR merge to staging: < 5 min.
- Time from release-tag to prod: < 15 min (most time is human approval).
