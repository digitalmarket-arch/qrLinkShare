/**
 * In-memory storage for rooms, shared items, uploaded files and pairing codes.
 *
 * Everything lives in RAM and expires automatically (ITEM_TTL_HOURS, default 24h).
 * That keeps the app simple and private, but it means a server restart clears
 * shared items. For permanent storage, swap the `files` map for S3 / Cloudflare R2.
 */
import type {
  DeviceInfo,
  FileMeta,
  PairingCode,
  PresentDevice,
  SharedItem,
} from '../src/types/share';
import { randomId, randomPin } from './tokens';

const HOUR = 60 * 60 * 1000;
export const ITEM_TTL_MS = Number(process.env.ITEM_TTL_HOURS || 24) * HOUR;
export const PAIR_TTL_MS = 3 * 60 * 1000;
const MAX_ITEMS_PER_ROOM = 200;
export const MAX_ROOM_BYTES = Number(process.env.MAX_ROOM_MB || 200) * 1024 * 1024;
const MAX_TOTAL_BYTES = Number(process.env.MAX_STORE_MB || 512) * 1024 * 1024;

export interface StoredFile {
  meta: FileMeta;
  roomId: string;
  itemId: string;
  data: Buffer;
  expiresAt: number;
}

export interface Room {
  id: string;
  items: SharedItem[];
  devices: Map<string, PresentDevice>; // keyed by connection id
  pairing?: PairingCode;
  bytes: number;
  /** Another device has joined this room at some point (so never move its items away). */
  everShared?: boolean;
}

/** A PIN record and its QR-token twin point at each other, so using one always revokes both. */
interface PairRecord {
  roomId: string;
  expiresAt: number;
  pin: string;
  pairToken: string;
}

type Listener = (roomId: string, event: Record<string, unknown>) => void;

const byNewest = (a: SharedItem, b: SharedItem) => b.createdAt.localeCompare(a.createdAt);

class Store {
  rooms = new Map<string, Room>();
  files = new Map<string, StoredFile>();
  pins = new Map<string, PairRecord>();
  pairTokens = new Map<string, PairRecord>();
  totalBytes = 0;
  private listener: Listener = () => {};

  onEvent(listener: Listener) {
    this.listener = listener;
  }

  private emit(roomId: string, event: Record<string, unknown>) {
    this.listener(roomId, event);
  }

