# @eternalos/contracts

Shared domain types for the EternalOS frontend (`@eternalos/frontend`) and
worker (`@eternalos/worker`). **Types only — no logic, no zod schemas
(yet).** The single runtime value is `CARTRIDGE_LIMITS`, a frozen literal the
worker validator and the frontend editor both read. Runtime validation at network boundaries is planned follow-up work
(design/RELEASE-READINESS.md, "Structure" item 1).

Both packages re-export these names from their own type modules
(`packages/frontend/src/types/index.ts`, `packages/worker/src/types.ts`, and
`utils/jwt.ts` for `AppGrantedPermissions`), so most imports don't change.

## What lives here

A common domain type belongs here when **both** deployables declare or use
it. Today that is the `DesktopItem` graph (item types, widget configs,
sticker/image-analysis metadata, app manifests and permission shapes),
`UserProfile`, sound/cursor skins (`SoundType`, `SoundPack`, `CursorState`,
`SoundAssetMeta`, `CursorAssetMeta`), `CustomCSSVersion`, and the fantasy
console `Cartridge`/`CartridgeMeta` plus `CARTRIDGE_LIMITS`. Types used by
only one package (worker auth records, bazaar types; frontend window state,
cartridge draft summaries, menu types, `AuthUser`) stay in that package.

Old import locations re-export the moved names (`worker/src/types.ts`,
`worker/src/utils/cartridge.ts`, `frontend/src/types/index.ts`,
`stores/soundStore.ts`, `services/appearance.ts`).

## Reconciliation record (2026-11)

The frontend and worker previously declared these types independently, with
drift. Differences found and how they were resolved (no field was widened or
narrowed silently):

| Type / field | Frontend | Worker | Shared resolution |
| --- | --- | --- | --- |
| `DesktopItem.thumbnailKey` | optional field | absent | kept optional — frontend-declared; the worker never writes it (not in its create/update allowlists), so dropping it would narrow the frontend |
| `DesktopItem.grantedPermissions` | fs (read/write/delete/mimeTypes), profile, network, handlers, ipc | fs (read/mimeTypes), profile only — "v1 surface" | full `AppGrantedPermissions` (moved from worker `utils/jwt.ts`): that is the exact shape `routes/apps.ts` writes onto items |
| `UserProfile.displayName` | optional | required | **required** — every construction site on both sides sets it; the wire format always includes it |
| `UserProfile.wallpaper` | optional | required | **optional** — the frontend builds interim profiles (authStore login/signup) without it and the visitor response omits it when unset |
| `UserProfile.soundPack` | loose `{ sounds: Partial<Record<string, string>> }` | `SoundPack` keyed by `SoundType` | **loose** — the server validates URL prefixes, not slot names, so arbitrary keys round-trip |
| `DesktopItem.type` | named `DesktopItemType` alias | inline union (same members) | named alias, same union |
| `AppManifest.windowConfig` | inline object type | named `AppWindowConfig` (structurally identical) | named `AppWindowConfig` |

A type-level regression test in `packages/frontend/src/types/index.test.ts`
locks the re-export wiring and the reconciled field shapes; it runs with the
vitest suite and is enforced by typecheck.
