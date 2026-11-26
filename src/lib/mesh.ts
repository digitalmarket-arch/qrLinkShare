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
 * Delivery has receipts: an item only counts as delivered once the other device
 * answers that it has saved it (and its file). Until then it stays "waiting".
 */
import { joinRoom, getRelaySockets, type Room, type MessageAction, type RequestAction, type JoinRoomConfig } from 'trystero';
import type { ConnectedDevice, DeviceInfo, DeviceType, LinkMethod, WireItem } from '../types/share';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS } from './shared';
import { APP_ID, groupRoom, inviteRoom, isValidSecret, pinRoom, type RoomRef } from './pairing';

export type HelloAuth = { idToken?: string };

type Hello = {
  v: 1;
  device: DeviceInfo;
  auth?: HelloAuth;
  /** A "keep nothing" device: it is a new device every visit, so it shouldn't be remembered. */
  ephemeral?: boolean;
  /** Account room: this device waits for the other one to prove itself first. */
  withheld?: boolean;
  /** Meeting rooms: this device already has paired devices. */
  paired?: boolean;
};

/** Host -> joining device, in a meeting room. */
type Welcome = { v: 1; group?: string; adopt?: boolean; adopted?: boolean; denied?: boolean; expired?: boolean };
/** Joining device -> host, in a meeting room. */
type JoinReply = { v: 1; ok?: boolean; group?: string };
/** Small control messages between devices in the same room. */
type Control = { v: 1; verdict?: boolean; moveTo?: string; bye?: boolean };
type Withdraw = { v: 1; id: string };

/** What the receiving device answers when it gets an item. */
export type Receipt = 'ok' | 'have' | 'need-file';
export type DeliveryResult = 'delivered' | 'unreachable' | 'refused' | 'aborted';
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
   * Google only: may this device show its proof to that device before that device has
   * shown its own? (Proofs are sign-in tokens; established devices don't hand theirs
   * to strangers.)
   */
  revealFirst?: (peerDeviceId: string) => boolean;
  /** Google only: both devices are waiting for each other; ask the person whether to go first. */
  onStuck?: (device: DeviceInfo, signal: AbortSignal) => Promise<boolean>;
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

export interface HostHandlers {
  groupSecret: () => string;
  /** Whether this device already has paired devices (then the other device joins this group). */
  hasPaired: () => boolean;
  /** A device typed this device's PIN: ask the person. `signal` aborts if that device gives up. */
  onKnock: (device: DeviceInfo, signal: AbortSignal) => Promise<boolean>;
  /** The other device brought its own group and this device had none: join that group. */
  onAdopt: (secret: string, device: DeviceInfo) => Promise<void>;
  onPaired: (device: DeviceInfo, via: 'qr' | 'pin') => void;
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
  ephemeral: boolean;
  /** We checked its hello and trust it. */
  verified: boolean;
  /** It told us it trusts our hello. */
  acceptsUs: boolean;
  /** When the connection became usable both ways (0 = not yet). Newest wins after a reconnect. */
  readyAt: number;
  /** What our hello to it contained so far. */
  sent: 'none' | 'withheld' | 'full';
  /** What its hello to us contained so far. */
  theirs: 'none' | 'withheld' | 'full';
  sending: boolean;
  wantFull: boolean;
  checking: boolean;
  /** Fresh hellos sent because the other device didn't accept ours. */
  retries: number;
  /** Hellos that failed to go out (connection not ready yet). */
  sendFails: number;
  /** Resolves once its first hello has been checked (or after a timeout). */
  firstCheck: Promise<void>;
  markChecked: () => void;
  stuckAsked: boolean;
  stuck: AbortController | null;
}

/** How long to wait for a device's hello before refusing what it sends. */
const VERDICT_TIMEOUT_MS = 20_000;
/** An item's receipt normally comes back in well under a second (the other device may be busy saving a big file). */
const ITEM_TIMEOUT_MS = 60_000;
/** Pairing: how long to look for the other device before saying it isn't there. */
const LOOK_TIMEOUT_MS = 25_000;
const UNTRUSTED = 'not-trusted';

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
    theirs: 'none',
    sending: false,
    wantFull: false,
    checking: false,
    retries: 0,
    sendFails: 0,
    firstCheck,
    markChecked: () => done(),
    stuckAsked: false,
    stuck: null,
  };
  setTimeout(() => done(), VERDICT_TIMEOUT_MS);
  return rec;
}

