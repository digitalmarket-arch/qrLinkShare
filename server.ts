/**
 * qrLinkShare server
 *  - REST API for pairing (QR / PIN), sign-in (Google / wallet) and sharing items
 *  - WebSocket hub at /ws that pushes new items to every device in a room instantly
 *  - Serves the React app (Vite in dev, ./dist in production)
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { AuthMethod, DeviceInfo, DeviceType, PresentDevice, RoomSession } from './src/types/share';
import {
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  cleanPin,
  fileKindOf,
  isInlineSafeMime,
  safeFileName,
  shortAddress,
  toHttpUrl,
} from './src/lib/shared';
import { accountRoomId, issueToken, randomId, verifyToken, type AccessClaims } from './server/tokens';
import { createWalletChallenge, verifyGoogleIdToken, verifyWalletSignature } from './server/auth';
import { store } from './server/store';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());

/* -------------------------------- helpers -------------------------------- */

interface AuthedRequest extends Request {
  claims?: AccessClaims;
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : undefined;
}

function requireRoom(req: AuthedRequest, res: Response, next: NextFunction) {
  const claims = verifyToken(bearer(req));
  if (!claims) return void res.status(401).json({ error: 'Your session expired. Please pair again.' });
  if (req.params.roomId && req.params.roomId !== claims.r) {
    return void res.status(403).json({ error: 'You do not have access to this room.' });
  }
  req.claims = claims;
  next();
}

function readDevice(req: Request): DeviceInfo {
  const decode = (v: unknown, max: number) => {
    try {
      return decodeURIComponent(String(v || '')).slice(0, max);
    } catch {
      return '';
    }
  };
  const type = String(req.headers['x-device-type'] || '');
  return {
    id: decode(req.headers['x-device-id'], 64) || 'unknown',
    name: decode(req.headers['x-device-name'], 60) || 'Unknown device',
    type: (['desktop', 'mobile', 'tablet'].includes(type) ? type : 'desktop') as DeviceType,
  };
}

function originOf(req: Request): string {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return origin;
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol;
  return `${proto}://${req.headers.host}`;
}

function session(roomId: string, method: AuthMethod, account?: string): RoomSession {
  return { roomId, token: issueToken(roomId, method, account), method, account };
}

/** Tiny fixed-window rate limiter (per IP + bucket). */
const hits = new Map<string, { count: number; resetAt: number }>();
function rateLimit(bucket: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || rec.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.resetAt - now) / 1000));
      return void res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
}, 60_000).unref();

/* --------------------------------- app ---------------------------------- */

