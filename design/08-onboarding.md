# 08 — Onboarding and friction reduction

> How a stranger becomes a beloved user. Zero-friction trial, goal-first signup, a non-blank first desktop, and a help surface that works for both "my grandmother" and "someone who already has a polybar config."
> Parent: [ROADMAP.md](ROADMAP.md) §F (items 78–95).

## Goals

1. A stranger can try the product in under 10 seconds without signing up.
2. Signup itself is < 30 seconds, with no email verification required to start.
3. First login never sees a blank desktop. Something is already there, inviting interaction.
4. The feed is never empty for new users.
5. Every surface has progressive disclosure — beginners see 3 options, ricers find 30 more behind a toggle.
6. Common frictions — storage, errors, undo, help — are visible rather than hidden.
7. The ricer/dev audience feels respected and finds power features fast.

## Non-goals

- Marketing splash pages. Landing is already adequate.
- Gamified badges / XP / streaks. Ick for this audience.
- Tutorial videos. Nobody watches them; interactive coach marks only.

## The friction audit

Current state, based on repo read:

| Surface | Friction | Evidence |
|---|---|---|
| Landing → signup | Must sign up to see anything real | [LandingPage.tsx](../packages/frontend/src/pages/LandingPage.tsx) uses mock data |
| Signup | Email + password + username all at once | [SignupPage](../packages/frontend/src/pages/SignupPage.tsx) + server at [auth.ts:88](../packages/worker/src/routes/auth.ts:88) |
| First login | Read Me + Getting Started folder (good) | [auth.ts:243](../packages/worker/src/routes/auth.ts:243) |
| First login UX | QuickStartWizard exists but minimal | [QuickStartWizard.tsx](../packages/frontend/src/components/ui/QuickStartWizard.tsx) |
| Discovery | No feed yet (pending social v1) | n/a |
| Errors | Generic "upload failed" strings | various |
| Help | No in-OS help, no tooltips after first use | n/a |

## Demo mode

**Concept**: `/` has a "Try it" button that drops you into an ephemeral session — fully functional desktop, no backend account, no persistence beyond localStorage.

**Implementation**:
- Route `/try` mounts `<DemoApp />` which uses Zustand stores populated from the existing mock data.
- Everything works locally: create items, drag around, customize CSS, even "install" a bazaar pack (the install code already writes to the store; it just never POSTs).
- Persist to localStorage so the same demo survives refresh, but never to the server.
- Banner: "You're in demo mode. [Keep my desktop — sign up]" — that CTA does an opportunistic signup and hydrates the server with the localStorage state.

**Why it wins**: strangers touch the actual product before deciding. Conversion from demo→signup is a known driver in UGC products.

## Progressive signup

**Concept**: The first ask is only a username. Email+password come later, at the moment the user benefits from having an account (installing a pack, posting to feed, sharing their desktop).

**Flow A — anonymous demo → signup:**
1. User in demo clicks "Keep my desktop".
2. Prompt: "Pick a username" (single text input + availability check).
3. Behind the scenes: server creates a user with `ephemeral = true`, no email, no password, generates a 6-month session cookie.
4. User now has a real account and real `/@username` URL.
5. At any time, they can "Set password + email" from Preferences → Account to upgrade.

**Flow B — traditional signup:**
1. User clicks "Sign up" from landing.
2. One combined form: username + email + password + Turnstile.
3. Same as today.

**Implementation note**: add `ephemeral?: boolean` to `UserRecord`. If true:
- Session cookie lasts 6 months (vs 7d refresh for password users).
- Cannot publish to bazaar or forum (nudges upgrade).
- Login-by-cookie only; no recovery possible if cookie is lost.
- Upgrade path to full account is a single form in Preferences.

## Goal-based onboarding wizard

**Concept**: after first login, ask the user what they're here for, route to a personalized first-run.

**UI**:

