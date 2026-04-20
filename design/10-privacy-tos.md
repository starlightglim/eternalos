# 10 — Privacy, Terms of Service, and legal posture

> Beta-blocker — you cannot open to public users without these. This doc is not legal advice; it's a structured starting point for an actual lawyer to review. The drafts below are deliberately plain-language and specific to what EternalOS actually does.
> Parent: [ROADMAP.md](ROADMAP.md) §H #119. Related: [06-moderation-trust.md](06-moderation-trust.md) (report/DMCA flows), [08-onboarding.md](08-onboarding.md) (consent at signup).

## Goals

1. Plain-language privacy policy users can read in under 5 minutes.
2. Plain-language ToS that doesn't hide hostile terms in legalese.
3. Signup consent captured (timestamped acceptance on user record).
4. GDPR + CCPA + COPPA compliance hooks in place — data export, deletion, minors.
5. DMCA takedown procedure defined.
6. Cookie and localStorage use documented.
7. Contact address + incident response listed.

## Non-goals (v1)

- EU "Data Protection Officer" appointment — required only above ~250 employees or for systematic large-scale processing of special categories. Not us.
- SOC 2 / ISO 27001 certification — post-beta, if enterprise interest emerges.
- Full DSA "trusted flagger" program — minimal viable DSA stubs only.
- CCPA "Do not sell" button — we don't sell data, so documented but not a required button yet.

## Legal posture at a glance

