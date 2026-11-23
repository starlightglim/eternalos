/**
 * EternalOS Cloudflare Worker Entry Point
 *
 * Exports the Durable Object classes and runs the scheduled maintenance
 * handler. Every /api/* request is dispatched through the policy-driven route
 * table in routes/routeTable.ts — see routes/router.ts for the dispatcher
 * that applies each route's auth / rate-limit / error policy.
 */

import { UserDesktop } from './durable-objects/UserDesktop';
import { RateLimiter } from './durable-objects/RateLimiter';
import { AuthCoordinator } from './durable-objects/AuthCoordinator';
import { BazaarCoordinator } from './durable-objects/BazaarCoordinator';
import { OrchestratorAgent } from './agents/OrchestratorAgent';
import { AppOutbound, EternalService } from './services/EternalService';
import { AppLogTail, AppRunner } from './durable-objects/AppRunner';
import { handleRequest } from './routes/routeTable';
import { listDuePendingDeletions, purgeAccount } from './utils/accountPurge';

export interface Env {
  // KV Namespaces
  AUTH_KV: KVNamespace;
  DESKTOP_KV: KVNamespace;

  // R2 Bucket
  ETERNALOS_FILES: R2Bucket;

  // Durable Objects
  USER_DESKTOP: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;
  AUTH_COORDINATOR: DurableObjectNamespace;
  BAZAAR_COORDINATOR: DurableObjectNamespace;
  OrchestratorAgent: DurableObjectNamespace<OrchestratorAgent>;
  APP_RUNNER: DurableObjectNamespace<AppRunner>;

  // Dynamic Workers (sandboxed app runtime)
  LOADER: WorkerLoader;

  // Anthropic API (optional — enables Claude as primary model)
  ANTHROPIC_API_KEY?: string;

  // Workers AI
  AI: Ai;

  // Secrets
  JWT_SECRET: string;
  RESEND_API_KEY?: string; // Fallback email provider when SEND_EMAIL binding isn't configured
  IMAGE_ANALYSIS_MODEL?: string; // Optional Workers AI model override for image metadata enrichment
  AGENT_CHAT_MODEL?: string; // Optional Workers AI model override for chat agent
  APP_BUILDER_MODEL?: string; // Optional Workers AI model override for structured app generation

  // Per-account AI usage limit overrides (see middleware/aiUsage.ts for the
  // defaults; the integration suite sets AI_REQUESTS_PER_DAY low to test
  // budget exhaustion quickly). Values must be positive integers.
  AI_REQUESTS_PER_DAY?: string;
  AI_TOKENS_PER_DAY?: string;
  AI_CONCURRENT_TURNS?: string;
  AI_TURN_LEASE_MS?: string;

  // Cloudflare Email Service binding (preferred over Resend when configured).
  // Set up via wrangler.toml: send_email = [{ name = "SEND_EMAIL" }]
  // Sending domain must be verified in CF dashboard (Email Routing → Outbound).
  SEND_EMAIL?: { send(message: unknown): Promise<void> };

  // Google OAuth (optional — enable by setting both)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string; // Set via `wrangler secret put GOOGLE_CLIENT_SECRET`

  // Cloudflare Turnstile (optional — invisible CAPTCHA on signup/login/forgot-password)
  // Set via: wrangler secret put TURNSTILE_SECRET
  // Frontend reads site key from VITE_TURNSTILE_SITE_KEY env var.
  // When unset, verifyTurnstile() returns true (dev mode).
  TURNSTILE_SECRET?: string;

  // Environment settings
  ENVIRONMENT?: 'development' | 'production';
  // Account hard-deletion grace period in days (default 14). Integration tests
  // set this to "0" so a soft-deleted account is immediately due for purge.
  ACCOUNT_DELETION_GRACE_DAYS?: string;
  ALLOWED_ORIGINS?: string; // Comma-separated list of allowed origins for production
  FROM_EMAIL?: string; // Sender email address (e.g., "EternalOS <noreply@eternalos.app>")
  APP_URL?: string; // Base URL for the app (e.g., "https://eternalos.app")
}

export { UserDesktop, RateLimiter, AuthCoordinator, BazaarCoordinator, OrchestratorAgent, EternalService, AppRunner, AppOutbound, AppLogTail };

export default {
  /**
   * Scheduled handler - runs daily to clean up old trashed items
   * Cron: 0 3 * * * (3:00 AM UTC daily)
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled trash cleanup...');

    // Enumerate all users via per-user index keys (avoids race condition of a single JSON array).
    // KV.list() returns keys in pages of up to 1000.
    const userUids: string[] = [];
    let cursor: string | undefined;
    do {
      const listResult = await env.AUTH_KV.list({ prefix: 'user_index:', cursor });
      for (const key of listResult.keys) {
        // key.name is "user_index:{uid}" — extract uid
        userUids.push(key.name.slice('user_index:'.length));
      }
      cursor = listResult.list_complete ? undefined : (listResult.cursor ?? undefined);
    } while (cursor);

    if (userUids.length === 0) {
      console.log('No users found, skipping cleanup');
      return;
    }

    console.log(`Processing ${userUids.length} users for trash cleanup`);

    let totalDeleted = 0;
    let totalR2Deleted = 0;

    // Workers have a 1000 subrequest limit. Each user needs 1 DO fetch + N R2 deletes.
    // Process in batches to stay within limits and avoid timeout.
    const BATCH_SIZE = 50; // Conservative: leaves room for R2 deletes per batch

    for (let i = 0; i < userUids.length; i += BATCH_SIZE) {
      const batch = userUids.slice(i, i + BATCH_SIZE);

      // Process batch concurrently
      const results = await Promise.allSettled(
        batch.map(async (uid) => {
          const doId = env.USER_DESKTOP.idFromName(uid);
          const stub = env.USER_DESKTOP.get(doId);
          const response = await stub.fetch(new Request('http://internal/trash/cleanup', {
            method: 'POST',
          }));

          const result = await response.json() as { deleted: number; r2Keys: string[] };

          if (result.deleted > 0) {
            console.log(`User ${uid}: deleted ${result.deleted} old trash items`);

            // Clean up R2 files
            if (result.r2Keys.length > 0) {
              await Promise.all(result.r2Keys.map((key) => env.ETERNALOS_FILES.delete(key)));
            }
          }

          return result;
        })
      );

      // Tally results
      for (const result of results) {
        if (result.status === 'fulfilled') {
          totalDeleted += result.value.deleted;
          totalR2Deleted += result.value.r2Keys.length;
        } else {
          console.error('Batch cleanup error:', result.reason);
        }
      }
    }

    console.log(`Scheduled cleanup complete: ${totalDeleted} items deleted, ${totalR2Deleted} R2 files cleaned up`);

    // --- Account hard-deletion purge ---
    // Enumerate the small `pending-deletion:` index (not every user) for
    // accounts past their 14-day grace deadline and purge each. The purge is
    // idempotent and resumable: a failure mid-run leaves the account still
    // indexed, and the next invocation re-purges it cleanly.
    try {
      const due = await listDuePendingDeletions(env, Date.now());
      if (due.length > 0) {
        console.log(`Purging ${due.length} account(s) past the deletion deadline`);
        for (const pending of due) {
          try {
            const result = await purgeAccount(env, pending);
            console.log(
              `Purged account ${pending.uid}: ${result.r2Deleted} R2 objects, ${result.kvDeleted} KV keys, ${result.packsDeleted} packs`
            );
          } catch (error) {
            // Leave the pending-deletion marker in place so the next run retries.
            console.error(`Account purge failed for ${pending.uid}; will retry next run:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Account purge enumeration failed:', error);
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
