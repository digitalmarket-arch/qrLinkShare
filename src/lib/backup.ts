/**
 * Backup file for Saved items. Because nothing is stored on a server, this file
 * is the only copy outside the device: keep it somewhere safe (it isn't encrypted).
 */
import type { StoredItem } from '../types/share';
import type { Store } from './db';
import { isWireItem } from './mesh';

interface BackupFile {
  app: 'qrLinkShare';
  version: 1;
  exportedAt: string;
  items: StoredItem[];
  /** item id -> file contents as a data: URL */
  files: Record<string, string>;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Builds a backup of every Saved item (files included). */
export async function createBackup(store: Store): Promise<Blob> {
  const items = (await store.list()).filter((i) => i.retention === 'saved' && i.status !== 'receiving' && i.status !== 'failed');
  const files: Record<string, string> = {};
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const blob = await store.getBlob(item.id);
    if (blob) files[item.id] = await blobToDataUrl(blob);
  }
  const data: BackupFile = { app: 'qrLinkShare', version: 1, exportedAt: new Date().toISOString(), items, files };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

/** Restores items from a backup file. Items already on this device are skipped. Returns how many were added. */
export async function restoreBackup(store: Store, file: File): Promise<number> {
  let data: BackupFile;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('This is not a qrLinkShare backup file.');
  }
  if (data?.app !== 'qrLinkShare' || data.version !== 1 || !Array.isArray(data.items)) {
    throw new Error('This is not a qrLinkShare backup file.');
  }
  let added = 0;
  for (const raw of data.items) {
    if (!isWireItem(raw) || (await store.get(raw.id))) continue;
    if (raw.kind === 'file') {
      const url = data.files?.[raw.id];
      if (typeof url !== 'string' || !url.startsWith('data:')) continue;
      const blob = await (await fetch(url)).blob();
      await store.putBlob(raw.id, new Blob([blob], { type: raw.file?.mime || blob.type }));
    }
    const { expiresAt: _e, ...rest } = raw as StoredItem;
    await store.put({ ...rest, retention: 'saved', status: 'ready', storedAt: Date.now() });
    added++;
  }
  return added;
}
