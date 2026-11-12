import { afterEach, describe, expect, test, vi } from 'vitest';
import type { EsthemeManifest } from './estheme';
import { installTheme, previewTheme } from './installTheme';

// installTheme/previewTheme are fetch-driven: GET pack+manifest, GET each
// declared layer asset, PATCH /api/profile, POST install counter. We stub the
// global fetch with a tiny router keyed on the URL path so we can assert the
// assembled profile patch, the applied/skipped layer bookkeeping, and the
// error-to-warning handling without a live worker.

const PACK_ID = 'pack-123';

type RouteBody = { json?: unknown; text?: string; ok?: boolean; status?: number };
type Router = (url: string, init?: RequestInit) => RouteBody;

function makeResponse(body: RouteBody): Response {
  const ok = body.ok ?? true;
  const status = body.status ?? (ok ? 200 : 404);
  return {
    ok,
    status,
    json: async () => body.json,
    text: async () => body.text ?? (body.json !== undefined ? JSON.stringify(body.json) : ''),
  } as Response;
}

/** Records every fetch call and routes it through `router`. */
function installFetch(router: Router): { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return makeResponse(router(url, init));
  });
  (globalThis as unknown as { fetch: typeof fn }).fetch = fn;
  return { calls };
}

function manifest(layers: EsthemeManifest['layers']): EsthemeManifest {
  return {
    formatVersion: 1,
    id: 'retro-mint',
    name: 'Retro Mint',
    version: '1.0.0',
    author: '@tester',
    layers,
  };
}

/** Default router covering a full four-layer theme. */
function fullThemeRouter(m: EsthemeManifest): Router {
  return (url) => {
    if (url.includes(`/api/bazaar/pack/`)) return { json: { pack: { packId: PACK_ID }, manifest: m } };
    if (url.includes('/tokens.json')) return { json: { accentColor: '#00ffcc', designTokens: { 'window.titleBar.background': '#111' } } };
    if (url.includes('/theme.css')) return { text: '.window { border-radius: 8px; }' };
    if (url.includes('/variants.json')) return { json: { aqua: 'blue', graphite: 'gray' } };
    if (url.includes('/typography.json')) return { json: { systemFont: 'Chicago', bodyFont: 'Geneva', fontSmoothing: false } };
    if (url.includes('/api/profile')) return { json: { ok: true } };
    if (url.includes('/api/bazaar/install/')) return { json: { success: true } };
    return { ok: false, status: 404 };
  };
}

const origFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as unknown as { fetch: typeof origFetch }).fetch = origFetch;
  vi.restoreAllMocks();
});

