import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, ConnectedDevice, DeviceInfo, KnownDevice, LinkMethod, Retention, StoredItem, WireItem } from '../types/share';
import { Mesh, type AccountSession, type Receipt, type Receiver, type RelayStatus } from '../lib/mesh';
import { isPersisted, openStore, requestPersistentStorage, type Store } from '../lib/db';
import { accountRoom, randomSecret } from '../lib/pairing';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, TEMP_TTL_MS, toHttpUrl } from '../lib/shared';
import { verifyGoogleToken } from '../lib/verify';
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
  hooks: { revealFirst: (peerId: string) => boolean; onStuck: (d: DeviceInfo, s: AbortSignal) => Promise<boolean> }
): Promise<AccountSession> {
  if (acc.kind === 'google') {
    const projectId = firebaseConfig.projectId;
    return {
      kind: 'google',
      room: await accountRoom({ kind: 'google', uid: acc.uid }),
      auth: async () => {
        const fb = await import('../lib/firebase');
        const token = await fb.currentIdToken(acc.uid);
        return token ? { idToken: token } : {};
      },
      verify: (auth) => verifyGoogleToken(auth?.idToken ?? '', acc.uid, projectId),
      revealFirst: hooks.revealFirst,
      onStuck: hooks.onStuck,
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
  const { status: _s, storedAt: _t, deliveredTo: _d, ...wire } = item;
  return wire;
};

/** A brand-new device also gets what was sent in the moments before it finished connecting. */
const NEW_DEVICE_GRACE_MS = 2 * 60 * 1000;
/** A file whose transfer shows no progress for this long is marked as interrupted. */
const STALL_MS = 150_000;
/** ...or, if this tab never saw it moving (e.g. after a reload), after this long. */
const STALE_RECEIVING_MS = 10 * 60_000;

const expired = (i: { retention: Retention; expiresAt?: string }, now = Date.now()) =>
  i.retention === 'temp' && !!i.expiresAt && Date.parse(i.expiresAt) <= now;

/** Runs `fn` while holding a lock shared by all tabs of this browser (so two tabs never send the same thing twice). */
async function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) {
    await locks.request(name, fn);
    return;
  }
  await fn();
}

export interface IncomingNotice {
  item: StoredItem;
  from: DeviceInfo;
}

export interface P2PHandlers {
  onIncoming?: (n: IncomingNotice) => void;
  onProblem?: (msg: string) => void;
  /** Google: a device of the account and this one are both waiting for the other to go first. */
  onAccountKnock?: (device: DeviceInfo, signal: AbortSignal) => Promise<boolean>;
  /** A device unpaired from this one or signed out. */
  onDeviceGone?: (name: string, method: LinkMethod) => void;
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

  const updateKnown = useCallback((fn: (k: Record<string, KnownDevice>) => Record<string, KnownDevice>) => {
    const next = fn({ ...knownRef.current });
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
      await persistIfExists(it.id, (i) => (i.status === 'receiving' ? { ...i, status: 'failed' } : null));
    }
  };

  /* ------------------------------- outbox -------------------------------- */

  /** Sends in progress: item -> (controller -> device). Deleting an item aborts them. */
  const sends = useRef(new Map<string, Map<AbortController, string>>());
  /** One delivery run per device at a time; `again` asks for another pass when it ends. */
  const runs = useRef(new Map<string, { running: boolean; again: boolean }>());
  /** Catch-up start times for "keep nothing" devices (they aren't remembered). */
  const sessionSince = useRef(new Map<string, number>());

  const abortSends = (id: string) => {
    const active = sends.current.get(id);
    if (active) for (const c of active.keys()) c.abort();
  };

