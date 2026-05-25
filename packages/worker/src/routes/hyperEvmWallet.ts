/**
 * HyperEVM wallet linking and login.
 *
 * Wallets are optional credentials layered on top of the existing EternalOS
 * account system. They are intentionally scoped to HyperEVM chain IDs only:
 * mainnet 999 and testnet 998.
 */

import { getAddress, isAddress, verifyMessage, type Hex } from 'viem';
import type { Env } from '../index';
import type { AuthContext } from '../middleware/auth';
import type { HyperEvmChainId, LinkedWallet, UserRecord, SessionRecord } from '../types';
import { signJWT } from '../utils/jwt';

const HYPEREVM_MAINNET_CHAIN_ID = 999;
const HYPEREVM_TESTNET_CHAIN_ID = 998;
const SUPPORTED_HYPEREVM_CHAIN_IDS = new Set<number>([
  HYPEREVM_MAINNET_CHAIN_ID,
  HYPEREVM_TESTNET_CHAIN_ID,
]);

const NONCE_TTL_SECONDS = 5 * 60;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

type HyperEvmWalletPurpose = 'link' | 'login';

interface HyperEvmNonceBody {
  address?: string;
  chainId?: number;
  purpose?: HyperEvmWalletPurpose;
}

interface HyperEvmVerifyBody extends HyperEvmNonceBody {
  nonce?: string;
  signature?: string;
}

interface HyperEvmNonceRecord {
  provider: 'hyperevm';
  address: string;
  chainId: HyperEvmChainId;
  purpose: HyperEvmWalletPurpose;
  nonce: string;
  message: string;
  issuedAt: number;
  expiresAt: number;
}

interface WalletIndexRecord {
  uid: string;
  address: string;
  chainId: HyperEvmChainId;
  linkedAt: number;
}

export const HYPEREVM_CHAINS = {
  mainnet: {
    chainId: HYPEREVM_MAINNET_CHAIN_ID,
    name: 'HyperEVM',
    rpcUrl: 'https://rpc.hyperliquid.xyz/evm',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  },
  testnet: {
    chainId: HYPEREVM_TESTNET_CHAIN_ID,
    name: 'HyperEVM Testnet',
    rpcUrl: 'https://rpc.hyperliquid-testnet.xyz/evm',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
  },
} as const;

function generateRefreshToken(): string {
  return crypto.randomUUID() + '-' + crypto.randomUUID();
}

function normalizePurpose(value: unknown): HyperEvmWalletPurpose | null {
  return value === 'link' || value === 'login' ? value : null;
}

function normalizeChainId(value: unknown): HyperEvmChainId | null {
  const chainId = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(chainId) || !SUPPORTED_HYPEREVM_CHAIN_IDS.has(chainId)) {
    return null;
  }
  return chainId as HyperEvmChainId;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string' || !isAddress(value)) {
    return null;
  }
  return getAddress(value);
}

function walletIndexKey(chainId: HyperEvmChainId, address: string): string {
  return `wallet:hyperevm:${chainId}:${address.toLowerCase()}`;
}

function nonceKey(nonce: string): string {
  return `wallet-nonce:hyperevm:${nonce}`;
}

function getAppOrigin(request: Request, env: Env): string {
  const appUrl = env.APP_URL || request.headers.get('Origin') || request.url;
  try {
    return new URL(appUrl).origin;
  } catch {
    return new URL(request.url).origin;
  }
}

function getAppDomain(request: Request, env: Env): string {
  return new URL(getAppOrigin(request, env)).host;
}

function buildHyperEvmMessage(input: {
  domain: string;
  origin: string;
  address: string;
  chainId: HyperEvmChainId;
  purpose: HyperEvmWalletPurpose;
  nonce: string;
  issuedAt: number;
}): string {
  const statement = input.purpose === 'link'
    ? 'Link this HyperEVM wallet to your EternalOS account.'
    : 'Sign in to EternalOS with a linked HyperEVM wallet.';

  return `${input.domain} wants you to sign in with your HyperEVM wallet:
${input.address}

${statement}

URI: ${input.origin}
Version: 1
Chain ID: ${input.chainId}
Nonce: ${input.nonce}
Issued At: ${new Date(input.issuedAt).toISOString()}`;
}

async function getUserByUid(env: Env, uid: string): Promise<{ email: string; user: UserRecord } | null> {
  const uidIndex = await env.AUTH_KV.get(`uid:${uid}`);
  if (!uidIndex) return null;

  const { email } = JSON.parse(uidIndex) as { email: string };
  const userJson = await env.AUTH_KV.get(`user:${email}`);
  if (!userJson) return null;

  return { email, user: JSON.parse(userJson) as UserRecord };
}

async function saveUserRecord(env: Env, email: string, user: UserRecord): Promise<void> {
  await env.AUTH_KV.put(`user:${email}`, JSON.stringify(user));
}

