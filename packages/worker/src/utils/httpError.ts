/**
 * Error carrying the HTTP status the caller should surface for it.
 *
 * Handlers that funnel every throw into one response (the Durable Object
 * fetch catch-all, route wrappers) map plain `Error`s to 500. Client-input
 * failures are not server faults though — throw `HttpError` so the mapper
 * answers with the right status (400 for rejected input, 404 for a missing
 * resource) instead of tripping 5xx alarms.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
