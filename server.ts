import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  ConnectedDevice,
  CreateShareItemPayload,
  DeviceType,
  SharedItem,
} from './src/types/share';
import {
  normalizeRoomCode,
  validateShareSubmission,
} from './src/utils/shareLogic';
import { createInitialSeedItems } from './src/utils/seedData';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RoomRecord {
  roomId: string;
  items: SharedItem[];
  devices: Map<string, ConnectedDevice>;
}

const rooms = new Map<string, RoomRecord>();

function getOrCreateRoom(rawRoomId: string): RoomRecord {
  const roomId = normalizeRoomCode(rawRoomId) || 'SYNC-42';
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      roomId,
      items: roomId === 'SYNC-42' ? createInitialSeedItems('SYNC-42') : [],
      devices: new Map<string, ConnectedDevice>(),
    };
    rooms.set(roomId, room);
  }
  return room;
}

// Pre-seed default room SYNC-42
getOrCreateRoom('SYNC-42');

interface ClientMeta {
  ws: WebSocket;
  clientId: string;
  roomId: string;
  deviceName: string;
  deviceType: DeviceType;
}

const clients = new Map<WebSocket, ClientMeta>();

function broadcastToRoom(roomId: string, event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  for (const [, meta] of clients) {
    if (meta.roomId === roomId && meta.ws.readyState === WebSocket.OPEN) {
      meta.ws.send(payload);
    }
  }
}

