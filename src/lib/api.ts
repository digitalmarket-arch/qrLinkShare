/**
 * Talks to the qrLinkShare server (REST + WebSocket).
 *
 * By default the API lives on the same website. If you host the frontend on
 * GitHub Pages and the server elsewhere (Render, Railway…), build with
 * VITE_SERVER_URL=https://your-server.example.com
 */
import type { DeviceInfo, PairingCode, RoomSession, SharedItem } from '../types/share';
import { deviceNameFromUA, deviceTypeFromUA } from './shared';

const RAW_BASE = (import.meta.env.VITE_SERVER_URL as string | undefined) || '';
export const API_BASE = RAW_BASE.replace(/\/$/, '');

export function wsUrl(): string {
  if (API_BASE) return API_BASE.replace(/^http/, 'ws') + '/ws';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Absolute URL for a shared file (also used inside per-item QR codes). */
export function fileUrl(fileId: string, download = false): string {
  const base = API_BASE || location.origin;
  return `${base}/api/files/${encodeURIComponent(fileId)}${download ? '?download=1' : ''}`;
}

/** The link encoded in the pairing QR code. Opening it on a phone joins the room. */
export function pairingLink(pairToken: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('pair', pairToken);
  return url.toString();
}

/* --------------------------------- helpers -------------------------------- */

/** Random id that also works on plain-http LAN addresses (crypto.randomUUID needs https). */
export function uid(): string {
  if (typeof crypto.randomUUID === 'function' && isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Copy to clipboard, with a fallback for plain-http pages where navigator.clipboard is missing. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Copy is not supported in this browser.');
}

/* ------------------------------ local storage ----------------------------- */

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / storage blocked: the app still works for this tab
  }
}

export function getDevice(): DeviceInfo {
  const saved = readJson<DeviceInfo>('qrls.device');
  const ua = navigator.userAgent;
  const device: DeviceInfo = {
    id: saved?.id || uid(),
    name: saved?.name || deviceNameFromUA(ua),
    type: deviceTypeFromUA(ua),
  };
  if (!saved) writeJson('qrls.device', device);
  return device;
}

export const loadSession = () => readJson<RoomSession>('qrls.session');
export const saveSession = (s: RoomSession | null) => writeJson('qrls.session', s);

export function loadPref<T>(key: string, fallback: T): T {
  const v = readJson<T>(`qrls.pref.${key}`);
  return v === null ? fallback : v;
}
export const savePref = (key: string, value: unknown) => writeJson(`qrls.pref.${key}`, value);

/* --------------------------------- fetch ---------------------------------- */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function deviceHeaders(): Record<string, string> {
  const d = getDevice();
  return {
    'X-Device-Id': d.id,
    'X-Device-Name': encodeURIComponent(d.name),
    'X-Device-Type': d.type,
  };
}

async function request<T>(path: string, init: RequestInit & { token?: string; body?: BodyInit | null } = {}): Promise<T> {
  const headers: Record<string, string> = { ...deviceHeaders(), ...(init.headers as Record<string, string>) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError('Cannot reach the server. Check your internet connection.', 0);
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok || !isJson) {
    const fallback = !isJson
      ? 'The qrLinkShare server is not running at this address.'
      : `Request failed (${res.status}).`;
    throw new ApiError((data as { error?: string }).error || fallback, isJson ? res.status : 0);
  }
  return data as T;
}

const postJson = <T>(path: string, body: unknown, token?: string) =>
  request<T>(path, {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });

export const api = {
  newRoom: () => postJson<RoomSession>('/api/rooms', {}),
  checkSession: (token: string) =>
    request<Omit<RoomSession, 'token'>>('/api/session', { token }),
  createPairing: (s: RoomSession) =>
    postJson<PairingCode>(`/api/rooms/${encodeURIComponent(s.roomId)}/pair`, {}, s.token),
  // fromToken: this device's current room, so anything it already shared there comes along.
  claimPin: (pin: string) => postJson<RoomSession>('/api/pair/claim', { pin, fromToken: loadSession()?.token }),
  claimPairToken: (pairToken: string) =>
    postJson<RoomSession>('/api/pair/claim', { pairToken, fromToken: loadSession()?.token }),
  googleSignIn: (idToken: string) =>
    postJson<RoomSession>('/api/auth/google', { idToken, fromToken: loadSession()?.token }),
  walletChallenge: (address: string, chainId: number) =>
    postJson<{ message: string }>('/api/auth/wallet/challenge', { address, chainId }),
  walletVerify: (message: string, signature: string) =>
    postJson<RoomSession>('/api/auth/wallet/verify', { message, signature, fromToken: loadSession()?.token }),
  sendText: (s: RoomSession, text: string) =>
    postJson<{ item: SharedItem }>(`/api/rooms/${encodeURIComponent(s.roomId)}/items`, { text }, s.token),
  deleteItem: (s: RoomSession, itemId: string) =>
    request<{ ok: true }>(`/api/rooms/${encodeURIComponent(s.roomId)}/items/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
      token: s.token,
    }),
  clearRoom: (s: RoomSession) =>
    request<{ ok: true }>(`/api/rooms/${encodeURIComponent(s.roomId)}/items`, { method: 'DELETE', token: s.token }),
};

/**
 * Uploads one file with progress updates. Uses XMLHttpRequest because
 * fetch() can't report upload progress yet.
 */
export function uploadFile(
  s: RoomSession,
  file: File,
  onProgress: (fraction: number) => void
): { promise: Promise<SharedItem>; cancel: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<SharedItem>((resolve, reject) => {
    xhr.open('POST', `${API_BASE}/api/rooms/${encodeURIComponent(s.roomId)}/files`);
    xhr.setRequestHeader('Authorization', `Bearer ${s.token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    for (const [k, v] of Object.entries(deviceHeaders())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: { item?: SharedItem; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // non-JSON
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.item) resolve(data.item);
      else reject(new ApiError(data.error || `Upload failed (${xhr.status}).`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection.', 0));
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', -1));
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}
