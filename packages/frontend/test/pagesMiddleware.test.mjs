// functions/_middleware.ts: only social link-preview bots get the OG page,
// built from API_URL (no hardcoded API host) with a PNG og:image.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { onRequest, isSocialBot, apiOrigin } = await import('../functions/_middleware.ts');

const SPA = new Response('spa');

function run(path, { ua = 'Twitterbot/1.0', env = { API_URL: 'https://api.example.test/' }, visit } = {}) {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    return visit ?? Response.json({ username: 'alice', displayName: 'Alice <3', items: [1, 2] });
  };
  const context = {
    request: new Request(`https://eternalos.test${path}`, { headers: { 'User-Agent': ua } }),
    env,
    next: async () => SPA,
  };
  return onRequest(context).finally(() => { globalThis.fetch = realFetch; }).then((response) => ({ response, fetched }));
}

test('social bots match; search crawlers and browsers do not', () => {
  for (const ua of ['facebookexternalhit/1.1', 'Mozilla/5.0 (compatible; Discordbot/2.0)', 'Slackbot-LinkExpanding 1.0', 'Twitterbot/1.0', 'Bluesky Cardyb/1.1']) {
    assert.equal(isSocialBot(ua), true, ua);
  }
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'Mozilla/5.0 (Macintosh) Safari/605.1.15']) {
    assert.equal(isSocialBot(ua), false, ua);
  }
});

test('apiOrigin accepts only http(s) URLs', () => {
  assert.equal(apiOrigin('https://api.example.test/'), 'https://api.example.test');
  assert.equal(apiOrigin(undefined), null);
  assert.equal(apiOrigin('javascript:alert(1)'), null);
  assert.equal(apiOrigin('not a url'), null);
});

test('a social bot on /@user gets OG tags from API_URL', async () => {
  const { response, fetched } = await run('/@alice');
  assert.deepEqual(fetched, ['https://api.example.test/api/visit/alice']);
  const html = await response.text();
  assert.match(html, /<meta property="og:image" content="https:\/\/api\.example\.test\/api\/og\/alice\.png" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/eternalos\.test\/@alice" \/>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/eternalos\.test\/@alice" \/>/);
  assert.match(html, /Alice &lt;3's Desktop/);
  assert.doesNotMatch(html, /<script/);
});

test('mixed-case usernames get the lowercase canonical URL', async () => {
  const { response, fetched } = await run('/@Alice');
  assert.deepEqual(fetched, ['https://api.example.test/api/visit/alice']);
  assert.match(await response.text(), /<link rel="canonical" href="https:\/\/eternalos\.test\/@alice" \/>/);
});

test('HEAD from a bot gets the preview headers without a body', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ displayName: 'Alice' });
  try {
    const response = await onRequest({
      request: new Request('https://eternalos.test/@alice', { method: 'HEAD', headers: { 'User-Agent': 'Twitterbot/1.0' } }),
      env: { API_URL: 'https://api.example.test' },
      next: async () => SPA,
    });
    assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
    assert.equal(await response.text(), '');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('browsers, search crawlers, other paths and a missing API_URL pass through', async () => {
  for (const options of [
    { ua: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
    { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    { env: {} },
  ]) {
    const { response, fetched } = await run('/@alice', options);
    assert.equal(response, SPA);
    assert.deepEqual(fetched, []);
  }
  const other = await run('/desktop');
  assert.equal(other.response, SPA);
  const missing = await run('/@nobody', { visit: new Response('nope', { status: 404 }) });
  assert.equal(missing.response, SPA);
});