function serializeDevices(room: RoomRecord): ConnectedDevice[] {
  return Array.from(room.devices.values());
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);

  // Support up to 25MB payloads for base64 file/image/doc drops
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', activeRooms: rooms.size });
  });

  // Get room state
  app.get('/api/rooms/:roomId', (req, res) => {
    const room = getOrCreateRoom(req.params.roomId);
    res.json({
      roomId: room.roomId,
      items: room.items,
      devices: serializeDevices(room),
    });
  });

  // Create/drop a shared item in the room
  app.post('/api/rooms/:roomId/items', (req, res) => {
    const room = getOrCreateRoom(req.params.roomId);
    const body = req.body as CreateShareItemPayload;

    const validation = validateShareSubmission(body);
    if (!validation.valid || !validation.resolvedCategory) {
      res.status(400).json({ error: validation.error || 'Invalid share item.' });
      return;
    }

    const itemId =
      body.id || `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // Idempotency guard: if item with same ID already exists, return it
    const existing = room.items.find((i) => i.id === itemId);
    if (existing) {
      res.status(200).json({ item: existing });
      return;
    }

    const resolvedContent =
      validation.resolvedCategory === 'link' && validation.normalizedUrl
        ? validation.normalizedUrl
        : (body.content ?? '').trim();

    const defaultTitle =
      body.title?.trim() ||
      body.fileName?.trim() ||
      (validation.resolvedCategory === 'link'
        ? resolvedContent.replace(/^https?:\/\//, '').slice(0, 48)
        : resolvedContent.slice(0, 42) || 'Shared Item');

    const sizeBytes =
      typeof body.sizeBytes === 'number' && body.sizeBytes > 0
        ? body.sizeBytes
        : body.dataUrl
          ? Math.round((body.dataUrl.length * 3) / 4)
          : Buffer.byteLength(resolvedContent, 'utf-8');

    const newItem: SharedItem = {
      id: itemId,
      roomId: room.roomId,
      category: validation.resolvedCategory,
      title: defaultTitle,
      content: resolvedContent,
      fileName: body.fileName,
      mimeType: body.mimeType,
      sizeBytes,
      dataUrl: body.dataUrl,
      senderDevice: body.senderDevice === 'mobile' ? 'mobile' : 'desktop',
      senderName:
        body.senderName?.trim() ||
        (body.senderDevice === 'mobile' ? 'Mobile Handset' : 'Desktop Studio'),
      createdAt: new Date().toISOString(),
      pinned: false,
    };

    room.items.unshift(newItem);

    broadcastToRoom(room.roomId, {
      type: 'item:created',
      item: newItem,
    });

    res.status(201).json({ item: newItem });
  });

  // Toggle pin on an item
  app.patch('/api/rooms/:roomId/items/:itemId/pin', (req, res) => {
    const room = getOrCreateRoom(req.params.roomId);
    const target = room.items.find((i) => i.id === req.params.itemId);
    if (!target) {
      res.status(404).json({ error: 'Item not found.' });
      return;
    }
    target.pinned = !target.pinned;
    broadcastToRoom(room.roomId, {
      type: 'item:updated',
      item: target,
    });
    res.json({ item: target });
  });

  // Delete a specific item (idempotent)
  app.delete('/api/rooms/:roomId/items/:itemId', (req, res) => {
    const room = getOrCreateRoom(req.params.roomId);
    const itemId = req.params.itemId;
    room.items = room.items.filter((i) => i.id !== itemId);
    broadcastToRoom(room.roomId, {
      type: 'item:deleted',
      itemId,
    });
    res.json({ deleted: true, itemId });
  });

  // Clear unpinned items in room
  app.delete('/api/rooms/:roomId/items', (req, res) => {
    const room = getOrCreateRoom(req.params.roomId);
    const keepPinned = req.query.keepPinned !== 'false';
    room.items = keepPinned ? room.items.filter((i) => i.pinned) : [];
    broadcastToRoom(room.roomId, {
      type: 'room:cleared',
      items: room.items,
    });
    res.json({ items: room.items });
  });

  // Direct download endpoint for scanning an item's individual QR code on a phone or desktop
  app.get('/api/rooms/:roomId/items/:itemId/download', (req, res) => {
    const room = getOrCreateRoom(req.params.roomId);
    const item = room.items.find((i) => i.id === req.params.itemId);
    if (!item) {
      res.status(404).send('Shared item not found.');
      return;
    }

    if (item.category === 'link') {
      res.redirect(item.content);
      return;
    }

    if (item.dataUrl && item.dataUrl.startsWith('data:')) {
      const match = item.dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (match) {
        const mime = match[1] || item.mimeType || 'application/octet-stream';
        const isBase64 = Boolean(match[2]);
        const rawData = match[3] || '';
        const buffer = isBase64
          ? Buffer.from(rawData, 'base64')
          : Buffer.from(decodeURIComponent(rawData), 'utf-8');
        const safeName = (item.fileName || `${item.id}.bin`).replace(
          /[^a-zA-Z0-9._-]/g,
          '_'
        );
        res.setHeader('Content-Type', mime);
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${safeName}"`
        );
        res.send(buffer);
        return;
      }
    }

    const safeTxtName = (item.fileName || `${item.id}.txt`).replace(
      /[^a-zA-Z0-9._-]/g,
      '_'
    );
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${safeTxtName}"`);
    res.send(item.content);
  });

  // Attach WebSocket server on /ws for real-time phone-to-desktop synchronization
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'room:join') {
          const room = getOrCreateRoom(msg.roomId || 'SYNC-42');
          const clientId =
            msg.clientId ||
            `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const deviceType: DeviceType =
            msg.deviceType === 'mobile' ? 'mobile' : 'desktop';
          const deviceName =
            msg.deviceName ||
            (deviceType === 'mobile' ? 'Mobile Handset' : 'Desktop Studio');

          // Remove from previous room if switching rooms
          const prev = clients.get(ws);
          if (prev && prev.roomId !== room.roomId) {
            const oldRoom = rooms.get(prev.roomId);
            if (oldRoom) {
              oldRoom.devices.delete(prev.clientId);
              broadcastToRoom(oldRoom.roomId, {
                type: 'presence:updated',
                devices: serializeDevices(oldRoom),
              });
            }
          }

          const deviceRecord: ConnectedDevice = {
            clientId,
            deviceName,
            deviceType,
            joinedAt: new Date().toISOString(),
          };

          clients.set(ws, {
            ws,
            clientId,
            roomId: room.roomId,
            deviceName,
            deviceType,
          });
          room.devices.set(clientId, deviceRecord);

          ws.send(
            JSON.stringify({
              type: 'room:init',
              roomId: room.roomId,
              items: room.items,
              devices: serializeDevices(room),
            })
          );

          broadcastToRoom(room.roomId, {
            type: 'presence:updated',
            devices: serializeDevices(room),
          });
        }
      } catch {
        // Ignore malformed WS frames
      }
    });

    ws.on('close', () => {
      const meta = clients.get(ws);
      if (meta) {
        clients.delete(ws);
        const room = rooms.get(meta.roomId);
        if (room) {
          room.devices.delete(meta.clientId);
          broadcastToRoom(room.roomId, {
            type: 'presence:updated',
            devices: serializeDevices(room),
          });
        }
      }
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`qrLinkShare server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
