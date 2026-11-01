/**
 * API smoke test against a running server: wallet sign-in with a real signature,
 * access control, one-time PINs, rate limiting and safe file serving.
 *
 *   BASE=http://localhost:3000 npx tsx scripts/api-check.ts
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const BASE = process.env.BASE || 'http://localhost:3000';
const ORIGIN = new URL(BASE).origin;
let failed = 0;
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!cond) failed++;
};

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function main() {
  /* ----------------------------- wallet sign-in ----------------------------- */
  const account = privateKeyToAccount(generatePrivateKey());
  const ch = await post('/api/auth/wallet/challenge', { address: account.address, chainId: 8453 });
  check('wallet challenge issued', ch.status === 200 && ch.data.message.includes(account.address));
  check('challenge bound to site domain', ch.data.message.startsWith(`${new URL(BASE).host} wants you to sign in`));

  const signature = await account.signMessage({ message: ch.data.message });
  const v = await post('/api/auth/wallet/verify', { message: ch.data.message, signature });
  check('valid wallet signature signs in', v.status === 200 && v.data.method === 'wallet' && v.data.roomId?.startsWith('w_'));

  const replay = await post('/api/auth/wallet/verify', { message: ch.data.message, signature });
  check('signature replay rejected', replay.status === 401);

  // Same wallet on a second device lands in the same room
  const ch2 = await post('/api/auth/wallet/challenge', { address: account.address, chainId: 1 });
  const v2 = await post('/api/auth/wallet/verify', { message: ch2.data.message, signature: await account.signMessage({ message: ch2.data.message }) });
  check('same wallet → same room on another device', v2.data.roomId === v.data.roomId);

  // Someone else's signature for my address
  const attacker = privateKeyToAccount(generatePrivateKey());
  const ch3 = await post('/api/auth/wallet/challenge', { address: account.address, chainId: 1 });
  const forged = await post('/api/auth/wallet/verify', { message: ch3.data.message, signature: await attacker.signMessage({ message: ch3.data.message }) });
  check('signature from a different key rejected', forged.status === 401, forged.data.error);

  // Message requested for another website (phishing relay)
  const ch4 = await post('/api/auth/wallet/challenge', { address: account.address, chainId: 1 }, { Origin: 'https://evil.example' });
  const phish = await post('/api/auth/wallet/verify', { message: ch4.data.message, signature: await account.signMessage({ message: ch4.data.message }) });
  check('message created for another domain rejected here', phish.status === 401, phish.data.error);

  const bad = await post('/api/auth/wallet/challenge', { address: '0x123', chainId: 1 });
  check('invalid address rejected', bad.status === 400);

  /* --------------------------------- google -------------------------------- */
  const g = await post('/api/auth/google', { idToken: 'not-a-real-token' });
  check('fake Google token rejected', g.status === 401);

  /* ----------------------------- access control ---------------------------- */
  const a = (await post('/api/rooms', {})).data;
  const b = (await post('/api/rooms', {})).data;
  const auth = (s: any) => ({ Authorization: `Bearer ${s.token}` });

  const cross = await post(`/api/rooms/${b.roomId}/items`, { text: 'hi' }, auth(a));
  check("token can't write to another room", cross.status === 403);
  const noTok = await post(`/api/rooms/${a.roomId}/items`, { text: 'hi' });
  check('no token → 401', noTok.status === 401);
  const tampered = await post(`/api/rooms/${b.roomId}/items`, { text: 'hi' }, { Authorization: `Bearer ${a.token.replace(/^[^.]+/, Buffer.from(JSON.stringify({ r: b.roomId, m: 'guest', exp: 9e9 })).toString('base64url'))}` });
  check('tampered token rejected', tampered.status === 401);

  /* ------------------------------ link vs text ----------------------------- */
  const js = await post(`/api/rooms/${a.roomId}/items`, { text: 'javascript:alert(1)' }, auth(a));
  check('javascript: URL stored as plain text, not a link', js.data.item?.kind === 'text');

  /* --------------------------------- PINs --------------------------------- */
  const code = (await post(`/api/rooms/${a.roomId}/pair`, {}, auth(a))).data;
  const join = await post('/api/pair/claim', { pin: code.pin });
  check('correct PIN joins the room', join.status === 200 && join.data.roomId === a.roomId);
  const again = await post('/api/pair/claim', { pin: code.pin });
  check('PIN is one-time', again.status === 404);

  /* ------------------------------ file serving ----------------------------- */
  const up = async (name: string, type: string, body: string) => {
    const r = await fetch(`${BASE}/api/rooms/${a.roomId}/files`, {
      method: 'POST',
      headers: { ...auth(a), 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) },
      body,
    });
    return ((await r.json()) as any).item;
  };
  const svg = await up('x.svg', 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svgRes = await fetch(`${BASE}/api/files/${svg.file.fileId}`);
  check('SVG served as download, never inline', (svgRes.headers.get('content-disposition') || '').startsWith('attachment'));
  const html = await up('x.html', 'text/html', '<script>alert(1)</script>');
  const htmlRes = await fetch(`${BASE}/api/files/${html.file.fileId}`);
  check('HTML served as download with sandbox CSP', (htmlRes.headers.get('content-disposition') || '').startsWith('attachment') && (htmlRes.headers.get('content-security-policy') || '').includes('sandbox'));
  check('unknown file id → 404', (await fetch(`${BASE}/api/files/nope`)).status === 404);

  /* ------------------------------ rate limiting ---------------------------- */
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const r = await post('/api/pair/claim', { pin: String(100000 + i) });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  check('PIN guessing gets rate-limited', limited);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll API checks passed');
  process.exitCode = failed ? 1 : 0;
}

main();
