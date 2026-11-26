/**
 * Backups: the .tar format (checked with the system `tar` too), which items go in,
 * restoring only what's new, old JSON backups, damaged files, and that file
 * contents are never read into memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup } from './backup';
import { createMemoryStore, type Store } from './db';
import type { StoredItem } from '../types/share';

const CREATED_AT = '2025-06-01T10:00:00.000Z';
const NOT_A_BACKUP = { message: 'This is not a qrLinkShare backup file.' };
const DAMAGED = { message: 'This backup file is damaged.' };

const base = (id: string, over: Partial<StoredItem>): StoredItem => ({
  id,
  kind: 'text',
  retention: 'saved',
  from: { id: 'device-laptop', name: 'Laptop', type: 'desktop' },
  createdAt: CREATED_AT,
  status: 'ready',
  storedAt: 1,
  ...over,
});
const textItem = (id: string, text: string, over: Partial<StoredItem> = {}) => base(id, { kind: 'text', text, ...over });
const linkItem = (id: string, url: string, over: Partial<StoredItem> = {}) => base(id, { kind: 'link', url, ...over });
const fileItem = (id: string, name: string, bytes: Uint8Array, mime: string, over: Partial<StoredItem> = {}) =>
  base(id, { kind: 'file', file: { name, size: bytes.byteLength, mime }, ...over });

/** Stores an item, and its file contents when given. */
async function add(store: Store, item: StoredItem, bytes?: Uint8Array) {
  await store.put(item);
  if (bytes) await store.putBlob(item.id, new Blob([bytes], { type: item.file?.mime }));
}

const random = (n: number) => new Uint8Array(randomBytes(n));
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b);
async function bytesOf(blob: Blob | undefined): Promise<Uint8Array> {
  assert.ok(blob, 'expected file contents');
  return new Uint8Array(await blob.arrayBuffer());
}

interface Entry {
  name: string;
  size: number;
  header: Uint8Array;
  headerOffset: number;
  /** Where the contents start. */
  offset: number;
  data: Uint8Array;
}

/** A minimal tar reader, separate from backup.ts, for looking inside archives. */
async function untar(archive: Blob): Promise<Entry[]> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const entries: Entry[] = [];
  for (let pos = 0; pos + 512 <= bytes.length; ) {
    const header = bytes.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const field = (o: number, n: number) => new TextDecoder().decode(header.subarray(o, o + n)).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12), 8);
    const offset = pos + 512;
    entries.push({ name: field(0, 100), size, header, headerOffset: pos, offset, data: bytes.subarray(offset, offset + size) });
    pos = offset + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function manifestOf(archive: Blob) {
  const [first] = await untar(archive);
  assert.equal(first.name, 'qrlinkshare-backup.json');
  return JSON.parse(new TextDecoder().decode(first.data));
}

test('round trip: notes, links and files (non-ASCII names too) come back as Saved, bytes identical', async () => {
  const pdf = random(70_001);
  const photo = random(512); // exactly one block, so no padding
  const doc = random(3);
  const note = textItem('note00000001', 'Remember the milk\nदूध भी 👋');
  const link = linkItem('link00000001', 'https://example.com/a?b=1', { status: 'pending', deliveredTo: [] });
  const report = fileItem('file00000001', 'रिपोर्ट 2026.pdf', pdf, 'application/pdf', { deliveredTo: ['device-phone'] });
  const img = fileItem('file00000002', 'IMG 0001.jpg', photo, 'image/jpeg');
  const longDoc = fileItem('file00000003', `${'very long name '.repeat(10)}.docx`, doc, 'application/msword');
  const a = createMemoryStore();
  await add(a, note);
  await add(a, link);
  await add(a, report, pdf);
  await add(a, img, photo);
  await add(a, longDoc, doc);

  const backup = await createBackup(a);
  assert.equal(backup.type, 'application/x-tar');
  assert.equal(backup.size % 512, 0);

  // Paths in the archive are ASCII, at most 99 bytes, and keep the extension.
  const manifest = await manifestOf(backup);
  assert.equal(manifest.files[report.id].path, 'files/file00000001-________2026.pdf');
  assert.equal(manifest.files[img.id].path, 'files/file00000002-IMG_0001.jpg');
  const longPath: string = manifest.files[longDoc.id].path;
  assert.equal(longPath.length, 99);
  assert.ok(longPath.startsWith('files/file00000003-very_long_name_very_long_name_'), longPath);
  assert.ok(longPath.endsWith('.docx'), longPath);
  assert.deepEqual(
    (await untar(backup)).map((e) => e.name),
    ['qrlinkshare-backup.json', manifest.files[report.id].path, manifest.files[img.id].path, longPath]
  );

  const b = createMemoryStore();
  assert.equal(await restoreBackup(b, new File([backup], 'qrlinkshare-backup.tar')), 5);
  for (const original of [note, link, report, img, longDoc]) {
    const restored = await b.get(original.id);
    assert.ok(restored, original.id);
    const { storedAt, ...rest } = restored;
    const { storedAt: _s, deliveredTo: _d, ...expected } = original;
    assert.deepEqual(rest, { ...expected, status: 'ready' });
    assert.ok(storedAt > 1);
  }
  assert.equal((await b.get(report.id))?.file?.name, 'रिपोर्ट 2026.pdf'); // the item keeps its real name
  for (const [item, bytes] of [[report, pdf], [img, photo], [longDoc, doc]] as const) {
    const blob = await b.getBlob(item.id);
    assert.equal(blob?.type, item.file?.mime);
    assert.ok(sameBytes(await bytesOf(blob), bytes), `${item.id} bytes differ`);
  }
});

