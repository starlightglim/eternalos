import { expect, test, describe, beforeAll } from 'vitest';
import {
  TOKEN_REGISTRY,
  ALL_TOKEN_PATHS,
  getAllCSSVars,
  getTokenByPath,
  getTokensByTab,
  getConditionalTokens,
  findTokenDefinition,
} from './tokenSchema';
import { registerBuiltinVariants } from '../variants/registerBuiltins';

/**
 * Token registry integrity. TOKEN_REGISTRY is the single source of truth for
 * every appearance property; a duplicate path, a clashing profile key, or a
 * CSS var declared by two tokens silently breaks theming. These invariants are
 * cheap to assert and catch copy-paste mistakes before they ship.
 */

const TABS = new Set(['themes', 'palette', 'windows', 'controls', 'typography', 'preview']);

describe('TOKEN_REGISTRY', () => {
  test('is non-empty', () => {
    expect(TOKEN_REGISTRY.length).toBeGreaterThan(0);
  });

  test('every token path is unique', () => {
    const paths = TOKEN_REGISTRY.map((t) => t.path);
    const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
    expect(dupes, `duplicate paths: ${[...new Set(dupes)].join(', ')}`).toEqual([]);
  });

  test('every non-null profileKey is unique (no two tokens write one field)', () => {
    const keys = TOKEN_REGISTRY.map((t) => t.profileKey).filter((k): k is string => k !== null);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes, `duplicate profileKeys: ${[...new Set(dupes)].join(', ')}`).toEqual([]);
  });

  test('no CSS var is declared by two different tokens', () => {
    // A var set by two tokens means the second silently clobbers the first.
    const owners = new Map<string, string[]>();
    for (const token of TOKEN_REGISTRY) {
      for (const v of token.cssVars ?? []) {
        owners.set(v, [...(owners.get(v) ?? []), token.path]);
      }
    }
    const clashes = [...owners.entries()].filter(([, paths]) => paths.length > 1);
    expect(clashes.map(([v, paths]) => `${v} ← ${paths.join(', ')}`)).toEqual([]);
  });

  test('every token has the required fields and a known tab', () => {
    for (const token of TOKEN_REGISTRY) {
      expect(token.path, 'path').toBeTruthy();
      expect(token.label, token.path).toBeTruthy();
      expect(token.valueType, token.path).toBeTruthy();
      expect(token.defaultValue, token.path).toBeDefined();
      expect(TABS.has(token.tab), `${token.path}: tab=${token.tab}`).toBe(true);
    }
  });

  test('select tokens carry an options list; number tokens carry constraints', () => {
    for (const token of TOKEN_REGISTRY) {
      if (token.valueType === 'select') {
        expect(Array.isArray(token.options) && token.options.length > 0, token.path).toBe(true);
      }
      if (token.valueType === 'number' && token.numberConstraints) {
        const { min, max } = token.numberConstraints;
        if (typeof min === 'number' && typeof max === 'number') {
          expect(min, token.path).toBeLessThanOrEqual(max);
        }
      }
    }
  });
});

describe('ALL_TOKEN_PATHS', () => {
  test('matches the registry exactly', () => {
    expect(ALL_TOKEN_PATHS.size).toBe(TOKEN_REGISTRY.length);
    for (const token of TOKEN_REGISTRY) {
      expect(ALL_TOKEN_PATHS.has(token.path)).toBe(true);
    }
  });
});

describe('getAllCSSVars', () => {
  test('returns a deduped list of --prefixed vars', () => {
    const vars = getAllCSSVars();
    expect(vars.length).toBe(new Set(vars).size); // deduped
    for (const v of vars) expect(v.startsWith('--'), v).toBe(true);
  });
});

describe('lookup helpers', () => {
  test('getTokenByPath finds a known token and misses an unknown one', () => {
    const first = TOKEN_REGISTRY[0];
    expect(getTokenByPath(first.path)?.path).toBe(first.path);
    expect(getTokenByPath('no.such.token')).toBeUndefined();
  });

  test('getTokensByTab returns only tokens on that tab', () => {
    const palette = getTokensByTab('palette');
    expect(palette.length).toBeGreaterThan(0);
    for (const token of palette) expect(token.tab).toBe('palette');
  });
});

describe('variant-registered conditional tokens (sprite/skin system)', () => {
  // Conditional tokens live in the variant registry, NOT in TOKEN_REGISTRY —
  // but the customization pipeline (token routing + compiler + var clearance)
  // must see them, or every SpriteEditor write silently no-ops.
  beforeAll(() => {
    registerBuiltinVariants();
  });

  test('variants register sprite, texture, and gradient tokens', () => {
    const paths = getConditionalTokens().map((t) => t.path);
    expect(paths).toContain('chrome.sprite.url');
    expect(paths).toContain('chrome.sprite.sliceTop');
    expect(paths).toContain('titlebar.sprite.url');
    expect(paths).toContain('buttons.sprite.close');
    expect(paths).toContain('buttons.sprite.width');
    expect(paths).toContain('resize.sprite.url');
    expect(paths).toContain('window.titleBar.gradientStart');
  });

  test('findTokenDefinition resolves conditional tokens that a registry-only lookup drops', () => {
    // The regression this guards: TOKEN_REGISTRY.find('chrome.sprite.url')
    // misses, which used to make buildTokenUpdate return {} (a no-op write).
    expect(TOKEN_REGISTRY.find((t) => t.path === 'chrome.sprite.url')).toBeUndefined();
    expect(findTokenDefinition('chrome.sprite.url')?.profileKey).toBeNull();
    expect(findTokenDefinition('buttons.sprite.close')?.profileKey).toBeNull();
    expect(findTokenDefinition('window.titleBar.gradientStart')?.profileKey).toBeNull();
    // Registry tokens still resolve first...
    const first = TOKEN_REGISTRY[0];
    expect(findTokenDefinition(first.path)?.path).toBe(first.path);
    // ...and truly unknown paths still miss (the fallback is not a wildcard).
    expect(findTokenDefinition('no.such.token')).toBeUndefined();
    expect(getTokenByPath('chrome.sprite.url')?.path).toBe('chrome.sprite.url');
  });

  test('conditional token paths are unique and never shadow registry paths', () => {
    const registryPaths = new Set(TOKEN_REGISTRY.map((t) => t.path));
    const condPaths = getConditionalTokens().map((t) => t.path);
    expect(new Set(condPaths).size, 'conditional paths must be unique').toBe(condPaths.length);
    for (const p of condPaths) {
      expect(registryPaths.has(p), `${p} shadows a registry token`).toBe(false);
    }
  });

  test('no CSS var is declared by both the registry and a conditional token', () => {
    const registryVars = new Set(TOKEN_REGISTRY.flatMap((t) => t.cssVars ?? []));
    for (const token of getConditionalTokens()) {
      for (const v of token.cssVars ?? []) {
        expect(registryVars.has(v), `${v} declared by both ${token.path} and a registry token`).toBe(false);
      }
    }
  });

  test('conditional vars are tracked by getAllCSSVars so the DOM can clear them', () => {
    const vars = getAllCSSVars();
    expect(vars).toContain('--eos-chrome-sprite-url');
    expect(vars).toContain('--eos-sprite-btn-close');
    expect(vars).toContain('--eos-sprite-resize-url');
    expect(vars).toContain('--eos-titlebar-gradient-start');
  });
});
