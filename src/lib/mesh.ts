/**
 * The peer-to-peer engine.
 *
 * Devices connect directly to each other (WebRTC, encrypted end to end) using the
 * Trystero library. Public relays are only used to find each other and exchange an
 * encrypted handshake; links, notes and files go straight from device to device.
 *
 * Rooms this device can be in:
 *  - group:   all devices paired by QR code / PIN (always)
 *  - account: all devices signed in to the same Google account or wallet (optional)
 *  - invite / pin: short-lived meeting rooms used only while pairing a new device
 *
 * Every device introduces itself with a "hello". Only devices that pass the room's
 * check are treated as connected; anything from anyone else is ignored.
 */
import { joinRoom, getRelaySockets, type Room, type MessageAction, type JoinRoomConfig } from 'trystero';
import type { ConnectedDevice, DeviceInfo, DeviceType, LinkMethod, WireItem } from '../types/share';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from './shared';
import { APP_ID, groupRoom, inviteRoom, isValidSecret, pinRoom, type RoomRef } from './pairing';

export type HelloAuth = { idToken?: string; message?: string; signature?: string };
type Hello = { v: 1; device: DeviceInfo; auth?: HelloAuth };
type Welcome = { v: 1; group?: string; denied?: boolean };

/** Decides whether a device in the account room really belongs to the same account. */
export type AccountVerifier = (auth: HelloAuth | undefined, peerDeviceId: string) => Promise<boolean>;

export interface AccountSession {
  kind: 'google' | 'wallet';
  room: RoomRef;
  /** What this device sends to prove itself (fetched fresh for every hello). */
  auth: () => Promise<HelloAuth>;
  verify: AccountVerifier;
}

export interface MeshOptions {
  privateMode: boolean;
  device: { name: string; type: DeviceType };
  /** Relay addresses (only used by tests / self-hosting; default: Trystero's public relays). */
  relayUrls?: string[];
  /** Override network-traversal servers (tests pass []). */
  iceServers?: RTCIceServer[];
  /** Optional TURN relay for very strict networks. */
  turn?: { urls: string[]; username?: string; credential?: string };
}

export type RelayStatus = 'connecting' | 'online' | 'offline';

interface PeerRecord {
  peerId: string;
  userId: string;
  device: DeviceInfo | null;
  verified: boolean;
  helloSent: boolean;
  /** Resolves once this device's hello has been checked (false if it fails or never comes). */
  verdict: Promise<boolean>;
  settle: (ok: boolean) => void;
  settled: boolean;
}

/** How long to wait for a device's hello before ignoring what it sends. */
const VERDICT_TIMEOUT_MS = 20_000;

function newPeerRecord(peerId: string, userId: string): PeerRecord {
  let settle!: (ok: boolean) => void;
  const verdict = new Promise<boolean>((resolve) => (settle = resolve));
  const rec: PeerRecord = { peerId, userId, device: null, verified: false, helloSent: false, verdict, settle, settled: false };
  rec.settle = (ok) => {
    if (rec.settled) return;
    rec.settled = true;
    settle(ok);
  };
  setTimeout(() => rec.settle(false), VERDICT_TIMEOUT_MS);
  return rec;
}

interface Channel {
  kind: 'group' | 'account';
  method: LinkMethod;
  room: Room;
  peers: Map<string, PeerRecord>;
  item: MessageAction<WireItem>;
  file: MessageAction<Blob | Uint8Array>;
  hello: MessageAction<Hello>;
  helloAuth: () => Promise<HelloAuth | undefined>;
  verify: (hello: Hello, peerUserId: string) => Promise<boolean>;
}

