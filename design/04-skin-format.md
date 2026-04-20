# 04 — `.estheme` skin format

> One-file, Winamp-for-the-web, Linux-ricer-grade bundle format for EternalOS themes. Drag-drop install, export, fork, nest, share.
> Parent doc: [ROADMAP.md](ROADMAP.md). Related: [02-social-v1.md](02-social-v1.md) (bazaar v2 is where `.estheme` packs live).

## Goals

1. A user's entire desktop aesthetic — colors, wallpaper, CSS, cursors, sounds, icon pack, fonts, typography, variants — bundled as one file users trade like Winamp skins.
2. **Drag-and-drop install** onto the desktop; one click to apply.
3. **Export your current rice** as `.estheme`.
4. **Preview before install** — temp-apply, "Keep" or "Revert".
5. **Fork and remix** — every published theme has a lineage; credits flow back.
6. **Compose** — a theme can extend another. Base rice + your overrides.
7. **Mobile parity** — themes render on mobile with graceful fallback.
8. **Versionable** — semver + changelog per theme.
9. **Safe** — validated manifest, scoped CSS, bounded asset sizes.

## Non-goals

- Arbitrary JS in skins (that's the apps layer — see [01-apps-interop.md](01-apps-interop.md)).
- Native desktop integration (taskbar, system tray). We're a web app.
- Binary asset formats (SWF, native cursors .ani). We accept .cur/.ani from bazaar's existing allowlist but won't add more binary types.

## Current state

Customization today is fragmented across several sibling systems:

- **Custom CSS** — `UserProfile.customCSS` string, scoped to `.user-desktop`, max 50KB. History preserved via `CustomCSSVersion[]` at the DO level.
- **Color tokens** — flat fields on `UserProfile`: `accentColor`, `desktopColor`, `windowBgColor`, `titleBarBgColor`, `titleBarTextColor`, etc. Plus border-radius / shadow / opacity knobs.
- **Typography** — `systemFont`, `bodyFont`, `monoFont` font catalog IDs + `fontSmoothing`.
- **Design tokens** — extensible `designTokens: Record<string, string | number | boolean>` for anything not covered by the flat fields.
- **Variants** — `variants: Record<string, string>` for swappable window chrome, buttons, title bars, resize handles (see `packages/frontend/src/variants/`).
- **Wallpaper** — `wallpaper: string` (pattern name, `custom:...` R2 key, or bazaar URL). + `wallpaperMode`.
- **Sounds** — `SoundPack` with sounds[SoundType] → URL.
- **Cursors** — `CursorAssetMeta` entries per state; currently only eight states.
- **Icons** — per-item `customIcon` (library ID or uploaded R2 key).
- **CSS assets** — uploaded images usable in CSS (backgrounds, cursor backgrounds).

Bazaar today has pack types `'cursor' | 'icon' | 'sound' | 'effect' | 'skin'`. The `'skin'` type is meant to be the unification — but the current bazaar publishes a `config: Record<string, string | number | boolean>` blob that only covers flat tokens, not CSS + cursor packs + sound packs + wallpaper as a single unit.

**The `.estheme` format is that unification, done properly.**

## The bundle

A `.estheme` file is a zip archive with a fixed layout:

```
my-rice.estheme
├── manifest.json          (required; schema v1)
├── preview.png            (required; 1200×750 cover image)
├── preview-mobile.png     (optional; 400×800 mobile screenshot)
├── tokens.json            (required; design-token overrides)
├── theme.css              (optional; scoped custom CSS, ≤ 50KB)
├── variants.json          (optional; variant selections)
├── typography.json        (optional; font pack reference)
├── wallpaper.{jpg|png}    (optional; ≤ 2MB)
├── wallpaper-mobile.{jpg|png} (optional)
├── cursors/
│   ├── default.{png|cur|ani}  (optional; any of the eight CursorState values)
│   ├── pointer.{png|...}
│   └── ...
├── sounds/
│   ├── click.mp3          (optional; any of the 11 SoundType values)
│   ├── windowOpen.mp3
│   └── ...
├── icons/
│   ├── folder.png         (optional; overrides default item-type icons)
│   ├── text.png
│   └── ...
├── assets/                (optional; arbitrary files referenced by theme.css)
│   └── pattern.png
└── readme.md              (optional; displayed on pack page)
```

### Constraints

- Total archive size ≤ 10 MB.
- Up to 20 asset files.
- Per-file size limits mirror the existing per-category limits (50 KB per cursor, 500 KB per css-asset, 2 MB wallpaper, 500 KB per sound).
- No executable files. No JS files. If future phases add a safe-JS-hook story, that's a separate permission layer, not part of the skin format.

## Manifest v1

```json
{
  "formatVersion": 1,

  "id": "dreamcore-deluxe",
  "name": "Dreamcore Deluxe",
  "description": "Soft pastel vaporwave with chromatic aberration and a lofi jazz soundpack.",
  "version": "1.2.0",
  "author": "@alice",

  "extends": "@base/system7",

  "tags": ["dreamcore", "vaporwave", "pastel", "lofi"],

  "license": "CC-BY-SA-4.0",
  "homepage": "https://eternalos.app/@alice/themes/dreamcore-deluxe",
  "repo": "https://github.com/alice/dreamcore-deluxe",

  "minHostVersion": "0.2.0",

  "layers": {
    "tokens": "tokens.json",
    "css": "theme.css",
    "variants": "variants.json",
    "typography": "typography.json",
    "wallpaper": {
      "file": "wallpaper.jpg",
      "mobileFile": "wallpaper-mobile.jpg",
      "mode": "cover"
    },
    "cursors": {
      "default": "cursors/default.png",
      "pointer": "cursors/pointer.png",
      "grab": "cursors/grab.png"
    },
    "sounds": {
      "click": "sounds/click.mp3",
      "windowOpen": "sounds/open.mp3",
      "windowClose": "sounds/close.mp3"
    },
    "icons": {
      "folder": "icons/folder.png",
      "text": "icons/text.png",
      "image": "icons/image.png"
    }
  },

  "changelog": [
    { "version": "1.2.0", "date": "2026-03-15", "notes": "Added mobile wallpaper variant and softer click sound." },
    { "version": "1.1.0", "date": "2026-02-20", "notes": "Fixed button contrast in NeXT mode." },
    { "version": "1.0.0", "date": "2026-01-30", "notes": "Initial release." }
  ],

  "credits": [
    { "kind": "base", "id": "@base/system7", "reason": "Derived from base theme" },
    { "kind": "asset", "name": "wallpaper.jpg", "attribution": "@bob's photo, used with permission" }
  ]
}
```

### Field notes

- **`id`** — kebab-case, unique within an author's namespace (`@{author}/{id}`).
- **`extends`** — optional reference to a parent theme. Values: `@alice/dreamcore-base` (community theme) or `@base/<name>` (EternalOS built-in: `system7`, `macos8`, `macos9`, `next`, `aqua`, `bebos`, etc.). Children merge on top of parents. Supports one level of extension in v1; deeper chains in v2.
- **`minHostVersion`** — refuse to install on older hosts.
- **`layers`** — maps layer names to files in the bundle. Missing layers → don't override.
- **`changelog`** — required for versions > 1.0.0 in bazaar publishing; optional otherwise.
- **`credits`** — freeform; encouraged for attribution.

## Layer semantics

### Tokens layer (`tokens.json`)

Object of design-token overrides; keys match the shape of `UserProfile.designTokens` plus the flat fields for backwards compat:

```json
{
  "accentColor": "#ff66cc",
  "desktopColor": "linear-gradient(180deg, #111122 0%, #221133 100%)",
  "windowBgColor": "rgba(40, 20, 60, 0.92)",
  "titleBarBgColor": "#331144",
  "titleBarTextColor": "#ffccff",
  "windowBorderColor": "#8844aa",
  "buttonBgColor": "#4422aa",
  "buttonTextColor": "#eeccff",
  "buttonBorderColor": "#6633cc",
  "labelColor": "#ffddff",
  "windowBorderRadius": 4,
  "controlBorderRadius": 2,
  "windowShadow": 16,
  "windowOpacity": 95,
  "designTokens": {
    "chromaticAberration": 2,
    "fontLetterSpacing": 0.03,
    "glowColor": "#ff66cc"
  }
}
```

Values follow the same types as the existing profile fields. Anything new goes in `designTokens`.

### CSS layer (`theme.css`)

Same constraints as today's `customCSS`: 50 KB, scoped to `.user-desktop`, no `@import` of third-party origins. The builder pipeline wraps the theme's CSS in `.user-desktop { ... }` if it isn't already.

Asset references use `url('asset://pattern.png')` or similar virtual scheme; the installer rewrites these to published R2 URLs on install. This keeps themes portable — the same `.estheme` works whether installed on eternalos.app, a local dev instance, or shared via a raw URL.

### Variants layer (`variants.json`)

```json
{
  "titlebar": "gradient",
  "chrome": "beveled",
  "buttons": "sprite",
  "resize": "corner-dot"
}
```

Values are variant IDs registered in the variants registry ([variants/registry.ts](../packages/frontend/src/variants/registry.ts)). Unknown variant IDs are ignored with a warning.

### Typography layer (`typography.json`)

```json
{
  "systemFont": "chicago",
  "bodyFont": "geneva",
  "monoFont": "monaco",
  "fontSmoothing": false
}
```

Font IDs must exist in the font catalog ([utils/fontCatalog.ts](../packages/frontend/src/utils/fontCatalog.ts)) — including community-published font packs if we add those.

### Wallpaper layer

Image file + display mode (`cover | tile | center`) + optional mobile variant (rendered on viewports < 640px).

### Cursors / sounds / icons layers

File mappings keyed by their respective enum values. Referenced assets are included in the bundle under their respective subdirectories.

## Install flow

```
User drags my-rice.estheme onto the desktop
 │
 ▼
Frontend: unzip + validate manifest schema
 │
 ▼
Show install sheet:
  ┌────────────────────────────────────────────┐
  │ [ preview image ]                          │
  │                                            │
  │ Dreamcore Deluxe                           │
  │ v1.2.0 by @alice                           │
  │                                            │
  │ Soft pastel vaporwave with...              │
  │                                            │
  │ This theme will change:                    │
  │   ✓ Colors, fonts, window style            │
  │   ✓ Wallpaper                              │
  │   ✓ 3 cursors, 3 sounds                    │
  │   ✓ 3 icon overrides                       │
  │                                            │
  │ Extends: @base/system7                     │
  │                                            │
  │ [ Preview ]  [ Cancel ]  [ Install ]       │
  └────────────────────────────────────────────┘
 │
 ├─► Preview: temp-apply, show "Trying Dreamcore Deluxe" banner
 │          with [ Keep ] / [ Revert ] at top.
 │
 └─► Install: backup current theme as an auto-saved CustomCSSVersion,
             upload all assets to R2 under css-assets/cursors/sounds/icons,
             set UserProfile.activeTheme = theme ID,
             apply tokens/css/variants/wallpaper/sounds/cursors/icons.
```

**Auto-backup.** Installing a theme auto-saves the user's current config as a theme named `backup-<timestamp>` in their personal theme library. One click to restore.

## Export flow

```
Preferences → Appearance → Export Current Theme
 │
 ▼
Dialog:
  Name: [ My Dreamcore Mod    ]
  ID:   [ my-dreamcore-mod    ]
  Description: [__________________]
  Version: [ 1.0.0 ]
  License: [ CC-BY-SA-4.0 ▾ ]
  [ Include wallpaper ]  ✓
  [ Include sounds ]      ✓
  [ Include cursors ]     ✓
  [ Include icons ]       ✓
  [ Include CSS ]         ✓
  [ Include fonts ref ]   ✓
  [ Base on: @alice/dreamcore-deluxe ]  ← shows if current theme was installed
 │
 ▼
Zip it up client-side using JSZip; serve as download.
```

Client-side zip keeps this scalable (no server zipping overhead). File size is bounded by our per-asset constraints.

## Publish to bazaar

```
Preferences → Appearance → My Themes → [ Publish to Bazaar ] on any theme
 │
 ▼
Publish sheet:
  Required:
    ✓ Preview image
    ✓ Description (≤ 500 chars)
    ✓ Tags
    ✓ License
  Optional:
    Changelog entry for this version
    Homepage URL, repo URL
 │
 ▼
POST /api/bazaar/publish with multipart/form-data
  - manifest.json
  - all assets
  - preview.png
 │
 ▼
Worker:
  - Validates manifest schema (zod).
  - Runs safety checks on CSS (regex-based dangerous-pattern filter;
    same set UserDesktop.updateProfile already uses).
  - Runs moderation classification on preview image + description.
  - Creates row in D1 packs table (see [02-social-v1.md]).
  - Stores manifest + assets in R2 at apps/<uid>/<packId>/
  - Returns pack URL.
```

## Fork

Any published theme has a [Fork] button. It:

1. Downloads the full `.estheme` to the user's browser.
2. Decrements version to `X.Y.Z-fork.1` (or a pattern the user chooses).
3. Adds `extends: "@original-author/original-id"` if not already set.
4. Adds a credit line.
5. Adds the fork to the user's themes (installed, but not applied).
6. Opens the CSS editor for tweaking.

On publish of the fork, D1 `packs.parent_pack_id` is set; lineage shows: "Forked from @alice's Dreamcore Deluxe, which forked from @base/system7."

## Extension resolution

When applying a theme with `extends`:

1. Load the parent theme (from bazaar KV cache or D1).
2. Compute merged token set: parent's tokens + child overrides (child wins per-key).
3. Concatenate CSS: parent's CSS + `\n/* child override */\n` + child's CSS (child wins per-selector per CSS cascade).
4. Merge variants: parent + child overrides.
5. Merge wallpaper / cursors / sounds / icons: child overrides any parent assets; missing child assets inherit parent's.

Circular extension is refused. Missing parents fail the install with a clear error.

## Backup and history

Every apply (install, swap, fork-apply, revert, export-reapply) creates a `CustomCSSVersion`-equivalent record extended to cover the full theme state:

```typescript
export interface ThemeSnapshot {
  id: string;
  createdAt: number;
  source: 'install' | 'manual' | 'assistant' | 'revert' | 'export';
  themeId?: string;        // if applied from a named theme
  tokens: UserProfile['designTokens'];
  css: string;
  variants: Record<string, string>;
  typography: { systemFont?: string; bodyFont?: string; monoFont?: string; fontSmoothing?: boolean };
  wallpaper?: { url: string; mode: 'cover' | 'tile' | 'center' };
  soundPack?: SoundPack;
  cursors?: Record<CursorState, string>;
  iconOverrides?: Record<string, string>;
  summary?: string;
}
```

Stored in the user's DO, capped at 50 snapshots (rolling). Users can revert to any snapshot.

## Mobile-specific behavior

- `preview-mobile.png` and `wallpaper-mobile.*` in the bundle, if present, are used on viewports < 640px.
- CSS authors can use `@media (max-width: 640px)` blocks normally.
- Cursor layer is ignored on mobile (no cursor).
- Window-chrome variants fall back to mobile sheets automatically (the sheet layer doesn't use window-chrome variants).
- When previewing on mobile, the "Trying X" banner sits below the status bar.

## Safety rules

**CSS.** Same pattern the DO profile update already applies. Block: `javascript:` URLs, `expression()`, `@import` from non-bundle origins, `position: fixed` outside `.user-desktop` scope. Allow gradients, animations, data: URLs (limited size), and our own `asset://` scheme which gets rewritten.

**Assets.** Mime-type validated via `file-type` (already in use for uploads). Reject anything not on the per-layer allowlist.

**Manifest.** Validated with zod at parse time. Unknown keys are rejected (forward-compat via explicit `formatVersion` bump).

**Moderation.** Preview image and description run through the same moderation pipeline as posts (llama-guard + vision model). Theme held until reviewed if flagged.

## Compatibility with existing bazaar

Existing bazaar packs of type `'cursor' | 'icon' | 'sound' | 'effect' | 'skin'` keep working. The migration from KV to D1 (see [02-social-v1.md](02-social-v1.md)) translates them into D1 rows. A one-shot backfill then wraps each `'skin'` pack into a minimal `.estheme` file and stores it at a new R2 path. The old pack-browse endpoints keep serving for a deprecation window.

New packs uploaded after this lands MUST be `.estheme` bundles (except `'app'` packs from [01-apps-interop.md](01-apps-interop.md), which have their own format).

## Discoverability — the bazaar shape

Bazaar pages gain theme-specific UI:

- **Live in-browser preview** — drop the theme into a sandboxed iframe with a mock desktop rendering the theme tokens + CSS + wallpaper. User sees how their own desktop will look.
- **A/B preview** — split screen: "before" (current theme) and "after" (hovered theme).
- **Lineage tree** — tree view of fork ancestors and descendants.
- **"Also installed by"** — what other themes users who installed this have installed.
- **Changelog tab**.
- **Screenshots** — additional screenshots beyond `preview.png` can be added via the preview carousel.

## Power-user features

### Partial themes

A `.estheme` can ship with only some layers (`tokens` only, or `sounds` only). Installing applies that layer and leaves others alone. Lets users collect "just the cursors from X theme" without adopting the whole aesthetic.

### Theme composition

Long-term goal (v2): a user can apply multiple themes in stacked layers. e.g., base theme `@alice/dreamcore` + cursor-only theme `@bob/pixel-cursors`. Each layer is ordered; later layers override earlier ones.

For v1, only `extends` is supported (one parent). Stacking is v2.

### Theme authoring in-OS

A new window: "Theme Studio." 3-pane:

1. Left: list of layers (tokens, CSS, variants, wallpaper, etc.). Toggle each on/off.
2. Center: live preview of the current desktop with changes applied.
3. Right: editor for the selected layer (color pickers for tokens, CodeMirror for CSS, upload buttons for assets).

Button at bottom: Export as `.estheme`. Or Publish to bazaar.

Authorship is fundamentally a desktop experience, but mobile gets a subset (tokens editor only; advanced users can still fork and tweak CSS on desktop later).

### Custom CSS IDE features

- Live reload while typing (debounced).
- Variable autocomplete from tokens (`var(--accent-color)` suggestions).
- Error reporting for CSS syntax.
- Token picker popover (click a value, pick from color wheel or image sampler).
- Theme linter — warns about contrast, readability, missing mobile rules.
- `@assistant` inline help: "What does this do?" tooltip on any selector, powered by the OrchestratorAgent.

## Sharing

- **URL share.** `eternalos.app/theme/@alice/dreamcore-deluxe` serves a landing page with preview, "Install" button, and a "Try in your browser" button that applies it temporarily without login.
- **Export-to-URL.** Any `.estheme` file can be uploaded to a CDN of the user's choice and linked. Our installer accepts URLs that return a valid `.estheme`.
- **Direct-send-to-user.** From a theme page: "Send to @bob" creates a theme-gift DesktopItem on @bob's desktop, which they can install or trash.

## Open questions

- **Who owns an asset in a forked theme?** If Alice ships a theme with her own photo as wallpaper and Bob forks it, Bob's pack re-uses Alice's asset. If Alice removes her pack later, Bob's keeps working (assets are copied at fork time). Should forks reduplicate or reference? Reduplicate for isolation; reference for storage efficiency. I'd reduplicate — storage is cheap.
- **Should font packs be separate or part of skins?** A font pack on its own is a skin with only typography layer + asset files. I'd unify — one format, one install flow.
- **License defaults.** Default license for publish: CC-BY-4.0. Author can change. Do we show the license to installers? Yes, on the install sheet.
- **Install count vs reaction count as ranking.** Research mentioned reactions as fitting the vibe. For themes, "installs" is the honest metric; reactions can be additional signal. Weighted sort.
- **Should `extends` support multi-parent?** For composition. v2 question.
- **Dev mode / unsigned themes.** Power users self-serving `.estheme` files from GitHub don't want to publish to bazaar. Allow install from URL with a "Unverified theme — install anyway?" dialog.

## Phased delivery

**Phase A (1 week).**
- Manifest v1 schema + zod validation.
- `.estheme` zip reader / writer (browser-side, JSZip).
- Export flow (client-side zip + download).
- Drag-drop install flow with safety checks.
- Preview-before-install (temp apply + Keep/Revert banner).

**Phase B (0.5 weeks).**
- Backup snapshots + revert UI.
- Theme Studio skeleton (tokens + CSS editing, no asset upload yet).

**Phase C (1 week).**
- Bazaar integration for `.estheme` packs.
- Fork button with lineage recording.
- In-browser live preview on pack pages.
- Mobile layer support (mobile wallpaper, mobile preview).

**Phase D (optional) — Theme Studio full.**
- Asset uploads from within Theme Studio.
- Linter + inline assistant help.
- Partial theme publish workflow.

## Success metrics

- % of users with a non-default theme installed after 14 days ≥ 40%.
- % of users who export or publish a theme after 30 days ≥ 5%.
- Fork rate on top-10 themes (forks / installs) ≥ 3%.
- Average themes in a user's library ≥ 3.
- Bazaar theme browse sessions per user per week.