test('only Saved items that are ready or pending go into the backup', async () => {
  const bytes = random(10);
  const later = '2025-06-02T10:00:00.000Z';
  const store = createMemoryStore();
  await add(store, textItem('saved0ready', 'keep me'));
  await add(store, linkItem('saved0pending', 'https://example.com/', { status: 'pending' }));
  await add(store, fileItem('savedfile001', 'd.bin', bytes, 'application/octet-stream'), bytes);
  await add(store, textItem('temp00000001', 'not me', { retention: 'temp', expiresAt: later }));
  await add(store, fileItem('temp00000002', 'a.bin', bytes, 'application/octet-stream', { retention: 'temp', expiresAt: later }), bytes);
  await add(store, fileItem('receiving001', 'b.bin', bytes, 'application/octet-stream', { status: 'receiving' }), bytes);
  await add(store, fileItem('failed000001', 'c.bin', bytes, 'application/octet-stream', { status: 'failed' }), bytes);

  const backup = await createBackup(store);
  assert.deepEqual(
    (await untar(backup)).map((e) => e.name),
    ['qrlinkshare-backup.json', 'files/savedfile001-d.bin']
  );
  const manifest = await manifestOf(backup);
  assert.equal(manifest.app, 'qrLinkShare');
  assert.equal(manifest.version, 2);
  assert.ok(!Number.isNaN(Date.parse(manifest.exportedAt)));
  assert.deepEqual(
    manifest.items.map((i: StoredItem) => i.id),
    ['saved0ready', 'saved0pending', 'savedfile001']
  );
  assert.deepEqual(manifest.files, { savedfile001: { path: 'files/savedfile001-d.bin', size: 10, mime: 'application/octet-stream' } });
});

test('a file whose contents are missing is left out; a wrong recorded size is corrected', async () => {
  const bytes = random(10);
  const store = createMemoryStore();
  await add(store, textItem('note00000001', 'hi'));
  await add(store, fileItem('lost00000001', 'gone.pdf', random(100), 'application/pdf')); // no contents stored
  await add(store, { ...fileItem('odd000000001', 'odd.bin', bytes, 'application/octet-stream'), file: { name: 'odd.bin', size: 999, mime: 'application/octet-stream' } }, bytes);

  const backup = await createBackup(store);
  const manifest = await manifestOf(backup);
  assert.deepEqual(manifest.items.map((i: StoredItem) => i.id), ['note00000001', 'odd000000001']);
  assert.deepEqual(Object.keys(manifest.files), ['odd000000001']);
  assert.equal(manifest.items[1].file.size, 10); // describes the bytes that are really in the archive

  const other = createMemoryStore();
  assert.equal(await restoreBackup(other, backup), 2);
  assert.equal(await other.get('lost00000001'), undefined);
  assert.ok(sameBytes(await bytesOf(await other.getBlob('odd000000001')), bytes));
});

