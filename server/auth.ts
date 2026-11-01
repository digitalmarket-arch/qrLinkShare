/**
 * Google (Firebase) and Web3 wallet sign-in verification.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createPublicClient, http, getAddress, verifyMessage, type Chain } from 'viem';
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains';
import firebaseConfig from '../firebase-applet-config.json' with { type: 'json' };
import { buildWalletMessage, parseWalletMessage } from '../src/lib/shared';
import { randomId } from './tokens';

/* ---------------------------- Google / Firebase --------------------------- */

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId;
const firebaseJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

/** Checks a Firebase ID token (from signInWithPopup) and returns the user. */
export async function verifyGoogleIdToken(idToken: string): Promise<{ uid: string; email?: string }> {
  const { payload } = await jwtVerify(idToken, firebaseJwks, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });
  if (!payload.sub) throw new Error('Token has no user id.');
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  return { uid: payload.sub, email };
}

/* ------------------------------ Web3 wallets ------------------------------ */

const NONCE_TTL_MS = 5 * 60 * 1000;
const walletNonces = new Map<string, { address: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, rec] of walletNonces) if (rec.expiresAt < now) walletNonces.delete(nonce);
}, 60_000).unref();

/** Creates the sign-in message the wallet will be asked to sign. */
export function createWalletChallenge(params: {
  address: string;
  chainId: number;
  origin: string;
}): string {
  const address = getAddress(params.address); // throws on invalid, returns EIP-55 checksum form
  const originUrl = new URL(params.origin);
  const nonce = randomId(12).replace(/[^a-zA-Z0-9]/g, '');
  const now = Date.now();
  walletNonces.set(nonce, { address: address.toLowerCase(), expiresAt: now + NONCE_TTL_MS });
  return buildWalletMessage({
    domain: originUrl.host,
    uri: originUrl.origin,
    address,
    chainId: Number.isInteger(params.chainId) && params.chainId > 0 ? params.chainId : 1,
    nonce,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + NONCE_TTL_MS).toISOString(),
  });
}

const CHAINS: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  137: polygon,
  10: optimism,
  42161: arbitrum,
};

/** Verifies a signed wallet message. Returns the checksummed address. */
export async function verifyWalletSignature(params: {
  message: string;
  signature: string;
  origin: string;
}): Promise<string> {
  const parsed = parseWalletMessage(params.message);
  if (!parsed) throw new Error('Malformed sign-in message.');

  const nonceRec = walletNonces.get(parsed.nonce);
  if (!nonceRec || nonceRec.expiresAt < Date.now()) throw new Error('Sign-in request expired. Please try again.');
  if (nonceRec.address !== parsed.address.toLowerCase()) throw new Error('Address does not match the sign-in request.');
  if (new URL(params.origin).host !== parsed.domain) throw new Error('Sign-in message was created for another website.');

  // One-time use, even if verification fails below.
  walletNonces.delete(parsed.nonce);

  const address = getAddress(parsed.address);
  const signature = params.signature as `0x${string}`;
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error('Invalid signature.');

  // 1) Normal wallets (MetaMask, Trust, Rabby…): pure math, no network needed.
  const okEoa = await verifyMessage({ address, message: params.message, signature }).catch(() => false);
  if (okEoa) return address;

  // 2) Smart-contract wallets (e.g. Coinbase Smart Wallet) need an on-chain check (EIP-1271/6492).
  const chainIdLine = params.message.match(/^Chain ID: (\d+)$/m);
  const chain = CHAINS[Number(chainIdLine?.[1] ?? 1)] ?? mainnet;
  try {
    const client = createPublicClient({ chain, transport: http() });
    const okContract = await client.verifyMessage({ address, message: params.message, signature });
    if (okContract) return address;
  } catch {
    // fall through
  }
  throw new Error('Signature check failed.');
}
