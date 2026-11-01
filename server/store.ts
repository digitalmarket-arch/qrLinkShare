/**
 * In-memory storage for rooms, shared items, uploaded files and pairing codes.
 *
 * Everything lives in RAM and expires automatically (ITEM_TTL_HOURS, default 24h).
 * That keeps the app simple and private, but it means a server restart clears
 * shared items. For permanent storage, swap the `files` map for S3 / Cloudflare R2.
 *
 * Memory rules:
 *  - every item (file OR note) counts toward its room, its uploader and the server total;
 *  - when the server is full, NEW uploads are refused. Nobody else's files are ever
 *    deleted to make room;
 *  - one uploader (IP address) may hold at most MAX_USER_MB (default: a quarter of the total).
 */
import type {
  DeviceInfo,
  FileMeta,
  PairingCode,
  PresentDevice,
  SharedItem,
} from '../src/types/share';
import { randomId, randomPin, type AccessClaims } from './tokens';

const HOUR = 60 * 60 * 1000;
export const ITEM_TTL_MS = Number(process.env.ITEM_TTL_HOURS || 24) * HOUR;
export const PAIR_TTL_MS = 3 * 60 * 1000;
const MAX_ITEMS_PER_ROOM = 200;
export const MAX_ROOM_BYTES = Number(process.env.MAX_ROOM_MB || 200) * 1024 * 1024;
const MAX_TOTAL_BYTES = Number(process.env.MAX_STORE_MB || 512) * 1024 * 1024;
/** Per uploader (IP address). Default: a quarter of the server's storage. */
const MAX_OWNER_BYTES = process.env.MAX_USER_MB ? Number(process.env.MAX_USER_MB) * 1024 * 1024 : Math.floor(MAX_TOTAL_BYTES / 4);
/** Space kept free for notes and links, so big files can never block text sharing. */
const NOTE_RESERVE_BYTES = Math.max(2 * 1024 * 1024, Math.floor(MAX_TOTAL_BYTES * 0.05));
/** Notes/links one uploader may hold at once (keeps the reserve from being used up by one person). */
const MAX_OWNER_NOTE_BYTES = 2 * 1024 * 1024;
/** How long uploads still in flight from a device's old room are redirected after it pairs. */
const MOVED_TO_TTL_MS = 15 * 60 * 1000;

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
  /** This device just paired elsewhere; anything still arriving here goes there instead. */
  movedTo?: { roomId: string; until: number };
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

/** Approximate RAM cost of an item (JS strings are ~2 bytes per character). */
export function itemCost(item: Pick<SharedItem, 'text' | 'url'>, data?: Buffer): number {
  return (data?.length ?? 0) + 2 * ((item.text?.length ?? 0) + (item.url?.length ?? 0)) + 256;
}

class Store {
  rooms = new Map<string, Room>();
  files = new Map<string, StoredFile>();
  pins = new Map<string, PairRecord>();
  pairTokens = new Map<string, PairRecord>();
  totalBytes = 0;
  /** itemId -> who stored it and how much memory it uses */
  private sizes = new Map<string, { bytes: number; owner: string; note: boolean }>();
  private ownerBytes = new Map<string, number>();
  private ownerNoteBytes = new Map<string, number>();
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

  /**
   * Where a new item from this token should go. Only the room's creator (the 'guest'
   * token, i.e. the device that just moved) follows a recent move; every other member
   * of the old room keeps writing to the old room.
   */
  resolveRoom(claims: AccessClaims): string {
    if (claims.m !== 'guest') return claims.r;
    const moved = this.rooms.get(claims.r)?.movedTo;
    return moved && moved.until > Date.now() ? moved.roomId : claims.r;
  }

  /* ------------------------------- items ------------------------------- */

  /** Returns a user-facing reason if this item can't be stored right now, else null. */
  refuse(owner: string, bytes: number, kind: 'file' | 'note'): string | null {
    // Files may not use the last few MB, so notes and links keep working when big files fill the server.
    const limit = kind === 'file' ? MAX_TOTAL_BYTES - NOTE_RESERVE_BYTES : MAX_TOTAL_BYTES;
    if (this.totalBytes + bytes > limit) return 'The server is full right now. Please try again later.';
    if ((this.ownerBytes.get(owner) ?? 0) + bytes > MAX_OWNER_BYTES) {
      return 'You are storing a lot already. Delete some items or wait for them to expire.';
    }
    if (kind === 'note' && (this.ownerNoteBytes.get(owner) ?? 0) + bytes > MAX_OWNER_NOTE_BYTES) {
      return 'You have shared a lot of notes already. Delete some or send long text as a file.';
    }
    return null;
  }