- **Operator**: solo proprietor (to be LLC'd before public beta).
- **Jurisdiction**: US. Governing law: Delaware or user's home state per choice-of-law in ToS (lawyer decides).
- **User ages**: 13+ at signup. No one under 13 (COPPA compliance is too expensive to add here; clear ban is simpler).
- **EU users**: allowed; GDPR compliance baseline in place.
- **UK users**: same as EU (UK-GDPR post-Brexit mirrors EU).
- **California users**: CCPA baseline.
- **Data processor dependencies**: Cloudflare (workers, R2, KV, D1, Workers AI, Images). Optional: Anthropic (if ANTHROPIC_API_KEY set), Resend (if RESEND_API_KEY set) — these become "sub-processors" requiring disclosure.

## Data we collect

Written as "what a user would want to know," not "what a lawyer would write." The lawyer turns this into the formal text.

### Identity data

- **Email address** — required for signup unless using demo/ephemeral mode.
- **Username** — chosen by user at signup, becomes their public handle.
- **Password** — hashed with PBKDF2 + salt. Never stored or logged in plaintext.
- **Recovery codes** — hashed with the same scheme. Only visible once at signup.
- **Google OAuth identifier** — if using Google sign-in, we store the Google user ID and email.
- **Display name, bio, profile links** — user-provided and user-controlled.

### Content data

- **Desktop items**: folders, text notes, links, widgets, images, audio, video, PDFs. Stored in R2 + Durable Objects.
- **Custom CSS**, wallpaper choice, color tokens, font picks.
- **Bazaar pack uploads** — cursor/icon/sound/skin/app packs.
- **Posts, comments, reactions** (when social lands).
- **Guestbook entries from others** on your desktop.

### Automatic data

- **Visitor counts** per profile (opt-in via `analyticsEnabled`).
- **IP address** — used for rate limiting, fraud detection, not stored long-term.
- **User-Agent** — used for session device recognition.
- **Session tokens** — in KV with 15-min access TTL, 7-day refresh TTL.
- **Durable Object state** — per-user, stores window positions, trash, CSS history.

### AI-generated data

- **Image analysis metadata** — captions, tags, OCR text, dominant colors from Workers AI vision on uploaded images.
- **AI chat history** — persisted per-user in the OrchestratorAgent's SQLite.

### What we don't collect

- **Location** — we don't geolocate beyond coarse IP-based rate-limit bucketing.
- **Phone numbers** — not asked, not stored.
- **Payment info** — no paid tier yet.
- **Social graph imports** — no contact-book uploads.
- **Precise device fingerprints** — no canvas/WebGL fingerprinting.

## Data retention

| Data | Retention |
|---|---|
| Active user data | Indefinite (while account exists) |
| Session tokens | 15 min access, 7 days refresh |
| Soft-deleted account (post-self-delete) | 14 days grace period |
| Hard-deleted account data | 0 days (purged nightly by scheduled worker) |
| Rate-limit buckets | 60–120 seconds |
| Log entries (Logpush → R2) | 30 days |
| Mod action audit log | Indefinite (while referenced user exists); 90 days after user hard-delete |
| Image-hash blocklist | Indefinite |
| CSAM-related retention | 90 days minimum per 18 USC § 2258A |
| Analytics events | 180 days rolling |
| Backup snapshots | 30 days rolling |

## User rights

- **Access** — GET `/api/auth/export-data` returns full data JSON.
- **Correction** — every user-controllable field is editable from Preferences.
- **Deletion** — Preferences → Account → Delete. 14-day grace, then purge. Implemented ticks 8.
- **Portability** — JSON export is portable. R2 blobs downloadable individually.
- **Objection** — opt out of analytics (per-profile), bazaar pack publishing, etc.
- **Complaint** — contact address below; EU users can file with their DPA.

## Third-party data processors

Disclosed in privacy policy as sub-processors:

| Processor | Purpose | Data flowing |
|---|---|---|
| Cloudflare Inc. | Hosting, edge compute, storage, CDN | All user data |
| Cloudflare Workers AI | Text + image classification and chat | Text/image snippets for analysis |
| Anthropic PBC (optional) | Advanced chat model | User chat messages |
| Resend Inc. (optional) | Transactional email | Email addresses + email body |
| Cloudflare Turnstile (optional) | CAPTCHA | IP address + ephemeral challenge metadata |
| Google LLC (optional) | OAuth sign-in | Email + Google subject id for users who choose Google |

Each is a processor under EU/UK-GDPR. DPA (Data Processing Addendum) with Cloudflare is standard and auto-accepted in their ToS. For the optional ones, DPA required if you enable them.

## Cookies and local storage

EternalOS uses:

- **Session storage (localStorage)** — cached desktop state, appearance preview, preferences. Persists until user clears browser data or logs out.
- **First-party cookies** — none currently. Auth uses Bearer tokens stored in localStorage and sent in headers. No tracking cookies.
- **Service Worker cache** — per [03-mobile.md](03-mobile.md), caches app shell + R2 assets for offline. Scoped to the origin.
- **Third-party cookies** — set only by Turnstile during challenge (ephemeral) and by Google during OAuth sign-in flow if used.

No tracking pixels. No ad networks. No analytics SDK beyond Cloudflare's own infrastructure metrics.

## Signup consent

Current signup flow at [auth.ts:88](../packages/worker/src/routes/auth.ts:88) does not capture explicit policy acceptance. Add:

- Checkbox at signup: "I accept the [Terms of Service](/terms) and [Privacy Policy](/privacy)." Required.
- Store on `UserRecord`:
  ```typescript
  tosAcceptedAt?: number;
  tosVersionAccepted?: string;  // e.g. "2026-05-01"
  privacyAcceptedAt?: number;
  privacyVersionAccepted?: string;
  ```
- On policy updates, show a modal on next login requiring re-acceptance.

Both docs get a `version: YYYY-MM-DD` header. Changes bump the version; material changes require re-consent.

## Privacy policy draft (skeleton)

Stub below — lawyer finalizes wording. Lives at `/privacy` as a rendered page sourced from `packages/frontend/public/legal/privacy.md` (treat content as data; update deploys republish it).

```markdown
# EternalOS Privacy Policy
Effective 2026-05-01. Version 2026-05-01.

## Who we are
EternalOS is a personal desktop built on Cloudflare, operated by [Operator Name],
reachable at privacy@eternalos.app.

## What we collect
- Account: email, username, password hash, recovery code hashes, optional
  Google OAuth ID.
- Content: what you upload or create on your desktop — files, folders, notes,
  links, widgets, custom CSS, bazaar pack uploads, posts and comments.
- Automatic: IP address (for rate limiting, not stored beyond 30 days), user
  agent, session tokens.
- AI-derived: captions, tags, OCR text, and dominant colors extracted from
  images you upload, and chat history with the Ask Eternal assistant.

## What we don't collect
- Location, phone number, payment info, contact book imports, device
  fingerprinting, cross-site tracking.

## How we use it
- To operate the service and show you your desktop.
- To let visitors see items you've marked public.
- To moderate content against our guidelines.
- To send transactional email (account recovery, verification) if configured.
- To run AI analysis on images you upload so they're searchable on your own desktop.
- To prevent abuse and debug problems.

## Who we share it with
- Cloudflare, Inc. (infrastructure).
- Cloudflare Workers AI (text and image classification).
- Anthropic PBC (if enabled — for the chat assistant).
- Resend, Inc. (if enabled — for transactional email).
- Google LLC (if you sign in with Google).
- Law enforcement with valid legal process, or when required to protect users
  from imminent harm.

We never sell your data.

## Public vs. private
Items default to private. You explicitly mark items "public" to share them on
your `@username` profile. Bazaar packs you publish are public. Posts, comments,
guestbook entries are public when you choose to post them. Everything else
stays private to you and to the operators.

## Your rights
You can export all your data, correct it, or delete your account at any time
from Preferences. See "Deleting your account" below.

EU / UK / California users have additional rights under GDPR / UK-GDPR / CCPA
(access, correction, erasure, portability, objection, complaint).

## Retention
Active accounts: indefinite while the account exists. Deleted accounts: purged
14 days after you initiate deletion. Logs: 30 days. Analytics: 180 days.

## Children
EternalOS is not for users under 13. If you are under 13, do not sign up. If we
discover an under-13 account, we delete it. Parents: contact us at
privacy@eternalos.app if you suspect your child has an account.

## Deleting your account
Preferences → Account → Delete Account. A 14-day grace period lets you cancel
by signing in. After the grace period, your data is permanently deleted.

## Contact
privacy@eternalos.app
[Operator postal address]

## Changes
We may update this policy. Material changes require you to re-accept on next
sign-in. Non-material changes are announced in the app.
```

## Terms of Service draft (skeleton)

```markdown
# EternalOS Terms of Service
Effective 2026-05-01. Version 2026-05-01.

## What this is
EternalOS is a personal desktop environment. You create an account, upload
content, and share what you want. We keep the service running.

## You must
- Be at least 13 years old.
- Not impersonate others, abuse, harass, scam, or harm anyone.
- Not upload CSAM. Ever. Reports are forwarded to NCMEC.
- Not publish malware, phishing pages, or illegal content.
- Respect other users' copyrights and personal data.
- Keep your account credentials safe.

## You may
- Customize your desktop any way you like (CSS, icons, sounds).
- Publish themes, cursor packs, sound packs to the bazaar.
- Run user-created apps that you or others built in the sandboxed runtime.
- Follow other users, comment, react (once those features ship).
- Build agents on top of the MCP server and automate your desktop.

## Your content
You own what you create. You grant us the minimum license to host, display,
and back up your content so we can run the service. We do not claim ownership.
When you delete content, the license ends.

## Our content
The EternalOS software, aesthetic, and branding are ours. Don't clone the
product. Forking open-source bits where we publish them under OSS licenses is
fine and encouraged.

## We may
- Moderate content that violates these terms (see Acceptable Use).
- Suspend or terminate accounts for repeat or severe violations.
- Change the service. We give notice for meaningful reductions.
- Update these Terms. Material updates require re-acceptance.

## We may not
- Sell your personal data.
- Use your private content for AI training outside what you've consented to.
- Read your private messages (if/when DMs ship) except when automated systems
  flag specific content for moderation review.

## Availability
EternalOS runs on Cloudflare. We target high availability but make no specific
uptime guarantee. The service is provided "as is" without warranty of any
kind. In plain English: stuff breaks sometimes, back up things you care about.

## Limitation of liability
To the maximum extent allowed by law, we are not liable for indirect,
consequential, or incidental damages. Our total liability to any user is
limited to what that user paid us in the past 12 months (currently $0 for
all users).

## Termination
Either side can terminate at any time. You by deleting your account. Us by
notice to you at the email on file, except we may terminate immediately for
serious violations (CSAM, credible threats, active abuse).

## Governing law
[Delaware state law, Delaware courts, with carve-outs for users' home
jurisdiction consumer protections.]

## Contact
support@eternalos.app
```

## Acceptable Use Policy

Links out from ToS. Lives at `/acceptable-use`.

Lists specific prohibited content categories (linked to moderation pipeline in [06-moderation-trust.md](06-moderation-trust.md)):

- Sexual content involving anyone under 18.
- Credible threats of violence.
- Harassment targeting individuals.
- Doxxing / sharing private information.
- Malware, phishing kits, credential stuffing tools.
- Hate speech and slur-laden content targeting protected classes.
- Illegal content (stolen credentials, illicit drug sales, etc.).
- Deceptive impersonation of real people or orgs.
- Spam.
- Material that infringes copyright (DMCA process governs).

## DMCA procedure

Separate page at `/legal/dmca`. Contains:

- Designated agent name + email (operator).
- Required elements of a valid notice (identification of work, identification of infringement, contact, sworn statement, signature).
- Counter-notice form for affected users.
- Repeat infringer policy: 3 strikes → account termination.

Received notices are logged in the mod queue with target content hidden pending review (per DMCA safe harbor requirements).

## Age gating

- Signup form: "I am at least 13 years old" checkbox. Required.
- Store `ageConfirmedAt?: number` on `UserRecord`.
- Under-13 detection (self-reported) → immediate block + account purge.
- No age verification beyond self-report. Sufficient for COPPA safe harbor (we make reasonable efforts).

## Incident response for privacy breaches

If user data leaks:

1. Contain — revoke sessions, rotate JWT_SECRET if needed (invalidates all sessions).
2. Assess — what data, how many users, what's the blast radius.
3. Notify — email affected users within 72 hours of confirmation (GDPR threshold). Post a status update at `/status`.
4. Report — notify relevant authorities (EU DPA, state AGs per breach notification laws).
5. Postmortem — public, within 14 days, technical + process changes.

Keep a draft email template in `packages/worker/legal/breach-email-template.md` so we're not composing under pressure.

## Cookie banner / consent

Current EternalOS doesn't set tracking cookies. No GDPR cookie banner needed unless we ship tracking later.

If Google OAuth is enabled: the Google flow itself sets Google cookies. Mention in the privacy policy; no banner required on our side.

## Data flow diagram

For transparency (good UX + useful for any DPIA / audit):

```
User's browser
    │
    ▼ (HTTPS)
Cloudflare Workers (eternalos-api)
    │
    ├─► AUTH_KV  (sessions, users, rate limits)
    ├─► DESKTOP_KV (public snapshots, bazaar KV legacy)
    ├─► SOCIAL_DB (D1; packs, follows, posts)
    ├─► ETERNALOS_FILES (R2; blobs)
    ├─► USER_DESKTOP (per-user DO)
    ├─► Workers AI (text + vision classification)
    │     └─► (optional) @cf/meta/* / @cf/anthropic/*
    ├─► Resend API (optional; email)
    └─► Turnstile verify (optional; IP + token)
```

## Lawyer deliverables

What to actually hand to a lawyer:

1. This doc, as the product brief.
2. Source of the signup/login flows for context.
3. The permission model in [01-apps-interop.md](01-apps-interop.md) for the "third-party apps" clause.
4. The MCP server in [05-mcp-server.md](05-mcp-server.md) for the "agent access" clause.
5. A list of sub-processors (as listed above, kept current in privacy.md).

Ask them for:

1. Jurisdiction-specific privacy policy (US + EU/UK minimum).
2. ToS (with arbitration or not — product decision).
3. Acceptable Use Policy.
4. DMCA notice template + counter-notice template.
5. Cookie policy (short — we don't use many cookies).
6. Age-gating language + COPPA safe-harbor.
7. Review of breach notification email template.
8. LLC formation (separate engagement).

Budget: $2k–$5k for a privacy/tech lawyer on a flat fee for the above in US market.

## Implementation phases

**Phase A (1 day) — signup consent + pages.**
- Add `tosAcceptedAt` + `tosVersionAccepted` + age confirmation to `UserRecord`.
- Signup form checkbox + age confirmation.
- Render `/privacy`, `/terms`, `/acceptable-use`, `/legal/dmca` as static markdown pages.
- Drop draft copy in; replace with lawyer-reviewed before public beta.

**Phase B (1 day) — re-consent flow.**
- On policy version change, show blocking modal on login.
- User clicks "I accept." Record the new version + timestamp.

**Phase C (1 day) — breach response + status page.**
- Draft breach email template.
- Runbook page in the mod app with the exact steps above.
- Status page wired per [07-observability-ops.md](07-observability-ops.md).

**Phase D (pre-beta) — lawyer pass.**
- Ship lawyer-reviewed copy.
- Any product changes required by the review (often: add/remove a feature, tighten a retention window, broaden a disclosure).

## Open questions

- **Arbitration clause?** US consumer contracts commonly include binding arbitration. Unpopular with users. Decision: leave out for beta. Revisit at scale.
- **LLC vs solo proprietor during beta?** LLC adds liability protection. Form it before real revenue or notable user-count. Delaware LLC is ~$90 filing + annual report ~$300. Worth it.
- **Insurance (tech E&O)?** Overkill for beta. Revisit when we have material traffic.
- **Do we need a "Right to be forgotten" for public content?** If @alice deletes her account, do visitor pages at `/@alice` break? Yes, they should 404. But what about references in other users' guestbooks / forum posts? Replace username with "[deleted user]"; don't delete the foreign posts.
- **EU transfer safeguards.** Cloudflare is US-headquartered. Use their Standard Contractual Clauses (built into their DPA) as transfer mechanism. Document in privacy policy.
- **Minor content moderation for 13-17 users.** Extra caution on direct messaging (when DMs land), image-posting, location sharing. For beta (no DMs, no location), this is largely moot, but revisit before shipping any of those.

## Success metrics

- 100% of signups capture timestamped acceptance.
- Privacy policy readability: < 10-minute read, grade 8 level (measure with Hemingway App).
- Data export endpoint success rate: > 99.5%.
- Account deletion → hard-delete SLA: < 15 days (grace + 1 day).
- Breach notification readiness: under 24 hours from detection to draft email ready.
- Zero COPPA violations (no known under-13 accounts in production).
