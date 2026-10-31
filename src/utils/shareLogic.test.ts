import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRoomCode,
  detectItemCategory,
  validateShareSubmission,
  formatBytes,
  buildPairingUrl,
  buildItemDirectSharePayload,
  filterAndSortItems,
  computeRoomStats,
} from './shareLogic';
import { SharedItem } from '../types/share';

test('normalizeRoomCode cleans and uppercases room identifiers', () => {
  assert.equal(normalizeRoomCode('  sync-42 '), 'SYNC-42');
  assert.equal(normalizeRoomCode('room_99!@#'), 'ROOM99');
  assert.equal(normalizeRoomCode(''), '');
});

test('detectItemCategory classifies images, documents, files, links, and text accurately', () => {
  assert.equal(
    detectItemCategory({ fileName: 'photo.png', mimeType: 'image/png' }),
    'image'
  );
  assert.equal(
    detectItemCategory({ fileName: 'report.pdf', mimeType: 'application/pdf' }),
    'document'
  );
  assert.equal(
    detectItemCategory({ fileName: 'notes.md', mimeType: 'text/markdown' }),
    'document'
  );
  assert.equal(
    detectItemCategory({ fileName: 'bundle.zip', mimeType: 'application/zip' }),
    'file'
  );
  assert.equal(
    detectItemCategory({ content: 'https://developer.mozilla.org/en-US/' }),
    'link'
  );
  assert.equal(
    detectItemCategory({ content: 'Meet at conference room 4B at 14:00' }),
    'text'
  );
});

test('validateShareSubmission enforces strict input validation without silent fallbacks', () => {
  const emptyLink = validateShareSubmission({
    category: 'link',
    content: '   ',
    senderDevice: 'mobile',
    senderName: 'iPhone',
  });
  assert.equal(emptyLink.valid, false);
  assert.ok(emptyLink.error);

  const invalidLink = validateShareSubmission({
    category: 'link',
    content: 'not a valid url',
    senderDevice: 'mobile',
    senderName: 'iPhone',
  });
  assert.equal(invalidLink.valid, false);

  const validDomainWithoutProtocol = validateShareSubmission({
    category: 'link',
    content: 'docs.example.com/spec',
    senderDevice: 'mobile',
    senderName: 'iPhone',
  });
  assert.equal(validDomainWithoutProtocol.valid, true);
  assert.equal(
    validDomainWithoutProtocol.normalizedUrl,
    'https://docs.example.com/spec'
  );

  const missingFile = validateShareSubmission({
    category: 'image',
    fileName: '',
    dataUrl: '',
    senderDevice: 'mobile',
    senderName: 'iPhone',
  });
  assert.equal(missingFile.valid, false);

  const validFile = validateShareSubmission({
    category: 'document',
    fileName: 'spec.md',
    mimeType: 'text/markdown',
    dataUrl: 'data:text/markdown;base64,SGVsbG8=',
    senderDevice: 'desktop',
    senderName: 'Workstation',
  });
  assert.equal(validFile.valid, true);
  assert.equal(validFile.resolvedCategory, 'document');
});

test('formatBytes formats byte sizes cleanly', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1048576 * 2.5), '2.50 MB');
});

test('buildPairingUrl and buildItemDirectSharePayload generate scannable URLs', () => {
  assert.equal(
    buildPairingUrl('https://app.example.com/', 'sync-42'),
    'https://app.example.com/?room=SYNC-42&device=mobile'
  );

  const sampleDoc: SharedItem = {
    id: 'doc-123',
    roomId: 'SYNC-42',
    category: 'document',
    title: 'Architecture PDF',
    content: 'Summary',
    fileName: 'arch.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4096,
    senderDevice: 'mobile',
    senderName: 'Phone',
    createdAt: '2026-10-31T01:00:00.000Z',
    pinned: false,
  };

  assert.equal(
    buildItemDirectSharePayload(sampleDoc, 'https://app.example.com'),
    'https://app.example.com/api/rooms/SYNC-42/items/doc-123/download'
  );
});

test('filterAndSortItems sorts pinned items first and filters by category and query', () => {
  const items: SharedItem[] = [
    {
      id: '1',
      roomId: 'SYNC-42',
      category: 'link',
      title: 'Old Unpinned Link',
      content: 'https://example.com/old',
      sizeBytes: 30,
      senderDevice: 'desktop',
      senderName: 'Mac',
      createdAt: '2026-10-31T01:00:00.000Z',
      pinned: false,
    },
    {
      id: '2',
      roomId: 'SYNC-42',
      category: 'image',
      title: 'Pinned Camera Diagram',
      content: 'Camera capture',
      fileName: 'diagram.svg',
      sizeBytes: 1200,
      senderDevice: 'mobile',
      senderName: 'iPhone',
      createdAt: '2026-10-31T00:30:00.000Z',
      pinned: true,
    },
  ];

  const allSorted = filterAndSortItems(items, {
    category: 'all',
    searchQuery: '',
  });
  assert.equal(allSorted[0].id, '2');

  const onlyImages = filterAndSortItems(items, {
    category: 'image',
    searchQuery: 'camera',
  });
  assert.equal(onlyImages.length, 1);
  assert.equal(onlyImages[0].id, '2');

  const stats = computeRoomStats(items);
  assert.equal(stats.totalItems, 2);
  assert.equal(stats.totalBytes, 1230);
  assert.equal(stats.pinnedCount, 1);
  assert.equal(stats.countByCategory.image, 1);
});