const errorKind = (err: unknown) => (err as { kind?: string } | null)?.kind ?? '';
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export class Mesh {
  readonly devicesChanged = new Emitter<ConnectedDevice[]>();
  /** A device became usable in both directions (emitted again after each reconnect). */
  readonly deviceReady = new Emitter<ConnectedDevice>();
  /** A device of this group moved to another group and asks this one to follow. */
  readonly groupMove = new Emitter<{ secret: string; from: DeviceInfo }>();
  /** A device said goodbye (it unpaired or signed out). */
  readonly deviceGone = new Emitter<{ id: string; name: string; method: LinkMethod }>();
  readonly receiveProgress = new Emitter<{ id: string; progress: number }>();
  readonly problem = new Emitter<string>();

  private groups = new Map<string, Channel>();
  private currentSecret: string | null = null;
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
      rec.stuck?.abort();
      if (rec.readyAt) this.emitDevices();
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
      if (rec.verified) {
        // It introduced itself again (maybe our answer got lost): answer again.
        this.sendVerdict(ch, rec, true);
        void this.sendHello(ch, rec);
        return;
      }
      if (data.withheld) {
        // It waits for us to prove ourselves first.
        rec.theirs = 'withheld';
        if (rec.sent === 'none') void this.sendHello(ch, rec);
        else if (rec.sent === 'withheld') this.askIfStuck(ch, rec);
        return;
      }
      rec.theirs = 'full';
      if (rec.checking) return;
      rec.checking = true;
      let ok = false;
      try {
        ok = ch.session ? await ch.session.verify(data.auth, userId) : true;
      } catch {
        ok = false;
      } finally {
        rec.checking = false;
      }
      if (!ch.open || ch.peers.get(peerId) !== rec) return;
      rec.verified = ok;
      rec.markChecked();
      this.sendVerdict(ch, rec, ok);
      if (ok) {
        rec.stuck?.abort();
        // It proved itself, so it may see our proof too.
        void this.sendHello(ch, rec, true);
        this.updateReady(ch, rec);
      } else {
        void this.sendHello(ch, rec);
      }
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

    ch.file.onReceive(async ({ peerId, userId, byteLength, metadata }) => {
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
   * Sends (or upgrades) our hello. In the Google room an established device first sends
   * a hello without its sign-in token ("withheld") to devices it doesn't know yet.
   */
  private async sendHello(ch: Channel, rec: PeerRecord, full = false): Promise<void> {
    if (full) rec.wantFull = true;
    if (rec.sending || !ch.open) return;
    const policy = ch.session?.revealFirst;
    const wantFull = !policy || rec.wantFull || rec.verified || policy(rec.userId);
    if (rec.sent === 'full' || (rec.sent === 'withheld' && !wantFull)) return;
    rec.sending = true;
    let sentNow: PeerRecord['sent'] | null = null;
    try {
      const hello: Hello = { v: 1, device: await this.me(ch.room), ...(this.opts.privateMode ? { ephemeral: true } : {}) };
      if (wantFull) {
        const auth = ch.session ? await ch.session.auth() : undefined;
        if (auth && auth.idToken) hello.auth = auth;
      } else {
        hello.withheld = true;
      }
      await ch.hello.send(hello, { target: rec.peerId });
      sentNow = wantFull ? 'full' : 'withheld';
      rec.sent = sentNow;
    } catch {
      // the connection wasn't ready; try again shortly while that device is still here
      if (rec.sendFails++ < 4) setTimeout(() => ch.peers.get(rec.peerId) === rec && void this.sendHello(ch, rec), 1500 * rec.sendFails);
    } finally {
      rec.sending = false;
    }
    if (sentNow === 'withheld') {
      if (rec.wantFull) void this.sendHello(ch, rec, true);
      else if (rec.theirs === 'withheld') this.askIfStuck(ch, rec);
    }
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
      void this.sendHello(ch, rec, true);
    }, 2000 * rec.retries);
  }

  /** Both devices wait for the other to go first: ask the person once. */
  private askIfStuck(ch: Channel, rec: PeerRecord) {
    const onStuck = ch.session?.onStuck;
    if (!onStuck || rec.stuckAsked || rec.verified || !rec.device) return;
    rec.stuckAsked = true;
    rec.stuck = new AbortController();
    void onStuck(rec.device, rec.stuck.signal)
      .then((allow) => {
        if (allow && ch.open && ch.peers.get(rec.peerId) === rec) void this.sendHello(ch, rec, true);
      })
      .catch(() => {})
      .finally(() => {
        rec.stuck = null;
      });
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
    for (const rec of ch.peers.values()) rec.stuck?.abort();
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

  /** Whether any device of this device's own paired group is connected right now. */
  hasGroupPeers(): boolean {
    const ch = this.currentSecret ? this.groups.get(this.currentSecret) : undefined;
    return !!ch && [...ch.peers.values()].some((p) => p.readyAt > 0);
  }

  private emitDevices() {
    this.devicesChanged.emit(this.devices());
  }

  /** The newest working connection to a device (an old one may be a dead leftover). */
  private routeTo(deviceId: string): { ch: Channel; rec: PeerRecord } | null {
    let best: { ch: Channel; rec: PeerRecord } | null = null;
    for (const ch of this.liveChannels()) {
      for (const rec of ch.peers.values()) {
        if (rec.userId === deviceId && rec.readyAt && (!best || rec.readyAt > best.rec.readyAt)) best = { ch, rec };
      }
    }
    return best;
  }

  /* ---------------------------------- sending --------------------------------- */

  /**
   * Sends one item (and its file, if the other device needs it) to one device and
   * waits for its receipt.
   */
  async deliver(
    item: WireItem,
    blob: Blob | undefined,
    deviceId: string,
    opts: { signal?: AbortSignal; onProgress?: (p: number) => void } = {}
  ): Promise<DeliveryResult> {
    const route = this.routeTo(deviceId);
    if (!route) return 'unreachable';
    const { ch, rec } = route;
    try {
      const receipt = await ch.item.request(item, { target: rec.peerId, timeoutMs: ITEM_TIMEOUT_MS, signal: opts.signal });
      if (receipt === 'need-file') {
        if (!blob) return 'refused';
        const done = await ch.file.request(blob, {
          target: rec.peerId,
          metadata: { id: item.id },
          signal: opts.signal,
          onProgress: (p) => opts.onProgress?.(p),
        });
        return done === 'ok' || done === 'have' ? 'delivered' : 'refused';
      }
      return receipt === 'ok' || receipt === 'have' ? 'delivered' : 'refused';
    } catch (err) {
      const kind = errorKind(err);
      if (kind === 'aborted' || opts.signal?.aborted) return 'aborted';
      if (kind === 'rejected' && String((err as Error).message).includes(UNTRUSTED)) {
        // It doesn't (yet) trust us: re-introduce ourselves and treat it as not connected.
        rec.acceptsUs = false;
        this.updateReady(ch, rec);
        rec.retries = 0;
        this.retryHello(ch, rec);
        return 'unreachable';
      }
      if (kind === 'rejected') return 'refused';
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
   * Shows this device's code: listens in the meeting rooms for the current QR
   * invitation and PIN until `expiresAt`. A device arriving with the QR invitation is
   * welcomed automatically; one arriving with the PIN needs `onKnock` to approve it.
   * Returns a function that stops listening.
   */
  host(code: { invite: string; pin: string; expiresAt: number }, h: HostHandlers): () => void {
    const rooms: Room[] = [];
    const controllers = new Set<AbortController>();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(expiry);
      for (const c of controllers) c.abort();
      for (const r of rooms) void r.leave().catch(() => {});
    };
    // Leave the meeting rooms when the code expires (late arrivals are refused on the spot anyway).
    const expiry = setTimeout(() => {
      if (controllers.size === 0) stop();
    }, Math.max(0, code.expiresAt - Date.now()));

    const open = async (via: 'qr' | 'pin') => {
      const ref = via === 'qr' ? await inviteRoom(code.invite) : await pinRoom(code.pin);
      if (stopped) return;
      const room = joinRoom(this.roomConfig(ref, { maxUsers: 2 }), ref.roomId);
      rooms.push(room);
      const hello = room.makeAction<Hello>('hello');
      const welcome = room.makeAction<Welcome>('welcome');
      const reply = room.makeAction<JoinReply>('reply');
      const sessions = new Map<string, { abort: AbortController; waiting: Array<(r: JoinReply) => void> }>();

      room.onPeerLeave(({ peerId }) => sessions.get(peerId)?.abort.abort());
      reply.onMessage((data, { peerId }) => {
        const s = sessions.get(peerId);
        if (s && data?.v === 1) for (const fn of s.waiting.splice(0)) fn(data);
      });

      hello.onMessage(async (data, { peerId, userId }) => {
        if (stopped || sessions.has(peerId) || !data || data.v !== 1 || !isDeviceInfo(data.device) || data.device.id !== userId) return;
        if (Date.now() >= code.expiresAt) {
          await welcome.send({ v: 1, expired: true }, { target: peerId }).catch(() => {});
          return;
        }
        const abort = new AbortController();
        const session = { abort, waiting: [] as Array<(r: JoinReply) => void> };
        sessions.set(peerId, session);
        controllers.add(abort);
        const nextReply = (ms: number) =>
          new Promise<JoinReply | null>((resolve) => {
            const t = setTimeout(() => resolve(null), ms);
            abort.signal.addEventListener('abort', () => (clearTimeout(t), resolve(null)), { once: true });
            session.waiting.push((r) => (clearTimeout(t), resolve(r)));
          });
        try {
          const ok = via === 'qr' ? true : await h.onKnock(data.device, abort.signal).catch(() => false);
          if (stopped || abort.signal.aborted) return;
          if (!ok) {
            await welcome.send({ v: 1, denied: true }, { target: peerId }).catch(() => {});
            return;
          }
          if (!h.hasPaired() && data.paired === true) {
            // This device has no paired devices yet but the other one does: join its group,
            // so the other device keeps all of its existing pairings.
            await welcome.send({ v: 1, adopt: true }, { target: peerId });
            const r = await nextReply(15_000);
            if (!r || !isValidSecret(r.group) || abort.signal.aborted) return;
            await h.onAdopt(r.group, data.device);
            await welcome.send({ v: 1, adopted: true }, { target: peerId }).catch(() => {});
            h.onPaired(data.device, via);
            return;
          }
          await welcome.send({ v: 1, group: h.groupSecret() }, { target: peerId });
          const r = await nextReply(10_000);
          if (r?.ok) h.onPaired(data.device, via);
        } catch {
          // the other device left part-way
        } finally {
          controllers.delete(abort);
          if (controllers.size === 0 && Date.now() >= code.expiresAt) stop();
        }
      });
    };
    void open('qr');
    void open('pin');
    return stop;
  }

  /**
   * Joins another device using its QR invitation or PIN. Resolves with the group secret
   * to use from now on (the other device's, or this device's own if that device adopted it).
   */
  async joinWith(
    code: { invite?: string; pin?: string },
    opts: { mySecret: string; paired: boolean; signal?: AbortSignal; onStatus?: (s: JoinStatus) => void }
  ): Promise<{ secret: string; adopted: boolean }> {
    const isPin = !code.invite;
    const ref = code.invite ? await inviteRoom(code.invite) : await pinRoom(code.pin ?? '');
    if (opts.signal?.aborted) throw abortError();
    const room = joinRoom(this.roomConfig(ref, { maxUsers: 2 }), ref.roomId);
    const hello = room.makeAction<Hello>('hello');
    const welcome = room.makeAction<Welcome>('welcome');
    const reply = room.makeAction<JoinReply>('reply');
    const me = this.me(room);

    try {
      return await new Promise<{ secret: string; adopted: boolean }>((resolve, reject) => {
        let host: string | null = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const fail = (message: string) => finish(() => reject(new Error(message)));
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
        opts.signal?.addEventListener('abort', () => finish(() => reject(abortError())), { once: true });
        opts.onStatus?.('looking');

        room.onPeerJoin(async ({ peerId }) => {
          if (host || settled) return;
          host = peerId;
          opts.onStatus?.(isPin ? 'approval' : 'found');
          deadline(
            isPin ? 120_000 : 30_000,
            isPin ? 'The other device didn’t answer in time. Try again and tap Allow there.' : 'The other device did not answer. Try again.'
          );
          await hello.send({ v: 1, device: await me, paired: opts.paired }, { target: peerId }).catch(() => {});
        });
        room.onPeerLeave(({ peerId }) => {
          if (peerId === host) fail('The other device stopped showing this code. Ask for a new one and try again.');
        });
        welcome.onMessage(async (data, { peerId }) => {
          if (peerId !== host || !data || data.v !== 1 || settled) return;
          if (data.denied) return fail('The other device declined the connection.');
          if (data.expired) return fail('This code has expired. Use the new code shown on the other device.');
          if (data.adopt) {
            // The other device is new: it joins this device's group instead.
            await reply.send({ v: 1, group: opts.mySecret }, { target: peerId }).catch(() => {});
            return;
          }
          if (data.adopted) return finish(() => resolve({ secret: opts.mySecret, adopted: true }));
          if (isValidSecret(data.group)) {
            await reply.send({ v: 1, ok: true }, { target: peerId }).catch(() => {});
            return finish(() => resolve({ secret: data.group!, adopted: false }));
          }
          fail('The other device sent an invalid answer.');
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