```
┌─ Welcome to EternalOS ─────────────────────────┐
│                                                │
│ What brought you here?                         │
│                                                │
│  [ 🏠 Share a vibe        — personal page ]   │
│  [ 🛠  Build apps         — dev / tinkerer ]  │
│  [ 🎨 Just customize      — ricer / artist ]  │
│  [ 👀 Just looking around                   ] │
│                                                │
│ (We'll tailor the first-run experience.)       │
└────────────────────────────────────────────────┘
```

**Routing logic**:

- **Share a vibe** → open a "Customize your homepage" flow: pick wallpaper, write bio, add 3 sample items (photo/text/link).
- **Build apps** → open the in-OS code editor with a "Build your first app" tutorial (guided prompts to OrchestratorAgent).
- **Just customize** → open Theme Studio (from [04-skin-format.md](04-skin-format.md)) + preload one of the curated example themes in preview.
- **Just looking** → default Read Me + Getting Started folder (today's behavior).

All routes end with "by the way, here are 3 recommended accounts" (auto-follow if clicked), plus a "you can find everything via Cmd+K" hint.

## Non-blank first desktop

Current `Read Me.txt` + `Getting Started` folder is a start. Expand:

1. **Pre-applied wallpaper** — a pleasant default (not the stock CF pattern) chosen randomly from a curated set of 5 tasteful options. User can change immediately.
2. **Sticky note widget** — "Try me: double-click to edit. (You can delete this note, too.)"
3. **Guestbook widget** — one sample signature (from `@staff`) in it, "signed" at signup.
4. **Read Me.txt** — same as today.
5. **Getting Started folder** — same + one new file: "3 ways to rice.txt" pointing to Theme Studio / bazaar / custom CSS.
6. **Desk Assistant** — first prompt pre-populated: "Try: 'Change my wallpaper to something cyberpunk'".

Aim: feels inhabited, not empty. User wants to touch everything.

## Interactive coach marks

On first visit, after the wizard closes, show a sequence of non-blocking hotspots:

1. "This is your desktop. Drag items to rearrange." → pointer at first icon.
2. "Right-click for the context menu." → pointer at empty space.
3. "Press Cmd+K to find anything." → pointer at menubar.
4. "Customize your look with Special → Appearance." → pointer at menubar.

Dismissible: click anywhere to advance, "skip all" in the corner, "don't show again" on the last one. State in localStorage.

Implementation: tiny `<CoachMark>` component (tooltip + backdrop that doesn't block, with a "next/skip" button). 200 lines of React.

## Example desktops (clone templates)

**Concept**: in onboarding, offer "start from a vibe" templates. User picks one, their desktop is pre-populated.

Templates (all curated by us):

- **Minimalist** — one sticky note, one folder, subtle grayscale theme.
- **Cottagecore** — warm wallpaper, serif body font, a guestbook, a mood board folder.
- **Cyberpunk** — neon colors, monospace font, a calculator, a visualizer widget stub.
- **System 7 purist** — no custom styling, lots of folders, the full retro Mac feel.
- **Dev's desktop** — code editor open on a hello-world app, a terminal widget stub, a GitHub link.

Each is stored as a `.estheme` bundle + a list of default items. "Apply this template" does the theme install + creates the items.

Stored in R2 at `templates/{name}/`.

## Empty-feed bootstrap

A new user with 0 follows sees nothing in their feed. Fix:

1. **Auto-follow 5 curated accounts** at signup (skippable). These are hand-picked to show off what's possible (a ricer, an app builder, a photographer, a musician, a staff account).
2. **"Fresh users" section** on explore — promotes brand-new users to each other.
3. **Daily prompt** — "Today: post your desktop in its current state" / "Today: share a pack you made." Drives content volume at any time. Shown as a dismissible card at top of feed.
4. **"Accounts you might like"** — based on tags the user picked during wizard (if any). Cheap algorithm: tag-match + trust-score threshold.

## Friction reduction (micro-UX)

### Storage budget visible

Preferences → Account shows a storage meter:

```
Storage: 23.4 MB / 100 MB used
 ████░░░░░░░░░░░░░░░░░░░░░░░░░
 
 Images    14.2 MB (60%)
 Video      6.8 MB (29%)
 CSS        1.2 MB
 Other      1.2 MB
```

Surface the same meter as a tiny bar in the trash window.

### Clear error messages

Replace generic `"Upload failed"` with specific:

- "Upload failed: file is 15 MB but your limit is 10 MB." + link "Need more space?"
- "Upload failed: this file type (`.exe`) is not supported. We support images, text, PDF, audio, video."
- "Upload failed: you're over quota (103% of 100 MB). [Open Trash]"

Implementation: the backend already returns structured errors (e.g. `{ error, quota }`). Frontend needs to surface them instead of showing the string.

### Undo snackbar

Every destructive action shows an "Undone: X" snackbar with `[Undo]` button for 8 seconds. Covers:

- Trash an item → Undo moves it back.
- Delete from trash → Undo impossible, say so.
- Overwrite CSS → Undo pulls the previous version from history.
- Install a theme → Undo reverts to the prior snapshot.

A generic `useUndoBuffer` hook manages the queue. Existing [clipboardStore.ts](../packages/frontend/src/stores/clipboardStore.ts) pattern is a good template.

### Tooltips on hover

Every menubar item, icon button, context menu entry has a tooltip on first-24h hover. After 24h, tooltips only show on Alt+hover (power-user discoverability preserved).

Implementation: `useTooltipOnce` hook + CSS `::after`. ~100 lines total.

## Help surface

### The `?` menubar button

Top-right of the menubar. Clicking opens a Help window with:

1. **Search** — searches all help content via FTS.
2. **Tour of the OS** (re-run the coach marks).
3. **Keyboard shortcuts** (the same ones in Getting Started/Keyboard Shortcuts.txt).
4. **"Ask Eternal"** button — opens the assistant pre-seeded with "I need help with...".
5. **FAQ sections** — Customization, Files, Social, Privacy, Account.

Content lives in markdown files at `packages/frontend/src/help/`, imported as strings. FTS done client-side (trivial at this scale).

### Inline help on complex surfaces

The CSS editor and Theme Studio have a persistent info pane that explains what the focused control does:

- Hover a color swatch → "This sets the accent color — used for highlights, selection, and focus rings."
- Focus the CSS editor → "Write CSS here. It's scoped to `.user-desktop`. Try: `.desktop-icon { transform: rotate(2deg); }`"

Content pulled from the same markdown corpus as the Help window.

## Command palette (Cmd/Ctrl+K)

Designed to serve both audiences at once:

- Beginners see: "Change wallpaper", "Find a friend", "Install a theme", "Open preferences", "Create a new note". Natural language.
- Power users type: "app: weather", "css", "newpost", or use mnemonics.

Architecture:

- Single `CommandPalette` React component, full-screen overlay on Cmd+K.
- Actions registered dynamically by each feature area via a `registerCommand({id, title, keywords, run})` hook.
- Recent commands surface first; otherwise fuzzy search (fuse.js or a hand-rolled ranker).
- Supports "types to actions" — search matches both action names and data (item names, pack names, user names).

Commands for v1:

- File operations: New folder, New text, New link, New widget, New app, Upload...
- Navigation: Open trash, Open preferences, Open explore, Visit @...
- Customization: Change wallpaper, Apply theme..., Edit CSS, Open Theme Studio
- Social (when shipped): Post to feed, Follow user..., Open inbox
- Account: Log out, Export data, Edit profile

Keyboard-first, mouse-optional. Essential for ricers.

## Ricer-specific onboarding

Hidden behind the "Build apps" or "Just customize" wizard paths:

1. **Dev mode toggle** in Preferences → Advanced. Enables:
   - CSS editor shows line numbers + lint + autocomplete on Ctrl+Space.
   - Custom CSS limit raised to 100KB (from 50KB).
   - Bazaar install shows unverified themes.
   - An "Inspect window" command (shows the actual CSS + variants + tokens of the focused window).
2. **Theme Studio** is reachable directly from the wizard.
3. **In-OS code editor** link in the Help window for app building.
4. **API docs** page at `/docs` or in the Help window — REST endpoints + MCP + export format reference.

## Beginner-specific onboarding

Hidden behind the "Share a vibe" or "Just looking" wizard paths:

1. Default view hides the menubar's File/Edit/View/Special options not needed for passive use; replaces with a simpler "Add → (folder, note, photo, link)" button.
2. CSS editor shows a "not ready for this? Use the Appearance panel instead." link.
3. Coach marks are slightly longer on first-run and include "Right-click = context menu" spelled out.

Both sets of users see the same OS underneath; the differences are affordance defaults + what's visible first.

## Cohort strategy (human side of onboarding)

- **First 50 users**: invite-only. Hand-pick from early-access list. Run a Discord for them.
- **First 500**: still invite-only but each user gets 3 invites. Viral coefficient check.
- **First 5,000**: open signup with mild friction (Turnstile + email verification required for public posts).
- **Full public**: open everything; mature moderation + trust score does the throttling.

At each cohort boundary: pause + analyze churn / NPS / retention / cost. Don't flip the next gate until signals are good.

## Deprecation / removal

Some existing patterns should retire:

- **`mockItems` in desktopStore** — repurpose into demo mode / templates; remove the runtime branching.
- **`LandingPage.tsx`'s FEATURED_DESKTOPS placeholder** — replace with real curated accounts or remove until social v1 ships.
- **`fix_plan.md`** — already marked obsolete in tick 1.

## Implementation phases

**Phase A (3 days) — friction quick wins.**
- Better error messages across upload/quota paths.
- Storage meter in Preferences.
- Undo snackbar for trash actions.
- Tooltips everywhere.

**Phase B (1 week) — demo mode + progressive signup.**
- `/try` route with ephemeral session.
- "Keep my desktop" upgrade flow.
- Server-side `ephemeral` user type.

**Phase C (1 week) — wizard + templates.**
- Goal-based onboarding wizard.
- 5 curated templates (`.estheme` + seeded items).
- Non-blank default desktop (widgets, Desk Assistant seed prompt).

**Phase D (1 week) — help surface.**
- `?` menubar button + Help window.
- Markdown help content + client FTS.
- Inline help on CSS editor / Theme Studio.
- Command palette (Cmd+K).

**Phase E (ongoing) — empty-feed bootstrap.**
Ties into social v1 — auto-follow, daily prompts, fresh-users row.

Total: ~4 weeks.

## Open questions

- **How aggressive should demo mode be?** Full product in local-only mode is cool but could confuse users when they lose it. Alternative: demo is read-only (can drag and click but can't add items). Decision: full editable, with a persistent "saved locally only" banner. Lost-work is the user's tradeoff.
- **Progressive signup: do we accept no-email users ever?** Email is how account recovery works. Without it, losing the session cookie means losing the account. For beta, allow it but flash a "you might want to add an email someday" reminder every 30 days.
- **Should we A/B test onboarding paths?** Not at beta size. The sample size is too small for meaningful lift detection. Pick one path per cohort, iterate in cohort boundaries.
- **Command palette scope creep.** Every feature will want to register commands. Keep a maximum of 80 visible commands at one time (filtered by context). Beyond that, use fuzzy search.
- **Do we need a "skip" for the wizard?** Yes, always. Covered in the mockup ("Just looking around").

## Success metrics

- Demo-to-signup conversion rate: ≥ 15%.
- Time from landing to first customization action: < 3 min median.
- Time from signup to first public item flip: < 24h for 40% of users.
- 7-day retention for signups: ≥ 30% (strong for UGC beta).
- Users who reach Theme Studio in week 1: ≥ 25%.
- Help window opens per DAU: < 0.05 (signals help isn't needed) but > 0 (signals it's discoverable).
- Fraction of actions using the command palette: ≥ 20% among week-2 users.
