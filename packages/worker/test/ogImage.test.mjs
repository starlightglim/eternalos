// og:image: /api/og/:username.png must be a real 1200×630 PNG (social
// crawlers don't render SVG), drawn with the bundled font.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

register(new URL('./tsModuleHooks.mjs', import.meta.url));
const { parseOgTarget, generateDesktopSvg, rasterizeOgSvg, handleOgImage, ogFontCanRender } = await import('../src/routes/ogImage.ts');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function fakeEnv({ users = {}, snapshot = null } = {}) {
  const kv = new Map();
  return {
    kv,
    AUTH_KV: { get: async (key) => users[key] ?? null },
    DESKTOP_KV: {
      getWithMetadata: async (key) => kv.get(key) ?? { value: null, metadata: null },
      put: async (key, value, options) => {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        kv.set(key, { value: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), metadata: options?.metadata ?? null });
      },
    },
    USER_DESKTOP: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async () => snapshot ? Response.json(snapshot) : new Response('no', { status: 404 }),
      }),
    },
  };
}

describe('parseOgTarget', () => {
  it('reads the username and format from the path segment', () => {
    assert.deepEqual(parseOgTarget('Alice.png'), { username: 'alice', format: 'png' });
    assert.deepEqual(parseOgTarget('alice.svg'), { username: 'alice', format: 'svg' });
    assert.deepEqual(parseOgTarget('alice'), { username: 'alice', format: 'png' });
  });
});

describe('font coverage', () => {
  it('knows what the bundled font can draw', () => {
    assert.equal(ogFontCanRender('Alice Smith 42!'), true);
    assert.equal(ogFontCanRender('Café'), true);
    assert.equal(ogFontCanRender('山田'), false);
    assert.equal(ogFontCanRender('Жанна'), false);
    assert.equal(ogFontCanRender('…'), false);
  });

  it('never draws text the font lacks: names fall back, descriptions drop', () => {
    const svg = generateDesktopSvg('yamada', '山田', [
      { id: '1', type: 'folder', name: '写真', parentId: null, isTrashed: false },
      { id: '2', type: 'text', name: '日記.txt', parentId: null, isTrashed: false },
    ], { shareDescription: 'こんにちは' }, ogFontCanRender);
    assert.doesNotMatch(svg, /[぀-鿿]/);
    assert.match(svg, /yamada's Desktop/);
    assert.match(svg, /<tspan>Folder<\/tspan>/);
    assert.match(svg, /<tspan>\.txt<\/tspan>/);
  });
});

describe('rasterizeOgSvg', () => {
  it('turns the desktop SVG into a 1200×630 PNG', async () => {
    const svg = generateDesktopSvg('alice', 'Alice', [
      { id: '1', type: 'folder', name: 'Projects', parentId: null, isTrashed: false },
      { id: '2', type: 'text', name: 'Read me.txt', parentId: null, isTrashed: false },
      { id: '3', type: 'audio', name: 'A very long song name.mp3', parentId: null, isTrashed: false },
    ], { desktopColor: '#4A6FA5', shareDescription: 'A quiet corner of the web' });
    const png = await rasterizeOgSvg(svg);
    assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE);
    assert.deepEqual(pngSize(png), { width: 1200, height: 630 });
    if (process.env.OG_IMAGE_OUT) writeFileSync(process.env.OG_IMAGE_OUT, png);
  });
});

describe('handleOgImage', () => {
  const users = { 'username:alice': { uid: 'u1' } };
  const snapshot = { items: [], profile: { displayName: 'Alice', desktopColor: '#4A6FA5' } };

  it('serves image/png bytes for .png and caches them', async () => {
    const env = fakeEnv({ users, snapshot });
    const response = await handleOgImage(new Request('http://x/api/og/alice.png'), env, 'alice.png');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE);
    assert.equal(env.kv.get('og:png:u1').metadata.contentType, 'image/png');

    const cached = await handleOgImage(new Request('http://x/api/og/alice.png'), env, 'alice.png');
    assert.equal(cached.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), bytes);
  });

  it('serves SVG under image/svg+xml for .svg', async () => {
    const env = fakeEnv({ users, snapshot });
    const response = await handleOgImage(new Request('http://x/api/og/alice.svg'), env, 'alice.svg');
    assert.equal(response.headers.get('Content-Type'), 'image/svg+xml');
    assert.match(await response.text(), /#4A6FA5/);
  });

  it('answers unknown users with a 404 PNG', async () => {
    const response = await handleOgImage(new Request('http://x/api/og/nobody.png'), fakeEnv(), 'nobody.png');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Content-Type'), 'image/png');
  });
});
