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
import { runTrashCleanup, type TrashCleanupSummary } from './utils/trashCleanup';

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
  /** Ask Eternal: end a turn whose model produced no output for this long (ms). Default 90000. */
  AGENT_STALL_TIMEOUT_MS?: string;

  // Workers AI
  AI: Ai;

  // Secrets
  JWT_SECRET: string;
  RESEND_API_KEY?: string; // Fallback email provider when SEND_EMAIL binding isn't configured
  IMAGE_ANALYSIS_MODEL?: string; // Optional Workers AI model override for image metadata enrichment
  AGENT_CHAT_MODEL?: string; // Optional Workers AI model override for chat agent
  APP_BUILDER_MODEL?: string; // Optional Workers AI model override for structured app generation
  IMAGE_GEN_MODEL?: string; // Optional Workers AI text-to-image model for skin textures (default flux-1-schnell)

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
    const startedAt = Date.now();
    // One summary line per run; per-user detail stays out of the logs
    // (failures are still logged individually, without content).
    let trash: TrashCleanupSummary = { users: 0, itemsDeleted: 0, r2Deleted: 0, failures: 0 };
    try {
      trash = await runTrashCleanup(env);
    } catch (error) {
      console.error('Trash cleanup enumeration failed:', error);
    }

    // --- Account hard-deletion purge ---
    // Enumerate the small `pending-deletion:` index (not every user) for
    // accounts past their 14-day grace deadline and purge each. The purge is
    // idempotent and resumable: a failure mid-run leaves the account still
    // indexed, and the next invocation re-purges it cleanly.
    let accountsPurged = 0;
    let purgeFailures = 0;
    try {
      const due = await listDuePendingDeletions(env, Date.now());
      for (const pending of due) {
        try {
          await purgeAccount(env, pending);
          accountsPurged += 1;
        } catch (error) {
          // Leave the pending-deletion marker in place so the next run retries.
          purgeFailures += 1;
          console.error(`Account purge failed for ${pending.uid}; will retry next run:`, error);
        }
      }
    } catch (error) {
      console.error('Account purge enumeration failed:', error);
    }

    console.log(
      `[cron] ${event.cron}: trash ${trash.itemsDeleted} items / ${trash.r2Deleted} files across ${trash.users} users` +
        ` (${trash.failures} failed); purged ${accountsPurged} accounts (${purgeFailures} failed) in ${Date.now() - startedAt}ms`,
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};
