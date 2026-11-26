/**
 * Pairing helpers: secrets, invite links and the "rooms" devices meet in.
 *
 * How devices find each other (no server of ours involved):
 *  - Every group of paired devices shares a long random secret. The secret never
 *    leaves the devices except inside an encrypted peer-to-peer connection.
 *  - Devices look for each other through public relays using only a hash of the
 *    secret, and the connection handshake is encrypted with the secret itself,
 *    so relays can't read it or join.
 *  - QR codes and PINs are one-time invitations into a short-lived meeting room,
 *    where the existing device hands the group secret over directly.
 */
import type { Account } from '../types/share';

/** Globally unique app id for the peer-to-peer library. */
export const APP_ID = 'qrlinkshare.digitalmarket-arch.github.io';

const B64URL = /^[A-Za-z0-9_-]+$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random secret, e.g. 18 bytes -> 24 URL-safe characters (144 bits). */
export function randomSecret(bytes = 18): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A random 6-digit PIN. */
export function randomPin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RoomRef {
  roomId: string;
  password: string;
}

/** The room a group of paired devices lives in. */
export async function groupRoom(secret: string): Promise<RoomRef> {
  return { roomId: `g-${(await sha256Hex(`qrls/group/${secret}`)).slice(0, 32)}`, password: `qrls/group/${secret}` };
}

/** Short-lived meeting room behind a QR invitation. */
export async function inviteRoom(invite: string): Promise<RoomRef> {
  return { roomId: `i-${(await sha256Hex(`qrls/invite/${invite}`)).slice(0, 32)}`, password: `qrls/invite/${invite}` };
}

/** Short-lived meeting room behind a 6-digit PIN. */
export async function pinRoom(pin: string): Promise<RoomRef> {
  return { roomId: `p-${(await sha256Hex(`qrls/pin/${pin}`)).slice(0, 32)}`, password: `qrls/pin/${pin}` };
}

/**
 * The room every device signed in to the same account meets in. For a wallet it is
 * derived from a signature only that wallet can make, so outsiders can't find it.
 */
export async function accountRoom(account: Pick<Account, 'kind'> & { uid?: string; roomKey?: string }): Promise<RoomRef> {
  const subject = account.kind === 'google' ? `google/${account.uid}` : `wallet/${account.roomKey}`;
  return { roomId: `a-${(await sha256Hex(`qrls/account/${subject}`)).slice(0, 32)}`, password: `qrls/account/${subject}` };
}

/**
 * The link inside the QR code. The invitation travels after "#", which browsers
 * never send to the web server.
 */
export function inviteLink(invite: string, base: { origin: string; pathname: string }): string {
  return `${base.origin}${base.pathname}#join=${invite}`;
}

/** Extracts the invitation from a scanned/opened link, or null if it isn't one of ours. */
export function parseInviteLink(text: string): string | null {
  const m = text.trim().match(/[#&]join=([A-Za-z0-9_-]{16,64})(?:&|$)/);
  return m && B64URL.test(m[1]) ? m[1] : null;
}

/** Makes sure a stored secret looks valid before trusting it. */
export function isValidSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= 16 && secret.length <= 64 && B64URL.test(secret);
}
