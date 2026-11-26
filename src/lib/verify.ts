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

/** Loads the checking code ahead of time (so a later app update can't break it in this tab). */
export async function preloadVerifier(): Promise<void> {
  await import('jose');
}

/** When the token's sign-in happened (seconds), or null if it can't be read. Not a check by itself. */
export async function tokenAuthTime(token: string): Promise<number | null> {
  try {
    const { decodeJwt } = await import('jose');
    const t = decodeJwt(token).auth_time;
    return typeof t === 'number' ? t : null;
  } catch {
    return null;
  }
}

/**
 * Remembers the sign-in tokens this device handed out. A device that presents one of them (or
 * any token from this device's own sign-in) only got it from us, e.g. after a mistaken "Allow":
 * it isn't signed in itself.
 */
export function createOwnTokenGuard() {
  const issued = new Set<string>();
  const signIns = new Set<number>();
  return {
    async remember(token: string) {
      issued.add(token);
      const t = await tokenAuthTime(token);
      if (t !== null) signIns.add(t);
    },
    async isOwn(token: string) {
      if (issued.has(token)) return true;
      const t = await tokenAuthTime(token);
      return t !== null && signIns.has(t);
    },
  };
}