test('restore adds only items that are not on this device yet, and counts them', async () => {
  const bytes = random(1234);
  const a = createMemoryStore();
  await add(a, textItem('note00000001', 'from the backup'));
  await add(a, linkItem('link00000001', 'https://example.com/'));
  await add(a, fileItem('file00000001', 'a.txt', bytes, 'text/plain'), bytes);
  const backup = await createBackup(a);

  const b = createMemoryStore();
  await add(b, textItem('note00000001', 'already here'));
  assert.equal(await restoreBackup(b, backup), 2);
  assert.equal((await b.get('note00000001'))?.text, 'already here');
  assert.equal((await b.list()).length, 3);
  assert.equal(await restoreBackup(b, backup), 0); // nothing new the second time
});

test('restore skips a file whose entry is missing or has the wrong size', async () => {
  const one = random(700);
  const two = random(800);
  const a = createMemoryStore();
  await add(a, fileItem('file00000001', 'one.bin', one, 'application/octet-stream'), one);
  await add(a, fileItem('file00000002', 'two.bin', two, 'application/octet-stream'), two);
  await add(a, textItem('note00000001', 'still fine'));
  const bytes = new Uint8Array(await (await createBackup(a)).arrayBuffer());

  // Same-length edits inside the manifest, so every header (and its checksum) stays valid.
  const [m] = await untar(new Blob([bytes]));
  const before = new TextDecoder().decode(m.data);
  const after = before
    .replace('"size": 700,', '"size": 701,') // the first match is in the item: it now claims another size
    .replace('"files/file00000002-two.bin"', '"files/file00000002-two.bix"'); // no such entry
  assert.ok(after.includes('"size": 701,') && after.includes('two.bix'));
  bytes.set(new TextEncoder().encode(after), m.offset);

  const b = createMemoryStore();
  assert.equal(await restoreBackup(b, new Blob([bytes])), 1);
  assert.deepEqual((await b.list()).map((i) => i.id), ['note00000001']);
});

test('when the device runs out of space, restore says so and leaves no half-saved file', async () => {
  const bytes = random(100);
  const a = createMemoryStore();
  await add(a, textItem('note00000001', 'first'));
  await add(a, fileItem('file00000001', 'a.bin', bytes, 'application/octet-stream'), bytes);
  const backup = await createBackup(a);

  const inner = createMemoryStore();
  const full: Store = {
    ...inner,
    put: async (item) => {
      if (item.kind === 'file') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return inner.put(item);
    },
  };
  await assert.rejects(restoreBackup(full, backup), { message: 'This device ran out of storage space. 1 item was restored before that.' });
  assert.deepEqual((await inner.list()).map((i) => i.id), ['note00000001']);
  assert.equal(await inner.getBlob('file00000001'), undefined); // its contents were removed again
});

test('old JSON backups (version 1) still restore; very big ones are refused', async () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4 from an old backup');
  const pdf = fileItem('file00000001', 'old.pdf', pdfBytes, 'application/pdf');
  const v1 = {
    app: 'qrLinkShare',
    version: 1,
    exportedAt: '2025-10-01T00:00:00.000Z',
    items: [
      textItem('note00000001', 'old note', { retention: 'temp', expiresAt: '2025-10-02T00:00:00.000Z' }),
      pdf,
      fileItem('file00000002', 'no-contents.bin', random(5), 'application/octet-stream'),
      { not: 'an item' },
    ],
    files: { [pdf.id]: `data:application/pdf;base64,${Buffer.from(pdfBytes).toString('base64')}` },
  };
  const store = createMemoryStore();
  const file = new File(['﻿\n  ', JSON.stringify(v1)], 'qrlinkshare-backup-2025-10-01.json', { type: 'application/json' });
  assert.equal(await restoreBackup(store, file), 2);
  const note = await store.get('note00000001');
  assert.equal(note?.retention, 'saved');
  assert.equal(note?.status, 'ready');
  assert.equal(note?.expiresAt, undefined);
  const blob = await store.getBlob(pdf.id);
  assert.equal(blob?.type, 'application/pdf');
  assert.ok(sameBytes(await bytesOf(blob), pdfBytes));

  // Old backups have to be read whole, so huge ones are refused instead of crashing the tab.
  const mb = new Blob([new Uint8Array(1024 * 1024)]); // repeated by reference: no 151 MB in memory
  const huge = new Blob(['{"app":"qrLinkShare","version":1,"items":[],"files":{"x":"', ...Array<Blob>(151).fill(mb), '"}}']);
  await assert.rejects(restoreBackup(createMemoryStore(), huge), { message: 'This old-style backup is too big to restore in the browser.' });
});

