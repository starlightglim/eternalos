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
