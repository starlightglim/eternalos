/**
 * Read a request body as text with a hard byte cap.
 *
 * A Content-Length check alone is not a cap: a chunked request carries no
 * length header, and `request.text()` / `request.json()` buffer the whole
 * body before anything can measure it. This reads the stream and stops (and
 * cancels it) as soon as the limit is passed, so an oversized body is never
 * held in memory in full.
 *
 * Returns null when the body is larger than `maxBytes` (callers answer 413).
 * A missing body reads as ''.
 */
export async function readTextWithLimit(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
