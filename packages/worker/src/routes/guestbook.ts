/**
 * Guestbook route
 *
 *   POST /api/guestbook/:ownerUid/:itemId — add a public guestbook entry
 *
 * Auth policy: 'none' (visitors sign). Rate-limit policy: the general API
 * bucket at dispatch, plus this handler's own per-widget KV cooldown — one
 * entry per hour per (owner, item, IP) — stored only after a successful DO
 * write.
 */

import type { RouteContext } from './router';

export async function handleGuestbookSign(c: RouteContext): Promise<Response> {
  const [ownerUid, itemId] = c.params;

  // Rate limit by IP: 1 entry per hour per widget
  const ip = c.request.headers.get('CF-Connecting-IP') || c.request.headers.get('X-Forwarded-For') || 'unknown';
  const rateLimitKey = `guestbook:${ownerUid}:${itemId}:${ip}`;
  const lastEntry = await c.env.AUTH_KV.get(rateLimitKey);

  if (lastEntry) {
    const lastTime = parseInt(lastEntry, 10);
    const elapsed = Date.now() - lastTime;
    const oneHour = 60 * 60 * 1000;
    if (elapsed < oneHour) {
      const retryAfter = Math.ceil((oneHour - elapsed) / 1000);
      return Response.json(
        { error: 'You can only sign once per hour. Please try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': retryAfter.toString() },
        }
      );
    }
  }

  // Get the entry data
  let entryData: { name: string; message: string };
  try {
    entryData = await c.request.json();
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!entryData.name || !entryData.message) {
    return Response.json({ error: 'Name and message are required' }, { status: 400 });
  }

  // Validate input lengths
  if (entryData.name.length > 50) {
    return Response.json({ error: 'Name must be 50 characters or less' }, { status: 400 });
  }

  if (entryData.message.length > 500) {
    return Response.json({ error: 'Message must be 500 characters or less' }, { status: 400 });
  }

  // Forward to the owner's Durable Object
  const doId = c.env.USER_DESKTOP.idFromName(ownerUid);
  const stub = c.env.USER_DESKTOP.get(doId);
  const doResponse = await stub.fetch(
    new Request(`http://internal/guestbook/${itemId}`, {
      method: 'POST',
      body: JSON.stringify(entryData),
    })
  );

  if (doResponse.ok) {
    // Store rate limit timestamp
    await c.env.AUTH_KV.put(rateLimitKey, Date.now().toString(), {
      expirationTtl: 3600, // 1 hour TTL
    });
  }

  return doResponse;
}
