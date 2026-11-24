// App documents must be frameable by the real frontend origins. Their baked-in
// CSP said `frame-ancestors 'self'` (the API origin), so production browsers
// refused to render every installed app inside eternalos.me.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { allowFramingByFrontend, frameAncestorsFor } from '../src/utils/appFraming.ts';

const BAKED_CSP = "default-src 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline'";
const PROD = { ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://eternalos.me, https://www.eternalos.me,javascript:alert(1)' };

describe('app document framing', () => {
  it('lists the configured https frontend origins in production', () => {
    assert.equal(frameAncestorsFor(PROD), "'self' https://eternalos.me https://www.eternalos.me");
  });

  it('allows local frontends in development', () => {
    assert.match(frameAncestorsFor({ ENVIRONMENT: 'development' }), /http:\/\/localhost:\*/);
  });

  it('rewrites only the frame-ancestors directive and keeps the rest', async () => {
    const original = new Response('<h1>hi</h1>', {
      status: 200,
      headers: { 'content-security-policy': BAKED_CSP, 'content-type': 'text/html' },
    });
    const rewritten = allowFramingByFrontend(original, PROD);
    assert.equal(
      rewritten.headers.get('content-security-policy'),
      "default-src 'none'; frame-ancestors 'self' https://eternalos.me https://www.eternalos.me; script-src 'self' 'unsafe-inline'",
    );
    assert.equal(rewritten.headers.get('content-type'), 'text/html');
    assert.equal(await rewritten.text(), '<h1>hi</h1>');
  });

  it('leaves responses without a frame-ancestors CSP untouched', () => {
    const plain = new Response('x', { headers: { 'content-type': 'text/css' } });
    assert.equal(allowFramingByFrontend(plain, PROD), plain);
  });
});

describe('app static files under an opaque origin', async () => {
  const { allowOpaqueOriginAssets } = await import('../src/utils/appFraming.ts');
  const js = () => new Response('export {}', { headers: { 'content-type': 'text/javascript' } });

  it('lets the sandboxed app load its own module scripts', () => {
    assert.equal(allowOpaqueOriginAssets(js(), 'GET', 'app.js').headers.get('access-control-allow-origin'), '*');
    assert.equal(allowOpaqueOriginAssets(js(), 'GET', '').headers.get('access-control-allow-origin'), '*');
  });

  it('leaves the bridge, the backend, writes and existing policies alone', () => {
    assert.equal(allowOpaqueOriginAssets(js(), 'GET', '_eternal/fs/list').headers.get('access-control-allow-origin'), null);
    assert.equal(allowOpaqueOriginAssets(js(), 'GET', 'api/books').headers.get('access-control-allow-origin'), null);
    assert.equal(allowOpaqueOriginAssets(js(), 'POST', 'app.js').headers.get('access-control-allow-origin'), null);
    const chosen = new Response('', { headers: { 'access-control-allow-origin': 'https://eternalos.me' } });
    assert.equal(allowOpaqueOriginAssets(chosen, 'GET', 'app.js').headers.get('access-control-allow-origin'), 'https://eternalos.me');
  });
});