test('garbage, damaged and cut-off files are rejected with a clear message, and nothing is added', async () => {
  const store = createMemoryStore();
  await assert.rejects(restoreBackup(store, new Blob([])), NOT_A_BACKUP);
  await assert.rejects(restoreBackup(store, new Blob(['PK\u0003\u0004 this is a zip file'])), NOT_A_BACKUP);
  await assert.rejects(restoreBackup(store, new Blob([new Uint8Array(4096).fill(0xa5)])), NOT_A_BACKUP);
  await assert.rejects(restoreBackup(store, new Blob(['{"hello": "world"}'])), NOT_A_BACKUP);
  await assert.rejects(restoreBackup(store, new Blob(['{ not json'])), NOT_A_BACKUP);

  const bytes = random(5000);
  const a = createMemoryStore();
  await add(a, textItem('note00000001', 'hi'));
  await add(a, fileItem('file00000001', 'a.bin', bytes, 'application/octet-stream'), bytes);
  const good = new Uint8Array(await (await createBackup(a)).arrayBuffer());
  const [, fileEntry] = await untar(new Blob([good]));
  const flipped = (offset: number) => {
    const copy = good.slice();
    copy[offset] ^= 0x01;
    return new Blob([copy]);
  };
  await assert.rejects(restoreBackup(store, flipped(149)), DAMAGED); // the first header's checksum
  await assert.rejects(restoreBackup(store, flipped(0)), DAMAGED); // the first header's name
  await assert.rejects(restoreBackup(store, flipped(fileEntry.headerOffset + 130)), DAMAGED); // the file's size
  await assert.rejects(restoreBackup(store, new Blob([good.subarray(0, good.length - 3000)])), DAMAGED); // cut off
  await assert.rejects(restoreBackup(store, new Blob([good.subarray(0, 300)])), DAMAGED); // cut inside a header
  assert.equal((await store.list()).length, 0);
});

test('every header follows the ustar layout, and the archive ends with two zero blocks', async () => {
  const bytes = random(1000);
  const store = createMemoryStore();
  await add(store, fileItem('file00000001', 'a.bin', bytes, 'application/octet-stream'), bytes);
  const backup = await createBackup(store);
  const entries = await untar(backup);
  assert.equal(entries.length, 2);
  for (const { header: h, size } of entries) {
    const field = (o: number, n: number) => String.fromCharCode(...h.subarray(o, o + n));
    assert.equal(field(100, 8), '0000644\0');
    assert.equal(field(108, 8), '0000000\0');
    assert.equal(field(116, 8), '0000000\0');
    assert.equal(field(124, 12), `${size.toString(8).padStart(11, '0')}\0`);
    assert.match(field(136, 12), /^[0-7]{11}\0$/);
    assert.match(field(148, 8), /^[0-7]{6}\0 $/);
    const sum = h.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 0x20 : b), 0);
    assert.equal(parseInt(field(148, 6), 8), sum);
    assert.equal(field(156, 1), '0');
    assert.equal(field(157, 100), '\0'.repeat(100));
    assert.equal(field(257, 8), 'ustar\u000000');
    assert.equal(field(265, 12), 'qrlinkshare\0');
    assert.equal(field(297, 12), 'qrlinkshare\0');
    assert.equal(field(345, 155), '\0'.repeat(155));
  }
  assert.equal(parseInt(String.fromCharCode(...entries[1].header.subarray(136, 147)), 8), Date.parse(CREATED_AT) / 1000);
  const all = new Uint8Array(await backup.arrayBuffer());
  assert.equal(all.length, entries[1].offset + 1024 + 1024); // 1000 bytes padded to 1024, then the end blocks
  assert.ok(all.subarray(-1024).every((b) => b === 0));
});

const tarVersion = spawnSync('tar', ['--version']);
const hasTar = !tarVersion.error && tarVersion.status === 0;