  /** Sends a device everything it should have and hasn't confirmed yet, oldest first. */
  const drainFor = async (deviceId: string) => {
    const store = storeRef.current;
    const mesh = meshRef.current;
    const me = selfRef.current;
    if (!store || !mesh || !me) return;
    const now = Date.now();
    const since = knownRef.current[deviceId]?.since ?? sessionSince.current.get(deviceId) ?? now - NEW_DEVICE_GRACE_MS;
    const todo = (await store.list())
      .filter((i) => i.from.id === me && (i.status === 'pending' || i.status === 'ready'))
      .filter((i) => !(i.deliveredTo ?? []).includes(deviceId) && !expired(i, now))
      .filter((i) => i.status === 'pending' || Date.parse(i.createdAt) >= since)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const candidate of todo) {
      const item = await store.get(candidate.id); // it may have been deleted meanwhile
      if (!item || (item.deliveredTo ?? []).includes(deviceId) || expired(item)) continue;
      const blob = item.kind === 'file' ? await store.getBlob(item.id) : undefined;
      if (item.kind === 'file' && !blob) continue;

      const ctrl = new AbortController();
      let active = sends.current.get(item.id);
      if (!active) sends.current.set(item.id, (active = new Map()));
      active.set(ctrl, deviceId);
      let result;
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
        await persistIfExists(item.id, (i) => ({ ...i, status: 'ready', deliveredTo: [...new Set([...(i.deliveredTo ?? []), deviceId])] }));
      } else if (result === 'aborted') {
        mesh.withdraw(item.id, [deviceId]); // deleted here while sending: tell the other device to drop it
      } else if (result === 'unreachable') {
        return; // it went away: the rest waits for its next connection
      }
      // 'refused': skip that one and carry on
    }
  };

  const kick = (deviceId: string) => {
    let state = runs.current.get(deviceId);
    if (!state) runs.current.set(deviceId, (state = { running: false, again: false }));
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    const s = state;
    void (async () => {
      try {
        do {
          s.again = false;
          await withLock(`qrls-out:${selfRef.current}:${deviceId}`, () => drainFor(deviceId));
        } while (s.again);
      } catch (err) {
        console.error(err);
      } finally {
        s.running = false;
      }
    })();
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
            if (existing.status === 'failed') await persistIfExists(wire.id, (i) => ({ ...i, status: 'receiving', storedAt: Date.now() }));
            return 'need-file';
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
          await store.putBlob(id, new Blob([bytes], { type: it.file.mime || 'application/octet-stream' }));
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

    // When a device connects (or reconnects), send it what it missed.
    const offReady = mesh.deviceReady.on((device) => {
      const now = Date.now();
      if (device.ephemeral) {
        if (!sessionSince.current.has(device.id)) sessionSince.current.set(device.id, now - NEW_DEVICE_GRACE_MS);
      } else {
        updateKnown((k) => {
          const prev = k[device.id];
          k[device.id] = {
            id: device.id,
            name: device.name,
            type: device.type,
            // Pairing is the lasting link; keep it even when the device also shares an account.
            method: prev?.method === 'paired' ? 'paired' : device.method,
            since: prev?.since ?? now - NEW_DEVICE_GRACE_MS,
            lastSeen: now,
          };
          return k;
        });
      }
      const acc = accountRef.current;
      if (device.method === 'google' && acc?.kind === 'google' && !acc.met) setAccount({ ...acc, met: true });
      kickRef.current(device.id);
    });

    // A device of this group paired with a device of another group and moved there: follow it.
    const offMove = mesh.groupMove.on(({ secret }) => void switchGroupRef.current(secret, { migrate: true }));

    const offGone = mesh.deviceGone.on(({ id, name, method }) => {
      if (knownRef.current[id]) {
        updateKnown((k) => {
          delete k[id];
          return k;
        });
      }
      handlersRef.current.onDeviceGone?.(name, method);
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
        // An established device shows its Google token only to devices it already knows,
        // or to devices that have shown theirs first.
        revealFirst: (peerId) => {
          const a = accountRef.current;
          return !(a?.kind === 'google' && a.met) || !!knownRef.current[peerId];
        },
        onStuck: (device, signal) => handlersRef.current.onAccountKnock?.(device, signal) ?? Promise.resolve(false),
      });
      if (!stale) await mesh.setAccount(session);
    })().catch((err) => handlersRef.current.onProblem?.(String(err?.message || err)));
    return () => {
      stale = true;
    };
  }, [key, ready]);

  /** Signs out of the account here; the other devices are told so they forget this one. */
  const leaveAccount = async () => {
    const acc = accountRef.current;
    if (!acc) return;
    await meshRef.current?.sayBye('account');
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

  /** Tries again to send everything that's still waiting. */
  const retry = () => kickAll();

  /* -------------------------------- pairing -------------------------------- */

  /** Forgets remembered devices linked by one method (after unpairing or signing out). */
  const forgetDevices = (method: LinkMethod) =>
    updateKnown((k) => Object.fromEntries(Object.entries(k).filter(([, d]) => d.method !== method)));

  /** Whether this device has paired devices (connected now or remembered). */
  const hasPaired = useCallback(
    () => Object.values(knownRef.current).some((d) => d.method === 'paired') || !!meshRef.current?.hasGroupPeers(),
    []
  );

  /**
   * Moves to another group. With `migrate`, the old group is kept for a while so its
   * other devices are told to follow (nobody gets left behind).
   */
  const switchGroup = async (secret: string, opts: { migrate: boolean }) => {
    const old = groupRef.current;
    if (secret === old) return;
    const keep = opts.migrate ? [{ secret: old, since: Date.now() }, ...loadOldGroups()] : [];
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
  const joinGroup = (secret: string) => switchGroup(secret, { migrate: hasPaired() });

  /** Stops connecting to paired devices; they are told so they forget this one. */
  const unpair = async (freshSecret: string) => {
    await meshRef.current?.sayBye('group');
    await switchGroup(freshSecret, { migrate: false });
    forgetDevices('paired');
  };

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
    joinGroup,
    switchGroup,
    unpair,
    forgetDevices,
  };
}

export type P2P = ReturnType<typeof useP2P>;
