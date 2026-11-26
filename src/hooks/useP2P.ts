import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, ConnectedDevice, DeviceInfo, KnownDevice, LinkMethod, Retention, StoredItem, WireItem } from '../types/share';
import { Mesh, type AccountSession, type RelayStatus } from '../lib/mesh';
import { openStore, requestPersistentStorage, type Store } from '../lib/db';
import { accountRoom, randomSecret } from '../lib/pairing';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, TEMP_TTL_MS, toHttpUrl } from '../lib/shared';
import { verifyGoogleToken } from '../lib/verify';
import {
  deviceBasics,
  isPrivateMode,
  loadAccount,
  loadGroupSecret,
  loadKnownDevices,
  saveAccount,
  saveGroupSecret,
  saveKnownDevices,
} from '../lib/settings';
import firebaseConfig from '../../firebase-applet-config.json';

/** Build-time options (used by tests and self-hosters; normally empty). */
function meshEnv() {
  const env = import.meta.env;
  const list = (v: string | undefined) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const relayUrls = list(env.VITE_RELAY_URLS as string | undefined);
  const ice = env.VITE_ICE_SERVERS as string | undefined;
  const turnUrls = list(env.VITE_TURN_URLS as string | undefined);
  return {
    relayUrls: relayUrls.length ? relayUrls : undefined,
    iceServers: ice === undefined ? undefined : list(ice).map((urls) => ({ urls })),
    turn: turnUrls.length
      ? { urls: turnUrls, username: env.VITE_TURN_USERNAME as string | undefined, credential: env.VITE_TURN_CREDENTIAL as string | undefined }
      : undefined,
  };
}

