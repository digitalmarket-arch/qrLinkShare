import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWalletMessage,
  cleanPin,
  deviceNameFromUA,
  deviceTypeFromUA,
  fileKindOf,
  formatBytes,
  formatPin,
  isInlineSafeMime,
  parseWalletMessage,
  safeFileName,
  shortAddress,
  toHttpUrl,
} from './shared';

test('cleanPin accepts exactly 6 digits (spaces/dashes allowed)', () => {
  assert.equal(cleanPin('482910'), '482910');
  assert.equal(cleanPin('482 910'), '482910');
  assert.equal(cleanPin('482-910'), '482910');
  assert.equal(cleanPin('12345'), null);
  assert.equal(cleanPin('1234567'), null);
  assert.equal(cleanPin('12345a'), null);
  assert.equal(formatPin('482910'), '482 910');
});

test('toHttpUrl detects links and rejects unsafe or non-link text', () => {
  assert.equal(toHttpUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(toHttpUrl('example.com'), 'https://example.com/');
  assert.equal(toHttpUrl('  docs.google.com/doc/123  '), 'https://docs.google.com/doc/123');
  assert.equal(toHttpUrl('http://localhost:3000/x'), 'http://localhost:3000/x');
  assert.equal(toHttpUrl('http://192.168.1.4:8080'), 'http://192.168.1.4:8080/');
  assert.equal(toHttpUrl('javascript:alert(1)'), null);
  assert.equal(toHttpUrl('data:text/html,hi'), null);
  assert.equal(toHttpUrl('ftp://example.com'), null);
  assert.equal(toHttpUrl('meet me at 5'), null);
  assert.equal(toHttpUrl('hello'), null);
  assert.equal(toHttpUrl('file.txt'), 'https://file.txt/'); // looks like a domain; acceptable
  assert.equal(toHttpUrl('version 1.2'), null);
  assert.equal(toHttpUrl(''), null);
});

test('fileKindOf buckets common phone/desktop file types', () => {
  assert.equal(fileKindOf('image/heic', 'IMG_0001.HEIC'), 'image');
  assert.equal(fileKindOf('', 'IMG_0001.HEIC'), 'image');
  assert.equal(fileKindOf('application/pdf', 'a.pdf'), 'pdf');
  assert.equal(fileKindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'), 'doc');
  assert.equal(fileKindOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'a.xlsx'), 'sheet');
  assert.equal(fileKindOf('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a.pptx'), 'slides');
  assert.equal(fileKindOf('application/zip', 'a.zip'), 'archive');
  assert.equal(fileKindOf('video/quicktime', 'a.mov'), 'video');
  assert.equal(fileKindOf('application/octet-stream', 'a.bin'), 'other');
});

test('isInlineSafeMime never allows script-capable types inline', () => {
  assert.equal(isInlineSafeMime('image/png'), true);
  assert.equal(isInlineSafeMime('application/pdf'), true);
  assert.equal(isInlineSafeMime('image/svg+xml'), false);
  assert.equal(isInlineSafeMime('text/html'), false);
  assert.equal(isInlineSafeMime('application/xhtml+xml'), false);
  assert.equal(isInlineSafeMime('application/javascript'), false);
});

test('safeFileName strips path and header-breaking characters', () => {
  assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(safeFileName('a"b\\c.txt'), 'a_b_c.txt');
  assert.equal(safeFileName('report\r\n.pdf'), 'report__.pdf');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('राम.pdf'), 'राम.pdf');
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(25 * 1024 * 1024), '25 MB');
});

test('device detection from user agent', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  assert.equal(deviceTypeFromUA(iphone), 'mobile');
  assert.equal(deviceTypeFromUA(android), 'mobile');
  assert.equal(deviceTypeFromUA(win), 'desktop');
  assert.equal(deviceTypeFromUA(ipad), 'tablet');
  assert.equal(deviceNameFromUA(iphone), 'iPhone · Safari');
  assert.equal(deviceNameFromUA(android), 'Android · Chrome');
  assert.equal(deviceNameFromUA(win), 'Windows · Chrome');
});

test('wallet sign-in message round-trips through the parser', () => {
  const msg = buildWalletMessage({
    domain: 'share.example.com',
    uri: 'https://share.example.com',
    address: '0x52908400098527886E0F7030069857D2E4169EE7',
    chainId: 1,
    nonce: 'abc123XYZ',
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T00:05:00.000Z',
  });
  assert.match(msg, /^share\.example\.com wants you to sign in with your Ethereum account:\n0x5290/);
  assert.deepEqual(parseWalletMessage(msg), {
    domain: 'share.example.com',
    address: '0x52908400098527886E0F7030069857D2E4169EE7',
    nonce: 'abc123XYZ',
    expiresAt: '2026-01-01T00:05:00.000Z',
  });
  assert.equal(parseWalletMessage('hello'), null);
  assert.equal(shortAddress('0x52908400098527886E0F7030069857D2E4169EE7'), '0x5290…9EE7');
});
