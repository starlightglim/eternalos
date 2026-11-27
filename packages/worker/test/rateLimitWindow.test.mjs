/**
 * Unit tests for the fixed-window rate-limit counter
 * (src/durable-objects/rateLimitWindow.ts), the per-IP client identifier and
 * the CORS header resolution (src/middleware/http.ts). Runs under plain
 * node --test (Node strips the erasable TS syntax).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyRateLimitCheck,
  rateLimitWindowExpired,
} from '../src/durable-objects/rateLimitWindow.ts';

const MINUTE = 60_000;

describe('fixed-window rate-limit counter', () => {
  it('opens a window at the first request and counts admitted requests', () => {
    const { window, result } = applyRateLimitCheck(null, { maxRequests: 3, windowMs: MINUTE, now: 1_000 });
    assert.deepEqual(window, { start: 1_000, windowMs: MINUTE, count: 1 });
    assert.deepEqual(result, { allowed: true, remaining: 2, resetAt: 1_000 + MINUTE });
  });

  it('rejects past the limit without changing the counter, then resets', () => {
    let stored = null;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const { window, result } = applyRateLimitCheck(stored, { maxRequests: 3, windowMs: MINUTE, now: 1_000 + i });
      if (result.allowed) stored = window;
      statuses.push(result.allowed);
    }
    assert.deepEqual(statuses, [true, true, true, false, false]);
    assert.equal(stored.count, 3);

    const rejected = applyRateLimitCheck(stored, { maxRequests: 3, windowMs: MINUTE, now: 31_000 });
    assert.equal(rejected.result.allowed, false);
    assert.equal(rejected.result.remaining, 0);
    assert.equal(rejected.result.resetAt, 1_000 + MINUTE);
    assert.equal(rejected.result.retryAfter, 30);

    // The window ends exactly at start + windowMs.
    assert.equal(rateLimitWindowExpired(stored, 1_000 + MINUTE - 1), false);
    assert.equal(rateLimitWindowExpired(stored, 1_000 + MINUTE), true);
    const next = applyRateLimitCheck(stored, { maxRequests: 3, windowMs: MINUTE, now: 1_000 + MINUTE });
    assert.equal(next.result.allowed, true);
    assert.deepEqual(next.window, { start: 1_000 + MINUTE, windowMs: MINUTE, count: 1 });
  });

  it('keeps the stored state constant-size no matter the limit', () => {
    let stored = null;
    for (let i = 0; i < 1000; i++) {
      stored = applyRateLimitCheck(stored, { maxRequests: 1000, windowMs: MINUTE, now: i }).window;
    }
    assert.deepEqual(Object.keys(stored).sort(), ['count', 'start', 'windowMs']);
    assert.equal(stored.count, 1000);
    assert.equal(applyRateLimitCheck(stored, { maxRequests: 1000, windowMs: MINUTE, now: 1000 }).result.allowed, false);
  });

  it('starts a new window when the configured window length changes', () => {
    const stored = { start: 0, windowMs: MINUTE, count: 5 };
    const { window, result } = applyRateLimitCheck(stored, { maxRequests: 5, windowMs: 2 * MINUTE, now: 10 });
    assert.equal(result.allowed, true);
    assert.deepEqual(window, { start: 10, windowMs: 2 * MINUTE, count: 1 });
  });
});

describe('per-IP client identifier', async () => {
  const { getClientId } = await import('../src/middleware/rateLimit.ts');

  it('uses CF-Connecting-IP and never the spoofable X-Forwarded-For', () => {
    const both = new Request('http://w/api/x', {
      headers: { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' },
    });
    assert.equal(getClientId(both), '203.0.113.7');

    const spoofed = new Request('http://w/api/x', { headers: { 'X-Forwarded-For': '198.51.100.1' } });
    assert.equal(getClientId(spoofed), 'unknown');
  });
});

describe('CORS headers', async () => {
  const { getCorsHeaders } = await import('../src/middleware/http.ts');
  const req = (origin, url = 'https://api.example.test/api/desktop') =>
    new Request(url, { headers: origin ? { Origin: origin } : {} });
  const dev = { ENVIRONMENT: 'development' };
  const prod = { ENVIRONMENT: 'production', ALLOWED_ORIGINS: 'https://app.example.test, ' };

  it('echoes an allowed localhost origin with credentials in development', () => {
    const headers = getCorsHeaders(req('http://localhost:5173'), dev);
    assert.equal(headers['Access-Control-Allow-Origin'], 'http://localhost:5173');
    assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(headers.Vary, 'Origin');
  });

  it('never pairs a wildcard origin with credentials when there is no Origin', () => {
    for (const env of [dev, prod]) {
      const headers = getCorsHeaders(req(null), env);
      assert.equal('Access-Control-Allow-Origin' in headers, false);
      assert.equal('Access-Control-Allow-Credentials' in headers, false);
    }
  });

  it('omits ACAO entirely for a disallowed origin', () => {
    for (const env of [dev, prod]) {
      const headers = getCorsHeaders(req('https://evil.example'), env);
      assert.equal('Access-Control-Allow-Origin' in headers, false);
      assert.equal('Access-Control-Allow-Credentials' in headers, false);
      assert.ok(headers['Access-Control-Allow-Methods']);
    }
  });

  it('allows configured and same-origin origins in production', () => {
    assert.equal(
      getCorsHeaders(req('https://app.example.test'), prod)['Access-Control-Allow-Origin'],
      'https://app.example.test'
    );
    assert.equal(
      getCorsHeaders(req('https://api.example.test'), prod)['Access-Control-Allow-Origin'],
      'https://api.example.test'
    );
  });
});