async function main() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // CORS, so the frontend can be hosted elsewhere (e.g. GitHub Pages) and call this API.
  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type,X-File-Name,X-Device-Id,X-Device-Name,X-Device-Type'
      );
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });

  const json = express.json({ limit: '100kb' });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: store.rooms.size, files: store.files.size });
  });

  /* ----------------------------- sessions ----------------------------- */

  // A brand-new private room for this device.
  app.post('/api/rooms', rateLimit('rooms', 30, 60_000), (_req, res) => {
    res.status(201).json(session(store.newRoomId(), 'guest'));
  });

  // Check that a saved session is still valid.
  app.get('/api/session', (req, res) => {
    const claims = verifyToken(bearer(req));
    if (!claims) return void res.status(401).json({ error: 'Session expired.' });
    res.json({ roomId: claims.r, method: claims.m, account: claims.a });
  });

  /* ------------------------------ pairing ----------------------------- */

  // Show this on screen: a QR token + a 6-digit PIN that let ONE other device join.
  app.post('/api/rooms/:roomId/pair', rateLimit('pair-create', 60, 60_000), requireRoom, (req: AuthedRequest, res) => {
    res.json(store.createPairing(req.claims!.r));
  });

  // The other device redeems the PIN (typed) or the token (scanned QR).
  app.post('/api/pair/claim', json, rateLimit('pair-claim', 12, 5 * 60_000), (req, res) => {
    const pin = req.body?.pin ? cleanPin(String(req.body.pin)) : null;
    const pairToken = typeof req.body?.pairToken === 'string' ? req.body.pairToken.slice(0, 64) : undefined;
    if (!pin && !pairToken) return void res.status(400).json({ error: 'Enter the 6-digit PIN shown on the other device.' });

    const roomId = store.claimPairing(pin ? { pin } : { pairToken }, readDevice(req));
    if (!roomId) {
      return void res.status(404).json({
        error: pin
          ? 'That PIN is wrong or has expired. Check the other screen for the current PIN.'
          : 'This QR code has expired. Ask the other device to show a fresh one.',
      });
    }
    res.json(session(roomId, pin ? 'pin' : 'qr'));
  });

  /* ------------------------------ sign-in ----------------------------- */

  app.post('/api/auth/google', json, rateLimit('auth', 30, 60_000), async (req, res) => {
    try {
      const user = await verifyGoogleIdToken(String(req.body?.idToken || ''));
      res.json(session(accountRoomId('google', user.uid), 'google', user.email || 'Google account'));
    } catch (err) {
      console.warn('[auth/google]', err instanceof Error ? err.message : err);
      res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
  });

  app.post('/api/auth/wallet/challenge', json, rateLimit('auth', 30, 60_000), (req, res) => {
    try {
      const message = createWalletChallenge({
        address: String(req.body?.address || ''),
        chainId: Number(req.body?.chainId || 1),
        origin: originOf(req),
      });
      res.json({ message });
    } catch {
      res.status(400).json({ error: 'That does not look like a valid wallet address.' });
    }
  });

  app.post('/api/auth/wallet/verify', json, rateLimit('auth', 30, 60_000), async (req, res) => {
    try {
      const address = await verifyWalletSignature({
        message: String(req.body?.message || ''),
        signature: String(req.body?.signature || ''),
        origin: originOf(req),
      });
      res.json(session(accountRoomId('wallet', address), 'wallet', shortAddress(address)));
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : 'Wallet sign-in failed.' });
    }
  });

  /* ------------------------------- items ------------------------------ */

  // Share a link or a text note.
  app.post('/api/rooms/:roomId/items', json, rateLimit('items', 120, 60_000), requireRoom, (req: AuthedRequest, res) => {
    const raw = typeof req.body?.text === 'string' ? req.body.text : '';
    const text = raw.trim();
    if (!text) return void res.status(400).json({ error: 'Type or paste something to send.' });
    if (text.length > MAX_TEXT_CHARS) {
      return void res.status(413).json({ error: `Text is too long (max ${MAX_TEXT_CHARS.toLocaleString()} characters).` });
    }
    const url = toHttpUrl(text);
    const item = store.addItem(req.claims!.r, {
      kind: url ? 'link' : 'text',
      ...(url ? { url } : { text: raw.replace(/^\s*\n|\s+$/g, '') }),
      from: readDevice(req),
    });
    res.status(201).json({ item });
  });

  // Upload a file (raw bytes in the body, name in the X-File-Name header).
  app.post(
    '/api/rooms/:roomId/files',
    rateLimit('files', 60, 60_000),
    requireRoom,
    express.raw({ type: () => true, limit: MAX_FILE_BYTES }),
    (req: AuthedRequest, res) => {
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return void res.status(400).json({ error: 'The file is empty.' });
      }
      if (!store.hasSpaceFor(data.length)) return void res.status(413).json({ error: 'Room storage is full.' });
      let name = 'file';
      try {
        name = safeFileName(decodeURIComponent(String(req.headers['x-file-name'] || 'file')));
      } catch {
        // keep default
      }
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
      const item = store.addItem(
        req.claims!.r,
        {
          kind: 'file',
          file: { fileId: randomId(18), name, size: data.length, mime },
          from: readDevice(req),
        },
        data
      );
      res.status(201).json({ item });
    }
  );

  app.delete('/api/rooms/:roomId/items/:itemId', requireRoom, (req: AuthedRequest, res) => {
    store.removeItem(req.claims!.r, String(req.params.itemId));
    res.json({ ok: true });
  });

  app.delete('/api/rooms/:roomId/items', requireRoom, (req: AuthedRequest, res) => {
    store.clearRoom(req.claims!.r);
    res.json({ ok: true });
  });

  // Download / preview. The long random fileId acts as the key, so this link also
  // works from a per-item QR code on a phone that never paired.
  app.get('/api/files/:fileId', (req, res) => {
    const file = store.files.get(String(req.params.fileId));
    if (!file || file.expiresAt < Date.now()) return void res.status(404).send('This file has expired or was deleted.');

    const { mime, name } = file.meta;
    const inline = req.query.download === undefined && isInlineSafeMime(mime);
    const encoded = encodeURIComponent(name);
    res.setHeader('Content-Type', inline ? mime : mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encoded}`
    );
    // Uploaded files must never run scripts on our domain.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(file.data);
  });

  // Unknown API routes / errors (e.g. upload too large) should return JSON, not the SPA.
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'Not found.' }));
  app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') {
      return void res.status(413).json({ error: `File is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).` });
    }
    console.error(err);
    res.status(err.status || 500).json({ error: 'Something went wrong on the server.' });
  });

  /* -------------------------------- web app ------------------------------- */

  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const dist = path.join(__dirname, 'dist');
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  /* ------------------------------ WebSocket ------------------------------- */

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

  interface Conn {
    ws: WebSocket;
    id: string;
    roomId?: string;
    alive: boolean;
  }
  const conns = new Set<Conn>();

  store.onEvent((roomId, event) => {
    const payload = JSON.stringify(event);
    for (const c of conns) {
      if (c.roomId === roomId && c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
    }
  });

  wss.on('connection', (ws) => {
    const conn: Conn = { ws, id: randomId(8), alive: true };
    conns.add(conn);
    ws.on('pong', () => (conn.alive = true));

    // The first message must be { type: 'hello', token, device }.
    const helloTimer = setTimeout(() => !conn.roomId && ws.close(4001, 'hello timeout'), 10_000);

    ws.on('message', (raw) => {
      let msg: { type?: string; token?: string; device?: Partial<DeviceInfo> };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'ping') return void ws.send('{"type":"pong"}');
      if (msg.type !== 'hello' || conn.roomId) return;

      const claims = verifyToken(msg.token);
      if (!claims) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session expired. Please pair again.' }));
        return void ws.close(4003, 'unauthorized');
      }
      clearTimeout(helloTimer);
      const d = msg.device || {};
      const device: PresentDevice = {
        id: String(d.id || conn.id).slice(0, 64),
        name: String(d.name || 'Unknown device').slice(0, 60),
        type: d.type === 'mobile' || d.type === 'tablet' ? d.type : 'desktop',
        method: claims.m,
        joinedAt: new Date().toISOString(),
      };
      conn.roomId = claims.r;
      const room = store.room(claims.r);
      ws.send(JSON.stringify({ type: 'ready', roomId: room.id, items: room.items, devices: store.presence(room.id) }));
      store.join(room.id, conn.id, device);
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      conns.delete(conn);
      if (conn.roomId) store.leave(conn.roomId, conn.id);
    });
  });

  // Drop dead connections (phones going to sleep etc.).
  setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 25_000).unref();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`qrLinkShare running on http://localhost:${PORT}`);
  });
}

main();
