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
 * same account. The signature is checked against Google's public keys (fetched from
 * Google and cached). If they can't be fetched, the check fails: an unchecked token is
 * never accepted.
 */
export async function verifyGoogleToken(
  token: string,
  expectedUid: string,
  projectId: string,
  opts: { jwks?: JWTVerifyGetKey; now?: number } = {}
): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 4096 || !expectedUid) return false;
  try {
    const { jwtVerify, createRemoteJWKSet } = await import('jose');
    const keys = opts.jwks ?? (remoteJwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)));
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ['RS256'],
      ...(opts.now ? { currentDate: new Date(opts.now) } : {}),
    });
    return payload.sub === expectedUid;
  } catch {
    return false;
  }
}
