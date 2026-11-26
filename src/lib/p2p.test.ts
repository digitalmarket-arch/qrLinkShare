/**
 * Unit tests for the peer-to-peer building blocks that don't need a network:
 * room derivation, invitations, on-device storage, message validation and the
 * Google / wallet identity checks (with real signatures).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { accountRoom, groupRoom, inviteLink, inviteRoom, isValidSecret, parseInviteLink, pinRoom, randomPin, randomSecret } from './pairing';
import { createMemoryStore } from './db';
import { isWireItem, securityCode } from './mesh';
import { verifyGoogleToken } from './verify';
import { buildWalletRoomMessage } from './shared';
import type { StoredItem, WireItem } from '../types/share';

test('secrets and PINs are random and well-formed', () => {
  const a = randomSecret();
  assert.equal(a.length, 24);
  assert.ok(isValidSecret(a));
  assert.notEqual(a, randomSecret());
  assert.match(randomPin(), /^\d{6}$/);
  assert.equal(isValidSecret('short'), false);
  assert.equal(isValidSecret('has spaces in it, nope!!'), false);
  assert.equal(isValidSecret(42), false);
});

test('rooms are derived from secrets, never contain them, and differ by purpose', async () => {
  const secret = randomSecret();
  const g = await groupRoom(secret);
  const i = await inviteRoom(secret);
  assert.ok(g.roomId.startsWith('g-') && i.roomId.startsWith('i-'));
  assert.notEqual(g.roomId, i.roomId);
  assert.ok(!g.roomId.includes(secret));
  assert.deepEqual(await groupRoom(secret), g); // deterministic: both devices land in the same room
  const p1 = await pinRoom('482910');
  assert.ok(p1.roomId.startsWith('p-'));
  assert.notEqual(p1.roomId, (await pinRoom('482911')).roomId);
});

test('same Google account -> same room; different accounts -> different rooms', async () => {
  const g1 = await accountRoom({ kind: 'google', uid: 'uid-1' });
  assert.deepEqual(g1, await accountRoom({ kind: 'google', uid: 'uid-1' }));
  assert.notEqual(g1.roomId, (await accountRoom({ kind: 'google', uid: 'uid-2' })).roomId);
});

test('invite links carry the invitation after # (never sent to the web server)', () => {
  const inv = randomSecret();
  const link = inviteLink(inv, { origin: 'https://x.github.io', pathname: '/qrLinkShare/' });
  assert.equal(link, `https://x.github.io/qrLinkShare/#join=${inv}`);
  assert.equal(parseInviteLink(link), inv);
  assert.equal(parseInviteLink(`#join=${inv}`), inv);
  assert.equal(parseInviteLink('https://example.com/?join=abc'), null);
  assert.equal(parseInviteLink('https://example.com/#join=<script>'), null);
  assert.equal(parseInviteLink('random text'), null);
});

const baseItem = (over: Partial<WireItem> = {}): WireItem => ({
  id: 'abcdefgh1234',
  kind: 'link',
  retention: 'temp',
  url: 'https://example.com/',
  from: { id: 'dev1', name: 'Phone', type: 'mobile' },
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1000).toISOString(),
  ...over,
});

test('incoming items are validated before being stored', () => {
  assert.ok(isWireItem(baseItem()));
  assert.ok(isWireItem(baseItem({ kind: 'text', url: undefined, text: 'hello' })));
  assert.ok(isWireItem(baseItem({ kind: 'file', url: undefined, file: { name: 'a.pdf', size: 10, mime: 'application/pdf' } })));
  assert.equal(isWireItem(baseItem({ url: 'javascript:alert(1)' })), false);
  assert.equal(isWireItem(baseItem({ id: '../../etc' })), false);
  assert.equal(isWireItem(baseItem({ retention: 'forever' as never })), false);
  assert.equal(isWireItem(baseItem({ kind: 'file', file: { name: 'x', size: 300 * 1024 * 1024, mime: 'x/y' } })), false);
  assert.equal(isWireItem(baseItem({ createdAt: 'not a date' })), false);
  assert.equal(isWireItem(null), false);
});

test('memory store: temporary items expire, saved items stay, blobs go with their item', async () => {
  const store = createMemoryStore();
  const now = Date.now();
  const temp: StoredItem = { ...baseItem({ id: 'temp00001', expiresAt: new Date(now - 1).toISOString() }), status: 'ready', storedAt: now };
  const saved: StoredItem = { ...baseItem({ id: 'saved0001', retention: 'saved', expiresAt: undefined }), status: 'ready', storedAt: now };
  await store.put(temp);
  await store.put(saved);
  await store.putBlob('temp00001', new Blob(['x']));
  assert.deepEqual(await store.purgeExpired(now), ['temp00001']);
  assert.equal(await store.getBlob('temp00001'), undefined);
  assert.deepEqual((await store.list()).map((i) => i.id), ['saved0001']);
  await store.remove('saved0001');
  assert.equal((await store.list()).length, 0);
});

test("wallet room: same wallet -> same private room on every device; others can't derive it", async () => {
  const { sha256Hex } = await import('./pairing');
  const roomFor = async (signer: ReturnType<typeof privateKeyToAccount>, claimedAddress: string) => {
    const sig = await signer.signMessage({ message: buildWalletRoomMessage(claimedAddress) });
    return accountRoom({ kind: 'wallet', roomKey: await sha256Hex(`qrls/wallet-room/${sig.toLowerCase()}`) });
  };
  const owner = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());
  const phone = await roomFor(owner, owner.address);
  const laptop = await roomFor(owner, owner.address.toLowerCase()); // other app, other casing
  assert.deepEqual(phone, laptop); // signatures are deterministic -> both devices meet
  // Someone who only knows the (public) address can't produce the signature, so lands elsewhere.
  assert.notEqual((await roomFor(attacker, owner.address)).roomId, phone.roomId);
  assert.ok(!phone.roomId.includes(owner.address.slice(2).toLowerCase()));
});

test('Google check: verifies the token signature, audience and account', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const project = 'demo-project';
  const sign = (claims: Record<string, unknown>, key = privateKey) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(`https://securetoken.google.com/${project}`)
      .setAudience(project)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);

  const good = await sign({ sub: 'user-1' });
  assert.equal(await verifyGoogleToken(good, 'user-1', project, { jwks }), true);
  assert.equal(await verifyGoogleToken(good, 'user-2', project, { jwks }), false); // someone else's account
  assert.equal(await verifyGoogleToken(good, 'user-1', 'other-project', { jwks }), false);
  const { privateKey: wrongKey } = await generateKeyPair('RS256');
  assert.equal(await verifyGoogleToken(await sign({ sub: 'user-1' }, wrongKey), 'user-1', project, { jwks }), false);
  assert.equal(await verifyGoogleToken('not-a-token', 'user-1', project, { jwks }), false);
  assert.equal(await verifyGoogleToken(good, 'user-1', project, { jwks, now: Date.now() + 2 * 3600_000 }), false); // expired
});

test('Google check: fails closed when Google’s keys can’t be fetched (no unchecked tokens)', async () => {
  const project = 'demo-project';
  const offline: JWTVerifyGetKey = async () => {
    throw new TypeError('Failed to fetch'); // what the browser throws when Google can't be reached
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = {
    sub: 'user-1',
    iss: `https://securetoken.google.com/${project}`,
    aud: project,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
  assert.equal(await verifyGoogleToken(unsigned, 'user-1', project, { jwks: offline }), false);
  const { privateKey } = await generateKeyPair('RS256');
  const selfSigned = await new SignJWT({ sub: 'user-1' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(claims.iss)
    .setAudience(project)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
  assert.equal(await verifyGoogleToken(selfSigned, 'user-1', project, { jwks: offline }), false);
  assert.equal(await verifyGoogleToken(unsigned, 'user-1', project), false); // no network in tests either way
});

test('security code: 4 digits, the same on both devices, different for anyone in between', async () => {
  const phone = { id: 'phone-id-aaaa', nonce: 'N1-phone-random-123' };
  const laptop = { id: 'laptop-id-bbbb', nonce: 'N2-laptop-random-456' };
  const a = await securityCode('pin/123456', phone, laptop);
  const b = await securityCode('pin/123456', laptop, phone); // the other side computes it in the other order
  assert.match(a, /^\d{4}$/);
  assert.equal(a, b);
  // Someone in the middle has another id: each real device then sees a different code.
  const mitm = { id: 'attacker-id-cccc', nonce: 'N3-attacker' };
  const phoneSees = await securityCode('pin/123456', phone, mitm);
  const laptopSees = await securityCode('pin/123456', laptop, mitm);
  assert.notEqual(phoneSees, laptopSees);
  // Every input matters.
  assert.notEqual(await securityCode('pin/654321', phone, laptop), a);
  assert.notEqual(await securityCode('pin/123456', { ...phone, nonce: 'other' }, laptop), a);
});
