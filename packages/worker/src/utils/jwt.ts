/**
 * JWT Utilities using Web Crypto API
 *
 * No external dependencies — uses Workers-native crypto.
 * HMAC-SHA256 signing and verification.
 */

import type { JWTPayload } from '../types';

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };

/**
 * Base64URL encode
 */
function base64urlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64URL decode
 */
function base64urlDecode(str: string): Uint8Array {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Import secret key for HMAC
 */
async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  return crypto.subtle.importKey('raw', keyData, ALGORITHM, false, ['sign', 'verify']);
}

/**
 * Sign a JWT
 */
export async function signJWT(
  payload: Omit<JWTPayload, 'iat' | 'exp'>,
  secret: string,
  expiresInSeconds: number = 7 * 24 * 60 * 60 // 7 days default
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
    jti: crypto.randomUUID(),
  };

  const header = { alg: 'HS256', typ: 'JWT' };

  const encoder = new TextEncoder();
  const headerBase64 = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const payloadBase64 = base64urlEncode(encoder.encode(JSON.stringify(fullPayload)));

  const signInput = `${headerBase64}.${payloadBase64}`;
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signInput));

  return `${signInput}.${base64urlEncode(signature)}`;
}

/**
 * Short-lived file token for media URLs (img/video/audio src attributes).
 *
 * Format: base64url(JSON{typ:"ft",uid,exp,scope?}).base64url(HMAC-SHA256 signature)
 * The HMAC is computed over `"ft:" + payloadBase64` so a capability token
 * (signed with `"cap:" + payloadBase64`) cannot be replayed as a file token
 * even though both classes share the same secret. The `typ` field inside the
 * payload gives a second, belt-and-suspenders, layer of protection.
 *
 * Default TTL: 5 minutes — long enough for page loads, short enough to
 * limit exposure if the URL is logged or leaked.
 */
const FILE_TOKEN_TTL_SECONDS = 5 * 60;
const FILE_TOKEN_SIGN_PREFIX = 'ft:';

export async function signFileToken(uid: string, secret: string, scope?: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS;
  const encoder = new TextEncoder();
  // SECURITY: scope limits the token to a specific itemId prefix, preventing
  // a leaked file URL token from being reused to access other files.
  const payloadObj: { typ: 'ft'; uid: string; exp: number; scope?: string } = { typ: 'ft', uid, exp };
  if (scope) payloadObj.scope = scope;
  const payload = base64urlEncode(encoder.encode(JSON.stringify(payloadObj)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(FILE_TOKEN_SIGN_PREFIX + payload));
  return `${payload}.${base64urlEncode(signature)}`;
}

export async function verifyFileToken(
  token: string,
  secret: string
): Promise<{ uid: string; scope?: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signatureBase64] = parts;

  try {
    const encoder = new TextEncoder();
    const key = await importKey(secret);
    const signature = base64urlDecode(signatureBase64);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(FILE_TOKEN_SIGN_PREFIX + payloadBase64)
    );
    if (!valid) return null;

    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadBase64))) as {
      typ?: string;
      uid: string;
      exp: number;
      scope?: string;
    };

    // Reject anything that isn't an explicit file token (defense in depth
    // against future payload-format changes).
    if (payload.typ !== 'ft') return null;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;

    return { uid: payload.uid, scope: payload.scope };
  } catch {
    return null;
  }
}

/**
 * App capability token — a short-lived, HMAC-signed token scoped to a single
 * user-created app. The iframe uses this to make bridge calls back to the
 * worker without seeing the user's root JWT. Carries the *granted*
 * permissions embedded so the worker can do stateless authorization.
 *
 * See design/01-apps-interop.md §capability tokens for the threat model.
 */
export interface AppGrantedPermissions {
  fs?: {
    read?: string[];              // glob patterns: ['**'] | ['/Photos/**']
    write?: string[];
    delete?: string[];
    mimeTypes?: string[];
  };
  ipc?: {
    listen?: string[];
    emit?: string[];
  };
  network?: {
    outbound?: string[];
  };
  handlers?: {
    mimeTypes?: string[];
    extensions?: string[];
  };
  virtualFolders?: {
    mountAt?: string[];
  };
  profile?: {
    read?: Array<'username' | 'displayName' | 'bio' | 'avatar'>;
  };
  ai?: {
    modes?: Array<'ask' | 'search' | 'enrich'>;
  };
}

export interface AppCapabilityPayload {
  typ: 'cap';
  uid: string;
  appId: string;
  granted: AppGrantedPermissions;
  iat: number;
  exp: number;
  jti: string;
}

const APP_CAPABILITY_DEFAULT_TTL = 5 * 60;   // 5 minutes
const APP_CAPABILITY_MAX_TTL = 15 * 60;       // 15 minutes hard cap
// SECURITY: Capability tokens share the same JWT_SECRET and 2-part wire format
// as file tokens (see signFileToken). To prevent a capability token from being
// replayed as a `?ft=` file token (which would hand a sandboxed app full
// account-scope access to the user's files), the HMAC signing input is
// prefixed differently here than for file tokens, and `typ: 'cap'` is enforced
// on verify.
const CAPABILITY_SIGN_PREFIX = 'cap:';
const CHAT_WS_SIGN_PREFIX = 'chatws:';
const CHAT_WS_DEFAULT_TTL = 60;
const CHAT_WS_MAX_TTL = 5 * 60;