async function accountSession(acc: Account): Promise<AccountSession> {
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

export interface IncomingNotice {
  item: StoredItem;
  from: DeviceInfo;
}

export function useP2P(handlers: { onIncoming?: (n: IncomingNotice) => void; onProblem?: (msg: string) => void }) {
  const privateMode = useMemo(isPrivateMode, []);
  const basics = useMemo(deviceBasics, []);
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<StoredItem[]>([]);
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [relay, setRelay] = useState<RelayStatus>('connecting');
  const [selfId, setSelfId] = useState('');
  const [account, setAccountState] = useState<Account | null>(() => loadAccount());
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [groupSecret, setGroupSecretState] = useState(() => loadGroupSecret());
  const [known, setKnown] = useState<Record<string, KnownDevice>>(() => loadKnownDevices());
  const knownRef = useRef(known);
  const updateKnown = useCallback((fn: (k: Record<string, KnownDevice>) => Record<string, KnownDevice>) => {
    const next = fn({ ...knownRef.current });
    knownRef.current = next;
    saveKnownDevices(next);
    setKnown(next);
  }, []);

  const storeRef = useRef<Store | null>(null);
  const meshRef = useRef<Mesh | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const orphanBlobs = useRef(new Map<string, Blob>());
  /**
   * Incoming items and files are handled strictly one after another. A small file can
   * arrive while its description is still being saved; without this, the two steps
   * could interleave and leave the item stuck at "Receiving".
   */
  const inbox = useRef<Promise<void>>(Promise.resolve());
  const serially = (task: () => Promise<void>) => {
    inbox.current = inbox.current.then(task).catch((err) => console.error(err));
  };
  const channel = useRef<BroadcastChannel | null>(null);

  const refresh = useCallback(async () => {
    const store = storeRef.current;
    if (!store) return;
    await store.purgeExpired();
    setItems(await store.list());
  }, []);

  /** Saves an item and tells other tabs of this browser to refresh. */
  const persist = useCallback(
    async (item: StoredItem) => {
      await storeRef.current?.put(item);
      setItems((prev) => {
        const i = prev.findIndex((x) => x.id === item.id);
        if (i === -1) return [...prev, item];
        const next = prev.slice();
        next[i] = item;
        return next;
      });
      channel.current?.postMessage('changed');
    },
    []
  );

  const setProgressFor = (id: string, value: number | null) =>
    setProgress((prev) => {
      const next = { ...prev };
      if (value === null) delete next[id];
      else next[id] = value;
      return next;
    });

  /* ------------------------------ start-up ------------------------------ */

  useEffect(() => {
    let cancelled = false;
    const env = meshEnv();
    const mesh = new Mesh({ privateMode, device: basics, ...env });
    meshRef.current = mesh;

    (async () => {
      const store = await openStore(privateMode);
      if (cancelled) return;
      storeRef.current = store;
      await refresh();
      await mesh.setGroup(groupSecret);
      setSelfId(await mesh.selfId());
      setReady(true);
    })().catch((err) => handlersRef.current.onProblem?.(String(err?.message || err)));

    const offDevices = mesh.devicesChanged.on((list) => {
      setDevices(list);
      if (list.length) {
        const now = Date.now();
        updateKnown((k) => {
          for (const d of list) if (k[d.id]) k[d.id] = { ...k[d.id], name: d.name, type: d.type, method: d.method, lastSeen: now };
          return k;
        });
      }
    });
    const offProblem = mesh.problem.on((m) => handlersRef.current.onProblem?.(m));

    const offItem = mesh.itemReceived.on((wire) => serially(async () => {
      const store = storeRef.current;
      if (!store) return;
      if (wire.retention === 'temp' && wire.expiresAt && Date.parse(wire.expiresAt) <= Date.now()) return;
      const existing = await store.get(wire.id);
      if (existing && existing.status !== 'failed') return;
      const orphan = orphanBlobs.current.get(wire.id);
      const item: StoredItem = {
        ...wire,
        status: wire.kind === 'file' && !orphan ? 'receiving' : 'ready',
        storedAt: Date.now(),
      };
      if (orphan) {
        orphanBlobs.current.delete(wire.id);
        await store.putBlob(wire.id, new Blob([orphan], { type: wire.file?.mime || 'application/octet-stream' }));
      }
      if (item.retention === 'saved') void requestPersistentStorage();
      await persist(item);
      handlersRef.current.onIncoming?.({ item, from: wire.from });
    }));

    const offFile = mesh.fileReceived.on(({ id, bytes }) => serially(async () => {
      const store = storeRef.current;
      if (!store) return;
      const item = await store.get(id);
      setProgressFor(id, null);
      if (!item) {
        // The file overtook its description; keep it until the description arrives.
        orphanBlobs.current.set(id, new Blob([bytes]));
        return;
      }
      if (item.kind !== 'file' || item.status === 'ready') return;
      if (bytes.byteLength !== item.file?.size) {
        await persist({ ...item, status: 'failed' });
        return;
      }
      await store.putBlob(id, new Blob([bytes], { type: item.file.mime || 'application/octet-stream' }));
      await persist({ ...item, status: 'ready' });
    }));

    const offProgress = mesh.receiveProgress.on(({ id, progress }) => setProgressFor(id, progress));

    // When a device connects, send it what it missed:
    //  - anything still waiting because no device was connected when it was created
    //  - anything created here after it first connected that it hasn't received yet
    const offVerified = mesh.deviceVerified.on(async (device) => {
      const store = storeRef.current;
      if (!store) return;
      const now = Date.now();
      let since = knownRef.current[device.id]?.since;
      if (since === undefined) since = now - NEW_DEVICE_GRACE_MS;
      updateKnown((k) => ({ ...k, [device.id]: { ...device, since: k[device.id]?.since ?? since!, lastSeen: now } }));
      const me = await mesh.selfId();
      const todo = (await store.list())
        .filter((i) => i.from.id === me && (i.status === 'pending' || i.status === 'ready'))
        .filter((i) => !(i.retention === 'temp' && i.expiresAt && Date.parse(i.expiresAt) <= now))
        .filter((i) => i.status === 'pending' || (Date.parse(i.createdAt) >= since! && !(i.deliveredTo ?? []).includes(device.id)))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const item of todo) {
        const blob = item.kind === 'file' ? await store.getBlob(item.id) : undefined;
        if (item.kind === 'file' && !blob) continue;
        const delivered = await mesh.send(toWire(item), blob, {
          onlyDeviceIds: [device.id],
          onProgress: (p) => setProgressFor(item.id, p),
        });
        setProgressFor(item.id, null);
        if (!delivered.length) continue;
        const latest = (await store.get(item.id)) ?? item;
        await persist({ ...latest, status: 'ready', deliveredTo: [...new Set([...(latest.deliveredTo ?? []), ...delivered])] });
      }
    });

    const relayTimer = setInterval(() => setRelay(mesh.relayStatus()), 2000);
    const purgeTimer = setInterval(() => void refresh(), 60_000);

    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('qrls-items');
      channel.current.onmessage = () => void refresh();
    }

    return () => {
      cancelled = true;
      offDevices();
      offProblem();
      offItem();
      offFile();
      offProgress();
      offVerified();
      clearInterval(relayTimer);
      clearInterval(purgeTimer);
      channel.current?.close();
      void mesh.destroy();
    };
  }, []);

  /* ------------------------------ accounts ------------------------------ */

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !ready) return;
    let stale = false;
    (async () => {
      if (!account) return mesh.setAccount(null);
      const session = await accountSession(account);
      if (!stale) await mesh.setAccount(session);
    })().catch((err) => handlersRef.current.onProblem?.(String(err?.message || err)));
    return () => {
      stale = true;
    };
  }, [account, ready]);

  const setAccount = useCallback((acc: Account | null) => {
    saveAccount(acc);
    setAccountState(acc);
  }, []);

  /* ------------------------------- sending ------------------------------- */

  const newItemBase = (retention: Retention) => {
    const now = Date.now();
    return {
      id: randomSecret(12),
      retention,
      from: { id: selfId, name: basics.name, type: basics.type },
      createdAt: new Date(now).toISOString(),
      ...(retention === 'temp' ? { expiresAt: new Date(now + TEMP_TTL_MS).toISOString() } : {}),
    };
  };

  const deliver = async (item: StoredItem, blob?: Blob) => {
    const mesh = meshRef.current;
    if (!mesh) return item;
    const delivered = await mesh.send(toWire(item), blob, { onProgress: (p) => setProgressFor(item.id, p) });
    setProgressFor(item.id, null);
    const latest = (await storeRef.current?.get(item.id)) ?? item;
    const deliveredTo = [...new Set([...(latest.deliveredTo ?? []), ...delivered])];
    const next: StoredItem = { ...latest, status: deliveredTo.length ? 'ready' : 'pending', deliveredTo };
    await persist(next);
    return next;
  };

  /** Shares a link or note. Returns false if there's nothing to send. */
  const sendText = async (raw: string, retention: Retention): Promise<StoredItem | null> => {
    const text = raw.trim();
    if (!text || text.length > MAX_TEXT_CHARS || !selfId) return null;
    const url = toHttpUrl(text);
    const item: StoredItem = {
      ...newItemBase(retention),
      kind: url ? 'link' : 'text',
      ...(url ? { url } : { text: raw.replace(/^\s*\n|\s+$/g, '') }),
      status: 'pending',
      storedAt: Date.now(),
    };
    if (retention === 'saved') void requestPersistentStorage();
    await persist(item);
    return deliver(item);
  };

  /** Shares a file (kept on this device too). */
  const sendFile = async (file: File, retention: Retention): Promise<StoredItem | null> => {
    const store = storeRef.current;
    if (!store || file.size > MAX_FILE_BYTES || file.size === 0 || !selfId) return null;
    const item: StoredItem = {
      ...newItemBase(retention),
      kind: 'file',
      file: { name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' },
      status: 'pending',
      storedAt: Date.now(),
    };
    await store.putBlob(item.id, file);
    if (retention === 'saved') void requestPersistentStorage();
    await persist(item);
    return deliver(item, file);
  };

  /* ---------------------------- managing items ---------------------------- */

  const keepForever = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const { expiresAt: _e, ...rest } = item;
    void requestPersistentStorage();
    await persist({ ...rest, retention: 'saved' });
  };

  const remove = async (id: string) => {
    await storeRef.current?.remove(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    channel.current?.postMessage('changed');
  };

  const removeAll = async (retention: Retention) => {
    for (const i of items.filter((x) => x.retention === retention)) await storeRef.current?.remove(i.id);
    setItems((prev) => prev.filter((i) => i.retention !== retention));
    channel.current?.postMessage('changed');
  };

  const getBlob = useCallback((id: string) => storeRef.current?.getBlob(id) ?? Promise.resolve(undefined), []);

  /** Re-sends an item that is still waiting (e.g. after a failure). */
  const retry = async (id: string) => {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    const blob = item.kind === 'file' ? await storeRef.current?.getBlob(id) : undefined;
    await deliver(item, blob);
  };

  /* -------------------------------- pairing -------------------------------- */

  /** Forgets remembered devices linked by one method (after unpairing or signing out). */
  const forgetDevices = (method: LinkMethod) =>
    updateKnown((k) => Object.fromEntries(Object.entries(k).filter(([, d]) => d.method !== method)));

  const switchGroup = async (secret: string) => {
    saveGroupSecret(secret);
    setGroupSecretState(secret);
    await meshRef.current?.setGroup(secret);
  };

  return {
    ready,
    privateMode,
    persistent: storeRef.current?.persistent ?? !privateMode,
    self: { id: selfId, name: basics.name, type: basics.type } as DeviceInfo,
    items,
    devices,
    knownDevices: Object.values(known).filter((d) => !devices.some((c) => c.id === d.id)),
    forgetDevices,
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
    switchGroup,
    persist,
  };
}

export type P2P = ReturnType<typeof useP2P>;
