/**
 * The frontend's version, injected by Vite's `define` from package.json.
 * Vitest runs with its own config (no define), hence the guard.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__ ? __APP_VERSION__ : 'dev';
