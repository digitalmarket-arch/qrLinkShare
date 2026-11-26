/**
 * Storage on this device only (IndexedDB = the browser's built-in database).
 *
 * - items: links, notes and file details
 * - blobs: the file contents
 *
 * In "keep nothing on this computer" mode, the same interface is backed by memory
 * and everything disappears when the tab is closed.
 */
import type { StoredItem } from '../types/share';

export interface Store {
  /** True when items survive closing the tab (IndexedDB); false for the memory store. */
  readonly persistent: boolean;
  list(): Promise<StoredItem[]>;
  get(id: string): Promise<StoredItem | undefined>;
  put(item: StoredItem): Promise<void>;
  /**
   * Changes an item only if it still exists, in one step (so a delete happening at the
   * same moment can't be undone by this write). `fn` returns the new item, or null for
   * "no change". Resolves with the stored item, or undefined if it's gone.
   */
  update(id: string, fn: (item: StoredItem) => StoredItem | null): Promise<StoredItem | undefined>;
  getBlob(id: string): Promise<Blob | undefined>;
  putBlob(id: string, blob: Blob): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes temporary items whose time is up. Returns their ids. */
  purgeExpired(now?: number): Promise<string[]>;
  clear(): Promise<void>;
}

const isExpired = (item: StoredItem, now: number) =>
  item.retention === 'temp' && !!item.expiresAt && new Date(item.expiresAt).getTime() <= now;

/* --------------------------------- memory ---------------------------------- */

export function createMemoryStore(): Store {
  const items = new Map<string, StoredItem>();
  const blobs = new Map<string, Blob>();
  return {
    persistent: false,
    list: async () => [...items.values()],
    get: async (id) => items.get(id),
    put: async (item) => void items.set(item.id, { ...item }),
    update: async (id, fn) => {
      const cur = items.get(id);
      if (!cur) return undefined;
      const next = fn({ ...cur });
      if (!next) return cur;
      items.set(id, { ...next });
      return next;
    },
    getBlob: async (id) => blobs.get(id),
    putBlob: async (id, blob) => void blobs.set(id, blob),
    remove: async (id) => {
      items.delete(id);
      blobs.delete(id);
    },
    purgeExpired: async (now = Date.now()) => {
      const gone = [...items.values()].filter((i) => isExpired(i, now)).map((i) => i.id);
      for (const id of gone) {
        items.delete(id);
        blobs.delete(id);
      }
      return gone;
    },
    clear: async () => {
      items.clear();
      blobs.clear();
    },
  };
}

/* -------------------------------- IndexedDB -------------------------------- */

const DB_NAME = 'qrlinkshare';
const DB_VERSION = 1;

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Storage is busy in another tab.'));
  });
}

/** Older Safari versions can't store Blobs in IndexedDB; store the bytes instead. */
type BlobRecord = Blob | { bytes: ArrayBuffer; type: string };

async function idbStore(): Promise<Store> {
  const db = await openDb();
  // Another tab is deleting the database (it switched to "keep nothing"): let go of it.
  db.onversionchange = () => db.close();
  const run = async <T>(stores: string[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T> | T): Promise<T> => {
    const tx = db.transaction(stores, mode);
    const done = txDone(tx);
    const result = await fn(tx);
    await done;
    return result;
  };

  const store: Store = {
    persistent: true,
    list: () => run(['items'], 'readonly', (tx) => promisify(tx.objectStore('items').getAll() as IDBRequest<StoredItem[]>)),
    get: (id) => run(['items'], 'readonly', (tx) => promisify(tx.objectStore('items').get(id) as IDBRequest<StoredItem | undefined>)),
    put: (item) => run(['items'], 'readwrite', (tx) => void tx.objectStore('items').put(item)),
    update: (id, fn) =>
      run(['items'], 'readwrite', (tx) => {
        const os = tx.objectStore('items');
        // Read and write inside the same transaction: nothing can run in between.
        return new Promise<StoredItem | undefined>((resolve, reject) => {
          const req = os.get(id) as IDBRequest<StoredItem | undefined>;
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve(undefined);
            const next = fn(cur);
            if (!next) return resolve(cur);
            os.put(next);
            resolve(next);
          };
          req.onerror = () => reject(req.error);
        });
      }),
    getBlob: async (id) => {
      const rec = await run(['blobs'], 'readonly', (tx) => promisify(tx.objectStore('blobs').get(id) as IDBRequest<BlobRecord | undefined>));
      if (!rec) return undefined;
      return rec instanceof Blob ? rec : new Blob([rec.bytes], { type: rec.type });
    },
    putBlob: async (id, blob) => {
      try {
        await run(['blobs'], 'readwrite', (tx) => void tx.objectStore('blobs').put(blob, id));
      } catch {
        const bytes = await blob.arrayBuffer();
        await run(['blobs'], 'readwrite', (tx) => void tx.objectStore('blobs').put({ bytes, type: blob.type } satisfies BlobRecord, id));
      }
    },
    remove: (id) =>
      run(['items', 'blobs'], 'readwrite', (tx) => {
        tx.objectStore('items').delete(id);
        tx.objectStore('blobs').delete(id);
      }),
    purgeExpired: async (now = Date.now()) => {
      const gone = (await store.list()).filter((i) => isExpired(i, now)).map((i) => i.id);
      if (gone.length) {
        await run(['items', 'blobs'], 'readwrite', (tx) => {
          for (const id of gone) {
            tx.objectStore('items').delete(id);
            tx.objectStore('blobs').delete(id);
          }
        });
      }
      return gone;
    },
    clear: () =>
      run(['items', 'blobs'], 'readwrite', (tx) => {
        tx.objectStore('items').clear();
        tx.objectStore('blobs').clear();
      }),
  };
  return store;
}

/** Opens on-device storage, falling back to memory if the browser blocks it (e.g. some private windows). */
export async function openStore(privateMode: boolean): Promise<Store> {
  if (privateMode || typeof indexedDB === 'undefined') return createMemoryStore();
  try {
    return await idbStore();
  } catch {
    return createMemoryStore();
  }
}

/** Deletes this app's whole on-device database (used when switching to "keep nothing"). */
export function deleteDatabase(): Promise<void> {
  return deleteNamedDatabase(DB_NAME);
}

/** Deletes one IndexedDB database by name; waits up to a few seconds if another tab still has it open. */
export function deleteNamedDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve();
      const req = indexedDB.deleteDatabase(name);
      const timer = setTimeout(resolve, 4000); // blocked by an open tab: it is told to close and the delete finishes later
      req.onsuccess = req.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
    } catch {
      resolve();
    }
  });
}

/** Whether the browser has promised not to clear our data when space runs low (null = can't tell). */
export async function isPersisted(): Promise<boolean | null> {
  try {
    const fn = navigator.storage?.persisted;
    return fn ? await fn.call(navigator.storage) : null;
  } catch {
    return null;
  }
}

/** Asks the browser not to clear our data when space runs low (best effort). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate(): Promise<{ used: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
