/**
 * What goes into an item's QR code. Pure helpers (no DOM, no network). Unit-tested in qrPayload.test.ts.
 */
import type { StoredItem } from '../types/share';

export const QR_BYTE_BUDGET = 700; // keeps the QR version small enough to scan from a screen

export type QrPayload = { ok: true; value: string; hint: string } | { ok: false; reason: string };

const encoder = new TextEncoder();

/** QR codes store text as UTF-8, so the budget is in bytes: a Hindi letter takes 3, an emoji 4. */
function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** What a phone gets when it scans an item's QR code; null for files (they only travel to paired devices). */
export function qrPayloadFor(item: Pick<StoredItem, 'kind' | 'text' | 'url'>): QrPayload | null {
  if (item.kind === 'link') {
    if (!item.url) return null;
    // A cut link would open the wrong page, so a link either fits whole or not at all.
    if (utf8Length(item.url) <= QR_BYTE_BUDGET) return { ok: true, value: item.url, hint: 'Scan to open this link.' };
    return { ok: false, reason: 'This link is too long for a QR code. Use Copy instead.' };
  }
  if (item.kind === 'text') {
    const text = item.text ?? '';
    if (!text) return null; // nothing to put in a QR code
    if (utf8Length(text) <= QR_BYTE_BUDGET) return { ok: true, value: text, hint: 'Scan to read this note on another phone.' };
    return {
      ok: true,
      value: truncateUtf8(text, QR_BYTE_BUDGET),
      hint: 'This note is long, so the QR code holds only the beginning of it.',
    };
  }
  return null; // files travel only to paired devices
}

/** Cuts text to at most `maxBytes` UTF-8 bytes without splitting a character (including emoji). */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0; // in UTF-16 units, for slice()
  for (const ch of text) {
    // Whole code points only, so a 4-byte emoji is never cut into a broken half.
    bytes += utf8Length(ch);
    if (bytes > maxBytes) break;
    end += ch.length;
  }
  return text.slice(0, end);
}
