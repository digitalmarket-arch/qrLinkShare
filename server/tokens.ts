/**
 * Small signed access tokens (like a minimal JWT) that say
 * "the holder may use room X". Signed with HMAC-SHA256 using SERVER_SECRET.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AuthMethod } from '../src/types/share';

const SECRET = process.env.SERVER_SECRET || randomBytes(32).toString('hex');
if (!process.env.SERVER_SECRET) {
  console.warn(
    '[qrLinkShare] SERVER_SECRET is not set. Using a random one, so every device must pair again after a server restart.'
  );
}

export interface AccessClaims {
  /** Room id */
  r: string;
  /** How this device got in */
  m: AuthMethod;
  /** Account label (email / wallet address) for account rooms */
  a?: string;
  /** Expiry, unix seconds */
  exp: number;
}

const DAY = 24 * 60 * 60;

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

export function issueToken(roomId: string, method: AuthMethod, account?: string): string {
  const lifetime = method === 'google' || method === 'wallet' ? 30 * DAY : 14 * DAY;
  const claims: AccessClaims = {
    r: roomId,
    m: method,
    ...(account ? { a: account } : {}),
    exp: Math.floor(Date.now() / 1000) + lifetime,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined | null): AccessClaims | null {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims;
    if (typeof claims.r !== 'string' || typeof claims.exp !== 'number') return null;
    if (claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}

export function randomId(bytes = 12): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Account rooms are derived from the account id, so every device signed in to it lands in the same room. */
export function accountRoomId(provider: 'google' | 'wallet', subject: string): string {
  const hash = createHash('sha256').update(`${provider}:${subject.toLowerCase()}`).digest('hex');
  return `${provider === 'google' ? 'g' : 'w'}_${hash.slice(0, 20)}`;
}
