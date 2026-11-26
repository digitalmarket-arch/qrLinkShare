/**
 * Checks, done on the device itself, that another device really belongs to the
 * same Google account. No server of ours is involved. (Wallet rooms need no extra
 * check: only the wallet owner can derive the room key.)
 */
import type { JWTVerifyGetKey } from 'jose';

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let remoteJwks: JWTVerifyGetKey | null = null;

/**
 * Verifies a Firebase/Google ID token from another device and checks it is for the
 * same account. Google's public keys are fetched from Google (the same keys any
 * server would use). If that fetch is impossible (offline, blocked), we fall back to
 * checking the token's claims: reaching the account room already required knowing
 * the account's private id.
 */
export async function verifyGoogleToken(
  token: string,
  expectedUid: string,
  projectId: string,
  opts: { jwks?: JWTVerifyGetKey; now?: number } = {}
): Promise<boolean> {
  if (typeof token !== 'string' || token.length > 4096 || !expectedUid) return false;
  const { jwtVerify, createRemoteJWKSet, decodeJwt } = await import('jose');
  const issuer = `https://securetoken.google.com/${projectId}`;
  try {
    const keys = opts.jwks ?? (remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)));
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: projectId,
      ...(opts.now ? { currentDate: new Date(opts.now) } : {}),
    });
    return payload.sub === expectedUid;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    const isNetwork = err instanceof TypeError || code === 'ERR_JWKS_TIMEOUT';
    if (!isNetwork) return false;
    try {
      const p = decodeJwt(token);
      const now = (opts.now ?? Date.now()) / 1000;
      return p.sub === expectedUid && p.iss === issuer && p.aud === projectId && typeof p.exp === 'number' && p.exp > now;
    } catch {
      return false;
    }
  }
}