describe('installTheme', () => {
  test('assembles the profile patch from every non-asset layer', async () => {
    const m = manifest({
      tokens: 'tokens.json',
      css: 'theme.css',
      variants: 'variants.json',
      typography: 'typography.json',
    });
    const { calls } = installFetch(fullThemeRouter(m));

    const result = await installTheme(PACK_ID, 'tok');

    expect(result.success).toBe(true);
    expect(result.appliedLayers.sort()).toEqual(['css', 'tokens', 'typography', 'variants']);
    expect(result.skippedLayers).toEqual([]);

    const patchCall = calls.find((c) => c.url.includes('/api/profile'));
    expect(patchCall?.init?.method).toBe('PATCH');
    const patch = JSON.parse(String(patchCall?.init?.body));
    expect(patch.accentColor).toBe('#00ffcc');
    expect(patch.designTokens).toEqual({ 'window.titleBar.background': '#111' });
    expect(patch.customCSS).toBe('.window { border-radius: 8px; }');
    expect(patch.variants).toEqual({ aqua: 'blue', graphite: 'gray' });
    expect(patch.systemFont).toBe('Chicago');
    expect(patch.fontSmoothing).toBe(false);
  });

  test('sends the auth token as a Bearer header on the profile PATCH', async () => {
    const m = manifest({ tokens: 'tokens.json' });
    const { calls } = installFetch(fullThemeRouter(m));

    await installTheme(PACK_ID, 'secret-token');

    const patchCall = calls.find((c) => c.url.includes('/api/profile'));
    const headers = patchCall?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
  });

  test('a failed layer fetch becomes a warning and does not abort the others', async () => {
    const m = manifest({ tokens: 'tokens.json', css: 'theme.css' });
    installFetch((url) => {
      if (url.includes('/api/bazaar/pack/')) return { json: { pack: {}, manifest: m } };
      if (url.includes('/tokens.json')) return { ok: false, status: 500 }; // tokens blow up
      if (url.includes('/theme.css')) return { text: '.x{}' };
      if (url.includes('/api/profile')) return { json: {} };
      return { json: {} };
    });

    const result = await installTheme(PACK_ID, 'tok');

    expect(result.appliedLayers).toEqual(['css']);
    expect(result.warnings.some((w) => w.includes('tokens'))).toBe(true);
    expect(result.success).toBe(true);
  });

  test('asset-bearing layers are skipped with a warning', async () => {
    const m = manifest({
      tokens: 'tokens.json',
      wallpaper: { ref: 'wallpaper.jpg', mode: 'cover' } as never,
      cursors: { default: 'cursors/d.png' } as never,
      sounds: { click: 'sounds/c.wav' } as never,
      icons: { trash: 'icons/t.png' } as never,
    });
    installFetch(fullThemeRouter(m));

    const result = await installTheme(PACK_ID, 'tok');

    expect(result.appliedLayers).toEqual(['tokens']);
    expect(result.skippedLayers.sort()).toEqual(['cursors', 'icons', 'sounds', 'wallpaper']);
    expect(result.warnings.length).toBeGreaterThanOrEqual(4);
  });

  test('does NOT PATCH the profile when no fetchable layer applied', async () => {
    const m = manifest({ wallpaper: { ref: 'w.jpg', mode: 'cover' } as never });
    const { calls } = installFetch(fullThemeRouter(m));

    const result = await installTheme(PACK_ID, 'tok');

    expect(result.appliedLayers).toEqual([]);
    expect(calls.some((c) => c.url.includes('/api/profile'))).toBe(false);
  });

  test('fires the install counter best-effort', async () => {
    const m = manifest({ tokens: 'tokens.json' });
    const { calls } = installFetch(fullThemeRouter(m));

    await installTheme(PACK_ID, 'tok');

    const counter = calls.find((c) => c.url.includes(`/api/bazaar/install/${PACK_ID}`));
    expect(counter?.init?.method).toBe('POST');
  });

  test('throws when the pack is not a .estheme bundle (manifest null)', async () => {
    installFetch((url) => {
      if (url.includes('/api/bazaar/pack/')) return { json: { pack: {}, manifest: null } };
      return { json: {} };
    });

    await expect(installTheme(PACK_ID, 'tok')).rejects.toThrow(/not a .estheme bundle/i);
  });

  test('throws when the pack fetch fails', async () => {
    installFetch((url) => {
      if (url.includes('/api/bazaar/pack/')) return { ok: false, status: 404 };
      return { json: {} };
    });

    await expect(installTheme(PACK_ID, 'tok')).rejects.toThrow(/Pack not found/i);
  });

  test('throws with the server status when the profile PATCH is rejected', async () => {
    const m = manifest({ tokens: 'tokens.json' });
    installFetch((url) => {
      if (url.includes('/api/bazaar/pack/')) return { json: { pack: {}, manifest: m } };
      if (url.includes('/tokens.json')) return { json: { accentColor: '#fff' } };
      if (url.includes('/api/profile')) return { ok: false, status: 400, text: 'bad token' };
      return { json: {} };
    });

    await expect(installTheme(PACK_ID, 'tok')).rejects.toThrow(/Failed to apply theme/i);
  });
});

describe('previewTheme', () => {
  test('returns the would-be patch without PATCHing the profile', async () => {
    const m = manifest({ tokens: 'tokens.json', css: 'theme.css' });
    const { calls } = installFetch(fullThemeRouter(m));

    const { manifest: gotManifest, patch, warnings } = await previewTheme(PACK_ID);

    expect(gotManifest.id).toBe('retro-mint');
    expect(patch.accentColor).toBe('#00ffcc');
    expect(patch.customCSS).toBe('.window { border-radius: 8px; }');
    expect(warnings).toEqual([]);
    expect(calls.some((c) => c.url.includes('/api/profile'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/api/bazaar/install/'))).toBe(false);
  });

  test('throws when the pack is not a .estheme bundle', async () => {
    installFetch((url) => {
      if (url.includes('/api/bazaar/pack/')) return { json: { pack: {}, manifest: null } };
      return { json: {} };
    });

    await expect(previewTheme(PACK_ID)).rejects.toThrow(/not a .estheme bundle/i);
  });
});
