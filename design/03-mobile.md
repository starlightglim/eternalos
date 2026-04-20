# 03 — Mobile redesign

> A native mobile paradigm for EternalOS, not a shrunken desktop. Grid home screen + PWA + gestures + full customization parity.
> Parent doc: [ROADMAP.md](ROADMAP.md). Related: [04-skin-format.md](04-skin-format.md) (skins must render on mobile).

## The core argument

Today: mobile users get [MobileBrowser.tsx](../packages/frontend/src/components/desktop/MobileBrowser.tsx) — a flat list of files, a "Log Out" button, and file viewers. None of the customization, none of the personality, none of the OS feel. This is not a version of the product — it's a fallback.

**Half the retention for a "desktop as identity" product is phone-time.** If someone can't look at their own desktop (or a friend's desktop) on their phone and feel the same rush, they won't come back.

Mobile should be:

1. A **native paradigm** — grid home screen, gestures, bottom tab bar — not a cramped desktop.
2. **Full customization parity** — themes, wallpaper, colors, sounds, CSS all editable from mobile. Everyone rices on their phone these days.
3. **Installable** (PWA) with offline shell.
4. **A first-class visitor experience** — visiting a friend's desktop on mobile renders their theme, widgets, and vibe, not a stripped file list.
5. **Fast.** iOS Safari on a 4-year-old phone is the target. Budget: first paint < 1.5s on 4G, interactive < 3s.

## Layouts

Three layouts, selected by viewport width:

| Width | Layout | Metaphor |
|---|---|---|
| < 640px | **Mobile** | iOS-style grid home screen + bottom tab bar + sheet-based dialogs |
| 640–1024px | **Tablet** | 2-pane: sidebar of folders + main content; still touch-first |
| ≥ 1024px | **Desktop** (unchanged) | Current Mac-style draggable windows |

Current breakpoint in `useIsMobile` is 768px — move to 640 for the phone boundary and add a 1024 breakpoint for tablet.

## Mobile home screen (< 640px)

### Primary screen

Grid of icons laid out 4 columns wide (5 on wider phones), labels under each. Swipe horizontally between "pages" of 16 items (4×4) or 20 items (4×5). This mirrors iOS and meets users where they live.

```
╭─────────── status bar (theme-colored) ───────────╮
│  9:41                                    ⚙ 🔔  │
├──────────────────────────────────────────────────┤
│                                                  │
│   📁        📄        🖼        🎵               │
│  Photos    Notes    Wallpaper  Mixtape           │
│                                                  │
│   🖼        📁        🎨        🕹               │
│  IMG_1234   Docs    CSS Lab    Snake             │
│                                                  │
│   📝        🖼        ✨        ➕               │
│  Sticky   IMG_5678  Visualizer  Add              │
│                                                  │
│                                                  │
│                  · ● · ·                          │ (page indicator)
├──────────────────────────────────────────────────┤
│   🏠      🔎      🏛      👤                     │ (bottom tab bar)
│  Home   Search  Bazaar  Profile                   │
╰──────────────────────────────────────────────────╯
```

Labels and icons use the user's configured icon pack / theme. The background uses their wallpaper. The bottom bar respects their accent color. **The ricing carries through to mobile.**

### Gestures

- **Tap.** Open the item.
- **Long-press.** Haptic feedback → item lifts and shows a context menu (Rename, Make Public, Get Info, Move to Trash, Share). Same options as the desktop right-click menu, rendered as an action sheet.
- **Long-press + drag.** Rearrange items on the grid (iOS-style "jiggle" mode). Drop on another item's icon to stack → creates a folder ("Folder 1", user can rename).
- **Swipe left on an item row (in list view).** Quick actions: Share, Delete.
- **Pull down from home.** Reveals search input.
- **Swipe horizontally.** Change home page.
- **Pinch in.** Zoom out to full-grid overview (all pages visible at once, iOS home-screen-exit style).
- **Two-finger swipe up from bottom (or a gesture grabber at the bottom).** Opens app switcher (open windows still exist on mobile as "app tabs").

### Folders

