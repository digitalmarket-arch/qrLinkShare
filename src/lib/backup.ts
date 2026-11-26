/**
 * Backup file for Saved items. Because nothing is stored on a server, this file
 * is the only copy outside the device: keep it somewhere safe (it isn't encrypted).
 *
 * Version 2 is a standard POSIX "ustar" tar archive, so it also opens with normal
 * tools (tar, 7-Zip, Archive Utility):
 *
 *   qrlinkshare-backup.json   the items, and which entry holds each file
 *   files/<id>-<name>         each file's contents, as they are
 *
 * File contents never pass through JavaScript memory: the archive is put together
 * from the stored Blobs themselves, and restoring stores slices of the chosen file.
 * So a backup with 200 MB files (or gigabytes in total) doesn't crash the tab.
 *
 * Version 1 backups (one JSON file with every file inside as a data: URL) can still
 * be restored, as long as they are small enough to read whole.
 */
import type { FileMeta, StoredItem } from '../types/share';
import type { Store } from './db';
import { isWireItem } from './mesh';

const APP = 'qrLinkShare';
const MANIFEST_PATH = 'qrlinkshare-backup.json';
const BLOCK = 512;
/** Longest path that fits the 100-byte name field with a NUL after it. */
const MAX_PATH_BYTES = 99;
/** Largest value of an 11-digit octal field (8 GiB - 1). */
const MAX_OCTAL_11 = 0o77777777777;
/** Old JSON backups have to be read whole into memory, so only smaller ones are safe. */
const V1_MAX_BYTES = 150 * 1024 * 1024;

const NOT_A_BACKUP = 'This is not a qrLinkShare backup file.';
const DAMAGED = 'This backup file is damaged.';

interface BackupFileEntry {
  /** Path of the archive entry that holds the contents. */
  path: string;
  size: number;
  mime: string;
}

/** qrlinkshare-backup.json */
interface Manifest {
  app: typeof APP;
  version: 2;
  exportedAt: string;
  items: StoredItem[];
  /** item id -> its file's entry */
  files: Record<string, BackupFileEntry>;
}

/** A parsed JSON file before it has been checked. */
type Unchecked = { app?: unknown; version?: unknown; items?: unknown; files?: unknown } | null;

/* --------------------------------- backup ---------------------------------- */

/** Builds a backup of every Saved item (files included) as a .tar archive. */
export async function createBackup(store: Store): Promise<Blob> {
  const now = Date.now();
  const items: StoredItem[] = [];
  const files: Array<[string, BackupFileEntry]> = [];
  const contents: Array<{ path: string; blob: Blob; mtime: number }> = [];
  const usedPaths = new Set([MANIFEST_PATH]);

  for (const item of await store.list()) {
    if (item.retention !== 'saved' || (item.status !== 'ready' && item.status !== 'pending')) continue;
    if (item.kind !== 'file') {
      items.push(item);
      continue;
    }
    const blob = await store.getBlob(item.id);
    if (!blob) continue; // the contents are gone: leave the item out rather than restore a broken file
    const name = item.file?.name ?? 'file';
    const mime = item.file?.mime || blob.type;
    const path = entryPath(item.id, name, usedPaths);
    // The archive holds the stored bytes, so describe those (restore checks that the sizes match).
    items.push(item.file?.size === blob.size ? item : { ...item, file: { name, size: blob.size, mime } });
    files.push([item.id, { path, size: blob.size, mime }]);
    contents.push({ path, blob, mtime: tarTime(Date.parse(item.createdAt)) });
  }

  const manifest: Manifest = {
    app: APP,
    version: 2,
    exportedAt: new Date(now).toISOString(),
    items,
    files: Object.fromEntries(files),
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  // Headers and padding are small byte arrays; the stored Blobs go in as they are, uncopied.
  const parts: BlobPart[] = [];
  const addEntry = (path: string, size: number, mtime: number, data: BlobPart) => {
    parts.push(tarHeader(path, size, mtime), data);
    if (size % BLOCK) parts.push(new Uint8Array(BLOCK - (size % BLOCK)));
  };
  addEntry(MANIFEST_PATH, json.byteLength, tarTime(now), json);
  for (const c of contents) addEntry(c.path, c.blob.size, c.mtime, c.blob);
  parts.push(new Uint8Array(2 * BLOCK)); // end of archive
  return new Blob(parts, { type: 'application/x-tar' });
}

/**
 * "files/<id>-<name>", ASCII only and at most 99 bytes. Characters other than
 * letters, digits, "." "_" and "-" become "_"; a long name keeps its extension.
 */
function entryPath(id: string, name: string, used: Set<string>): string {
  const safeId = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const safeName = name.replace(/[^A-Za-z0-9._-]/gu, '_') || 'file';
  for (let n = 1; ; n++) {
    // Item ids are unique, so the counter is only a safety net against odd ids.
    const prefix = n === 1 ? `files/${safeId}-` : `files/${safeId}-${n}-`;
    const path = prefix + shorten(safeName, MAX_PATH_BYTES - prefix.length);
    if (!used.has(path)) {
      used.add(path);
      return path;
    }
  }
}

/** Cuts a name down to `room` characters, keeping a short extension such as ".pdf". */
function shorten(name: string, room: number): string {
  if (name.length <= room) return name;
  const dot = name.lastIndexOf('.');
  const extLength = name.length - dot;
  const ext = dot > 0 && extLength <= 16 && extLength < room ? name.slice(dot) : '';
  return name.slice(0, room - ext.length) + ext;
}

/** Seconds since 1970 for a header (now, if the date is unusable). */
function tarTime(ms: number): number {
  const t = Number.isFinite(ms) ? ms : Date.now();
  return Math.min(MAX_OCTAL_11, Math.max(0, Math.floor(t / 1000)));
}

const octal = (n: number, digits: number) => n.toString(8).padStart(digits, '0');

/** A 512-byte ustar header for a regular file. `path` must be ASCII and at most 99 bytes. */
function tarHeader(path: string, size: number, mtime: number): Uint8Array {
  if (size > MAX_OCTAL_11) throw new Error('A file is too big to back up.');
  const h = new Uint8Array(BLOCK);
  const put = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) h[offset + i] = text.charCodeAt(i);
  };
  put(0, path); // the rest of the name field stays NUL
  put(100, '0000644\0'); // mode: rw-r--r--
  put(108, '0000000\0'); // uid
  put(116, '0000000\0'); // gid
  put(124, `${octal(size, 11)}\0`);
  put(136, `${octal(mtime, 11)}\0`);
  put(148, '        '); // checksum: counted as spaces while summing
  put(156, '0'); // typeflag: regular file
  // linkname (157) stays empty
  put(257, 'ustar\0');
  put(263, '00');
  put(265, 'qrlinkshare'); // uname
  put(297, 'qrlinkshare'); // gname
  // devmajor/devminor (329, 337) and prefix (345) stay empty, as GNU tar leaves them for files
  put(148, `${octal(h.reduce((sum, b) => sum + b, 0), 6)}\0 `);
  return h;
}

