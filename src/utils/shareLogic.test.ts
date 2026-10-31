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
  encodeShareUrlPayload,
  decodeShareUrlPayload,
  buildGithubPagesUrl,
  generateSixDigitPin,
  validatePinCode,
  findNewestUnopenedLink,
} from './shareLogic';
import { SharedItem } from '../types/share';

test('normalizeRoomCode cleans and uppercases room identifiers', () => {
  assert.equal(normalizeRoomCode('  sync-42 '), 'SYNC-42');
  assert.equal(normalizeRoomCode('room_99!@#'), 'ROOM99');
  assert.equal(normalizeRoomCode(''), '');
});

test('generateSixDigitPin and validatePinCode enforce 6-digit numeric PIN codes', () => {
  const pin = generateSixDigitPin(42);
  assert.equal(pin.length, 6);
  assert.match(pin, /^[0-9]{6}$/);

  assert.equal(validatePinCode('482910').valid, true);
  assert.equal(validatePinCode('12345').valid, false);
  assert.equal(validatePinCode('12345A').valid, false);
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

test('validateShareSubmission enforces strict input validation and retentionMode', () => {
  const emptyLink = validateShareSubmission({
    category: 'link',
    content: '   ',
    senderDevice: 'mobile',
    senderName: 'iPhone',
  });
  assert.equal(emptyLink.valid, false);
  assert.ok(emptyLink.error);

  const validTempLink = validateShareSubmission({
    category: 'link',
    retentionMode: 'temporary',
    content: 'docs.example.com/spec',
    senderDevice: 'mobile',
    senderName: 'iPhone',
  });
  assert.equal(validTempLink.valid, true);
  assert.equal(validTempLink.normalizedUrl, 'https://docs.example.com/spec');
  assert.equal(validTempLink.resolvedRetention, 'temporary');

  const validSavedDoc = validateShareSubmission({
    category: 'document',
    retentionMode: 'saved',
    fileName: 'spec.md',
    mimeType: 'text/markdown',
    dataUrl: 'data:text/markdown;base64,SGVsbG8=',
    senderDevice: 'desktop',
    senderName: 'Workstation',
  });
  assert.equal(validSavedDoc.valid, true);
  assert.equal(validSavedDoc.resolvedCategory, 'document');
  assert.equal(validSavedDoc.resolvedRetention, 'saved');
});

test('formatBytes formats byte sizes cleanly', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1048576 * 2.5), '2.50 MB');
});

test('buildPairingUrl and buildItemDirectSharePayload include QR login challenge parameters', () => {
  assert.equal(
    buildPairingUrl('https://app.example.com/', 'sync-42', 'chal-99', '482910'),
    'https://app.example.com/?room=SYNC-42&device=mobile&qrLogin=chal-99&pin=482910'
  );

  const sampleDoc: SharedItem = {
    id: 'doc-123',
    roomId: 'SYNC-42',
    category: 'document',
    retentionMode: 'saved',
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

test('findNewestUnopenedLink and filterAndSortItems support temporary vs saved retention tiers', () => {
  const items: SharedItem[] = [
    {
      id: '1',
      roomId: 'SYNC-42',
      category: 'link',
      retentionMode: 'temporary',
      title: 'Newest Temporary Link',
      content: 'https://example.com/new-temp',
      sizeBytes: 30,
      senderDevice: 'mobile',
      senderName: 'iPhone',
      createdAt: '2026-10-31T02:00:00.000Z',
      pinned: false,
      openedOnDesktop: false,
    },
    {
      id: '2',
      roomId: 'SYNC-42',
      category: 'image',
      retentionMode: 'saved',
      title: 'Pinned Camera Diagram',
      content: 'Camera capture',
      fileName: 'diagram.svg',
      sizeBytes: 1200,
      senderDevice: 'mobile',
      senderName: 'iPhone',
      createdAt: '2026-10-31T00:30:00.000Z',
      pinned: true,
      openedOnDesktop: true,
    },
  ];

  const newestUnopened = findNewestUnopenedLink(items);
  assert.ok(newestUnopened);
  assert.equal(newestUnopened.id, '1');

  const onlyTemp = filterAndSortItems(items, {
    category: 'all',
    retentionFilter: 'temporary',
    searchQuery: '',
  });
  assert.equal(onlyTemp.length, 1);
  assert.equal(onlyTemp[0].id, '1');

  const onlySaved = filterAndSortItems(items, {
    category: 'all',
    retentionFilter: 'saved',
    searchQuery: '',
  });
  assert.equal(onlySaved.length, 1);
  assert.equal(onlySaved[0].id, '2');

  const stats = computeRoomStats(items);
  assert.equal(stats.totalItems, 2);
  assert.equal(stats.temporaryCount, 1);
  assert.equal(stats.savedCount, 1);
  assert.equal(stats.unopenedLinkCount, 1);
});

test('encodeShareUrlPayload and decodeShareUrlPayload preserve retentionMode for GitHub Pages sharing', () => {
  const token = encodeShareUrlPayload({
    category: 'link',
    retentionMode: 'temporary',
    title: 'GitHub Pages Release',
    content: 'https://digitalmartket333.github.io/qrLinkShare/',
    senderDevice: 'mobile',
    senderName: 'iPhone 16 Pro',
  });
  const decoded = decodeShareUrlPayload(token);
  assert.ok(decoded);
  assert.equal(decoded.category, 'link');
  assert.equal(decoded.retentionMode, 'temporary');
  assert.equal(decoded.title, 'GitHub Pages Release');
  assert.equal(
    decoded.content,
    'https://digitalmartket333.github.io/qrLinkShare/'
  );

  assert.equal(
    buildGithubPagesUrl('digitalmartket333', 'qrLinkShare', 'sync-42'),
    'https://digitalmartket333.github.io/qrLinkShare/?room=SYNC-42'
  );
});
