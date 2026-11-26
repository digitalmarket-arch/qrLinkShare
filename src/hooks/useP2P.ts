import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, ConnectedDevice, DeviceInfo, KnownDevice, LinkMethod, Retention, StoredItem, WireItem } from '../types/share';
import { Mesh, type AccountSession, type DeliveryResult, type Receipt, type Receiver, type RelayStatus } from '../lib/mesh';
import { isPersisted, openStore, requestPersistentStorage, type Store } from '../lib/db';
import { accountRoom, randomSecret } from '../lib/pairing';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, TEMP_TTL_MS, toHttpUrl } from '../lib/shared';
import { createOwnTokenGuard, verifyGoogleToken } from '../lib/verify';
import {
  deviceBasics,
  isPrivateMode,
  loadAccount,
  loadGone,
  loadGroupSecret,
  loadKnownDevices,
  loadOldGroups,
  saveAccount,
  saveGone,
  saveGroupSecret,
  saveKnownDevices,
  saveOldGroups,
} from '../lib/settings';
import firebaseConfig from '../../firebase-applet-config.json';

/**
 * Network-traversal (STUN) servers: each device asks one for its own internet address so
 * devices on different networks can reach each other. They see the IP address only, never
 * what is sent. Cloudflare's is used by default (not Google's), and it can be changed at
 * build time with VITE_ICE_SERVERS (tests pass an empty list).
 */
const DEFAULT_ICE: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** Build-time options (used by tests and self-hosters; normally empty). */
function meshEnv() {
  const env = import.meta.env;
  const list = (v: string | undefined) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const relayUrls = list(env.VITE_RELAY_URLS as string | undefined);
  const ice = env.VITE_ICE_SERVERS as string | undefined;
  const turnUrls = list(env.VITE_TURN_URLS as string | undefined);
  return {
    relayUrls: relayUrls.length ? relayUrls : undefined,
    iceServers: ice === undefined ? DEFAULT_ICE : list(ice).map((urls) => ({ urls })),
    turn: turnUrls.length
      ? { urls: turnUrls, username: env.VITE_TURN_USERNAME as string | undefined, credential: env.VITE_TURN_CREDENTIAL as string | undefined }
      : undefined,
  };
}

const accountKey = (a: Account | null) => (!a ? '' : a.kind === 'google' ? `google:${a.uid}` : `wallet:${a.roomKey}`);

async function accountSession(
  acc: Account,
  hooks: { isApproved: (peerId: string) => boolean; approve: (d: DeviceInfo, code: string, s: AbortSignal) => Promise<boolean> }
): Promise<AccountSession> {
  if (acc.kind === 'google') {
    const projectId = firebaseConfig.projectId;
    // A device that only hands back one of our own tokens (after a mistaken "Allow") is refused.
    const own = createOwnTokenGuard();
    const current = () => import('../lib/firebase').then((fb) => fb.currentIdToken(acc.uid));
    void current().then((t) => t && own.remember(t)).catch(() => {});
    return {
      kind: 'google',
      room: await accountRoom({ kind: 'google', uid: acc.uid }),
      auth: async () => {
        const token = await current();
        if (!token) return {};
        await own.remember(token);
        return { idToken: token };
      },
      verify: async (auth) => {
        const token = auth?.idToken ?? '';
        if (!token || (await own.isOwn(token))) return false;
        return verifyGoogleToken(token, acc.uid, projectId);
      },
      // A device met for the first time is confirmed with a security code on both screens.
      isApproved: hooks.isApproved,
      approve: hooks.approve,
    };
  }
  // Only devices whose wallet made the same signature can derive this room at all.
  return {
    kind: 'wallet',
    room: await accountRoom({ kind: 'wallet', roomKey: acc.roomKey }),
    auth: async () => ({}),
    verify: async () => true,
  };
}

/** What goes over the wire: the item without this device's own bookkeeping. */
const toWire = (item: StoredItem): WireItem => {
  const { status: _s, storedAt: _t, deliveredTo: _d, refusedBy: _r, failReason: _f, ...wire } = item;
  return wire;
};

