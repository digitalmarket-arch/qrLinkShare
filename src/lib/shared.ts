/**
 * Pure helpers shared by the browser and the server. No DOM, no Node APIs.
 */
import type { DeviceType, FileKind } from '../types/share';

export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const MAX_TEXT_CHARS = 20_000;
export const PIN_LENGTH = 6;

/** Returns the 6 digits of a PIN, or null if it isn't exactly 6 digits. */
export function cleanPin(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^[0-9]{6}$/.test(digits) ? digits : null;
}

/** "482910" -> "482 910" for easier reading. */
export function formatPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

/**
 * If the input looks like a single web address, returns it as a normalised
 * http(s) URL. Otherwise returns null (the input should be treated as text).
 * Only http and https are allowed so we never render `javascript:` links.
 */
export function toHttpUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw) || raw.length > 4000) return null;

  const hasScheme = /^[a-z][a-z\d+\-.]*:/i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;

  const candidate = hasScheme ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname;
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    // Without a scheme, require something that looks like a domain ("example.com").
    if (!hasScheme && !isIp && !/\.[a-z]{2,}$/i.test(host)) return null;
    if (!host.includes('.') && host !== 'localhost') return null;
    return url.toString();
  } catch {
    return null;
  }
}

const EXT_KIND: Array<[RegExp, FileKind]> = [
  [/\.(png|jpe?g|gif|webp|avif|heic|heif|bmp|svg|ico)$/i, 'image'],
  [/\.(mp4|mov|webm|mkv|avi|m4v)$/i, 'video'],
  [/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i, 'audio'],
  [/\.pdf$/i, 'pdf'],
  [/\.(docx?|odt|rtf|txt|md|pages|epub)$/i, 'doc'],
  [/\.(xlsx?|ods|csv|tsv|numbers)$/i, 'sheet'],
  [/\.(pptx?|odp|key)$/i, 'slides'],
  [/\.(zip|rar|7z|tar|gz|tgz|bz2|xz)$/i, 'archive'],
  [/\.(js|ts|tsx|jsx|json|html?|css|py|java|kt|swift|go|rs|c|cpp|h|sh|ya?ml|xml|sql)$/i, 'code'],
];

/** Picks an icon/preview bucket for a file. */
export function fileKindOf(mime: string, name: string): FileKind {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('spreadsheet') || m.includes('excel') || m === 'text/csv') return 'sheet';
  if (m.includes('presentation') || m.includes('powerpoint')) return 'slides';
  if (m.includes('word') || m === 'text/markdown' || m === 'text/plain') return 'doc';
  if (m.includes('zip') || m.includes('compressed') || m.includes('tar')) return 'archive';
  for (const [re, kind] of EXT_KIND) if (re.test(name)) return kind;
  return 'other';
}

/** MIME types that are safe to show inline in the browser (no scripts). */
export function isInlineSafeMime(mime: string): boolean {
  return /^(image\/(png|jpeg|gif|webp|avif|bmp)|application\/pdf|text\/plain|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav|webm))$/i.test(
    mime
  );
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** "just now", "5 min ago", "2 h ago", or a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Makes a filename safe for a Content-Disposition header / download attribute. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f"\\/<>:|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return cleaned || 'file';
}

/** Guesses the device type from a user-agent string. */
export function deviceTypeFromUA(ua: string): DeviceType {
  if (/iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/iPhone|iPod|Android|Mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** A friendly default name like "iPhone · Safari" or "Windows · Chrome". */
export function deviceNameFromUA(ua: string): string {
  const os = /iPhone/i.test(ua)
    ? 'iPhone'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /Android/i.test(ua)
        ? 'Android'
        : /Windows/i.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/i.test(ua)
            ? 'Mac'
            : /CrOS/i.test(ua)
              ? 'Chromebook'
              : /Linux/i.test(ua)
                ? 'Linux'
                : 'Device';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /SamsungBrowser/i.test(ua)
        ? 'Samsung Internet'
        : /Firefox|FxiOS/i.test(ua)
          ? 'Firefox'
          : /Chrome|CriOS/i.test(ua)
            ? 'Chrome'
            : /Safari/i.test(ua)
              ? 'Safari'
              : 'Browser';
  return `${os} · ${browser}`;
}

/** 0x1234…abcd */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/**
 * Builds a "Sign-In with Ethereum" (EIP-4361) message. The server builds this,
 * the wallet signs it, and the server checks the signature and the nonce.
 */
export function buildWalletMessage(params: {
  domain: string;
  uri: string;
  address: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    'Sign in to qrLinkShare. Devices signed in with this wallet share files with each other in real time. This does not cost gas or give access to your funds.',
    '',
    `URI: ${params.uri}`,
    'Version: 1',
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expiresAt}`,
  ].join('\n');
}

/** Reads the fields we care about back out of a wallet sign-in message. */
export function parseWalletMessage(message: string): {
  domain: string;
  address: string;
  nonce: string;
  expiresAt: string;
} | null {
  const lines = message.split('\n');
  const domainMatch = lines[0]?.match(/^(.+) wants you to sign in with your Ethereum account:$/);
  const address = lines[1]?.trim() ?? '';
  const field = (name: string) =>
    lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? '';
  const nonce = field('Nonce');
  const expiresAt = field('Expiration Time');
  if (!domainMatch || !/^0x[0-9a-fA-F]{40}$/.test(address) || !nonce || !expiresAt) return null;
  return { domain: domainMatch[1], address, nonce, expiresAt };
}