/* --------------------------------- restore --------------------------------- */

/** Restores items from a backup file. Items already on this device are skipped. Returns how many were added. */
export async function restoreBackup(store: Store, file: Blob): Promise<number> {
  const head = new Uint8Array(await file.slice(0, BLOCK).arrayBuffer());
  if (ascii(head, 257, 5) === 'ustar') return restoreTar(store, file);
  if (looksLikeJson(head)) return restoreV1(store, file);
  throw new Error(NOT_A_BACKUP);
}

async function restoreTar(store: Store, file: Blob): Promise<number> {
  const entries = await readTarIndex(file);
  const m = entries.get(MANIFEST_PATH);
  if (!m) throw new Error(DAMAGED);
  let manifest: Unchecked;
  try {
    manifest = JSON.parse(await file.slice(m.offset, m.offset + m.size).text());
  } catch {
    throw new Error(DAMAGED);
  }
  if (manifest?.app !== APP) throw new Error(NOT_A_BACKUP);
  if (manifest.version !== 2) {
    const newer = typeof manifest.version === 'number' && manifest.version > 2;
    throw new Error(newer ? 'This backup was made by a newer version of qrLinkShare.' : NOT_A_BACKUP);
  }
  if (!Array.isArray(manifest.items)) throw new Error(DAMAGED);
  const files = (isObject(manifest.files) ? manifest.files : {}) as Record<string, Partial<BackupFileEntry> | undefined>;

  return addItems(store, manifest.items, async (id, meta) => {
    const ref = hasOwn(files, id) ? files[id] : undefined;
    const entry = typeof ref?.path === 'string' ? entries.get(ref.path) : undefined;
    if (!entry || entry.size !== meta.size) return undefined;
    const mime = meta.mime || (typeof ref?.mime === 'string' ? ref.mime : '');
    return file.slice(entry.offset, entry.offset + entry.size, mime);
  });
}

