import { expect, expectTypeOf, test, describe } from 'vitest';
import { getTextFileContentType } from './index';
import type { DesktopItem, UserProfile } from './index';
import type {
  AppGrantedPermissions,
  DesktopItem as ContractsDesktopItem,
  UserProfile as ContractsUserProfile,
} from '@eternalos/contracts';

describe('getTextFileContentType', () => {
  test('classifies markdown by extension', () => {
    expect(getTextFileContentType('README.md')).toBe('markdown');
    expect(getTextFileContentType('notes.markdown')).toBe('markdown');
  });

  test('classifies known code extensions (case-insensitive)', () => {
    for (const name of ['app.tsx', 'main.PY', 'style.css', 'data.json', 'run.sh', 'mod.rs']) {
      expect(getTextFileContentType(name), name).toBe('code');
    }
  });

  test('falls back to plain text for everything else', () => {
    for (const name of ['notes.txt', 'noextension', 'archive.zip', 'photo.png']) {
      expect(getTextFileContentType(name), name).toBe('text');
    }
  });

  test('matches only the final extension', () => {
    expect(getTextFileContentType('readme.md.txt')).toBe('text');
    expect(getTextFileContentType('script.txt.py')).toBe('code');
  });
});

// ---------------------------------------------------------------------------
// Shared contracts (@eternalos/contracts)
//
// These are compile-time assertions: expectTypeOf matchers fail `tsc` (and
// vitest --typecheck) rather than at runtime. They guard the re-export
// wiring in src/types/index.ts and the reconciled field shapes documented in
// packages/contracts/README.md — the frontend and worker previously declared
// these types independently, with drift.
// ---------------------------------------------------------------------------

describe('shared contracts re-exports', () => {
  test('frontend types are the shared contracts types, not divergent copies', () => {
    expectTypeOf<DesktopItem>().toEqualTypeOf<ContractsDesktopItem>();
    expectTypeOf<UserProfile>().toEqualTypeOf<ContractsUserProfile>();
  });
});

describe('reconciled DesktopItem shape', () => {
  test('grantedPermissions is the full AppGrantedPermissions wire shape (not a narrowed subset)', () => {
    expectTypeOf<DesktopItem['grantedPermissions']>().toEqualTypeOf<AppGrantedPermissions | undefined>();
    // Both former declarations' fields must survive the merge:
    expectTypeOf<AppGrantedPermissions['handlers']>().not.toBeUndefined();
    expectTypeOf<AppGrantedPermissions['fs']>().not.toBeUndefined();
    expectTypeOf<AppGrantedPermissions['profile']>().not.toBeUndefined();
  });

  test('keeps the frontend-declared thumbnailKey field the worker never writes', () => {
    expectTypeOf<DesktopItem['thumbnailKey']>().toEqualTypeOf<string | undefined>();
  });
});

describe('reconciled UserProfile shape', () => {
  test('displayName stays required (every construction site sets it; the wire format always includes it)', () => {
    expectTypeOf<UserProfile['displayName']>().toEqualTypeOf<string>();
  });

  test('wallpaper stays optional (clients build interim profiles before fetching the real one)', () => {
    expectTypeOf<UserProfile['wallpaper']>().toEqualTypeOf<string | undefined>();
  });

  test('soundPack keys stay unconstrained (the server validates URL prefixes, not slot names)', () => {
    expectTypeOf<NonNullable<UserProfile['soundPack']>['sounds']>().toEqualTypeOf<Partial<Record<string, string>>>();
  });
});