  addItem(
    roomId: string,
    owner: string,
    item: Omit<SharedItem, 'id' | 'roomId' | 'createdAt' | 'expiresAt'>,
    data?: Buffer
  ): SharedItem {
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
      this.files.set(full.file.fileId, { meta: full.file, roomId, itemId: full.id, data, expiresAt: now + ITEM_TTL_MS });
    }
    const bytes = itemCost(full, data);
    const note = !full.file;
    this.sizes.set(full.id, { bytes, owner, note });
    this.ownerBytes.set(owner, (this.ownerBytes.get(owner) ?? 0) + bytes);
    if (note) this.ownerNoteBytes.set(owner, (this.ownerNoteBytes.get(owner) ?? 0) + bytes);
    room.bytes += bytes;
    this.totalBytes += bytes;

    room.items.unshift(full);
    this.emit(roomId, { type: 'item:new', item: full });
    this.enforceRoomLimits(room);
    return full;
  }

  /** Frees an item's memory and bookkeeping (no events). */
  private forget(item: SharedItem, room: Room) {
    if (item.file) this.files.delete(item.file.fileId);
    const size = this.sizes.get(item.id);
    if (!size) return;
    this.sizes.delete(item.id);
    room.bytes -= size.bytes;
    this.totalBytes -= size.bytes;
    const dec = (map: Map<string, number>) => {
      const left = (map.get(size.owner) ?? 0) - size.bytes;
      if (left > 0) map.set(size.owner, left);
      else map.delete(size.owner);
    };
    dec(this.ownerBytes);
    if (size.note) dec(this.ownerNoteBytes);
  }

  removeItem(roomId: string, itemId: string): boolean {
    const room = this.rooms.get(roomId);
    const item = room?.items.find((i) => i.id === itemId);
    if (!room || !item) return false;
    room.items = room.items.filter((i) => i.id !== itemId);
    this.forget(item, room);
    this.emit(roomId, { type: 'item:removed', itemId });
    return true;
  }

  clearRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const item of room.items) this.forget(item, room);
    room.items = [];
    this.emit(roomId, { type: 'room:cleared' });
  }

  /**
   * A device that was alone in its own room just joined another room: bring along
   * what it shared, so a note sent before pairing isn't lost, and send anything
   * still uploading to the new room too. The caller checks that it's safe.
   */
  moveItems(fromRoomId: string, toRoomId: string) {
    if (fromRoomId === toRoomId) return;
    const from = this.room(fromRoomId);
    const to = this.room(toRoomId);
    from.movedTo = { roomId: toRoomId, until: Date.now() + MOVED_TO_TTL_MS };
    // Nobody new should join a room its creator just left.
    if (from.pairing) this.revoke(from.pairing.pin, from.pairing.pairToken);
    from.pairing = undefined;
    if (from.items.length === 0) return;
    const moving = [...from.items].reverse(); // oldest first
    from.items = [];
    for (const item of moving) {
      item.roomId = toRoomId;
      if (item.file) {
        const f = this.files.get(item.file.fileId);
        if (f) f.roomId = toRoomId;
      }
      const bytes = this.sizes.get(item.id)?.bytes ?? 0;
      from.bytes -= bytes;
      to.bytes += bytes;
      to.items.push(item);
      this.emit(toRoomId, { type: 'item:new', item });
    }
    to.items.sort(byNewest);
    this.emit(fromRoomId, { type: 'room:cleared' });
    this.enforceRoomLimits(to);
  }

  /** Oldest items go first when a room is too big or has too many items. */
  private enforceRoomLimits(room: Room) {
    while (room.items.length > MAX_ITEMS_PER_ROOM || room.bytes > MAX_ROOM_BYTES) {
      const oldest = room.items[room.items.length - 1];
      if (!oldest) break;
      this.removeItem(room.id, oldest.id);
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
      if (room.movedTo && room.movedTo.until < now) room.movedTo = undefined;
      // Keep rooms that still have a live pairing code or redirect.
      if (room.items.length === 0 && room.devices.size === 0 && !room.pairing && !room.movedTo) this.rooms.delete(room.id);
    }
    for (const [pin, rec] of this.pins) if (rec.expiresAt < now) this.pins.delete(pin);
    for (const [t, rec] of this.pairTokens) if (rec.expiresAt < now) this.pairTokens.delete(t);
  }
}

export const store = new Store();
setInterval(() => store.sweep(), 60_000).unref();