/** Version 1: { app, version: 1, exportedAt, items, files: { [item id]: data: URL } } */
async function restoreV1(store: Store, file: Blob): Promise<number> {
  if (file.size > V1_MAX_BYTES) throw new Error('This old-style backup is too big to restore in the browser.');
  let data: Unchecked;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  if (data?.app === APP && data.version === 2) {
    throw new Error('This is only the list of items from inside a backup. Choose the whole .tar backup file instead.');
  }
  if (data?.app !== APP || data.version !== 1 || !Array.isArray(data.items)) throw new Error(NOT_A_BACKUP);
  const files: Record<string, unknown> = isObject(data.files) ? data.files : {};

  return addItems(store, data.items, async (id, meta) => {
    const url = hasOwn(files, id) ? files[id] : undefined;
    if (typeof url !== 'string' || !url.startsWith('data:')) return undefined;
    try {
      const blob = await (await fetch(url)).blob();
      return new Blob([blob], { type: meta.mime || blob.type });
    } catch {
      return undefined; // a broken data: URL loses only that file
    }
  });
}

/**
 * Adds each well-formed item that isn't on this device yet, as a Saved item.
 * `contentsOf` gives a file item's contents, or undefined to skip the item.
 */
async function addItems(
  store: Store,
  raws: unknown[],
  contentsOf: (id: string, meta: FileMeta) => Promise<Blob | undefined>
): Promise<number> {
  let added = 0;
  for (const raw of raws) {
    if (!isWireItem(raw) || (await store.get(raw.id))) continue;
    let blob: Blob | undefined;
    if (raw.kind === 'file') {
      blob = raw.file ? await contentsOf(raw.id, raw.file) : undefined;
      if (!blob) continue;
    }
    const { expiresAt: _e, deliveredTo: _d, ...rest } = raw as StoredItem;
    try {
      if (blob) await store.putBlob(raw.id, blob);
      await store.put({ ...rest, retention: 'saved', status: 'ready', storedAt: Date.now() });
    } catch (err) {
      await store.remove(raw.id).catch(() => undefined); // don't leave file contents without their item
      const full = (err as { name?: unknown } | null)?.name === 'QuotaExceededError';
      const sofar = added ? ` ${added} item${added === 1 ? ' was' : 's were'} restored before that.` : '';
      const what = full ? 'This device ran out of storage space.' : 'Could not save the restored items on this device.';
      throw new Error(what + sofar, { cause: err });
    }
    added++;
  }
  return added;
}

/* ------------------------------- tar reading ------------------------------- */

interface TarEntry {
  /** Where the contents start in the file. */
  offset: number;
  size: number;
}

/**
 * Finds every regular file in the archive by reading only the 512-byte headers.
 * Throws if any header is damaged or the archive is cut short.
 */
async function readTarIndex(file: Blob): Promise<Map<string, TarEntry>> {
  const entries = new Map<string, TarEntry>();
  for (let pos = 0; pos < file.size; ) {
    if (pos + BLOCK > file.size) throw new Error(DAMAGED);
    const h = new Uint8Array(await file.slice(pos, pos + BLOCK).arrayBuffer());
    if (h.every((b) => b === 0)) break; // end of archive
    const size = readOctal(h, 124, 12);
    const offset = pos + BLOCK;
    if (!checksumOk(h) || Number.isNaN(size) || offset + size > file.size) throw new Error(DAMAGED);
    const type = h[156];
    if (type === 0x30 || type === 0) entries.set(entryName(h), { offset, size }); // '0' (NUL in old tars): a file
    pos = offset + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

/** The checksum is the sum of all header bytes, with its own 8 bytes counted as spaces. */
function checksumOk(h: Uint8Array): boolean {
  let unsigned = 0;
  let signed = 0; // some old tools summed signed bytes
  for (let i = 0; i < BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i];
    unsigned += b;
    signed += b < 128 ? b : b - 256;
  }
  const stored = readOctal(h, 148, 8);
  return stored === unsigned || stored === signed;
}

/** An octal number field (up to a NUL, spaces allowed around it): 0 if empty, NaN if invalid. */
function readOctal(h: Uint8Array, offset: number, length: number): number {
  const text = cString(h, offset, length).trim();
  if (!text) return 0;
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
}

function entryName(h: Uint8Array): string {
  const name = cString(h, 0, 100);
  // POSIX ustar can split long paths into prefix + name; old GNU tars use that space for other things.
  const prefix = ascii(h, 257, 6) === 'ustar\0' ? cString(h, 345, 155) : '';
  return (prefix ? `${prefix}/${name}` : name).replace(/^(?:\.\/)+/, '');
}

/** A text field that ends at the first NUL. */
function cString(h: Uint8Array, offset: number, length: number): string {
  const field = h.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

const ascii = (h: Uint8Array, offset: number, length: number) => String.fromCharCode(...h.subarray(offset, offset + length));

/** Old backups are JSON: "{" after an optional byte order mark and whitespace. */
function looksLikeJson(head: Uint8Array): boolean {
  let i = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d) i++;
  return head[i] === 0x7b;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

const hasOwn = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
