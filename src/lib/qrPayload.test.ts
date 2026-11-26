import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { QR_BYTE_BUDGET, qrPayloadFor, truncateUtf8 } from './qrPayload';

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The cut keeps whole characters from the start, stays within budget and doesn't stop early. */
function assertCleanCut(input: string, out: string, maxBytes: number) {
  assert.ok(input.startsWith(out), 'the result is the beginning of the input');
  assert.ok(bytes(out) <= maxBytes, `within ${maxBytes} bytes (got ${bytes(out)})`);
  const chars = [...input];
  const kept = [...out];
  assert.deepEqual(kept, chars.slice(0, kept.length), 'only whole characters are kept');
  assert.doesNotMatch(out, /[\uD800-\uDBFF]$/, 'no half emoji at the end');
  if (kept.length < chars.length) assert.ok(bytes(out + chars[kept.length]) > maxBytes, 'the next character would not have fitted');
}

const HINDI = 'नमस्ते दुनिया, आज मौसम बहुत अच्छा है। ';
const CHINESE = '你好世界，今天天气很好。';
const EMOJI = '😀👍🏽🇮🇳👨‍👩‍👧';

test('truncateUtf8 keeps short text as it is', () => {
  assert.equal(truncateUtf8('hello', 5), 'hello');
  assert.equal(truncateUtf8('नमस्ते', 18), 'नमस्ते');
  assert.equal(truncateUtf8('', 10), '');
  assert.equal(truncateUtf8('abcdef', 3), 'abc');
  assert.equal(truncateUtf8('abc', 0), '');
});

test('truncateUtf8 never splits a Hindi, Chinese or emoji character', () => {
  for (const [name, unit] of [
    ['Hindi', HINDI],
    ['Chinese', CHINESE],
    ['emoji', EMOJI],
    ['mixed', `Hi ${EMOJI} ${HINDI}${CHINESE} café `],
  ]) {
    const input = unit.repeat(200);
    // Every budget around the default one, so the cut lands at every position inside multi-byte characters.
    for (let max = QR_BYTE_BUDGET - 8; max <= QR_BYTE_BUDGET + 8; max++) {
      const out = truncateUtf8(input, max);
      assertCleanCut(input, out, max);
      assert.ok(bytes(out) > max - 4, `${name}: wastes less than one character (${bytes(out)} of ${max})`);
    }
  }
  // A 4-byte emoji that doesn't fit is dropped whole.
  assert.equal(truncateUtf8('ab😀', 5), 'ab');
  assert.equal(truncateUtf8('ab😀', 6), 'ab😀');
  // Hindi letters are 3 bytes each.
  assert.equal(truncateUtf8('नमस्ते', 8), 'नम');
});

test('a short note goes into the QR code whole', () => {
  assert.deepEqual(qrPayloadFor({ kind: 'text', text: 'Meet at 5 at Gate 2' }), {
    ok: true,
    value: 'Meet at 5 at Gate 2',
    hint: 'Scan to read this note on another phone.',
  });
  const exactlyFull = 'a'.repeat(QR_BYTE_BUDGET);
  assert.deepEqual(qrPayloadFor({ kind: 'text', text: exactlyFull }), {
    ok: true,
    value: exactlyFull,
    hint: 'Scan to read this note on another phone.',
  });
});

test('a long note puts only its beginning in the QR code, counted in bytes', () => {
  const ascii = 'a'.repeat(QR_BYTE_BUDGET + 1);
  assert.deepEqual(qrPayloadFor({ kind: 'text', text: ascii }), {
    ok: true,
    value: 'a'.repeat(QR_BYTE_BUDGET),
    hint: 'This note is long, so the QR code holds only the beginning of it.',
  });

  // 1,000 Hindi characters are about 2,800 bytes: far more than 1,000.
  const hindi = [...HINDI.repeat(40)].slice(0, 1000).join('');
  assert.equal(hindi.length, 1000);
  const p = qrPayloadFor({ kind: 'text', text: hindi });
  assert.ok(p?.ok);
  assert.equal(p.hint, 'This note is long, so the QR code holds only the beginning of it.');
  assertCleanCut(hindi, p.value, QR_BYTE_BUDGET);
});

test('a link fits whole or not at all', () => {
  assert.deepEqual(qrPayloadFor({ kind: 'link', url: 'https://maps.app.goo.gl/AbC123xyz' }), {
    ok: true,
    value: 'https://maps.app.goo.gl/AbC123xyz',
    hint: 'Scan to open this link.',
  });
  const longest = `https://example.com/${'a'.repeat(QR_BYTE_BUDGET - 20)}`;
  assert.equal(bytes(longest), QR_BYTE_BUDGET);
  assert.equal(qrPayloadFor({ kind: 'link', url: longest })?.ok, true);

  const tooLong = { ok: false, reason: 'This link is too long for a QR code. Use Copy instead.' };
  assert.deepEqual(qrPayloadFor({ kind: 'link', url: `${longest}a` }), tooLong);
  assert.deepEqual(qrPayloadFor({ kind: 'link', url: `https://example.com/?q=${'x'.repeat(3970)}` }), tooLong);
  // Counted in bytes, not characters: 300 Hindi characters are 900 bytes.
  assert.deepEqual(qrPayloadFor({ kind: 'link', url: `https://example.com/${'क'.repeat(300)}` }), tooLong);
});

test('files (and empty items) have no QR code', () => {
  assert.equal(qrPayloadFor({ kind: 'file' }), null);
  assert.equal(qrPayloadFor({ kind: 'file', text: 'ignored', url: 'https://example.com/' }), null);
  assert.equal(qrPayloadFor({ kind: 'text', text: '' }), null);
  assert.equal(qrPayloadFor({ kind: 'link' }), null);
});

test('a full payload still makes a QR code small enough to scan', (t) => {
  const valueFor = (item: Parameters<typeof qrPayloadFor>[0]) => {
    const p = qrPayloadFor(item);
    assert.ok(p?.ok);
    return p.value;
  };
  const payloads: Record<string, string> = {
    'English note': valueFor({ kind: 'text', text: 'The quick brown fox jumps over the lazy dog. '.repeat(40) }),
    'Hindi note': valueFor({ kind: 'text', text: HINDI.repeat(100) }),
    'Chinese note': valueFor({ kind: 'text', text: CHINESE.repeat(100) }),
    'Emoji note': valueFor({ kind: 'text', text: EMOJI.repeat(100) }),
    'Longest link': valueFor({ kind: 'link', url: `https://example.com/${'a'.repeat(QR_BYTE_BUDGET - 20)}` }),
  };
  for (const [name, value] of Object.entries(payloads)) {
    assert.ok(bytes(value) > QR_BYTE_BUDGET - 4 && bytes(value) <= QR_BYTE_BUDGET, `${name} fills the budget`);
    const qr = QRCode.create(value, { errorCorrectionLevel: 'M' }); // the same level QrCode.tsx uses
    t.diagnostic(`${name}: ${bytes(value)} bytes -> QR version ${qr.version} (${qr.modules.size}x${qr.modules.size} squares)`);
    assert.ok(qr.version <= 21, `${name} needs QR version ${qr.version}`);
  }
  // What used to happen: a 1,000-character Hindi note is too big for any QR code at all.
  const hindi = [...HINDI.repeat(40)].slice(0, 1000).join('');
  assert.throws(() => QRCode.create(hindi, { errorCorrectionLevel: 'M' }));
});