Tapping a folder **navigates** (not opens-in-a-window). Full-screen folder view with its own grid. Back button in top-left to return. Breadcrumb-less — mobile users navigate with back, not breadcrumbs.

### Widgets

Widgets render inline on the home grid as "tiles" spanning multiple cells:

- Sticky note: 2×2 tile, preview of text.
- Music player: 4×2 tile (full row), scrubber + play button.
- Clock: 2×2, live.
- Link board: 2×2 or 4×2, top 4 links visible.
- Pixel canvas: 2×2 preview.
- Guestbook: 4×1, latest signature rotating.

Tap a widget to open its full view in a sheet (not a window). Sheets dismiss with swipe-down.

### Sheets over windows

On mobile, the window manager is replaced by sheets:

- **Viewer sheets** (image, video, audio, PDF, text) — full-screen, dismissable by swiping the grabber at the top.
- **Settings / Preferences** — modal sheet.
- **App intents** (opening a user-created app) — full-screen.
- **Context menus** — bottom action sheet.
- **Alerts** — centered card.

Swipe-down-to-dismiss is universal. Users never need to hunt for an X.

## Bottom tab bar

Four tabs:

1. **🏠 Home** — the grid we've described.
2. **🔎 Search** — fullscreen search, with tabs for Files / Profiles / Packs / Posts. Below the input, recent searches + trending tags.
3. **🏛 Bazaar** — browse packs; installs flow is a sheet; tap to preview.
4. **👤 Profile** — your profile as visitors see it, with "Edit" button and a tab to your own followers/following.

When a user-created app or a viewer is open, the tab bar gets a 5th temporary tab showing the active window. Tap it to return to the sheet. Tap the sheet's close to go back to the tab bar's normal state.

## Customization on mobile

This is where current mobile fails hardest. Target: **every** customization surface reachable on mobile in ≤ 3 taps.

### Appearance panel (mobile)

A single sheet with segmented tabs across the top:

- **Colors** — tap a swatch, opens color picker (native `<input type="color">` on mobile = system picker).
- **Wallpaper** — tap current wallpaper to replace; recents + presets + upload button.
- **Sounds** — soundpack selector + preview.
- **Cursor** — (skip on mobile — no visible cursor; but mobile users install packs for their future desktop use).
- **Layout** — grid density, label size, icon pack.
- **CSS** — full editor, syntax-highlighted (Monaco too heavy; use CodeMirror 6 mobile build). Shows live preview inline at the top as you scroll the editor.

### Theme selector

Dedicated screen (Profile → Appearance → Themes). Swipeable cards of installed skins. Each card shows a miniature of your desktop applied to that theme. Tap to apply; swipe up to save as favorite.

### Install from bazaar

Packs browse in a grid. Tap a pack → sheet slides up with preview carousel + description + install button. Install applies the pack and dismisses. Sheet has "Try before install" button: applies temporarily, showing a banner "Trying @alice's Cyberpunk — [Keep / Revert]" at the top.

## Visitor mode on mobile

Visiting `@bob` on mobile must render Bob's vibe, not a file list. Strategy:

- Apply Bob's theme, wallpaper, custom CSS to the mobile shell. Mobile respects the user's chosen tokens.
- Show Bob's items in his preferred layout (grid or list; he picks in his profile settings).
- Widgets render on his mobile home (guestbook, music player, profile card).
- A banner at top: `Visiting @bob · [Follow]`.
- Bottom tab bar shows: Desktop, Posts, Packs, About. Four views of Bob's identity.

Custom CSS safety: same content-security scoping as desktop — CSS is applied within a `.user-desktop` wrapper and cannot break out. On mobile the wrapper is the full viewport (minus status + tab bar).

## PWA

### Manifest (`public/manifest.webmanifest`)

```json
{
  "name": "EternalOS",
  "short_name": "EternalOS",
  "description": "Your personal desktop, on the web.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#8b5cf6",
  "icons": [
    { "src": "/icons/pwa-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/pwa-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/pwa-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [
        { "name": "files", "accept": ["image/*", "video/*", "audio/*", "application/pdf", "text/*"] }
      ]
    }
  },
  "shortcuts": [
    { "name": "New note", "url": "/?action=new-note" },
    { "name": "Take photo", "url": "/?action=camera" },
    { "name": "Explore", "url": "/explore" }
  ]
}
```

