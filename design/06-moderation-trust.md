# 06 — Moderation, trust, and reports

> How EternalOS keeps the public surface (profiles, feed, forums, bazaar, guestbooks) safe without requiring a 24/7 mod team. Classifier-first, human-in-the-loop, trust-score-gated visibility.
> Parent: [ROADMAP.md](ROADMAP.md). Related: [02-social-v1.md](02-social-v1.md) §moderation (high-level), [05-mcp-server.md](05-mcp-server.md) (same audit-log primitive).

## Goals

1. Every piece of public content — posts, comments, packs, profile bios, guestbook entries, post images — is classified at write time.
2. High-confidence harmful content is auto-held. Mid-confidence goes into a review queue. Low-confidence publishes immediately.
3. Low-trust users (new, unverified) have their content shadow-hidden from discovery (explore, feed for non-followers) until trust accumulates.
4. Users can report content; reports are triaged automatically; mods see a prioritized queue.
5. Bans escalate: soft suspend (read-only) → account lock → 30-day cooldown → hard ban. Actions are logged and reversible where possible.
6. Appeals exist and a human reads them.

## Non-goals (v1)

- ML-trained custom moderation models. Use Cloudflare Workers AI providers.
- Proactive crawl of existing content. v1 moderates at write time; backfill is manual.
- Cross-user DM moderation. (DMs aren't shipping in v1.)
- Age verification. Deferred until we ship adult-content opt-in (post-beta).
- Deepfake / manipulated-media detection beyond what the vision model catches.

## Pipeline at write time

Every public-bound mutation goes through this gauntlet before persisting with `moderation_status = 'approved'`.

```
Write → Validate input → Classify text → Classify images → Rule-based filters → Decide → Persist
        (size/schema)    (llama-guard-    (vision model)     (banned domains,                (approved /
                          3-8b)                               CSAM perceptual                  held /
                                                              hash, scam phrases)              removed)
```

### Step 1 — input validation

Standard zod / schema checks: size limits, required fields, reasonable ranges. Anything failing here doesn't reach the classifier (saves tokens).

### Step 2 — text classification

Model: **`@cf/meta/llama-guard-3-8b`** (Workers AI, free tier includes it).

Input: `{ user_input: bodyText }`. Output: `safe` or `unsafe:{CategoryCode}` per Meta's [MLCommons taxonomy](https://github.com/meta-llama/PurpleLlama/blob/main/Llama-Guard3/MLCommons-Taxonomy.md). 13 categories: violence, sexual-content, weapons, hate, self-harm, etc.

We map Meta's output to our own decision:

| llama-guard output | Decision (base) |
|---|---|
| `safe` | `approved` |
| `unsafe:S4` (CSAM-adjacent) | `hard_deny` — always removed + account flagged for human review |
| `unsafe:S3` (sexual) | `held` (until reviewed) — NSFW may be allowed in a future opt-in tier |
| `unsafe:S1,S2,S9,S11` (violence, weapons, terrorism, threats) | `held` |
| `unsafe:S5,S6,S7,S8,S10,S13` (defamation, privacy, IP, hate, other) | `review_queued` — visible but shadow-hidden from discovery |
| `unsafe:S12` (self-harm) | `held` + surface crisis-resources banner to the user |

Confidence: llama-guard doesn't return probabilities. We do a single classification and trust it. In practice the model is noisy on edge cases — the human queue picks up what it gets wrong.

### Step 3 — image classification

For posts that include images (or for the images themselves — bazaar preview, profile avatar, uploaded photo going public):

Model: **`@cf/meta/llama-3.2-11b-vision-instruct`** or **Llama 4 Scout** (if bumped per research). Prompt the model with a structured "is this content NSFW / violent / hateful / CSAM-adjacent?" schema, ask for JSON.

```
Prompt: "Analyze this image for platform moderation. Return JSON with these keys:
  - nsfw: boolean (explicit sexual content)
  - violence: boolean (graphic violence, gore, weapons pointed at humans)
  - hate: boolean (hate symbols, slurs rendered)
  - child_safety: boolean (any content involving minors in any sexual or violent context — even artistic/drawn)
  - notes: string (one sentence if concerned, empty otherwise)
Return ONLY JSON, nothing else."
```

Decision mapping:

| Vision output | Decision |
|---|---|
| all false | `approved` |
| `nsfw: true` | `held` |
| `violence: true` or `hate: true` | `held` |
| `child_safety: true` | `hard_deny` — remove + lock account + legal escalation path |

### Step 4 — rule-based filters

Post-classifier, before persisting:

- **Banned domains**: any URL matching a curated block list (phishing kit infrastructure, known scam redirects) → `held`.
- **Scam phrases**: regex against body text (e.g., "send eth to", "claim your airdrop", "WATSAPP ME"). → `held`.
- **Banned words**: a short list of slurs (minimal — llama-guard catches most) — automatic `held`.
- **Perceptual image hash**: computed client-side (pHash algo) and sent alongside the image. Compare against a `banned_image_hashes` KV set. Hashes persist for repeat-offender tracking.
- **PhotoDNA / Thorn Safer** (phase B): integrate before beta if legal requires. Free tiers exist for qualifying platforms.

### Step 5 — decide + persist

Write-path pseudocode:

```typescript
async function moderate(content: ContentCandidate): Promise<ModerationDecision> {
  const textResult = await classifyText(content.bodyText ?? '');
  const imageResult = content.images?.length
    ? await classifyImages(content.images)
    : { decision: 'approved' };
  const rulesResult = await runRuleFilters(content);

  // Highest-severity decision wins.
  const decisions = [textResult, imageResult, rulesResult];
  if (decisions.some(d => d.decision === 'hard_deny')) return { decision: 'hard_deny', reason: combineReasons(decisions) };
  if (decisions.some(d => d.decision === 'held')) return { decision: 'held', reason: combineReasons(decisions) };
  if (decisions.some(d => d.decision === 'review_queued')) return { decision: 'review_queued', reason: combineReasons(decisions) };
  return { decision: 'approved' };
}
```

Persist with:

- `moderation_status ∈ { 'approved' | 'review_queued' | 'held' | 'removed' | 'hard_denied' }`
- `moderation_reason` text (what the classifier/rule said)
- `moderation_decided_at` timestamp
- `moderation_decided_by` = 'auto' | mod uid

## Trust score

Stored on `users.trust_score`, range 0–100. Reshuffled nightly via a scheduled Worker (cheap — it's all D1 + simple math).

**Factors** (with approximate weights, tuned from real reports later):

| Factor | Contribution |
|---|---|
| Account age in days | `+min(30, ageDays * 1)` |
| Email verified | `+20` |
| Approved posts count | `+min(30, approvedPostCount * 1)` |
| Positive reactions received | `+min(20, reactionCount * 0.1)` |
| Reports against (last 90 days) | `-min(50, reportsAgainst * 10)` |
| Had content hard-denied in last 90 days | `-30` per event |
| Had content held in last 90 days | `-10` per event |
| Has a published, installed-by-others bazaar pack | `+10` |
| Has at least one follower not new/unverified | `+5` |

Floor: 0. Ceiling: 100. Starts at ~0 at signup, rises with good behavior and time, falls with reports/holds.

**Thresholds**:

- `trust_score < 30`: shadow-hidden from discovery (explore, non-follower feeds, /random). Own followers still see their content. Public profile still works but marked "recently joined" for visitor cues.
- `trust_score ≥ 30 && < 60`: normal visibility; `held` decisions still block.
- `trust_score ≥ 60`: auto-approve for non-critical categories the classifier holds on. Saves mod time for trusted voices.
- `trust_score ≥ 85 && active > 90 days`: can apply for moderator status (opt-in).

Decay: trust score recalculates nightly, so bad behavior drops the score quickly; good behavior rebuilds slowly.

## Shadow-hide semantics

"Shadow-hidden" means:

- The content exists. The author can see it normally.
- Followers of the author can see it normally (this is *not* social punishment; it's protection of strangers from unvetted voices).
- `/explore`, `/random`, search, "Fresh users" widget, forum front page: the content is invisible.
- The content resurfaces in discovery once the author's trust score crosses 30 (or a mod approves the specific piece).

This is ethically nuanced. The alternative — letting new-account spam flood discovery — is worse. Surface the status to the author when it matters:

- "Your post was approved and is visible to your followers. It will appear on /explore once your account is more established." (first shadow-hide of a new user's content)
- Subsequent posts: no banner, to avoid training attackers on the threshold.

Never tell a user "you are shadow-banned." Dishonest, counterproductive, and ethically sketchy. The language above is truthful.

## Reports

A `reports` D1 table (per [02-social-v1.md](02-social-v1.md) §schema) collects user-filed reports.

Report categories: `spam | harassment | nsfw | scam | impersonation | doxxing | csam | other`.

Flow:

1. User clicks `Report` on any public content or profile.
2. Form asks: category + optional 280-char explanation.
3. Server writes to `reports` table + increments `targetUid`'s `reportsAgainst` counter.
4. Auto-triage:
   - `csam` → immediate escalation: content hidden instantly, account locked, queued at priority 0 for human review (legal hold).
   - `spam` / `harassment` on content by user with trust < 30 → auto-shadow-hide the content (not the user — the content).
   - 3+ independent reports on the same piece of content within 1 hour → auto-hide + queue priority 1.
   - Otherwise → queue priority 2.
5. Report queue is stored in `reports` table sorted by priority + created_at.

**Anti-abuse.** Reporting itself is rate-limited (see [social v1 rate limits](02-social-v1.md)). If a user's reports are consistently rejected ("low signal reporter"), their reports are down-weighted.

## Moderator tooling — the admin app

Built *on* EternalOS, because we're EternalOS. A special desktop item type `type: 'admin-app'` only visible to uids in the mod group. The app is a window with panes:

- **Queue** — prioritized list of reports, flagged content, held posts. One-click actions: Approve (publish), Remove (delete), Escalate (ban), Dismiss (false positive).
- **User detail** — look up a uid → recent activity, trust score factors, past mod actions.
- **Actions log** — every mod action ever, searchable, with audit trail.
- **Stats** — queue depth, median time to decision, approval rate, action rate.

Implementation: one Worker route `GET /api/mod/queue` etc., gated by `isModerator(uid)`. The frontend is a React component in the user's OS.

Mod group membership stored in KV `mod:uid:{uid}` (set/unset by admin, initially just the founder). Bootstrap via a one-shot admin secret for the first-ever mod.

## Bans

Progressive discipline:

1. **Warning** (soft). Mod sends a message explaining what happened. No functional change.
2. **Soft suspend** (`users.suspended = 1`). Read-only: can log in, see, but cannot post / comment / react / publish / install. Duration: 24h / 7d / 30d chosen by mod. Auto-expires.
3. **Account lock**. Cannot log in. Login shows: "Account locked pending review. [Appeal]" with form link.
4. **Hard ban**. Username freed, email marked banned, uid retained for audit. Cannot create a new account with the same email.

Every step requires mod action (no automatic progression). Appeals pause automatic expiry.

## Appeals

A form at `/appeal?uid={own uid}` when logged out, `/preferences/appeals` when in. User writes a short statement. Shows up in the mod queue under "Appeals" with SLA: 72h.

Mod actions: uphold / reduce / reverse. All logged.

## Audit trail

Every automated or manual moderation decision writes to `mod_actions` D1 table:

```sql
CREATE TABLE mod_actions (
  action_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  target_kind TEXT NOT NULL,        -- 'post' | 'comment' | 'user' | 'pack' | 'thread'
  target_id TEXT NOT NULL,
  actor TEXT NOT NULL,              -- 'auto:llama-guard' | 'auto:vision' | 'auto:rules' | uid
  action TEXT NOT NULL,             -- 'held' | 'approved' | 'removed' | 'suspended' | 'unsuspended' | 'banned'
  reason TEXT,
  metadata_json TEXT
);

CREATE INDEX idx_mod_actions_target ON mod_actions(target_kind, target_id, created_at DESC);
CREATE INDEX idx_mod_actions_actor ON mod_actions(actor, created_at DESC);
```

Users can see their own actions via `/preferences/mod-history` (a sub-tab of account settings) — transparency.

## CSAM + legal

- Any content flagged `child_safety: true` by the vision model is immediately removed, account hard-locked, and reported via NCMEC CyberTipline API. Legal requires this.
- We retain image hashes and metadata for 90 days (per US law 18 USC § 2258A) even after deletion.
- DMCA: a `/legal/dmca` page with a form. Reports go to a dedicated queue. Content is removed pending review if the form contains required elements (reporter identity, sworn statement, description of work).
- GDPR: data export (already implemented in tick 8) + right-to-erasure (account delete, also implemented).

## Compliance notes

- PhotoDNA / Thorn Safer: free for qualifying platforms. Apply before opening to public beta if image content is a meaningful share of uploads.
- Section 230 (US): hosting user content is fine; we have moderation + good-faith takedowns. Standard SaaS posture.
- EU DSA: as a "small" platform (below 45M active users in EU) most obligations are reduced. Still required: transparent ToS, reporting mechanisms, point of contact for authorities. Stub those before an EU beta.

## Implementation phases

**Phase A (1 week).** Schema + llama-guard text classification on posts/comments/bios/wall messages. Rule-based filters. `moderation_status` field. Shadow-hide logic in feed / explore queries. No vision yet.

**Phase B (1 week).** Vision classification on images. Trust score nightly job. Reports table + report UI + auto-triage.

**Phase C (1 week).** Admin app with queue + one-click actions. Mod group. Audit log.

**Phase D (ongoing).** Appeals flow. CSAM reporting integration (if needed by beta size). DMCA form. DSA compliance stub.

Total: ~3 weeks for a usable moderation system.

## Open questions

- **Mid-confidence threshold calibration.** What fraction of llama-guard "unsafe" responses are false positives? Only usable data will come from real traffic. Start conservative (held), loosen based on mod false-positive rate.
- **Should high-trust users' images skip vision classification?** Latency + cost win. Risk: once-trusted accounts get hacked. Decision: skip text only; always run vision on images.
- **Appeals for auto-decisions.** Today the flow is "file appeal → mod reviews." Alternative: a second-line classifier (different model) auto-reviews auto-decisions. Interesting but complicates the system. Defer.
- **"Spicy but allowed" tier.** Some users want to post R-rated content among consenting followers. Requires: opt-in visibility tag, consent gate on visitor page, age verification. Out of scope for beta. Design note: when/if we build this, use a visibility scope `isSpicy` flag per post + `seesSpicyContent` per viewer.
- **Mod burnout.** A two-person beta mod team burns out fast if the queue grows beyond 50/day. Watch queue depth. Onboard volunteer mods from high-trust users once trust scores stabilize.
- **Trust score weights.** Above values are initial guesses. Set up a nightly telemetry dashboard showing distribution of scores by account age tier, report rate by tier, etc. Tune weights from there.

## Success metrics

- Median queue time per report: < 2 hours for P0, < 24h for P1, < 72h for P2.
- False positive rate on auto-decisions (from appeals and mod overrides): target < 5%.
- Fraction of users shadow-hidden: should drop to < 3% of MAU after 30 days.
- CSAM incidents: 0 reaching the public surface (goal).
- Mod appeals reversal rate: 5–15% (healthy — neither too lax nor too harsh).