/** A brand-new device also gets what was sent in the moments before it finished connecting. */
const NEW_DEVICE_GRACE_MS = 2 * 60 * 1000;
/** A file whose transfer shows no progress for this long is marked as interrupted. */
const STALL_MS = 150_000;
/** ...or, if this tab never saw it moving (e.g. after a reload), after this long. */
const STALE_RECEIVING_MS = 10 * 60_000;
/** Waits before asking a still-connected device again after a send didn't get through. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 60_000];

/** Links and notes go in one lane, files in another, so a quick link never waits behind a big video. */
type Lane = 'items' | 'files';
const laneOf = (i: { kind: StoredItem['kind'] }): Lane => (i.kind === 'file' ? 'files' : 'items');

const expired = (i: { retention: Retention; expiresAt?: string }, now = Date.now()) =>
  i.retention === 'temp' && !!i.expiresAt && Date.parse(i.expiresAt) <= now;

const isQuotaError = (err: unknown) => {
  const e = err as { name?: string; message?: string } | null;
  return e?.name === 'QuotaExceededError' || /quota|space/i.test(e?.message ?? '');
};

/** Whether this device has room for a file of this size (true when the browser can't tell). */
async function hasRoomFor(size: number): Promise<boolean> {
  try {
    const e = await navigator.storage?.estimate?.();
    if (!e?.quota) return true;
    return e.quota - (e.usage ?? 0) > size * 1.1 + 5 * 1024 * 1024;
  } catch {
    return true;
  }
}

/** Runs `fn` while holding a lock shared by all tabs of this browser (so two tabs never send the same thing twice). */
async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) return (await locks.request(name, fn)) as T;
  return fn();
}

/** Adds one link (paired / google / wallet) to a remembered device. */
function addLink(k: Record<string, KnownDevice>, d: DeviceInfo, method: LinkMethod, now: number) {
  const prev = k[d.id];
  k[d.id] = {
    id: d.id,
    name: d.name,
    type: d.type,
    methods: [...new Set([...(prev?.methods ?? []), method])],
    since: prev?.since ?? now - NEW_DEVICE_GRACE_MS,
    lastSeen: now,
  };
}

/** Removes one link; the device is forgotten only when no link is left. */
function removeLink(k: Record<string, KnownDevice>, id: string, method: LinkMethod) {
  const prev = k[id];
  if (!prev) return;
  const methods = prev.methods.filter((m) => m !== method);
  if (methods.length) k[id] = { ...prev, methods };
  else delete k[id];
}

export interface IncomingNotice {
  item: StoredItem;
  from: DeviceInfo;
}

export interface P2PHandlers {
  onIncoming?: (n: IncomingNotice) => void;
  onProblem?: (msg: string) => void;
  /** Google: a device of the account met for the first time; show the security code and ask. */
  onAccountKnock?: (device: DeviceInfo, code: string, signal: AbortSignal) => Promise<boolean>;
  /** A device ended one link with this one (unpaired or signed out); `stillLinked` lists what remains. */
  onDeviceGone?: (name: string, method: LinkMethod, stillLinked: LinkMethod[]) => void;
  /** A paired device joined another group and this device followed it there. */
  onGroupMove?: (from: DeviceInfo) => void;
}