export interface IncomingFile {
  id: string;
  bytes: Uint8Array;
  fromDeviceId: string;
}

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private set = new Set<Listener<T>>();
  on(fn: Listener<T>) {
    this.set.add(fn);
    return () => void this.set.delete(fn);
  }
  emit(value: T) {
    for (const fn of [...this.set]) {
      try {
        fn(value);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

const ITEM_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Rejects anything that isn't a well-formed item (other devices are trusted, but not blindly). */
export function isWireItem(x: unknown): x is WireItem {
  const i = x as WireItem;
  if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !ITEM_ID.test(i.id)) return false;
  if (i.kind !== 'text' && i.kind !== 'link' && i.kind !== 'file') return false;
  if (i.retention !== 'temp' && i.retention !== 'saved') return false;
  if (typeof i.createdAt !== 'string' || Number.isNaN(Date.parse(i.createdAt))) return false;
  if (i.expiresAt !== undefined && (typeof i.expiresAt !== 'string' || Number.isNaN(Date.parse(i.expiresAt)))) return false;
  if (!i.from || typeof i.from.id !== 'string' || typeof i.from.name !== 'string') return false;
  if (i.kind === 'text' && (typeof i.text !== 'string' || i.text.length > MAX_TEXT_CHARS)) return false;
  if (i.kind === 'link' && (typeof i.url !== 'string' || !/^https?:\/\//i.test(i.url) || i.url.length > 4000)) return false;
  if (i.kind === 'file') {
    const f = i.file;
    if (!f || typeof f.name !== 'string' || typeof f.mime !== 'string' || typeof f.size !== 'number') return false;
    if (f.size < 0 || f.size > MAX_FILE_BYTES || f.name.length > 255 || f.mime.length > 255) return false;
  }
  return true;
}

function isDeviceInfo(d: unknown): d is DeviceInfo {
  const x = d as DeviceInfo;
  return !!x && typeof x.id === 'string' && typeof x.name === 'string' && x.name.length <= 80 && ['desktop', 'mobile', 'tablet'].includes(x.type);
}

export class Mesh {
  readonly devicesChanged = new Emitter<ConnectedDevice[]>();
  readonly deviceVerified = new Emitter<ConnectedDevice>();
  readonly itemReceived = new Emitter<WireItem>();
  readonly fileReceived = new Emitter<IncomingFile>();
  readonly receiveProgress = new Emitter<{ id: string; progress: number }>();
  readonly problem = new Emitter<string>();

  private group: Channel | null = null;
  private account: Channel | null = null;
  private selfIdPromise: Promise<string> | null = null;
  private destroyed = false;

  constructor(private opts: MeshOptions) {}

  /* ------------------------------ configuration ------------------------------ */

  private roomConfig(ref: RoomRef, extra: Partial<JoinRoomConfig> = {}): JoinRoomConfig {
    const { relayUrls, iceServers, turn, privateMode } = this.opts;
    return {
      appId: APP_ID,
      password: ref.password,
      identity: privateMode ? 'none' : 'local',
      maxReceiveBytes: MAX_FILE_BYTES + 1024 * 1024,
      ...(relayUrls?.length ? { relayConfig: { urls: relayUrls, redundancy: relayUrls.length } } : {}),
      ...(iceServers ? { rtcConfig: { iceServers } } : {}),
      ...(turn?.urls.length ? { turnConfig: [{ urls: turn.urls, username: turn.username, credential: turn.credential }] } : {}),
      ...extra,
    };
  }

  /** This device's verified id (the same in every room unless in private mode). */
  async selfId(): Promise<string> {
    if (!this.selfIdPromise) throw new Error('Not connected yet');
    return this.selfIdPromise;
  }

  private async me(room: Room): Promise<DeviceInfo> {
    const { userId } = await room.getSelf();
    return { id: userId, name: this.opts.device.name, type: this.opts.device.type };
  }

  /* --------------------------------- channels -------------------------------- */

  private openChannel(
    kind: Channel['kind'],
    method: LinkMethod,
    ref: RoomRef,
    helloAuth: Channel['helloAuth'],
    verify: Channel['verify']
  ): Channel {
    const room = joinRoom(this.roomConfig(ref), ref.roomId);
    const ch: Channel = {
      kind,
      method,
      room,
      peers: new Map(),
      item: room.makeAction<WireItem>('item'),
      file: room.makeAction<Blob | Uint8Array>('file'),
      hello: room.makeAction<Hello>('hello'),
      helloAuth,
      verify,
    };
    const selfId = room.getSelf().then((s) => s.userId);
    if (!this.selfIdPromise || kind === 'group') this.selfIdPromise = selfId;

    const sendHello = async (peerId: string) => {
      const rec = ch.peers.get(peerId);
      if (!rec || rec.helloSent) return;
      rec.helloSent = true;
      try {
        const [device, auth] = await Promise.all([this.me(room), ch.helloAuth()]);
        await ch.hello.send({ v: 1, device, ...(auth ? { auth } : {}) }, { target: peerId });
      } catch {
        rec.helloSent = false;
      }
    };

    /** The record for a device, created on first contact (join or first message). */
    const peer = (peerId: string, userId: string) => {
      let rec = ch.peers.get(peerId);
      if (!rec) {
        rec = newPeerRecord(peerId, userId);
        ch.peers.set(peerId, rec);
      }
      return rec;
    };

    room.onPeerJoin(async ({ peerId, userId }) => {
      if (userId === (await selfId)) return; // another tab of this same browser
      peer(peerId, userId);
      void sendHello(peerId);
    });

    room.onPeerLeave(({ peerId }) => {
      if (ch.peers.delete(peerId)) this.emitDevices();
    });

    ch.hello.onMessage(async (data, { peerId, userId }) => {
      if (userId === (await selfId)) return;
      const rec = peer(peerId, userId);
      if (rec.settled) return; // a device introduces itself once per connection
      if (!data || data.v !== 1 || !isDeviceInfo(data.device) || data.device.id !== userId) {
        rec.settle(false);
        return;
      }
      rec.device = data.device;
      rec.verified = await ch.verify(data, userId).catch(() => false);
      rec.settle(rec.verified);
      // Answer if our own hello hasn't gone out yet (e.g. it raced with their join).
      void sendHello(peerId);
      this.emitDevices();
      if (rec.verified) this.deviceVerified.emit({ ...data.device, method: ch.method });
    });

    /** Waits for the device's hello to be checked, so nothing it sends right after is lost. */
    const isTrusted = async (peerId: string, userId: string) => {
      if (userId === (await selfId)) return false;
      return peer(peerId, userId).verdict;
    };

    ch.item.onMessage(async (data, { peerId, userId }) => {
      if (!isWireItem(data) || data.from.id !== userId || !(await isTrusted(peerId, userId))) return;
      this.itemReceived.emit(data);
    });

    ch.file.onReceive(async ({ peerId, userId, byteLength, metadata }) => {
      const id = (metadata as { id?: unknown } | undefined)?.id;
      if (byteLength > MAX_FILE_BYTES || typeof id !== 'string' || !ITEM_ID.test(id)) return false;
      return isTrusted(peerId, userId);
    });
    ch.file.onReceiveProgress((progress, { metadata }) => {
      const id = (metadata as { id?: string } | undefined)?.id;
      if (id) this.receiveProgress.emit({ id, progress });
    });
    ch.file.onMessage((data, { peerId, userId, metadata }) => {
      const id = (metadata as { id?: string } | undefined)?.id;
      if (!id || ch.peers.get(peerId)?.verified !== true) return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(0);
      this.fileReceived.emit({ id, bytes, fromDeviceId: userId });
    });

    room.onError((err) => {
      if (err.code === 'peer-connect-failed') {
        this.problem.emit(
          'A device was found but a direct connection could not be made. Putting both devices on the same Wi-Fi usually fixes this.'
        );
      }
    });

    return ch;
  }

  /** Joins (or switches) the room of devices paired by QR code / PIN. */
  async setGroup(secret: string): Promise<void> {
    if (!isValidSecret(secret)) throw new Error('Invalid pairing secret');
    const old = this.group;
    this.group = null;
    if (old) await old.room.leave().catch(() => {});
    if (this.destroyed) return;
    const ref = await groupRoom(secret);
    this.group = this.openChannel('group', 'paired', ref, async () => undefined, async () => true);
    this.emitDevices();
  }

  /** Joins (or leaves, with null) the room of devices signed in to the same account. */
  async setAccount(session: AccountSession | null): Promise<void> {
    const old = this.account;
    this.account = null;
    if (old) await old.room.leave().catch(() => {});
    if (!session || this.destroyed) {
      this.emitDevices();
      return;
    }
    this.account = this.openChannel(
      'account',
      session.kind,
      session.room,
      () => session.auth(),
      (hello, peerUserId) => session.verify(hello.auth, peerUserId)
    );
    this.emitDevices();
  }

  /* ---------------------------------- devices --------------------------------- */

  /** Verified devices, one entry per device even if it is in two rooms or has two tabs open. */
  devices(): ConnectedDevice[] {
    const byId = new Map<string, ConnectedDevice>();
    for (const ch of [this.group, this.account]) {
      if (!ch) continue;
      for (const p of ch.peers.values()) {
        if (p.verified && p.device && !byId.has(p.userId)) byId.set(p.userId, { ...p.device, method: ch.method });
      }
    }
    return [...byId.values()];
  }

  private emitDevices() {
    this.devicesChanged.emit(this.devices());
  }

  /** One route (room + connection) per verified device. */
  private routes(only?: string[]): Array<{ ch: Channel; peerId: string; deviceId: string }> {
    const seen = new Set<string>();
    const out: Array<{ ch: Channel; peerId: string; deviceId: string }> = [];
    for (const ch of [this.group, this.account]) {
      if (!ch) continue;
      for (const p of ch.peers.values()) {
        if (!p.verified || seen.has(p.userId) || (only && !only.includes(p.userId))) continue;
        seen.add(p.userId);
        out.push({ ch, peerId: p.peerId, deviceId: p.userId });
      }
    }
    return out;
  }

  /**
   * Sends an item (and its file, if any) to every connected device, or only to
   * `onlyDeviceIds`. Returns the ids of the devices that received it.
   */
  async send(item: WireItem, blob?: Blob, opts: { onlyDeviceIds?: string[]; onProgress?: (p: number) => void } = {}): Promise<string[]> {
    const routes = this.routes(opts.onlyDeviceIds);
    const delivered: string[] = [];
    const progress = new Map<string, number>();
    await Promise.all(
      routes.map(async ({ ch, peerId, deviceId }) => {
        try {
          await ch.item.send(item, { target: peerId });
          if (blob) {
            await ch.file.send(blob, {
              target: peerId,
              metadata: { id: item.id },
              onProgress: (p) => {
                progress.set(deviceId, p);
                opts.onProgress?.(Math.min(...routes.map((r) => progress.get(r.deviceId) ?? 0)));
              },
            });
          }
          delivered.push(deviceId);
        } catch {
          // that device disconnected mid-way; it stays "pending" for it
        }
      })
    );
    return delivered;
  }

  /* --------------------------------- pairing --------------------------------- */

  /**
   * Shows this device's code: listens in the meeting rooms for the current QR
   * invitation and PIN. A device arriving with the QR invitation is welcomed
   * automatically; one arriving with the PIN needs `onKnock` to approve it.
   * Returns a function that stops listening.
   */
  host(
    code: { invite: string; pin: string },
    handlers: {
      groupSecret: () => string;
      onKnock: (device: DeviceInfo) => Promise<boolean>;
      onPaired: (device: DeviceInfo, via: 'qr' | 'pin') => void;
    }
  ): () => void {
    const rooms: Room[] = [];
    let stopped = false;

    const open = async (via: 'qr' | 'pin') => {
      const ref = via === 'qr' ? await inviteRoom(code.invite) : await pinRoom(code.pin);
      if (stopped) return;
      const room = joinRoom(this.roomConfig(ref, { maxUsers: 2 }), ref.roomId);
      rooms.push(room);
      const hello = room.makeAction<Hello>('hello');
      const welcome = room.makeAction<Welcome>('welcome');
      const answered = new Set<string>();
      hello.onMessage(async (data, { peerId, userId }) => {
        if (answered.has(peerId) || !data || data.v !== 1 || !isDeviceInfo(data.device) || data.device.id !== userId) return;
        answered.add(peerId);
        const ok = via === 'qr' ? true : await handlers.onKnock(data.device).catch(() => false);
        if (stopped) return;
        await welcome.send(ok ? { v: 1, group: handlers.groupSecret() } : { v: 1, denied: true }, { target: peerId }).catch(() => {});
        if (ok) handlers.onPaired(data.device, via);
      });
    };
    void open('qr');
    void open('pin');

    return () => {
      stopped = true;
      for (const r of rooms) void r.leave().catch(() => {});
    };
  }

  /**
   * Joins another device using its QR invitation or PIN. Resolves with that
   * device's group secret (which the caller then joins with setGroup).
   */
  async joinWith(code: { invite?: string; pin?: string }, timeoutMs = 60_000): Promise<string> {
    const ref = code.invite ? await inviteRoom(code.invite) : await pinRoom(code.pin ?? '');
    const room = joinRoom(this.roomConfig(ref, { maxUsers: 2 }), ref.roomId);
    const hello = room.makeAction<Hello>('hello');
    const welcome = room.makeAction<Welcome>('welcome');
    const me = this.me(room);

    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                code.pin
                  ? 'No answer. Check the PIN on the other screen (it changes every 3 minutes) and that the other device is still showing it.'
                  : 'The other device did not answer. Make sure it is still showing the QR code, then scan again.'
              )
            ),
          timeoutMs
        );
        room.onPeerJoin(async ({ peerId }) => {
          await hello.send({ v: 1, device: await me }, { target: peerId }).catch(() => {});
        });
        welcome.onMessage((data) => {
          clearTimeout(timer);
          if (data?.denied) reject(new Error('The other device declined the connection.'));
          else if (isValidSecret(data?.group)) resolve(data.group);
          else reject(new Error('The other device sent an invalid answer.'));
        });
      });
    } finally {
      void room.leave().catch(() => {});
    }
  }

  /* ---------------------------------- status ---------------------------------- */

  relayStatus(): RelayStatus {
    const sockets = Object.values(getRelaySockets());
    if (sockets.some((s) => s.readyState === WebSocket.OPEN)) return 'online';
    if (sockets.some((s) => s.readyState === WebSocket.CONNECTING) || sockets.length === 0) return 'connecting';
    return 'offline';
  }

  async destroy() {
    this.destroyed = true;
    const chans = [this.group, this.account];
    this.group = this.account = null;
    await Promise.all(chans.map((c) => c?.room.leave().catch(() => {})));
  }
}
