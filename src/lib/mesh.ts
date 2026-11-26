/**
 * The peer-to-peer engine.
 *
 * Devices connect directly to each other (WebRTC, encrypted end to end) using the
 * Trystero library. Public relays are only used to find each other and exchange an
 * encrypted handshake; links, notes and files go straight from device to device.
 *
 * Rooms this device can be in:
 *  - group:   all devices paired by QR code / PIN
 *  - legacy:  groups this device moved away from; it only stays to tell devices
 *             that come back "we moved, follow me" (so nobody is left behind)
 *  - account: all devices signed in to the same Google account or wallet (optional)
 *  - invite / pin: short-lived meeting rooms used only while pairing a new device
 *
 * Every device introduces itself with a "hello" and answers the other's hello with a
 * verdict. Only when both sides accept each other is a device "connected". Anything
 * from anyone else is refused.
 *
 * Security codes: a PIN is short, and anyone watching the public relays can work out
 * which PIN room is in use. So when devices meet with a PIN (or meet for the first
 * time through a Google account), both screens show the same 4-digit code, computed
 * from both devices' ids and random numbers each side commits to before seeing the
 * other's. Someone sitting in between can't choose the codes; each attempt gives them a
 * 1-in-10,000 chance of the two screens matching. Every attempt that doesn't finish uses
 * up the PIN and is shown, and repeated ones pause PIN pairing, so they can't keep trying.
 *
 * Delivery has receipts: an item only counts as delivered once the other device
 * answers that it has saved it (and its file). Until then it stays "waiting".
 */
import { joinRoom, getRelaySockets, type Room, type MessageAction, type RequestAction, type JoinRoomConfig } from 'trystero';
import type { ConnectedDevice, DeviceInfo, DeviceType, LinkMethod, WireItem } from '../types/share';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, MAX_URL_CHARS } from './shared';
import { APP_ID, groupRoom, inviteRoom, isValidSecret, pinRoom, randomSecret, sha256Hex, type RoomRef } from './pairing';

export type HelloAuth = { idToken?: string };

type Hello = {
  v: 1;
  device: DeviceInfo;
  auth?: HelloAuth;
  /** A "keep nothing" device: it is a new device every visit, so it shouldn't be remembered. */
  ephemeral?: boolean;
  /** Account room (Google): no sign-in token yet, this device first wants to confirm the other one. */
  withheld?: boolean;
  /** Account room (Google): this device has already approved the other one. */
  known?: boolean;
  /** Meeting rooms: this device already has paired devices. */
  paired?: boolean;
  /** PIN meeting room: commitment to this device's security-code number. */
  commit?: string;
};

/** Security-code exchange: first a commitment, then the numbers themselves. */
type Sas = { v: 1; commit?: string; nonce?: string };
/** Host -> joining device, in a meeting room. */
type Welcome = {
  v: 1;
  host?: DeviceInfo;
  group?: string;
  adopt?: boolean;
  adopted?: boolean;
  denied?: boolean;
  expired?: boolean;
  /** Two devices used the same code at once: refused for safety. */
  busy?: boolean;
};
/** Joining device -> host, in a meeting room. */
type JoinReply = { v: 1; ok?: boolean; group?: string; cancel?: boolean };
/** Small control messages between devices in the same room. */
type Control = { v: 1; verdict?: boolean; moveTo?: string; bye?: boolean };
type Withdraw = { v: 1; id: string };

/** What the receiving device answers when it gets an item. */
export type Receipt = 'ok' | 'have' | 'need-file' | 'no-space';
export type DeliveryResult = 'delivered' | 'unreachable' | 'refused' | 'no-space' | 'aborted';
export type JoinStatus = 'looking' | 'found' | 'approval';

/** Decides whether a device in the account room really belongs to the same account. */
export type AccountVerifier = (auth: HelloAuth | undefined, peerDeviceId: string) => Promise<boolean>;

export interface AccountSession {
  kind: 'google' | 'wallet';
  room: RoomRef;
  /** What this device sends to prove itself (fetched fresh for every hello). */
  auth: () => Promise<HelloAuth>;
  verify: AccountVerifier;
  /**
   * Google only: devices approved before reconnect without a question. Any other device
   * must be confirmed with a security code first, and only then sees this device's token.
   */
  isApproved?: (peerDeviceId: string) => boolean;
  /** Google only: shows the security code for a device not approved yet and asks the person. */
  approve?: (device: DeviceInfo, code: string, signal: AbortSignal) => Promise<boolean>;
}

/** The app's side of receiving: store things, then answer. Throwing refuses the item. */
export interface Receiver {
  item(item: WireItem, from: ConnectedDevice): Promise<Receipt>;
  file(id: string, bytes: Uint8Array, from: ConnectedDevice): Promise<Receipt>;
  /** Quick check before a file's bytes start flowing. */
  wantsFile(id: string, size: number, fromDeviceId: string): Promise<boolean>;
  /** The sender cancelled an item part-way (it was deleted there). */
  withdrawn(id: string, fromDeviceId: string): void;
}

/** Why a pairing code shouldn't be used again. */
export type SpentReason = 'declined' | 'left' | 'collision' | 'unfinished' | 'blocked';

export interface HostHandlers {
  groupSecret: () => string;
  /** Whether this device already has paired devices (then the other device joins this group). */
  hasPaired: () => boolean;
  /**
   * A device typed this device's PIN: show the security code and ask the person.
   * `signal` aborts if that device gives up.
   */
  onKnock: (device: DeviceInfo, code: string, signal: AbortSignal) => Promise<boolean>;
  /** The other device brought its own group and this device had none: join that group. */
  onAdopt: (secret: string, device: DeviceInfo) => Promise<void>;
  onPaired: (device: DeviceInfo, via: 'qr' | 'pin') => void;
  /** The code shouldn't be used again (declined, abandoned, unfinished, or two devices at once). */
  onSpent: (reason: SpentReason) => void;
}