async function issueSession(env: Env, user: UserRecord): Promise<{
  token: string;
  refreshToken: string;
  expiresIn: number;
}> {
  if (!env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  const now = Date.now();
  const token = await signJWT(
    { uid: user.uid, username: user.username },
    env.JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS,
  );
  const refreshToken = generateRefreshToken();

  const sessionRecord: SessionRecord = {
    uid: user.uid,
    expiresAt: now + (ACCESS_TOKEN_TTL_SECONDS * 1000),
    issuedAt: now,
    refreshToken,
    refreshExpiresAt: now + (REFRESH_TOKEN_TTL_SECONDS * 1000),
  };

  await env.AUTH_KV.put(`session:${token}`, JSON.stringify(sessionRecord), {
    expirationTtl: ACCESS_TOKEN_TTL_SECONDS,
  });

  await env.AUTH_KV.put(`refresh:${refreshToken}`, JSON.stringify({
    uid: user.uid,
    username: user.username,
    accessToken: token,
    expiresAt: now + (REFRESH_TOKEN_TTL_SECONDS * 1000),
    issuedAt: now,
  }), {
    expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
  });

  return { token, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

async function parseVerifyBody(request: Request): Promise<{
  address: string;
  chainId: HyperEvmChainId;
  purpose: HyperEvmWalletPurpose;
  nonce: string;
  signature: Hex;
} | Response> {
  let body: HyperEvmVerifyBody;
  try {
    body = await request.json() as HyperEvmVerifyBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const address = normalizeAddress(body.address);
  const chainId = normalizeChainId(body.chainId);
  const purpose = normalizePurpose(body.purpose);
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const signature = typeof body.signature === 'string' && body.signature.startsWith('0x')
    ? body.signature as Hex
    : null;

  if (!address || !chainId || !purpose || !nonce || !signature) {
    return Response.json(
      { error: 'address, chainId, purpose, nonce, and signature are required' },
      { status: 400 },
    );
  }

  return { address, chainId, purpose, nonce, signature };
}

async function verifyNonceSignature(
  request: Request,
  env: Env,
  expectedPurpose: HyperEvmWalletPurpose,
): Promise<{ address: string; chainId: HyperEvmChainId } | Response> {
  const parsed = await parseVerifyBody(request);
  if (parsed instanceof Response) return parsed;

  if (parsed.purpose !== expectedPurpose) {
    return Response.json({ error: 'Invalid wallet auth purpose' }, { status: 400 });
  }

  const key = nonceKey(parsed.nonce);
  const nonceJson = await env.AUTH_KV.get(key);
  if (!nonceJson) {
    return Response.json({ error: 'Wallet challenge expired or not found' }, { status: 400 });
  }

  // One-time use, even if verification fails.
  await env.AUTH_KV.delete(key);

  const record = JSON.parse(nonceJson) as HyperEvmNonceRecord;
  if (
    record.provider !== 'hyperevm' ||
    record.address !== parsed.address ||
    record.chainId !== parsed.chainId ||
    record.purpose !== expectedPurpose ||
    record.expiresAt < Date.now()
  ) {
    return Response.json({ error: 'Wallet challenge mismatch' }, { status: 400 });
  }

  const verified = await verifyMessage({
    address: parsed.address as Hex,
    message: record.message,
    signature: parsed.signature,
  });

  if (!verified) {
    return Response.json({ error: 'Invalid wallet signature' }, { status: 401 });
  }

  return { address: parsed.address, chainId: parsed.chainId };
}

export async function handleHyperEvmWalletNonce(request: Request, env: Env): Promise<Response> {
  let body: HyperEvmNonceBody;
  try {
    body = await request.json() as HyperEvmNonceBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const address = normalizeAddress(body.address);
  const chainId = normalizeChainId(body.chainId);
  const purpose = normalizePurpose(body.purpose);
  if (!address || !chainId || !purpose) {
    return Response.json(
      { error: 'A supported HyperEVM address, chainId, and purpose are required' },
      { status: 400 },
    );
  }

  const issuedAt = Date.now();
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const origin = getAppOrigin(request, env);
  const message = buildHyperEvmMessage({
    domain: getAppDomain(request, env),
    origin,
    address,
    chainId,
    purpose,
    nonce,
    issuedAt,
  });

  const record: HyperEvmNonceRecord = {
    provider: 'hyperevm',
    address,
    chainId,
    purpose,
    nonce,
    message,
    issuedAt,
    expiresAt: issuedAt + (NONCE_TTL_SECONDS * 1000),
  };

  await env.AUTH_KV.put(nonceKey(nonce), JSON.stringify(record), {
    expirationTtl: NONCE_TTL_SECONDS,
  });

  return Response.json({
    provider: 'hyperevm',
    chainId,
    address,
    nonce,
    message,
    expiresAt: record.expiresAt,
  });
}

export async function handleHyperEvmWalletLink(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const verified = await verifyNonceSignature(request, env, 'link');
  if (verified instanceof Response) return verified;

  const userRecord = await getUserByUid(env, auth.uid);
  if (!userRecord || userRecord.user.deletedAt) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const indexKey = walletIndexKey(verified.chainId, verified.address);
  const existingIndexJson = await env.AUTH_KV.get(indexKey);
  if (existingIndexJson) {
    const existing = JSON.parse(existingIndexJson) as WalletIndexRecord;
    if (existing.uid !== auth.uid) {
      return Response.json({ error: 'Wallet already linked to another account' }, { status: 409 });
    }
  }

  const now = Date.now();
  const existingWallets = userRecord.user.linkedWallets ?? [];
  const withoutCurrent = existingWallets.filter((wallet) => (
    wallet.provider !== 'hyperevm' ||
    wallet.chainId !== verified.chainId ||
    wallet.address.toLowerCase() !== verified.address.toLowerCase()
  ));

  const wallet: LinkedWallet = {
    provider: 'hyperevm',
    chainId: verified.chainId,
    address: verified.address,
    linkedAt: existingWallets.find((candidate) => (
      candidate.provider === 'hyperevm' &&
      candidate.chainId === verified.chainId &&
      candidate.address.toLowerCase() === verified.address.toLowerCase()
    ))?.linkedAt ?? now,
    lastVerifiedAt: now,
  };

  userRecord.user.linkedWallets = [...withoutCurrent, wallet];
  await saveUserRecord(env, userRecord.email, userRecord.user);
  await env.AUTH_KV.put(indexKey, JSON.stringify({
    uid: auth.uid,
    address: verified.address,
    chainId: verified.chainId,
    linkedAt: wallet.linkedAt,
  } satisfies WalletIndexRecord));

  return Response.json({ success: true, wallet });
}

export async function handleHyperEvmWalletLogin(request: Request, env: Env): Promise<Response> {
  const verified = await verifyNonceSignature(request, env, 'login');
  if (verified instanceof Response) return verified;

  const indexJson = await env.AUTH_KV.get(walletIndexKey(verified.chainId, verified.address));
  if (!indexJson) {
    return Response.json({ error: 'Wallet is not linked to an EternalOS account' }, { status: 401 });
  }

  const index = JSON.parse(indexJson) as WalletIndexRecord;
  const userRecord = await getUserByUid(env, index.uid);
  if (!userRecord || userRecord.user.deletedAt) {
    return Response.json({ error: 'Wallet account is unavailable' }, { status: 403 });
  }

  userRecord.user.linkedWallets = (userRecord.user.linkedWallets ?? []).map((wallet) => (
    wallet.provider === 'hyperevm' &&
    wallet.chainId === verified.chainId &&
    wallet.address.toLowerCase() === verified.address.toLowerCase()
      ? { ...wallet, lastVerifiedAt: Date.now() }
      : wallet
  ));
  await saveUserRecord(env, userRecord.email, userRecord.user);

  const session = await issueSession(env, userRecord.user);
  return Response.json({
    ...session,
    user: {
      uid: userRecord.user.uid,
      username: userRecord.user.username,
      email: userRecord.email,
      emailVerified: userRecord.user.emailVerified || false,
    },
  });
}

export async function handleHyperEvmWalletList(
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const userRecord = await getUserByUid(env, auth.uid);
  if (!userRecord) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const wallets = (userRecord.user.linkedWallets ?? [])
    .filter((wallet) => wallet.provider === 'hyperevm')
    .sort((a, b) => b.linkedAt - a.linkedAt);

  return Response.json({ wallets });
}

export async function handleHyperEvmWalletUnlink(
  env: Env,
  auth: AuthContext,
  chainIdRaw: string,
  addressRaw: string,
): Promise<Response> {
  const chainId = normalizeChainId(chainIdRaw);
  const address = normalizeAddress(decodeURIComponent(addressRaw));
  if (!chainId || !address) {
    return Response.json({ error: 'Invalid HyperEVM wallet' }, { status: 400 });
  }

  const userRecord = await getUserByUid(env, auth.uid);
  if (!userRecord) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  const wallets = userRecord.user.linkedWallets ?? [];
  const nextWallets = wallets.filter((wallet) => (
    wallet.provider !== 'hyperevm' ||
    wallet.chainId !== chainId ||
    wallet.address.toLowerCase() !== address.toLowerCase()
  ));

  if (nextWallets.length === wallets.length) {
    return Response.json({ error: 'Wallet is not linked to this account' }, { status: 404 });
  }

  userRecord.user.linkedWallets = nextWallets;
  await saveUserRecord(env, userRecord.email, userRecord.user);

  const indexKey = walletIndexKey(chainId, address);
  const existingIndexJson = await env.AUTH_KV.get(indexKey);
  if (existingIndexJson) {
    const existing = JSON.parse(existingIndexJson) as WalletIndexRecord;
    if (existing.uid === auth.uid) {
      await env.AUTH_KV.delete(indexKey);
    }
  }

  return Response.json({ success: true, wallets: nextWallets });
}