export interface ChatWebSocketTokenPayload {
  typ: 'chat-ws';
  uid: string;
  route: 'agent-chat';
  iat: number;
  exp: number;
  jti: string;
}

export async function signAppCapabilityToken(
  uid: string,
  appId: string,
  granted: AppGrantedPermissions,
  secret: string,
  ttlSeconds: number = APP_CAPABILITY_DEFAULT_TTL
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.min(ttlSeconds, APP_CAPABILITY_MAX_TTL);

  const payload: AppCapabilityPayload = {
    typ: 'cap',
    uid,
    appId,
    granted,
    iat: now,
    exp,
    jti: crypto.randomUUID(),
  };

  const encoder = new TextEncoder();
  const payloadBase64 = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(CAPABILITY_SIGN_PREFIX + payloadBase64)
  );
  return `${payloadBase64}.${base64urlEncode(signature)}`;
}

export async function verifyAppCapabilityToken(
  token: string,
  secret: string,
  options: { expectedAppId?: string; expectedUid?: string } = {}
): Promise<AppCapabilityPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signatureBase64] = parts;

  try {
    const encoder = new TextEncoder();
    const key = await importKey(secret);
    const signature = base64urlDecode(signatureBase64);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(CAPABILITY_SIGN_PREFIX + payloadBase64)
    );
    if (!valid) return null;

    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadBase64))) as Partial<AppCapabilityPayload>;

    if (payload.typ !== 'cap') return null;
    if (!payload.uid || !payload.appId || typeof payload.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;

    if (options.expectedAppId && payload.appId !== options.expectedAppId) return null;
    if (options.expectedUid && payload.uid !== options.expectedUid) return null;

    return payload as AppCapabilityPayload;
  } catch {
    return null;
  }
}

export async function signChatWebSocketToken(
  uid: string,
  secret: string,
  ttlSeconds: number = CHAT_WS_DEFAULT_TTL
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.min(ttlSeconds, CHAT_WS_MAX_TTL);

  const payload: ChatWebSocketTokenPayload = {
    typ: 'chat-ws',
    uid,
    route: 'agent-chat',
    iat: now,
    exp,
    jti: crypto.randomUUID(),
  };

  const encoder = new TextEncoder();
  const payloadBase64 = base64urlEncode(encoder.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(CHAT_WS_SIGN_PREFIX + payloadBase64)
  );
  return `${payloadBase64}.${base64urlEncode(signature)}`;
}

export async function verifyChatWebSocketToken(
  token: string,
  secret: string,
  options: { expectedUid?: string } = {}
): Promise<ChatWebSocketTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadBase64, signatureBase64] = parts;

  try {
    const encoder = new TextEncoder();
    const key = await importKey(secret);
    const signature = base64urlDecode(signatureBase64);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(CHAT_WS_SIGN_PREFIX + payloadBase64)
    );
    if (!valid) return null;

    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadBase64))) as Partial<ChatWebSocketTokenPayload>;
    if (payload.typ !== 'chat-ws') return null;
    if (payload.route !== 'agent-chat') return null;
    if (!payload.uid || typeof payload.exp !== 'number') return null;
    if (Math.floor(Date.now() / 1000) > payload.exp) return null;
    if (options.expectedUid && payload.uid !== options.expectedUid) return null;

    return payload as ChatWebSocketTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Check whether a granted-permissions set covers the required scope.
 * Scope format: `${domain}.${action}`, e.g., 'fs.read', 'ipc.emit', 'network.outbound'.
 */
export function capabilityHasScope(granted: AppGrantedPermissions, scope: string): boolean {
  const [domain, action] = scope.split('.');
  if (!domain || !action) return false;

  const domainGrants = (granted as unknown as Record<string, Record<string, unknown> | undefined>)[domain];
  if (!domainGrants) return false;

  const actionGrant = domainGrants[action];
  if (!actionGrant) return false;

  // Boolean, array, or object presence all count as "granted" for this check.
  if (typeof actionGrant === 'boolean') return actionGrant;
  if (Array.isArray(actionGrant)) return actionGrant.length > 0;
  return true;
}

/**
 * Verify a JWT and return payload if valid
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [headerBase64, payloadBase64, signatureBase64] = parts;

  try {
    // Verify signature
    const encoder = new TextEncoder();
    const signInput = `${headerBase64}.${payloadBase64}`;
    const key = await importKey(secret);
    const signature = base64urlDecode(signatureBase64);

    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signInput));
    if (!valid) {
      return null;
    }

    // Decode payload
    const payloadBytes = base64urlDecode(payloadBase64);
    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(payloadBytes)) as JWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