export interface JoinOptions {
  /** This device's current group secret (read when it is needed, so it is never stale). */
  mySecret: () => string;
  /** Whether this device already has paired devices. */
  paired: boolean;
  /** How many of this device's items are waiting to be sent (a new device would get them). */
  waiting: number;
  signal?: AbortSignal;
  onStatus?: (s: JoinStatus) => void;
  /**
   * Asks the person before anything is shared: with a PIN, whether both screens show
   * `code`; with a QR code, whether to bring this device's other devices along (merge).
   */
  confirm: (req: { code: string | null; host: DeviceInfo | null; merge: boolean; waiting: number }) => Promise<boolean>;
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

interface SasState {
  mine: string;
  sentCommit: boolean;
  sentNonce: boolean;
  theirCommit?: string;
  theirNonce?: string;
  code?: string;
  asked: boolean;
  abort: AbortController | null;
}

interface PeerRecord {
  peerId: string;
  userId: string;
  device: DeviceInfo | null;
  ephemeral: boolean;
  /** We checked its hello and trust it. */
  verified: boolean;
  /** It told us it trusts our hello. */
  acceptsUs: boolean;
  /** When the connection became usable both ways (0 = not yet). Newest wins after a reconnect. */
  readyAt: number;
  /** What our hello to it contained so far. */
  sent: 'none' | 'withheld' | 'full';
  sending: boolean;
  /** Its latest proof (Google token), kept until we may check it. */
  proof: HelloAuth | undefined;
  /** It sent its full hello (with proof, if the room needs one). */
  gotFull: boolean;
  /** It says it has approved us before (Google). */
  knowsUs: boolean;
  /** The person confirmed this device with a security code (Google). */
  allowed: boolean;
  /** The person said it is not their device. */
  denied: boolean;
  checking: boolean;
  /** Fresh hellos sent because the other device didn't accept ours. */
  retries: number;
  /** Hellos that failed to go out (connection not ready yet). */
  sendFails: number;
  /** Resolves once its first hello has been checked (or after a timeout). */
  firstCheck: Promise<void>;
  markChecked: () => void;
  sas: SasState | null;
}

/** How long to wait for a device's hello before refusing what it sends. */
const VERDICT_TIMEOUT_MS = 20_000;
/** An item's receipt normally comes back in well under a second (the other device may be busy saving a big file). */
const ITEM_TIMEOUT_MS = 60_000;
/** Pairing: how long to look for the other device before saying it isn't there. */
const LOOK_TIMEOUT_MS = 25_000;
/** Pairing: how long the person has to compare codes and confirm. */
const DECIDE_TIMEOUT_MS = 180_000;
const UNTRUSTED = 'not-trusted';
const NO_SPACE = 'no-space';

interface Channel {
  kind: 'group' | 'legacy' | 'account';
  method: LinkMethod;
  secret: string | null;
  session: AccountSession | null;
  room: Room;
  open: boolean;
  peers: Map<string, PeerRecord>;
  item: RequestAction<WireItem, Receipt>;
  file: RequestAction<Blob | Uint8Array, Receipt>;
  hello: MessageAction<Hello>;
  sas: MessageAction<Sas>;
  ctl: MessageAction<Control>;
  withdraw: MessageAction<Withdraw>;
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
  if (i.kind === 'link' && (typeof i.url !== 'string' || !/^https?:\/\//i.test(i.url) || i.url.length > MAX_URL_CHARS)) return false;
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

const isNonce = (n: unknown): n is string => typeof n === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(n);
const isHash = (h: unknown): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);

/**
 * The 4-digit security code both screens show. It mixes both devices' verified ids and a
 * random number from each side (each committed to before the other's was known).
 */
export async function securityCode(context: string, a: { id: string; nonce: string }, b: { id: string; nonce: string }): Promise<string> {
  const [first, second] = a.id < b.id ? [a, b] : [b, a];
  const hex = await sha256Hex(['qrls/sas/v1', context, first.id, first.nonce, second.id, second.nonce].join('|'));
  return String(parseInt(hex.slice(0, 8), 16) % 10_000).padStart(4, '0');
}

function newPeerRecord(peerId: string, userId: string): PeerRecord {
  let done!: () => void;
  const firstCheck = new Promise<void>((resolve) => (done = resolve));
  const rec: PeerRecord = {
    peerId,
    userId,
    device: null,
    ephemeral: false,
    verified: false,
    acceptsUs: false,
    readyAt: 0,
    sent: 'none',
    sending: false,
    proof: undefined,
    gotFull: false,
    knowsUs: false,
    allowed: false,
    denied: false,
    checking: false,
    retries: 0,
    sendFails: 0,
    firstCheck,
    markChecked: () => done(),
    sas: null,
  };
  setTimeout(() => done(), VERDICT_TIMEOUT_MS);
  return rec;
}

const errorKind = (err: unknown) => (err as { kind?: string } | null)?.kind ?? '';
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export class Mesh {
  readonly devicesChanged = new Emitter<ConnectedDevice[]>();
  /** A device became usable in both directions (emitted again after each reconnect or route change). */
  readonly deviceReady = new Emitter<ConnectedDevice>();
  /** A device of this group moved to another group and asks this one to follow. */
  readonly groupMove = new Emitter<{ secret: string; from: DeviceInfo }>();
  /** A device said goodbye on one link (it unpaired or signed out). */
  readonly deviceGone = new Emitter<{ id: string; name: string; method: LinkMethod }>();
  readonly receiveProgress = new Emitter<{ id: string; progress: number }>();
  readonly problem = new Emitter<string>();

  private groups = new Map<string, Channel>();
  private currentSecret: string | null = null;
  /** Google room: recent security-code checks that weren't finished or were declined. */
  private accountStrikes: number[] = [];
  /** Google room: until then, devices not approved before aren't checked at all. */
  private accountPausedUntil = 0;
  private account: Channel | null = null;
  private receiver: Receiver | null = null;
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

  /** This device's verified id (the same in every room). */
  async selfId(): Promise<string> {
    if (!this.selfIdPromise) throw new Error('Not connected yet');
    return this.selfIdPromise;
  }

  setReceiver(receiver: Receiver | null) {
    this.receiver = receiver;
  }

  private async me(room: Room): Promise<DeviceInfo> {
    const { userId } = await room.getSelf();
    return { id: userId, name: this.opts.device.name, type: this.opts.device.type };
  }

  private asConnected(ch: Channel, rec: PeerRecord): ConnectedDevice {
    return { ...rec.device!, method: ch.method, ...(rec.ephemeral ? { ephemeral: true } : {}) };
  }

  /** Google rooms ask for a security code before trusting a device they don't know. */
  private needsApproval(ch: Channel) {
    return !!ch.session?.isApproved;
  }

  /** Too many checks that weren't finished or were declined: stop checking new devices for a while. */
  private accountStrike() {
    const now = Date.now();
    this.accountStrikes = [...this.accountStrikes.filter((t) => now - t < 10 * 60_000), now];
    if (this.accountStrikes.length >= 3 && now >= this.accountPausedUntil) {
      this.accountPausedUntil = now + 10 * 60_000;
      this.accountStrikes = [];
      this.problem.emit(
        'Devices kept asking to connect through your Google account without finishing the security code. New devices are paused for 10 minutes; your own devices stay connected.'
      );
    }
  }

  private accountPaused(ch: Channel, rec: PeerRecord) {
    return Date.now() < this.accountPausedUntil && !ch.session?.isApproved?.(rec.userId);
  }

  /* --------------------------------- channels -------------------------------- */

  private openChannel(kind: Channel['kind'], method: LinkMethod, ref: RoomRef, opts: { secret?: string; session?: AccountSession }): Channel {
    const room = joinRoom(this.roomConfig(ref), ref.roomId);
    const ch: Channel = {
      kind,
      method,
      secret: opts.secret ?? null,
      session: opts.session ?? null,
      room,
      open: true,
      peers: new Map(),
      item: room.makeAction<WireItem, Receipt>('item', { kind: 'request' }),
      file: room.makeAction<Blob | Uint8Array, Receipt>('file', { kind: 'request' }),
      hello: room.makeAction<Hello>('hello'),
      sas: room.makeAction<Sas>('sas'),
      ctl: room.makeAction<Control>('ctl'),
      withdraw: room.makeAction<Withdraw>('withdraw'),
    };
    const selfId = room.getSelf().then((s) => s.userId);
    if (!this.selfIdPromise) this.selfIdPromise = selfId;
    const isSelf = async (userId: string) => userId === (await selfId);

    room.onPeerJoin(async ({ peerId, userId }) => {
      if ((await isSelf(userId)) || !ch.open) return; // another tab of this same browser
      void this.sendHello(ch, this.peer(ch, peerId, userId));
    });

    room.onPeerLeave(({ peerId }) => {
      const rec = ch.peers.get(peerId);
      if (!rec) return;
      ch.peers.delete(peerId);
      rec.sas?.abort?.abort();
      if (!rec.readyAt) return;
      this.emitDevices();
      // Still reachable through another connection (another tab or room)? Let its waiting items go there.
      const other = this.routeTo(rec.userId);
      if (other && ch.kind !== 'legacy') this.deviceReady.emit(this.asConnected(other.ch, other.rec));
    });

    ch.hello.onMessage(async (data, { peerId, userId }) => {
      if ((await isSelf(userId)) || !ch.open) return;
      const rec = this.peer(ch, peerId, userId);
      if (!data || data.v !== 1 || !isDeviceInfo(data.device) || data.device.id !== userId) {
        rec.markChecked();
        return;
      }
      rec.device = data.device;
      rec.ephemeral = data.ephemeral === true;
      rec.knowsUs = data.known === true;
      if (rec.verified) {
        // It introduced itself again (maybe our answer got lost): answer again.
        this.sendVerdict(ch, rec, true);
        void this.sendHello(ch, rec);
        return;
      }
      if (!data.withheld) {
        rec.gotFull = true;
        rec.proof = data.auth;
      }
      if (rec.sent === 'none') void this.sendHello(ch, rec);
      if (this.needsApproval(ch) && (!ch.session!.isApproved!(userId) || !rec.knowsUs)) {
        await this.startSas(ch, rec);
        this.askApproval(ch, rec); // in case the code was ready before this hello arrived
      }
      await this.evaluate(ch, rec);
    });

    ch.sas.onMessage(async (data, { peerId, userId }) => {
      if ((await isSelf(userId)) || !ch.open || !data || data.v !== 1 || !this.needsApproval(ch)) return;
      const rec = this.peer(ch, peerId, userId);
      await this.onSas(ch, rec, data);
    });

    ch.ctl.onMessage(async (data, { peerId, userId }) => {
      if ((await isSelf(userId)) || !ch.open || !data || data.v !== 1) return;
      const rec = ch.peers.get(peerId);
      if (!rec) return;
      if (typeof data.verdict === 'boolean') {
        rec.acceptsUs = data.verdict;
        if (!data.verdict) this.retryHello(ch, rec);
        this.updateReady(ch, rec);
        return;
      }
      if (!rec.verified || !rec.device) return; // the rest only from devices we trust
      if (data.bye) {
        ch.peers.delete(peerId);
        this.deviceGone.emit({ id: userId, name: rec.device.name, method: ch.method });
        if (rec.readyAt) this.emitDevices();
        return;
      }
      const target = data.moveTo;
      if (!isValidSecret(target) || !this.currentSecret || target === this.currentSecret) return;
      // In our current group anyone may move us; in an old group only toward the
      // "smaller" secret, so two groups that moved at the same time still end up as one.
      if (ch.kind === 'group' || (ch.kind === 'legacy' && target < this.currentSecret)) {
        this.groupMove.emit({ secret: target, from: rec.device });
      }
    });

    /** Waits for a device's first hello to be checked; null if it isn't trusted. */
    const trusted = async (peerId: string, userId: string) => {
      if (ch.kind === 'legacy' || (await isSelf(userId))) return null;
      const rec = this.peer(ch, peerId, userId);
      if (!rec.verified) await rec.firstCheck;
      return rec.verified && rec.device ? rec : null;
    };

    ch.item.onRequest(async (data, { peerId, userId }) => {
      const rec = await trusted(peerId, userId);
      if (!rec || !this.receiver) throw new Error(UNTRUSTED);
      if (!isWireItem(data) || data.from.id !== userId) throw new Error('invalid item');
      return this.receiver.item(data, this.asConnected(ch, rec));
    });

    const fileId = (metadata: unknown) => {
      const id = (metadata as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' && ITEM_ID.test(id) ? id : null;
    };

    ch.file.onReceive(async ({ kind, peerId, userId, byteLength, metadata }) => {
      // Trystero runs this same check on the receipt for a file *we* sent (no metadata there).
      if (kind === 'response') return byteLength <= 1024;
      const id = fileId(metadata);
      if (!id || byteLength > MAX_FILE_BYTES) return false;
      const rec = await trusted(peerId, userId);
      if (!rec || !this.receiver) return false;
      return this.receiver.wantsFile(id, byteLength, userId).catch(() => false);
    });
    ch.file.onReceiveProgress((progress, { metadata }) => {
      const id = fileId(metadata);
      if (id) this.receiveProgress.emit({ id, progress });
    });
    ch.file.onRequest(async (data, { peerId, userId, metadata }) => {
      const id = fileId(metadata);
      const rec = await trusted(peerId, userId);
      if (!id || !rec || !this.receiver) throw new Error(UNTRUSTED);
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await (data as Blob).arrayBuffer());
      return this.receiver.file(id, bytes, this.asConnected(ch, rec));
    });

    ch.withdraw.onMessage(async (data, { peerId, userId }) => {
      const rec = ch.peers.get(peerId);
      if (!rec?.verified || !data || data.v !== 1 || typeof data.id !== 'string' || !ITEM_ID.test(data.id)) return;
      this.receiver?.withdrawn(data.id, userId);
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

  /** The record for a device, created on first contact (join or first message). */
  private peer(ch: Channel, peerId: string, userId: string): PeerRecord {
    let rec = ch.peers.get(peerId);
    if (!rec) {
      rec = newPeerRecord(peerId, userId);
      ch.peers.set(peerId, rec);
    }
    return rec;
  }

  /**
   * Sends (or upgrades) our hello. In a Google room our sign-in token goes only to a
   * device approved before, or one the person just confirmed with a security code.
   */
  private async sendHello(ch: Channel, rec: PeerRecord): Promise<void> {
    if (rec.sending || !ch.open) return;
    const session = ch.session;
    const full = this.trustsHere(ch, rec);
    if (rec.sent === 'full' || (rec.sent === 'withheld' && !full)) return;
    rec.sending = true;
    try {
      const hello: Hello = { v: 1, device: await this.me(ch.room), ...(this.opts.privateMode ? { ephemeral: true } : {}) };
      if (this.needsApproval(ch)) hello.known = session!.isApproved!(rec.userId);
      if (full) {
        const auth = session ? await session.auth() : undefined;
        if (auth && auth.idToken) hello.auth = auth;
      } else {
        hello.withheld = true;
      }
      await ch.hello.send(hello, { target: rec.peerId });
      rec.sent = full ? 'full' : 'withheld';
    } catch {
      // the connection wasn't ready; try again shortly while that device is still here
      if (rec.sendFails++ < 4) setTimeout(() => ch.peers.get(rec.peerId) === rec && void this.sendHello(ch, rec), 1500 * rec.sendFails);
    } finally {
      rec.sending = false;
    }
    // Approved while that hello was going out: send the full one now.
    if (rec.sent === 'withheld' && rec.allowed) void this.sendHello(ch, rec);
  }

  /** Whether this device may trust that one: approved before, or confirmed now with the security code. */
  private trustsHere(ch: Channel, rec: PeerRecord) {
    if (!this.needsApproval(ch)) return true;
    return !rec.denied && (rec.allowed || ch.session!.isApproved!(rec.userId));
  }

  /** Checks a device once everything it needs is there; tells it the result. */
  private async evaluate(ch: Channel, rec: PeerRecord) {
    if (rec.verified || rec.checking || !rec.gotFull || !ch.open || !this.trustsHere(ch, rec)) return;
    rec.checking = true;
    let ok = false;
    try {
      ok = ch.session ? await ch.session.verify(rec.proof, rec.userId) : true;
    } catch {
      ok = false;
    } finally {
      rec.checking = false;
    }
    if (!ch.open || ch.peers.get(rec.peerId) !== rec) return;
    rec.verified = ok;
    rec.markChecked();
    this.sendVerdict(ch, rec, ok);
    if (ok) {
      rec.sas?.abort?.abort();
      void this.sendHello(ch, rec);
      this.updateReady(ch, rec);
    }
  }

  /* ------------------------------ security codes ------------------------------ */

  /** Google room, device not approved yet: start the security-code exchange (the lower id commits first). */
  private async startSas(ch: Channel, rec: PeerRecord) {
    if (this.accountPaused(ch, rec)) return;
    const self = await this.selfId();
    if (!rec.sas) rec.sas = { mine: randomSecret(16), sentCommit: false, sentNonce: false, asked: false, abort: null };
    const s = rec.sas;
    if (self < rec.userId && !s.sentCommit) {
      s.sentCommit = true;
      await ch.sas.send({ v: 1, commit: await sha256Hex(s.mine) }, { target: rec.peerId }).catch(() => (s.sentCommit = false));
    }
  }

  private async onSas(ch: Channel, rec: PeerRecord, data: Sas) {
    if (this.accountPaused(ch, rec)) return;
    const self = await this.selfId();
    if (!rec.sas) rec.sas = { mine: randomSecret(16), sentCommit: false, sentNonce: false, asked: false, abort: null };
    const s = rec.sas;
    const committer = self < rec.userId; // we committed first; they answer with their number
    if (isHash(data.commit) && !committer && !s.theirCommit) {
      s.theirCommit = data.commit;
      if (!s.sentNonce) {
        s.sentNonce = true;
        await ch.sas.send({ v: 1, nonce: s.mine }, { target: rec.peerId }).catch(() => (s.sentNonce = false));
        // After seeing our number it already knows the code. If it doesn't reveal its own, that
        // was a look at the code without showing it to anyone: count it.
        setTimeout(() => {
          if (rec.sas === s && !s.theirNonce) this.accountStrike();
        }, 20_000);
      }
      return;
    }
    if (!isNonce(data.nonce) || s.theirNonce) return;
    if (committer) {
      if (!s.sentCommit) return; // out of order
      s.theirNonce = data.nonce;
      if (!s.sentNonce) {
        s.sentNonce = true;
        await ch.sas.send({ v: 1, nonce: s.mine }, { target: rec.peerId }).catch(() => {});
      }
    } else {
      if (!s.theirCommit || (await sha256Hex(data.nonce)) !== s.theirCommit) return; // doesn't match what it committed to
      s.theirNonce = data.nonce;
    }
    s.code = await securityCode(`account/${ch.method}`, { id: self, nonce: s.mine }, { id: rec.userId, nonce: s.theirNonce });
    this.askApproval(ch, rec);
  }

  private askApproval(ch: Channel, rec: PeerRecord) {
    const s = rec.sas;
    const approve = ch.session?.approve;
    if (!s?.code || s.asked || !rec.device || !approve) return;
    s.asked = true;
    s.abort = new AbortController();
    void approve(rec.device, s.code, s.abort.signal)
      .then(async (allow) => {
        if (s.abort?.signal.aborted || !ch.open || ch.peers.get(rec.peerId) !== rec) return;
        if (!allow) {
          rec.denied = true;
          this.sendVerdict(ch, rec, false);
          this.accountStrike();
          return;
        }
        rec.allowed = true;
        await this.sendHello(ch, rec);
        await this.evaluate(ch, rec);
      })
      .catch(() => {});
  }

  /** Tells a device whether we accept its hello (retried briefly if the connection isn't ready). */
  private sendVerdict(ch: Channel, rec: PeerRecord, ok: boolean, attempt = 0) {
    ch.ctl.send({ v: 1, verdict: ok }, { target: rec.peerId }).catch(() => {
      if (attempt < 3 && ch.open && ch.peers.get(rec.peerId) === rec) setTimeout(() => this.sendVerdict(ch, rec, ok, attempt + 1), 1500);
    });
  }

  /** The other device didn't accept our hello: send a fresh one (new sign-in token) a few times. */
  private retryHello(ch: Channel, rec: PeerRecord) {
    if (rec.sent !== 'full') return;
    if (rec.retries >= 3) {
      if (ch.kind === 'account' && rec.retries++ === 3) {
        this.problem.emit(
          ch.method === 'google'
            ? `${rec.device?.name ?? 'Another device'} didn’t accept this device’s Google sign-in. Sign out here and sign in again.`
            : `${rec.device?.name ?? 'Another device'} didn’t accept this device. Link the wallet again.`
        );
      }
      return;
    }
    rec.retries++;
    setTimeout(() => {
      if (!ch.open || ch.peers.get(rec.peerId) !== rec || rec.acceptsUs) return;
      rec.sent = 'none';
      void this.sendHello(ch, rec);
    }, 2000 * rec.retries);
  }

  private updateReady(ch: Channel, rec: PeerRecord) {
    const ready = rec.verified && rec.acceptsUs && !!rec.device;
    if (ready && !rec.readyAt) {
      rec.readyAt = Date.now();
      if (ch.kind === 'legacy') {
        // A device from a group we left: tell it where we went.
        if (this.currentSecret) void ch.ctl.send({ v: 1, moveTo: this.currentSecret }, { target: rec.peerId }).catch(() => {});
        return;
      }
      this.emitDevices();
      this.deviceReady.emit(this.asConnected(ch, rec));
    } else if (!ready && rec.readyAt) {
      rec.readyAt = 0;
      this.emitDevices();
    }
  }

  private closeChannel(ch: Channel) {
    ch.open = false;
    for (const rec of ch.peers.values()) rec.sas?.abort?.abort();
    void ch.room.leave().catch(() => {});
  }

  /**
   * Joins the room of this device's paired group, plus the rooms of groups it moved away
   * from (so devices still waiting there are told to follow).
   */
  async setGroups(current: string, legacy: string[] = []): Promise<void> {
    if (!isValidSecret(current)) throw new Error('Invalid pairing secret');
    const wanted = new Map<string, 'group' | 'legacy'>([[current, 'group']]);
    for (const s of legacy) if (isValidSecret(s) && !wanted.has(s)) wanted.set(s, 'legacy');
    const refs = new Map<string, RoomRef>();
    for (const s of wanted.keys()) if (!this.groups.has(s)) refs.set(s, await groupRoom(s));
    if (this.destroyed) return;

    this.currentSecret = current;
    for (const [secret, ch] of this.groups) {
      if (!wanted.has(secret)) {
        this.groups.delete(secret);
        this.closeChannel(ch);
      }
    }
    for (const [secret, kind] of wanted) {
      const ch = this.groups.get(secret);
      if (!ch) {
        const ref = refs.get(secret);
        if (ref) this.groups.set(secret, this.openChannel(kind, 'paired', ref, { secret }));
        continue;
      }
      if (ch.kind === kind) continue;
      ch.kind = kind;
      for (const rec of ch.peers.values()) {
        if (!rec.readyAt || !rec.device) continue;
        if (kind === 'legacy') void ch.ctl.send({ v: 1, moveTo: current }, { target: rec.peerId }).catch(() => {});
        else this.deviceReady.emit(this.asConnected(ch, rec));
      }
    }
    this.emitDevices();
  }

  /** Joins (or leaves, with null) the room of devices signed in to the same account. */
  async setAccount(session: AccountSession | null): Promise<void> {
    const old = this.account;
    this.account = null;
    if (old) this.closeChannel(old);
    if (session && !this.destroyed) {
      this.account = this.openChannel('account', session.kind, session.room, { session });
    }
    this.emitDevices();
  }

  /** Tells connected devices this one is leaving on purpose (unpair / sign out). */
  async sayBye(which: 'group' | 'account'): Promise<void> {
    const chans = which === 'account' ? [this.account] : [...this.groups.values()];
    const sends: Promise<unknown>[] = [];
    for (const ch of chans) {
      if (!ch) continue;
      for (const rec of ch.peers.values()) {
        if (rec.verified) sends.push(ch.ctl.send({ v: 1, bye: true }, { target: rec.peerId }).catch(() => {}));
      }
    }
    await Promise.race([Promise.all(sends), new Promise((r) => setTimeout(r, 800))]);
  }

  /* ---------------------------------- devices --------------------------------- */

  private liveChannels(): Channel[] {
    const out: Channel[] = [];
    for (const ch of this.groups.values()) if (ch.kind === 'group') out.push(ch);
    if (this.account) out.push(this.account);
    return out;
  }

  /** Connected devices, one entry per device even if it is in two rooms or has two tabs open. */
  devices(): ConnectedDevice[] {
    const byId = new Map<string, ConnectedDevice>();
    for (const ch of this.liveChannels()) {
      for (const p of ch.peers.values()) {
        if (p.readyAt && p.device && !byId.has(p.userId)) byId.set(p.userId, this.asConnected(ch, p));
      }
    }
    return [...byId.values()];
  }

  /** The links over which a device is connected right now (e.g. paired and same wallet). */
  linksTo(deviceId: string): LinkMethod[] {
    const out = new Set<LinkMethod>();
    for (const ch of this.liveChannels()) for (const p of ch.peers.values()) if (p.userId === deviceId && p.readyAt) out.add(ch.method);
    return [...out];
  }

  /** Whether any device of this device's own paired group is connected right now. */
  hasGroupPeers(): boolean {
    const ch = this.currentSecret ? this.groups.get(this.currentSecret) : undefined;
    return !!ch && [...ch.peers.values()].some((p) => p.readyAt > 0);
  }

  private emitDevices() {
    this.devicesChanged.emit(this.devices());
  }

  /** The newest working connection to a device (an old one may be a dead leftover). */
  private routeTo(deviceId: string, exclude?: Set<string>): { ch: Channel; rec: PeerRecord } | null {
    let best: { ch: Channel; rec: PeerRecord } | null = null;
    for (const ch of this.liveChannels()) {
      for (const rec of ch.peers.values()) {
        if (rec.userId !== deviceId || !rec.readyAt || exclude?.has(rec.peerId)) continue;
        if (!best || rec.readyAt > best.rec.readyAt) best = { ch, rec };
      }
    }
    return best;
  }

  /* ---------------------------------- sending --------------------------------- */

  /**
   * Sends one item (and its file, if the other device needs it) to one device and
   * waits for its receipt. If that connection turns out to be gone, tries the device's
   * other connection (another tab or room) once.
   */
  async deliver(
    item: WireItem,
    blob: Blob | undefined,
    deviceId: string,
    opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {}
  ): Promise<DeliveryResult> {
    const tried = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const route = this.routeTo(deviceId, tried);
      if (!route) return 'unreachable';
      tried.add(route.rec.peerId);
      const result = await this.deliverVia(route, item, blob, opts);
      if (result !== 'retry') return result;
    }
    return 'unreachable';
  }

  private async deliverVia(
    { ch, rec }: { ch: Channel; rec: PeerRecord },
    item: WireItem,
    blob: Blob | undefined,
    opts: { signal?: AbortSignal; onProgress?: (p: number) => void }
  ): Promise<DeliveryResult | 'retry'> {
    try {
      // A long note travels like a file and may wait behind one: give it time.
      const long = new TextEncoder().encode(JSON.stringify(item)).length > 15_000;
      const receipt = await ch.item.request(item, { target: rec.peerId, timeoutMs: long ? 10 * 60_000 : ITEM_TIMEOUT_MS, signal: opts.signal });
      if (receipt === 'no-space') return 'no-space';
      if (receipt === 'need-file') {
        if (!blob) return 'refused';
        const done = await ch.file.request(blob, {
          target: rec.peerId,
          metadata: { id: item.id },
          signal: opts.signal,
          onProgress: (p) => opts.onProgress?.(p),
        });
        if (done === 'no-space') return 'no-space';
        return done === 'ok' || done === 'have' ? 'delivered' : 'refused';
      }
      return receipt === 'ok' || receipt === 'have' ? 'delivered' : 'refused';
    } catch (err) {
      const kind = errorKind(err);
      if (kind === 'aborted' || opts.signal?.aborted) return 'aborted';
      const message = String((err as Error)?.message ?? '');
      if (kind === 'rejected' && message.includes(UNTRUSTED)) {
        // It doesn't (yet) trust us: re-introduce ourselves and treat it as not connected.
        rec.acceptsUs = false;
        this.updateReady(ch, rec);
        rec.retries = 0;
        this.retryHello(ch, rec);
        return 'unreachable';
      }
      if (kind === 'rejected') return message.includes(NO_SPACE) ? 'no-space' : 'refused';
      if (kind === 'disconnected') return 'retry';
      return 'unreachable';
    }
  }

  /** Tells devices to drop an item they were still receiving (it was deleted here). */
  withdraw(itemId: string, deviceIds: string[]) {
    for (const id of deviceIds) {
      const route = this.routeTo(id);
      if (route) void route.ch.withdraw.send({ v: 1, id: itemId }, { target: route.rec.peerId }).catch(() => {});
    }
  }

  /* --------------------------------- pairing --------------------------------- */

  /**
   * Shows this device's code: listens in the meeting rooms for the current QR invitation
   * and PIN until `expiresAt`. A device arriving with the QR invitation is welcomed
   * automatically; one arriving with the PIN goes through the security code and needs
   * `onKnock` to approve it. Returns a function that stops listening (pairings already
   * approved are allowed to finish first).
   */
  host(code: { invite: string; pin: string | null; expiresAt: number }, h: HostHandlers): () => void {
    const rooms: Room[] = [];
    type Session = { abort: AbortController; approved: boolean; waiting: Array<(r: JoinReply) => void>; sas: Array<(s: Sas) => void> };
    const sessions = new Map<string, Session>();
    const endedAt = new Map<string, number>();
    let spentOnce = false;
    const spend = (reason: SpentReason) => {
      if (spentOnce) return;
      spentOnce = true;
      h.onSpent(reason);
    };
    let stopped = false;
    let closed = false;
    const leave = () => {
      if (closed) return;
      closed = true;
      clearTimeout(expiry);
      for (const r of rooms) void r.leave().catch(() => {});
    };
    const leaveWhenIdle = () => {
      if (stopped && [...sessions.values()].every((s) => !s.approved)) leave();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const s of sessions.values()) if (!s.approved) s.abort.abort();
      leaveWhenIdle();
      setTimeout(leave, 60_000); // approved pairings get a minute to finish
    };
    // When the code expires, refuse newcomers (checked on arrival) and leave once idle.
    const expiry = setTimeout(() => {
      if (sessions.size === 0) leave();
    }, Math.max(0, code.expiresAt - Date.now()));

    const open = async (via: 'qr' | 'pin') => {
      const ref = via === 'qr' ? await inviteRoom(code.invite) : await pinRoom(code.pin!);
      if (stopped) return;
      // The PIN room allows a third device, so a squatter can't lock the real one out: two at once are refused.
      const room = joinRoom(this.roomConfig(ref, { maxUsers: via === 'pin' ? 3 : 2 }), ref.roomId);
      rooms.push(room);
      const hello = room.makeAction<Hello>('hello');
      const sas = room.makeAction<Sas>('sas');
      const welcome = room.makeAction<Welcome>('welcome');
      const reply = room.makeAction<JoinReply>('reply');
      const me = this.me(room);

      // Who is in the PIN room right now (connections, not just devices: one device can open many).
      const present = new Map<string, ReturnType<typeof setTimeout>>();
      room.onPeerJoin(({ peerId }) => {
        if (via !== 'pin' || stopped) return;
        // A real device introduces itself at once; one that sits here silently blocks the PIN.
        present.set(
          peerId,
          setTimeout(() => {
            if (!stopped && present.has(peerId) && !sessions.has(peerId) && !endedAt.has(peerId)) spend('blocked');
          }, 10_000)
        );
      });
      room.onPeerLeave(({ peerId }) => {
        clearTimeout(present.get(peerId));
        present.delete(peerId);
        sessions.get(peerId)?.abort.abort();
      });
      reply.onMessage((data, { peerId }) => {
        const s = sessions.get(peerId);
        if (s && data?.v === 1) for (const fn of s.waiting.splice(0)) fn(data);
      });
      sas.onMessage((data, { peerId }) => {
        const s = sessions.get(peerId);
        if (s && data?.v === 1) for (const fn of s.sas.splice(0)) fn(data);
      });

      const next = <T,>(s: Session, list: Array<(v: T) => void>, ms: number) =>
        new Promise<T | null>((resolve) => {
          const t = setTimeout(() => resolve(null), ms);
          s.abort.signal.addEventListener('abort', () => (clearTimeout(t), resolve(null)), { once: true });
          list.push((v) => (clearTimeout(t), resolve(v)));
        });

      hello.onMessage(async (data, { peerId, userId }) => {
        if (stopped || closed || sessions.has(peerId) || !data || data.v !== 1 || !isDeviceInfo(data.device) || data.device.id !== userId) return;
        if (Date.now() - (endedAt.get(peerId) ?? 0) < 2000) return; // don't let one device flood the sheet
        if (Date.now() >= code.expiresAt) {
          await welcome.send({ v: 1, expired: true }, { target: peerId }).catch(() => {});
          return;
        }
        if (via === 'pin') {
          if (!isHash(data.commit)) return;
          clearTimeout(present.get(peerId));
          // Someone else is already at this PIN (another knock, or another device in the room):
          // for safety, refuse everyone and use a new code.
          const others = [...sessions.entries()].filter(([, s]) => !s.approved);
          const strangers = [...present.keys()].filter((p) => p !== peerId);
          if (others.length || strangers.length) {
            for (const [pid, s] of others) {
              s.abort.abort();
              void welcome.send({ v: 1, busy: true }, { target: pid }).catch(() => {});
            }
            await welcome.send({ v: 1, busy: true }, { target: peerId }).catch(() => {});
            spend('collision');
            return;
          }
        }
        const session: Session = { abort: new AbortController(), approved: false, waiting: [], sas: [] };
        sessions.set(peerId, session);
        let outcome: 'paired' | 'declined' | 'left' | 'unfinished' | 'other' = 'other';
        try {
          if (via === 'pin') {
            // Security code: we send our number only after its commitment arrived (in the hello),
            // and it reveals its number only after seeing ours.
            const mine = randomSecret(16);
            await sas.send({ v: 1, nonce: mine }, { target: peerId });
            const theirs = await next<Sas>(session, session.sas, 20_000);
            if (!theirs || !isNonce(theirs.nonce) || (await sha256Hex(theirs.nonce)) !== data.commit) {
              // It saw our number (so it knows the code) but didn't finish: that try uses up the PIN.
              outcome = 'unfinished';
              return;
            }
            const sasCode = await securityCode(`pin/${code.pin}`, { id: (await me).id, nonce: mine }, { id: userId, nonce: theirs.nonce });
            const ok = await h.onKnock(data.device, sasCode, session.abort.signal).catch(() => false);
            if (stopped || session.abort.signal.aborted) {
              outcome = 'left';
              return;
            }
            if (!ok) {
              outcome = 'declined';
              await welcome.send({ v: 1, denied: true }, { target: peerId }).catch(() => {});
              return;
            }
          }
          session.approved = true;
          const host = await me;
          if (!h.hasPaired() && data.paired === true) {
            // This device has no paired devices yet but the other one does: join its group,
            // so the other device keeps all of its existing pairings.
            await welcome.send({ v: 1, host, adopt: true }, { target: peerId });
            const r = await next<JoinReply>(session, session.waiting, DECIDE_TIMEOUT_MS);
            if (!r || r.cancel || !isValidSecret(r.group)) {
              outcome = r?.cancel ? 'declined' : 'left';
              return;
            }
            await h.onAdopt(r.group, data.device);
            await welcome.send({ v: 1, adopted: true }, { target: peerId }).catch(() => {});
            outcome = 'paired';
            h.onPaired(data.device, via);
            return;
          }
          await welcome.send({ v: 1, host, group: h.groupSecret() }, { target: peerId });
          const r = await next<JoinReply>(session, session.waiting, DECIDE_TIMEOUT_MS);
          if (r?.ok) {
            outcome = 'paired';
            h.onPaired(data.device, via);
          } else outcome = r?.cancel ? 'declined' : 'left';
        } catch {
          outcome = 'left';
        } finally {
          sessions.delete(peerId);
          endedAt.set(peerId, Date.now());
          // A PIN is used up by any attempt that didn't pair; a QR code when the other device said no.
          if (!stopped && outcome !== 'paired' && outcome !== 'other' && (via === 'pin' || outcome === 'declined')) spend(outcome);
          leaveWhenIdle();
          if (sessions.size === 0 && Date.now() >= code.expiresAt) leave();
        }
      });
    };
    void open('qr');
    if (code.pin) void open('pin');
    return stop;
  }

  /**
   * Joins another device using its QR invitation or PIN. Resolves with the group secret
   * to use from now on (the other device's, or this device's own if that device adopted it).
   */
  async joinWith(code: { invite?: string; pin?: string }, opts: JoinOptions): Promise<{ secret: string; adopted: boolean; host: DeviceInfo | null }> {
    const isPin = !code.invite;
    const pin = code.pin ?? '';
    const ref = code.invite ? await inviteRoom(code.invite) : await pinRoom(pin);
    if (opts.signal?.aborted) throw abortError();
    const room = joinRoom(this.roomConfig(ref, { maxUsers: isPin ? 3 : 2 }), ref.roomId);
    const hello = room.makeAction<Hello>('hello');
    const sas = room.makeAction<Sas>('sas');
    const welcome = room.makeAction<Welcome>('welcome');
    const reply = room.makeAction<JoinReply>('reply');
    const me = this.me(room);
    const mine = randomSecret(16);

    try {
      return await new Promise<{ secret: string; adopted: boolean; host: DeviceInfo | null }>((resolve, reject) => {
        let host: { peerId: string; userId: string } | null = null;
        let hostInfo: DeviceInfo | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        /**
         * The person's answer (PIN: the codes match; QR: bring the other devices along, or let the
         * new device have the items waiting here). A device with nothing to share pairs at once.
         */
        let decision: Promise<boolean> | null = isPin || opts.paired || opts.waiting > 0 ? null : Promise.resolve(true);
        let pendingWelcome: Welcome | null = null;
        let acting = false;
        let sentSecret: string | null = null;

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const fail = (message: string) => finish(() => reject(new Error(message)));
        const cancelled = () => finish(() => reject(abortError()));
        const deadline = (ms: number, message: string) => {
          clearTimeout(timer);
          timer = setTimeout(() => fail(message), ms);
        };
        deadline(
          LOOK_TIMEOUT_MS,
          isPin
            ? 'No device answered this PIN. Check the 6 digits, and that the other device still shows them (they change every 3 minutes).'
            : 'Couldn’t reach the other device. Make sure it still shows the QR code (codes change every 3 minutes and work once), then scan again.'
        );
        opts.signal?.addEventListener(
          'abort',
          () => {
            if (host) void reply.send({ v: 1, cancel: true }, { target: host.peerId }).catch(() => {});
            cancelled();
          },
          { once: true }
        );
        opts.onStatus?.('looking');

        /** Acts on the welcome once the person agreed. */
        const act = async () => {
          const w = pendingWelcome;
          if (!w || !host || !decision || acting || settled) return;
          acting = true;
          const yes = await decision;
          if (settled) return;
          if (!yes) {
            await reply.send({ v: 1, cancel: true }, { target: host.peerId }).catch(() => {});
            return cancelled();
          }
          if (w.adopt) {
            // The other device is new: it joins this device's group instead.
            sentSecret = opts.mySecret();
            await reply.send({ v: 1, group: sentSecret }, { target: host.peerId }).catch(() => {});
            opts.onStatus?.('approval');
            return; // wait for 'adopted'
          }
          if (isValidSecret(w.group)) {
            await reply.send({ v: 1, ok: true }, { target: host.peerId }).catch(() => {});
            return finish(() => resolve({ secret: w.group!, adopted: false, host: hostInfo }));
          }
          fail('The other device sent an invalid answer.');
        };

        // Introduce ourselves to everyone in the meeting room. Another device that typed the same
        // PIN may be here too, so the device that shows the code is the one that answers.
        const greeted = new Map<string, string>(); // peerId -> userId
        const claim = (peerId: string) => {
          if (host) {
            if (host.peerId === peerId) return true;
            // A second device answers as if it were the one showing the code: someone is
            // trying to get in between. Stop.
            if (greeted.has(peerId)) fail('Two devices answered this code at once, so pairing was stopped for safety. Use the new code on your other device.');
            return false;
          }
          const userId = greeted.get(peerId);
          if (!userId) return false;
          host = { peerId, userId };
          opts.onStatus?.('found');
          deadline(DECIDE_TIMEOUT_MS, 'The other device didn’t answer in time. Try again.');
          return true;
        };
        room.onPeerJoin(async ({ peerId, userId }) => {
          if (host || settled || greeted.has(peerId)) return;
          greeted.set(peerId, userId);
          const hi: Hello = { v: 1, device: await me, paired: opts.paired };
          if (isPin) hi.commit = await sha256Hex(mine);
          await hello.send(hi, { target: peerId }).catch(() => {});
        });
        room.onPeerLeave(({ peerId }) => {
          if (peerId === host?.peerId) fail('The other device stopped showing this code. Ask for a new one and try again.');
        });

        sas.onMessage(async (data, { peerId }) => {
          if (!isPin || settled || decision || !data || data.v !== 1 || !isNonce(data.nonce) || !claim(peerId) || !host) return;
          // It sent its number after our commitment; now we reveal ours.
          await sas.send({ v: 1, nonce: mine }, { target: peerId }).catch(() => {});
          const self = await me;
          const sasCode = await securityCode(`pin/${pin}`, { id: self.id, nonce: mine }, { id: host.userId, nonce: data.nonce });
          decision = opts.confirm({ code: sasCode, host: null, merge: opts.paired, waiting: opts.waiting });
          void decision.then((yes) => {
            if (!yes) {
              void reply.send({ v: 1, cancel: true }, { target: peerId }).catch(() => {});
              cancelled();
            } else if (!settled) {
              opts.onStatus?.('approval');
              void act();
            }
          });
        });

        welcome.onMessage(async (data, { peerId }) => {
          if (!data || data.v !== 1 || settled || !claim(peerId) || !host) return;
          if (data.denied) return fail('The other device declined the connection.');
          if (data.expired) return fail('This code has expired. Use the new code shown on the other device.');
          if (data.busy) return fail('Another device used this code at the same time, so it was refused for safety. Use the new code on the other device.');
          if (data.adopted) return sentSecret ? finish(() => resolve({ secret: sentSecret!, adopted: true, host: hostInfo })) : undefined;
          if (isDeviceInfo(data.host) && data.host.id === host.userId) hostInfo = data.host;
          pendingWelcome = data;
          // QR from a device: if this one has other devices or waiting items, ask before sharing them.
          if (!decision && !isPin) decision = opts.confirm({ code: null, host: hostInfo, merge: opts.paired, waiting: opts.waiting });
          void act();
        });
      });
    } finally {
      // Let the last reply leave before closing the meeting room.
      setTimeout(() => void room.leave().catch(() => {}), 1500);
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
    const chans = [...this.groups.values(), this.account];
    this.groups.clear();
    this.account = null;
    for (const ch of chans) if (ch) this.closeChannel(ch);
  }
}