test('the system tar lists and unpacks a backup, and a re-packed one restores', { skip: !hasTar && 'tar is not installed' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'qrlinkshare-backup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdf = random(70_001);
  const photo = random(512);
  const store = createMemoryStore();
  await add(store, textItem('note00000001', 'hello'));
  await add(store, fileItem('file00000001', 'रिपोर्ट 2026.pdf', pdf, 'application/pdf'), pdf);
  await add(store, fileItem('file00000002', 'IMG 0001.jpg', photo, 'image/jpeg'), photo);
  const backup = await createBackup(store);
  const archive = join(dir, 'backup.tar');
  writeFileSync(archive, new Uint8Array(await backup.arrayBuffer()));

  const list = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stderr, '');
  const expected: Array<[string, number]> = [
    ['qrlinkshare-backup.json', (await untar(backup))[0].size],
    ['files/file00000001-________2026.pdf', pdf.length],
    ['files/file00000002-IMG_0001.jpg', photo.length],
  ];
  const lines = list.stdout.trim().split('\n');
  assert.equal(lines.length, expected.length, list.stdout);
  lines.forEach((line, i) => {
    const columns = line.trim().split(/\s+/);
    assert.ok(line.startsWith('-rw-r--r--'), line);
    assert.equal(columns.at(-1), expected[i][0]);
    assert.ok(columns.includes(String(expected[i][1])), `size ${expected[i][1]} missing in: ${line}`);
  });

  const out = join(dir, 'unpacked');
  mkdirSync(out);
  const unpack = spawnSync('tar', ['-xf', archive, '-C', out], { encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  assert.ok(sameBytes(readFileSync(join(out, 'files/file00000001-________2026.pdf')), pdf));
  assert.ok(sameBytes(readFileSync(join(out, 'files/file00000002-IMG_0001.jpg')), photo));
  assert.equal(JSON.parse(readFileSync(join(out, 'qrlinkshare-backup.json'), 'utf8')).items.length, 3);

  // Packed again with the system tar (its own format, "./" paths, folder entries): still restores.
  const repacked = join(dir, 'repacked.tar');
  assert.equal(spawnSync('tar', ['-cf', repacked, '-C', out, '.']).status, 0);
  const restored = createMemoryStore();
  assert.equal(await restoreBackup(restored, new Blob([readFileSync(repacked)])), 3);
  assert.ok(sameBytes(await bytesOf(await restored.getBlob('file00000001')), pdf));

  // A tar without the item list isn't usable.
  const filesOnly = join(dir, 'files-only.tar');
  assert.equal(spawnSync('tar', ['-cf', filesOnly, '-C', out, 'files']).status, 0);
  await assert.rejects(restoreBackup(createMemoryStore(), new Blob([readFileSync(filesOnly)])), DAMAGED);
});

test('a 5 MB random file round-trips byte for byte', async () => {
  const bytes = random(5 * 1024 * 1024);
  const a = createMemoryStore();
  await add(a, fileItem('big000000001', 'video.mp4', bytes, 'video/mp4'), bytes);
  const backup = await createBackup(a);
  const b = createMemoryStore();
  assert.equal(await restoreBackup(b, backup), 1);
  const blob = await b.getBlob('big000000001');
  assert.equal(blob?.size, bytes.length);
  assert.equal(blob?.type, 'video/mp4');
  assert.ok(sameBytes(await bytesOf(blob), bytes));
});

/** Wraps a Blob and notes how many bytes are read at once from it (or from any slice of it). */
function watched(blob: Blob, reads: number[]): Blob {
  return new (class extends Blob {
    slice(start?: number, end?: number, type?: string) {
      return watched(blob.slice(start, end, type), reads);
    }
    arrayBuffer() {
      reads.push(blob.size);
      return blob.arrayBuffer();
    }
    text() {
      reads.push(blob.size);
      return blob.text();
    }
    stream() {
      reads.push(blob.size);
      return blob.stream();
    }
  })([blob], { type: blob.type });
}

test('backup and restore never read file contents into memory', async () => {
  const bytes = random(300_000);
  const reads: number[] = [];
  const a = createMemoryStore();
  await a.put(fileItem('file00000001', 'big.bin', bytes, 'application/octet-stream'));
  await a.putBlob('file00000001', watched(new Blob([bytes]), reads));
  const backup = await createBackup(a);
  assert.deepEqual(reads, []); // the stored Blob went into the archive unread

  const manifestSize = (await untar(backup))[0].size;
  const b = createMemoryStore();
  assert.equal(await restoreBackup(b, watched(backup, reads)), 1);
  assert.ok(reads.length > 0);
  // Only headers (512 bytes) and the item list were read; the file went into storage as a slice.
  assert.ok(Math.max(...reads) <= Math.max(512, manifestSize), `read ${Math.max(...reads)} bytes at once`);
  assert.ok(sameBytes(await bytesOf(await b.getBlob('file00000001')), bytes));
});
