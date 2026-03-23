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
 * Format: base64url(JSON{uid,exp}).base64url(HMAC-SHA256 signature)
 * Default TTL: 5 minutes — long enough for page loads, short enough to
 * limit exposure if the URL is logged or leaked.
 */
const FILE_TOKEN_TTL_SECONDS = 5 * 60;

export async function signFileToken(uid: string, secret: string, scope?: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + FILE_TOKEN_TTL_SECONDS;
  const encoder = new TextEncoder();
  // SECURITY: scope limits the token to a specific itemId prefix, preventing
  // a leaked file URL token from being reused to access other files.
  const payloadObj: { uid: string; exp: number; scope?: string } = { uid, exp };
  if (scope) payloadObj.scope = scope;
  const payload = base64urlEncode(encoder.encode(JSON.stringify(payloadObj)));
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
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
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payloadBase64));
    if (!valid) return null;

    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(base64urlDecode(payloadBase64))) as {
      uid: string;
      exp: number;
      scope?: string;
    };

    if (Math.floor(Date.now() / 1000) > payload.exp) return null;

    return { uid: payload.uid, scope: payload.scope };
  } catch {
    return null;
  }
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