export function useP2P(handlers: P2PHandlers) {
  const privateMode = useMemo(isPrivateMode, []);
  const basics = useMemo(deviceBasics, []);
  const [ready, setReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [items, setItems] = useState<StoredItem[]>([]);
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [relay, setRelay] = useState<RelayStatus>('connecting');
  const [selfId, setSelfId] = useState('');
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [account, setAccountState] = useState<Account | null>(() => loadAccount());
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [groupSecret, setGroupSecretState] = useState(() => loadGroupSecret());
  const [known, setKnown] = useState<Record<string, KnownDevice>>(() => loadKnownDevices());

  const knownRef = useRef(known);
  const accountRef = useRef(account);
  const groupRef = useRef(groupSecret);
  const selfRef = useRef('');
  const goneRef = useRef<Record<string, number>>(loadGone());
  const storeRef = useRef<Store | null>(null);
  const meshRef = useRef<Mesh | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const channel = useRef<BroadcastChannel | null>(null);

  /** Changes the remembered devices, starting from what is stored (another tab may have changed it). */
  const updateKnown = useCallback((fn: (k: Record<string, KnownDevice>) => Record<string, KnownDevice>) => {
    const next = fn(loadKnownDevices());
    knownRef.current = next;
    saveKnownDevices(next);
    setKnown(next);
  }, []);

  const setAccount = useCallback((acc: Account | null) => {
    accountRef.current = acc;
    saveAccount(acc);
    setAccountState(acc);
  }, []);

  /**
   * Incoming items and files are handled strictly one after another, so a file can never
   * be saved before (or at the same time as) its description.
   */
  const inbox = useRef<Promise<unknown>>(Promise.resolve());
  const serial = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = inbox.current.then(task);
    inbox.current = run.catch(() => {});
    return run;
  };

  /* ---------------------------- progress bars ---------------------------- */

  /** item -> device -> 0..1 while sending; the bar shows the slowest device. */
  const sendProgress = useRef(new Map<string, Map<string, number>>());
  /** item -> when its incoming transfer last moved. */
  const lastReceive = useRef(new Map<string, number>());

  const setProgressFor = (id: string, value: number | null) =>
    setProgress((prev) => {
      if (value === null && !(id in prev)) return prev;
      // Only when the shown percentage changes (a big file reports progress thousands of times).
      if (value !== null && id in prev && Math.round(prev[id] * 100) === Math.round(value * 100)) return prev;
      const next = { ...prev };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });

  const setSendProgress = (id: string, deviceId: string, p: number | null) => {
    let m = sendProgress.current.get(id);
    if (p === null) m?.delete(deviceId);
    else {
      if (!m) sendProgress.current.set(id, (m = new Map()));
      m.set(deviceId, p);
    }
    if (!m || m.size === 0) {
      sendProgress.current.delete(id);
      setProgressFor(id, null);
    } else setProgressFor(id, Math.min(...m.values()));
  };

  /* ------------------------------- storage ------------------------------- */

  const broadcast = () => channel.current?.postMessage('changed');

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    await store.purgeExpired();
    setItems(await store.list());
  }, []);

  const putInState = (item: StoredItem) =>
    setItems((prev) => {
      const i = prev.findIndex((x) => x.id === item.id);
      if (i === -1) return [...prev, item];
      const next = prev.slice();
      next[i] = item;
      return next;
    });

  /** Saves a new item and tells other tabs of this browser to refresh. */
  const persist = async (item: StoredItem) => {
    await storeRef.current?.put(item);
    putInState(item);
    broadcast();
  };

  /** Changes an item only if it still exists (a deleted item is never brought back). */
  const persistIfExists = async (id: string, fn: (i: StoredItem) => StoredItem | null) => {
    const next = await storeRef.current?.update(id, fn);
    if (next) {
      putInState(next);
      broadcast();
    }
    return next;
  };

  /** Marks incoming files that stopped moving as interrupted (the sender re-sends them when it's back). */
  const markStalled = async () => {
    const store = storeRef.current;
    if (!store) return;
    const now = Date.now();
    for (const it of await store.list()) {
      if (it.status !== 'receiving') continue;
      const last = lastReceive.current.get(it.id);
      const stalled = last ? now - last > STALL_MS : now - it.storedAt > STALE_RECEIVING_MS;
      if (!stalled) continue;
      lastReceive.current.delete(it.id);
      setProgressFor(it.id, null);
      // A sender this device no longer knows won't come back to finish it.
      const gone = !knownRef.current[it.from.id] && !meshRef.current?.devices().some((d) => d.id === it.from.id);
      await persistIfExists(it.id, (i) => (i.status === 'receiving' ? { ...i, status: 'failed', ...(gone ? { failReason: 'sender-gone' as const } : {}) } : null));
    }
  };

  /* ------------------------------- outbox -------------------------------- */

  /** Sends in progress: item -> (controller -> device). Deleting an item aborts them. */
  const sends = useRef(new Map<string, Map<AbortController, string>>());
  /** One delivery run per device and lane at a time; `again` asks for another pass when it ends. */
  const runs = useRef(new Map<string, { running: boolean; again: boolean; retries: number; timer?: ReturnType<typeof setTimeout> }>());
  /** Catch-up start times for "keep nothing" devices (they aren't remembered). */
  const sessionSince = useRef(new Map<string, number>());

  const abortSends = (id: string) => {
    const active = sends.current.get(id);
    if (active) for (const c of active.keys()) c.abort();
  };

  /** Sends a device everything of one lane it should have and hasn't confirmed yet, oldest first. */
  const drainFor = async (deviceId: string, lane: Lane): Promise<'done' | 'unreachable'> => {
    const store = storeRef.current;
    const mesh = meshRef.current;
    const me = selfRef.current;
    if (!store || !mesh || !me) return 'done';
    const now = Date.now();
    const since = knownRef.current[deviceId]?.since ?? sessionSince.current.get(deviceId) ?? now - NEW_DEVICE_GRACE_MS;
    const waiting = (i: StoredItem) =>
      i.from.id === me &&
      (i.status === 'pending' || i.status === 'ready') &&
      laneOf(i) === lane &&
      !(i.deliveredTo ?? []).includes(deviceId) &&
      !i.refusedBy?.[deviceId] &&
      !expired(i);
    // Items nobody has yet are for whichever device connects first; but an item another device
    // refused (e.g. no space there) is not pushed to a newly paired device unasked.
    const firstComer = (i: StoredItem) => i.status === 'pending' && !Object.keys(i.refusedBy ?? {}).length;
    const todo = (await store.list())
      .filter((i) => waiting(i) && (firstComer(i) || Date.parse(i.createdAt) >= since))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const candidate of todo) {
      const item = await store.get(candidate.id); // it may have been deleted or delivered meanwhile
      if (!item || !waiting(item)) continue;
      const blob = item.kind === 'file' ? await store.getBlob(item.id) : undefined;
      if (item.kind === 'file' && !blob) continue;

      const ctrl = new AbortController();
      let active = sends.current.get(item.id);
      if (!active) sends.current.set(item.id, (active = new Map()));
      active.set(ctrl, deviceId);
      let result: DeliveryResult;
      try {
        result = await mesh.deliver(toWire(item), blob, deviceId, {
          signal: ctrl.signal,
          onProgress: (p) => setSendProgress(item.id, deviceId, p),
        });
      } finally {
        active.delete(ctrl);
        if (active.size === 0) sends.current.delete(item.id);
        setSendProgress(item.id, deviceId, null);
      }

      if (result === 'delivered') {
        await persistIfExists(item.id, (i) => {
          const { [deviceId]: _gone, ...refusedBy } = i.refusedBy ?? {};
          return { ...i, status: 'ready', deliveredTo: [...new Set([...(i.deliveredTo ?? []), deviceId])], refusedBy };
        });
      } else if (result === 'aborted') {
        mesh.withdraw(item.id, [deviceId]); // deleted here while sending: tell the other device to drop it
      } else if (result === 'unreachable') {
        return 'unreachable'; // it went away (or isn't answering): the rest of this lane waits
      } else {
        // It can't take this one (e.g. its storage is full): remember, so it isn't sent again
        // and again; "Try again" clears this.
        const reason = result === 'no-space' ? 'no-space' : 'refused';
        await persistIfExists(item.id, (i) => ({ ...i, refusedBy: { ...(i.refusedBy ?? {}), [deviceId]: reason } }));
      }
    }
    return 'done';
  };

  const kickLane = (deviceId: string, lane: Lane) => {
    const key = `${deviceId}:${lane}`;
    let state = runs.current.get(key);
    if (!state) runs.current.set(key, (state = { running: false, again: false, retries: 0 }));
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    const s = state;
    void (async () => {
      let last: 'done' | 'unreachable' = 'done';
      try {
        do {
          s.again = false;
          last = await withLock(`qrls-out:${selfRef.current}:${deviceId}:${lane}`, () => drainFor(deviceId, lane));
        } while (s.again);
      } catch (err) {
        console.error(err);
      } finally {
        s.running = false;
      }
      // Didn't get through although the device still shows as connected: ask again a bit later.
      const stillThere = meshRef.current?.devices().some((d) => d.id === deviceId);
      if (last === 'unreachable' && stillThere) {
        const delay = RETRY_DELAYS_MS[Math.min(s.retries, RETRY_DELAYS_MS.length - 1)];
        s.retries++;
        s.timer = setTimeout(() => kickRef.current(deviceId), delay);
      } else if (last === 'done') s.retries = 0;
    })();
  };
  const kick = (deviceId: string) => {
    kickLane(deviceId, 'items');
    kickLane(deviceId, 'files');
  };
  const kickRef = useRef(kick);
  kickRef.current = kick;
  const kickAll = () => {
    for (const d of meshRef.current?.devices() ?? []) kickRef.current(d.id);
  };

  /* ------------------------------ start-up ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    const mesh = new Mesh({ privateMode, device: basics, ...meshEnv() });
    meshRef.current = mesh;

    const noSpace = (name: string, from: DeviceInfo) =>
      handlersRef.current.onProblem?.(`Not enough space on this device to save “${name}”. Free up space, then ask ${from.name} to tap Try again.`);

    const receiver: Receiver = {
      item: (wire, from) =>
        serial(async (): Promise<Receipt> => {
          const store = storeRef.current;
          if (!store) throw new Error('not ready');
          // Deleted here before, or already past its time: confirm it so the sender stops trying.
          if (goneRef.current[wire.id] || expired(wire)) return 'have';
          const existing = await store.get(wire.id);
          if (existing) {
            if (existing.kind !== 'file' || existing.status === 'ready') return 'have';
            if (existing.status === 'failed') {
              if (existing.failReason === 'no-space' && store.persistent && !(await hasRoomFor(wire.file?.size ?? 0))) return 'no-space';
              await persistIfExists(wire.id, (i) => {
                const { failReason: _f, ...rest } = i;
                return { ...rest, status: 'receiving', storedAt: Date.now() };
              });
            }
            return 'need-file';
          }
          if (wire.kind === 'file' && store.persistent && !(await hasRoomFor(wire.file?.size ?? 0))) {
            await persist({ ...wire, status: 'failed', failReason: 'no-space', storedAt: Date.now() });
            noSpace(wire.file?.name ?? 'a file', from);
            return 'no-space';
          }
          const item: StoredItem = { ...wire, status: wire.kind === 'file' ? 'receiving' : 'ready', storedAt: Date.now() };
          if (item.retention === 'saved') void requestPersistentStorage().then((ok) => ok && setPersisted(true));
          await persist(item);
          handlersRef.current.onIncoming?.({ item, from: { id: from.id, name: from.name, type: from.type } });
          return item.kind === 'file' ? 'need-file' : 'ok';
        }),
      wantsFile: async (id, size, fromId) => {
        const it = await storeRef.current?.get(id);
        return !!it && it.kind === 'file' && it.status !== 'ready' && it.file?.size === size && it.from.id === fromId;
      },
      file: (id, bytes, from) =>
        serial(async (): Promise<Receipt> => {
          const store = storeRef.current;
          if (!store) throw new Error('not ready');
          lastReceive.current.delete(id);
          setProgressFor(id, null);
          const it = await store.get(id);
          if (!it) {
            if (goneRef.current[id]) return 'ok'; // deleted here while it was arriving
            throw new Error('unknown item');
          }
          if (it.kind !== 'file' || it.from.id !== from.id) throw new Error('unexpected file');
          if (it.status === 'ready') return 'have';
          if (bytes.byteLength !== it.file?.size) {
            await persistIfExists(id, (i) => ({ ...i, status: 'failed' }));
            throw new Error('size mismatch');
          }
          try {
            await store.putBlob(id, new Blob([bytes], { type: it.file.mime || 'application/octet-stream' }));
          } catch (err) {
            if (!isQuotaError(err)) throw err;
            await persistIfExists(id, (i) => ({ ...i, status: 'failed', failReason: 'no-space' }));
            noSpace(it.file.name, from);
            return 'no-space';
          }
          const done = await persistIfExists(id, (i) => ({ ...i, status: 'ready' }));
          if (!done) await store.remove(id); // deleted while saving: drop the file too
          return 'ok';
        }),
      withdrawn: (id, fromId) =>
        void serial(async () => {
          const store = storeRef.current;
          const it = await store?.get(id);
          if (!store || !it || it.status !== 'receiving' || it.from.id !== fromId) return;
          await store.remove(id);
          lastReceive.current.delete(id);
          setProgressFor(id, null);
          setItems((prev) => prev.filter((i) => i.id !== id));
          broadcast();
        }),
    };
    mesh.setReceiver(receiver);

    (async () => {
      const store = await openStore(privateMode);
      if (cancelled) return;
      storeRef.current = store;
      if (store.persistent) setPersisted(await isPersisted());
      await refresh();
      await markStalled();
      await mesh.setGroups(groupRef.current, loadOldGroups().map((g) => g.secret));
      const id = await mesh.selfId();
      selfRef.current = id;
      setSelfId(id);
      setReady(true);
    })().catch((err) => {
      const msg = String(err?.message || err);
      setStartupError(msg);
      handlersRef.current.onProblem?.(msg);
    });

    const offDevices = mesh.devicesChanged.on((list) => {
      setDevices(list);
      const now = Date.now();
      if (list.some((d) => knownRef.current[d.id])) {
        updateKnown((k) => {
          for (const d of list) if (k[d.id]) k[d.id] = { ...k[d.id], name: d.name, type: d.type, lastSeen: now };
          return k;
        });
      }
    });
    const offProblem = mesh.problem.on((m) => handlersRef.current.onProblem?.(m));
    const offProgress = mesh.receiveProgress.on(({ id, progress }) => {
      lastReceive.current.set(id, Date.now());
      setProgressFor(id, progress);
    });

    // When a device connects (or reconnects, or its route changes), send it what it missed.
    const offReady = mesh.deviceReady.on((device) => {
      const now = Date.now();
      if (device.ephemeral) {
        if (!sessionSince.current.has(device.id)) sessionSince.current.set(device.id, now - NEW_DEVICE_GRACE_MS);
      } else {
        updateKnown((k) => {
          addLink(k, device, device.method, now);
          return k;
        });
      }
      kickRef.current(device.id);
    });

    // A device of this group paired with a device of another group and moved there: follow it.
    const offMove = mesh.groupMove.on(({ secret, from }) => {
      if (secret === groupRef.current) return;
      void switchGroupRef.current(secret, { keepCurrent: true, keepOld: true }).then(() => handlersRef.current.onGroupMove?.(from));
    });

    /** One notice per device, even when its goodbye arrives in several rooms. */
    const lastGone = new Map<string, number>();
    const offGone = mesh.deviceGone.on(({ id, name, method }) => {
      if (knownRef.current[id]) {
        updateKnown((k) => {
          removeLink(k, id, method);
          return k;
        });
      }
      const still = [...new Set([...(knownRef.current[id]?.methods ?? []), ...mesh.linksTo(id)])].filter((m) => m !== method);
      if (!still.length) {
        // Anything it was still sending here won't be finished.
        void (async () => {
          for (const it of (await storeRef.current?.list()) ?? []) {
            if (it.status !== 'receiving' || it.from.id !== id) continue;
            lastReceive.current.delete(it.id);
            setProgressFor(it.id, null);
            await persistIfExists(it.id, (i) => (i.status === 'receiving' ? { ...i, status: 'failed', failReason: 'sender-gone' } : null));
          }
        })();
      }
      const now = Date.now();
      if (now - (lastGone.get(`${id}:${method}`) ?? 0) < 5000) return;
      lastGone.set(`${id}:${method}`, now);
      handlersRef.current.onDeviceGone?.(name, method, still);
    });

    const relayTimer = setInterval(() => setRelay(mesh.relayStatus()), 2000);
    const purgeTimer = setInterval(() => void refresh().then(markStalled), 30_000);

    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('qrls-items');
      channel.current.onmessage = async () => {
        goneRef.current = loadGone();
        await refresh();
        // Deleted in another tab: stop sending it from this one too.
        const store = storeRef.current;
        for (const id of [...sends.current.keys()]) if (!(await store?.get(id))) abortSends(id);
      };
    }

    // Another tab of this browser changed the pairing (paired, unpaired, signed in or out, keep-nothing).
    const onStorage = (e: StorageEvent) => {
      if (privateMode || e.storageArea !== localStorage || !e.key) return;
      if (e.key === 'qrls.private') return location.reload();
      if ((e.key === 'qrls.group' || e.key === 'qrls.oldGroups') && e.newValue !== null) {
        const g = loadGroupSecret();
        groupRef.current = g;
        setGroupSecretState(g);
        void mesh.setGroups(g, loadOldGroups().map((o) => o.secret));
      } else if (e.key === 'qrls.account') {
        const a = loadAccount();
        accountRef.current = a;
        setAccountState(a);
      } else if (e.key === 'qrls.known') {
        const k = loadKnownDevices();
        knownRef.current = k;
        setKnown(k);
      } else if (e.key === 'qrls.gone') {
        goneRef.current = loadGone();
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      offDevices();
      offProblem();
      offProgress();
      offReady();
      offMove();
      offGone();
      clearInterval(relayTimer);
      clearInterval(purgeTimer);
      for (const r of runs.current.values()) if (r.timer) clearTimeout(r.timer);
      window.removeEventListener('storage', onStorage);
      channel.current?.close();
      mesh.setReceiver(null);
      void mesh.destroy();
    };
  }, []);

  /* ------------------------------ accounts ------------------------------ */

  const key = accountKey(account);
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !ready) return;
    let stale = false;
    (async () => {
      const acc = accountRef.current;
      if (!acc) return mesh.setAccount(null);
      const session = await accountSession(acc, {
        // A device already connected before (by any link) reconnects without a question.
        isApproved: (peerId) => !!knownRef.current[peerId],
        approve: (device, code, signal) => handlersRef.current.onAccountKnock?.(device, code, signal) ?? Promise.resolve(false),
      });
      if (!stale) await mesh.setAccount(session);
    })().catch((err) => handlersRef.current.onProblem?.(String(err?.message || err)));
    return () => {
      stale = true;
    };
  }, [key, ready]);

  /** Signs out of the account here; the other devices are told so they forget this link. */
  const leaveAccount = async () => {
    const acc = accountRef.current;
    if (!acc) return;
    await meshRef.current?.sayBye('account').catch(() => {});
    forgetDevices(acc.kind);
    setAccount(null);
  };

  /* ------------------------------- sending ------------------------------- */

  const newItemBase = (retention: Retention) => {
    const now = Date.now();
    return {
      id: randomSecret(12),
      retention,
      from: { id: selfRef.current, name: basics.name, type: basics.type },
      createdAt: new Date(now).toISOString(),
      ...(retention === 'temp' ? { expiresAt: new Date(now + TEMP_TTL_MS).toISOString() } : {}),
    };
  };

  /** Shares a link or note: saved here first, then delivered in the background. */
  const sendText = async (raw: string, retention: Retention): Promise<StoredItem | null> => {
    const text = raw.trim();
    if (!text || text.length > MAX_TEXT_CHARS || !selfRef.current) return null;
    const url = toHttpUrl(text);
    const item: StoredItem = {
      ...newItemBase(retention),
      kind: url ? 'link' : 'text',
      ...(url ? { url } : { text: raw.replace(/^\s*\n|\s+$/g, '') }),
      status: 'pending',
      storedAt: Date.now(),
    };
    if (retention === 'saved') void requestPersistentStorage().then((ok) => ok && setPersisted(true));
    await persist(item);
    kickAll();
    return item;
  };

  /** Shares a file (kept on this device too): saved here first, then delivered in the background. */
  const sendFile = async (file: File, retention: Retention): Promise<StoredItem | null> => {
    const store = storeRef.current;
    if (!store || file.size > MAX_FILE_BYTES || file.size === 0 || !selfRef.current) return null;
    const item: StoredItem = {
      ...newItemBase(retention),
      kind: 'file',
      file: { name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' },
      status: 'pending',
      storedAt: Date.now(),
    };
    await store.putBlob(item.id, file);
    if (retention === 'saved') void requestPersistentStorage().then((ok) => ok && setPersisted(true));
    await persist(item);
    kickAll();
    return item;
  };

  /* ---------------------------- managing items ---------------------------- */

  const keepForever = async (id: string) => {
    void requestPersistentStorage().then((ok) => ok && setPersisted(true));
    await persistIfExists(id, (i) => {
      const { expiresAt: _e, ...rest } = i;
      return { ...rest, retention: 'saved' };
    });
  };

  /** Deletes items from this device only (other devices keep their own copies). */
  const removeLocal = async (ids: string[]) => {
    const store = storeRef.current;
    const now = Date.now();
    goneRef.current = loadGone();
    for (const id of ids) {
      abortSends(id);
      goneRef.current[id] = now;
      await store?.remove(id);
      lastReceive.current.delete(id);
      setProgressFor(id, null);
    }
    saveGone(goneRef.current);
    const gone = new Set(ids);
    setItems((prev) => prev.filter((i) => !gone.has(i.id)));
    broadcast();
  };

  const remove = (id: string) => removeLocal([id]);
  const removeAll = (retention: Retention) => removeLocal(items.filter((x) => x.retention === retention).map((x) => x.id));

  const getBlob = useCallback((id: string) => storeRef.current?.getBlob(id) ?? Promise.resolve(undefined), []);

  /** Tries again to send everything that's still waiting, including items a device couldn't take before. */
  const retry = async () => {
    const store = storeRef.current;
    if (store) {
      for (const i of await store.list()) {
        if (i.from.id === selfRef.current && i.refusedBy && Object.keys(i.refusedBy).length) {
          await persistIfExists(i.id, (x) => {
            const { refusedBy: _r, ...rest } = x;
            return rest;
          });
        }
      }
    }
    for (const r of runs.current.values()) r.retries = 0;
    kickAll();
  };

  /* -------------------------------- pairing -------------------------------- */

  /** Forgets one kind of link on every remembered device (after unpairing or signing out). */
  const forgetDevices = (method: LinkMethod) =>
    updateKnown((k) => {
      for (const id of Object.keys(k)) removeLink(k, id, method);
      return k;
    });

  /** Forgets one device completely (e.g. one that was reset and will never come back). */
  const forgetDevice = (id: string) =>
    updateKnown((k) => {
      delete k[id];
      return k;
    });

  /** Whether this device has paired devices (connected now or remembered). */
  const hasPaired = useCallback(
    () => Object.values(knownRef.current).some((d) => d.methods.includes('paired')) || !!meshRef.current?.hasGroupPeers(),
    []
  );

  /** This device's group secret right now (read at the moment it is needed). */
  const currentGroup = useCallback(() => groupRef.current, []);

  /**
   * Moves to another group. `keepCurrent` keeps the group being left for a while so its other
   * devices are told to follow (nobody gets left behind); `keepOld` keeps earlier ones.
   */
  const switchGroup = async (secret: string, opts: { keepCurrent: boolean; keepOld: boolean }) => {
    const old = groupRef.current;
    if (secret === old) return;
    const keep = [...(opts.keepCurrent ? [{ secret: old, since: Date.now() }] : []), ...(opts.keepOld ? loadOldGroups() : [])];
    const olds = keep.filter((g, i) => g.secret !== secret && keep.findIndex((x) => x.secret === g.secret) === i);
    saveOldGroups(olds);
    saveGroupSecret(secret);
    groupRef.current = secret;
    setGroupSecretState(secret);
    await meshRef.current?.setGroups(
      secret,
      olds.map((g) => g.secret)
    );
  };
  const switchGroupRef = useRef(switchGroup);
  switchGroupRef.current = switchGroup;

  /** After pairing: use that group from now on, bringing this device's own paired devices along. */
  const joinGroup = (secret: string) => switchGroup(secret, { keepCurrent: hasPaired(), keepOld: true });

  /** This device had no paired devices, and the new device brought its group: use that one. */
  const adoptGroup = (secret: string) => switchGroup(secret, { keepCurrent: false, keepOld: true });

  /** Stops connecting to paired devices; those online are told so they forget this one. */
  const unpair = async (freshSecret: string) => {
    // Other tabs of this browser switch as soon as the new group is saved, so no tab keeps receiving.
    saveOldGroups([]);
    saveGroupSecret(freshSecret);
    await meshRef.current?.sayBye('group').catch(() => {});
    await switchGroup(freshSecret, { keepCurrent: false, keepOld: false });
    forgetDevices('paired');
  };

  const deviceNames = useMemo(
    () => Object.fromEntries([...Object.values(known), ...devices].map((d) => [d.id, d.name])) as Record<string, string>,
    [known, devices]
  );

  return {
    ready,
    startupError,
    privateMode,
    /** Items survive closing the tab (false in "keep nothing" mode or if the browser blocks storage). */
    persistent: storeRef.current?.persistent ?? !privateMode,
    /** The browser promised not to clear our data (null: unknown / not supported). */
    persisted,
    self: { id: selfId, name: basics.name, type: basics.type } as DeviceInfo,
    items,
    devices,
    knownDevices: Object.values(known).filter((d) => !devices.some((c) => c.id === d.id)),
    /** Names of devices this one knows (for "couldn't be saved on <name>"). */
    deviceNames,
    relay,
    progress,
    account,
    groupSecret,
    mesh: meshRef,
    store: storeRef,
    refresh,
    sendText,
    sendFile,
    keepForever,
    remove,
    removeAll,
    retry,
    getBlob,
    setAccount,
    leaveAccount,
    hasPaired,
    currentGroup,
    joinGroup,
    adoptGroup,
    switchGroup,
    unpair,
    forgetDevices,
    forgetDevice,
  };
}

export type P2P = ReturnType<typeof useP2P>;