  room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, items: [], devices: new Map(), bytes: 0 };
      this.rooms.set(id, room);
    }
    return room;
  }

  newRoomId(): string {
    let id = '';
    do id = `r_${randomId(9)}`;
    while (this.rooms.has(id));
    return id;
  }

  /* ------------------------------- items ------------------------------- */

  addItem(roomId: string, item: Omit<SharedItem, 'id' | 'roomId' | 'createdAt' | 'expiresAt'>, data?: Buffer): SharedItem {
    const room = this.room(roomId);
    const now = Date.now();
    const full: SharedItem = {
      ...item,
      id: randomId(9),
      roomId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ITEM_TTL_MS).toISOString(),
    };

    if (full.file && data) {
      this.files.set(full.file.fileId, {
        meta: full.file,
        roomId,
        itemId: full.id,
        data,
        expiresAt: now + ITEM_TTL_MS,
      });
      room.bytes += data.length;
      this.totalBytes += data.length;
    }

    room.items.unshift(full);
    this.emit(roomId, { type: 'item:new', item: full });
    this.enforceLimits(room);
    return full;
  }

  removeItem(roomId: string, itemId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const item = room.items.find((i) => i.id === itemId);
    if (!item) return false;
    room.items = room.items.filter((i) => i.id !== itemId);
    if (item.file) this.dropFile(item.file.fileId, room);
    this.emit(roomId, { type: 'item:removed', itemId });
    return true;
  }

  clearRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const item of room.items) if (item.file) this.dropFile(item.file.fileId, room);
    room.items = [];
    this.emit(roomId, { type: 'room:cleared' });
  }

  /**
   * Moves everything a device shared in its old (solo) room into the room it just
   * joined, so a note sent before pairing isn't lost. Only call this when nobody
   * else is in the old room.
   */
  moveItems(fromRoomId: string, toRoomId: string) {
    const from = this.rooms.get(fromRoomId);
    if (!from || fromRoomId === toRoomId || from.items.length === 0) return;
    const to = this.room(toRoomId);
    const moving = [...from.items].reverse(); // oldest first
    from.items = [];
    for (const item of moving) {
      item.roomId = toRoomId;
      if (item.file) {
        const f = this.files.get(item.file.fileId);
        if (f) {
          f.roomId = toRoomId;
          from.bytes -= f.data.length;
          to.bytes += f.data.length;
        }
      }
      to.items.push(item);
      this.emit(toRoomId, { type: 'item:new', item });
    }
    to.items.sort(byNewest);
    this.emit(fromRoomId, { type: 'room:cleared' });
    this.enforceLimits(to);
  }

  private dropFile(fileId: string, room?: Room) {
    const f = this.files.get(fileId);
    if (!f) return;
    this.files.delete(fileId);
    this.totalBytes -= f.data.length;
    const r = room ?? this.rooms.get(f.roomId);
    if (r) r.bytes -= f.data.length;
  }

  private enforceLimits(room: Room) {
    // Oldest items go first when a room is too big or has too many items.
    while (room.items.length > MAX_ITEMS_PER_ROOM || room.bytes > MAX_ROOM_BYTES) {
      const oldest = room.items[room.items.length - 1];
      if (!oldest) break;
      this.removeItem(room.id, oldest.id);
    }
    // Server-wide cap: trim the room holding the most data (normally whoever is
    // flooding the server), never someone else's small room first.
    while (this.totalBytes > MAX_TOTAL_BYTES) {
      let heaviest: Room | undefined;
      for (const r of this.rooms.values()) if (r.bytes > 0 && (!heaviest || r.bytes > heaviest.bytes)) heaviest = r;
      const victim = heaviest && [...heaviest.items].reverse().find((i) => i.file);
      if (!heaviest || !victim) break;
      this.removeItem(heaviest.id, victim.id);
    }
  }

  /* ------------------------------ pairing ------------------------------ */

  /** Creates a fresh one-time PIN + QR token for a room (replacing the old one). */
  createPairing(roomId: string): PairingCode {
    const room = this.room(roomId);
    if (room.pairing) this.revoke(room.pairing.pin, room.pairing.pairToken);
    room.pairing = undefined;
    let pin = '';
    do pin = randomPin();
    while (this.pins.has(pin));
    const pairToken = randomId(18);
    const expiresAt = Date.now() + PAIR_TTL_MS;
    const rec: PairRecord = { roomId, expiresAt, pin, pairToken };
    this.pins.set(pin, rec);
    this.pairTokens.set(pairToken, rec);
    room.pairing = { pin, pairToken, expiresAt: new Date(expiresAt).toISOString() };
    return room.pairing;
  }

  private revoke(pin: string, pairToken: string) {
    this.pins.delete(pin);
    this.pairTokens.delete(pairToken);
  }

  /** Uses up a PIN or QR token. Returns the room id, or null if invalid/expired. */
  claimPairing(by: { pin?: string; pairToken?: string }, device: DeviceInfo): string | null {
    const rec = by.pin ? this.pins.get(by.pin) : by.pairToken ? this.pairTokens.get(by.pairToken) : undefined;
    if (!rec || rec.expiresAt < Date.now()) return null;
    this.revoke(rec.pin, rec.pairToken);
    const room = this.room(rec.roomId);
    if (room.pairing?.pin === rec.pin) room.pairing = undefined;
    room.everShared = true;
    this.emit(room.id, { type: 'pair:used', by: device });
    return room.id;
  }

  /* ------------------------------ presence ----------------------------- */

  join(roomId: string, connId: string, device: PresentDevice) {
    this.room(roomId).devices.set(connId, device);
    this.emitPresence(roomId);
  }

  leave(roomId: string, connId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.devices.delete(connId);
    this.emitPresence(roomId);
  }

  presence(roomId: string): PresentDevice[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    // One entry per device even if it has two tabs open.
    const byId = new Map<string, PresentDevice>();
    for (const d of room.devices.values()) if (!byId.has(d.id)) byId.set(d.id, d);
    return [...byId.values()];
  }

  private emitPresence(roomId: string) {
    this.emit(roomId, { type: 'presence', devices: this.presence(roomId) });
  }

  /* ------------------------------ cleanup ------------------------------ */

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const expired = room.items.filter((i) => new Date(i.expiresAt).getTime() < now);
      for (const item of expired) this.removeItem(room.id, item.id);
      if (room.pairing && new Date(room.pairing.expiresAt).getTime() < now) {
        this.revoke(room.pairing.pin, room.pairing.pairToken);
        room.pairing = undefined;
      }
      // Keep rooms that still have a live pairing code, otherwise the code's
      // one-time revoke would have nothing to point at.
      if (room.items.length === 0 && room.devices.size === 0 && !room.pairing) this.rooms.delete(room.id);
    }
    for (const [pin, rec] of this.pins) if (rec.expiresAt < now) this.pins.delete(pin);
    for (const [t, rec] of this.pairTokens) if (rec.expiresAt < now) this.pairTokens.delete(t);
  }
}

export const store = new Store();
setInterval(() => store.sweep(), 60_000).unref();