### Service worker

Minimum scope:

- **App shell caching** — static HTML/JS/CSS cached at install; navigate requests served from cache, updated in background (stale-while-revalidate).
- **Runtime caching** — R2 asset fetches cached with cache-first strategy (they're immutable per `Cache-Control: max-age=31536000, immutable`).
- **Offline fallback** — if offline and requesting a non-cached asset, return an offline placeholder card.
- **Background sync** — failed uploads queued and retried when connection returns (iOS limited here; Android full support).

Use `workbox` or a small hand-rolled SW. No preaching about offline-first — desktop paradigm doesn't love it — but the shell should load without the network.

### Share target

When `/share-target` receives a POST, treat it like a drag-drop upload. Show an upload sheet with:
- Files preview (thumbnails).
- Destination picker (root, or a specific folder).
- Public / Private toggle (defaulting to private, of course).
- Upload button.

iOS and Android both surface "share to EternalOS" in the system share sheet once installed.

### Install prompt

First-time mobile web visit, after 30 seconds of engagement OR after first meaningful action (upload, customize), show a subtle "Install EternalOS" banner at the top. Dismissable, remembered in localStorage.

## Camera & media upload

On mobile, replace the desktop file-picker with context-aware UI:

- **"Add" button** on home grid → action sheet with: Take Photo / Pick from Library / New Note / New Folder / New Link / Paste / From URL.
- **"Take Photo"** uses `<input type="file" accept="image/*" capture="environment">` — opens camera on iOS and Android.
- **"Pick from Library"** uses `accept="image/*,video/*,audio/*"` — opens system picker, multi-select supported.
- After capture/pick, show a quick preview with: rename input, public toggle, destination folder, [Upload] button.

## Lock-screen / live activities (iOS 16.2+)

Aspirational, not beta-blocking:

- **Guestbook live activity** — when someone signs your guestbook, surface a live activity on the lock screen ("@alice signed your guestbook: 'slay'"). Requires iOS native wrapper or a standards-based Web Push + notification action.
- **Now playing** — if the user has a music player widget open, expose `MediaSession` metadata so iOS shows lock-screen controls.
- **Home screen widget** — iOS/Android Web App widgets are... fraught. Wait for the spec to stabilize. For now, lean on rich push notifications.

## Notifications on mobile

- **Browser Web Push** works on iOS 16.4+ and Android. Register on first visit via the Inbox integration (see [02-social-v1.md](02-social-v1.md) §notifications).
- **Actions** on notifications — "reply" (opens compose sheet), "view" (opens the referenced post).
- **Badge** on the PWA icon (unread count).

## Mobile-specific widgets

Some widgets make more sense on phones than on desktops:

1. **Day counter** — "It's been X days since you iced @alice." Whimsical.
2. **Mood board** — user picks a handful of photos that define today. Fresh-faces everyone who visits.
3. **Now playing** widget that pairs with the music player app (via IPC from [01-apps-interop.md](01-apps-interop.md)).
4. **Lock-screen widget** (when the platform lets us) — next guestbook entry preview, now playing, day counter.

## Accessibility

- Tap targets minimum 44×44 px (iOS HIG).
- Respect `prefers-reduced-motion` — no jiggle mode animation, no swipe-page animation.
- Respect `prefers-color-scheme` at the theme defaults (user can override).
- All gestures have a button fallback (long-press menu exists as "..." button too).
- Screen reader labels on every icon ("folder, Photos, 24 items").
- Dynamic type — font-size scales with user's iOS/Android font setting. Our custom fonts must support this.

## Performance

**Budgets.**
- First Contentful Paint < 1.5s on throttled 4G / mid-range Android.
- Interactive < 3s on the same.
- Initial JS payload ≤ 150 KB gzipped (desktop currently ships ~300 KB; mobile layout should code-split).
- Images lazy-loaded below the fold.
- Prefer CSS transitions over JS animations.

**Code splitting.** `MobileBrowser` (and its new grid/tab system) is one bundle. Customization panel is another, lazy-loaded. CSS editor is a third, lazy-loaded. Window manager + viewers split off for sheets.

**Service worker** precaches the shell but not the window-manager bundle — users who never open a viewer don't pay for it.

## Tablet layout (640–1024px)

Not a phone, not a desktop. Two columns:

```
╭─────── menubar (collapsed to hamburger) ────────╮
├─────────────────┬─────────────────────────────────┤
│  📁 Photos     │                                  │
│  📄 Notes      │   [main content of selected     │
│  📁 Projects   │    folder or viewer]             │
│  📁 Trash      │                                  │
│                 │                                  │
│  ─── Bazaar ─── │                                  │
│  📦 Popular     │                                  │
│  ⭐ Featured    │                                  │
├─────────────────┴─────────────────────────────────┤
│                                        🏠 🔎 🏛 👤 │
╰───────────────────────────────────────────────────╯
```

Touch targets still 44×44. Sidebar scrollable. Main content gets a window-chrome-lite (title bar, close button) but not draggable — it's always filling the main area.

## What stays the same as desktop

- Routes (`/`, `/@username`, `/explore`, `/forum`, etc.).
- Data model and API.
- Customization tokens and CSS scoping.
- Notifications delivery (WS + Push).
- Identity / login flow (though login UI uses mobile-native inputs).

## What changes

- Component tree: add `MobileShell`, `TabletShell`, `DesktopShell` as top-level alternatives in [App.tsx](../packages/frontend/src/App.tsx).
- Window manager replaced by sheet manager on mobile.
- Dialogs and context menus rendered as action sheets on mobile.
- Customization UI rebuilt as bottom-sheet stack (discoverable, thumb-reachable).
- PWA manifest, SW, share-target, install prompt.
- Bottom tab bar component.

## Migration from current `MobileBrowser`

- Keep `MobileBrowser` for tablet layout as the sidebar (it's already close to that shape).
- Build `MobileHomeGrid`, `MobileTabBar`, `MobileAppearancePanel`, `MobileSheet` as new components.
- `useIsMobile` (existing) bumped: < 640 mobile, 640–1024 tablet, else desktop.
- Route `<App>` to the right shell at top-level.
- Preserve all stores and services unchanged.

## Open questions

- **Do we want native wrappers (React Native / Capacitor)?** PWA gets us 90%. Native gets us 100% (widgets, better sharing, App Store presence, push without iOS 16.4 floor). Decision: ship PWA now; revisit native in Phase 6 if retention + user pressure justify.
- **Default on mobile: grid or list?** Grid is more fun; list is more efficient. Offer both via user setting; default to grid because this is the personality product.
- **Desktop rendering on mobile (landscape or tablet).** If a power user explicitly asks for "show me desktop mode" on their big phone, honor it. Add a menu toggle.
- **Visitor mode fidelity.** Should a visitor's CSS on mobile be scaled to fit the smaller viewport (CSS `zoom: 0.8`)? Yes, with an option to disable if they've explicitly written mobile rules.

## Phased delivery

**Phase A (1 week).**
- PWA manifest + install prompt.
- Service worker with app-shell + R2 cache-first.
- Share target integration.
- Breakpoint rework (640 / 1024).

**Phase B (1.5 weeks).**
- MobileHomeGrid (4-column grid, pagination, swipe).
- MobileTabBar.
- Sheet manager replacing WindowManager on mobile.
- Camera / picker upload flow.
- Context action sheets.

**Phase C (1.5 weeks).**
- Full customization parity on mobile (appearance sheet + CSS editor).
- Mobile visitor mode with full theme fidelity.
- Mobile-specific widgets.
- Web Push registration + badging.

**Phase D (0.5 weeks).**
- Tablet 2-pane layout.
- Accessibility audit (VoiceOver + TalkBack).
- Performance pass.

## Success metrics

- Mobile DAU ≥ desktop DAU within 3 months.
- Mobile install (PWA) rate among mobile visitors ≥ 15%.
- Mobile session length within 25% of desktop session length.
- % of mobile users who make at least one customization within 7 days.
- Core Web Vitals (LCP, INP, CLS) passing on 95th percentile.
