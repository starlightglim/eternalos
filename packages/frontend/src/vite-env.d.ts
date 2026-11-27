/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_USE_FIREBASE_EMULATORS: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Frontend package version, injected by Vite's `define` (absent under Vitest). */
declare const __APP_VERSION__: string;

// Custom eos-* attributes for CSS Element Picker targeting
declare namespace React {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface HTMLAttributes<T> {
    'eos-name'?: string;
    'eos-type'?: string;
    'eos-folder'?: string;
  }
}
