/**
 * Detect the errors a lazy viewer chunk throws when its file is gone (a deploy
 * replaced the hashed assets while this tab still runs the old build) or the
 * network dropped it. React.lazy caches the rejected import, so retrying in
 * place can't help: the page has to reload to pick up the new build.
 */

const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chrome
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /loading (css )?chunk [\w-]+ failed/i, // webpack-style
  /unable to preload css/i, // Vite preload helper
  /failed to load module script/i,
];

export function isChunkLoadError(error: unknown): boolean {
  if (typeof error === 'string') return matches(error);
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'ChunkLoadError') return true;
  return typeof message === 'string' && matches(message);
}

function matches(text: string): boolean {
  return CHUNK_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}
