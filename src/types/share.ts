/**
 * Shared types used by both the browser app and the Node server.
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

/** How a device got into a room. */
export type AuthMethod = 'guest' | 'qr' | 'pin' | 'google' | 'wallet';

export type ItemKind = 'text' | 'link' | 'file';

/** A rough visual bucket for files, derived from the MIME type / extension. */
export type FileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'code'
  | 'other';

export interface DeviceInfo {
  /** Stable random id stored in the browser (not a fingerprint). */
  id: string;
  name: string;
  type: DeviceType;
}

export interface FileMeta {
  /** Unguessable id used in the download URL (/api/files/:fileId). */
  fileId: string;
  name: string;
  size: number;
  mime: string;
}

export interface SharedItem {
  id: string;
  roomId: string;
  kind: ItemKind;
  /** Body for 'text' items. */
  text?: string;
  /** Normalised http(s) URL for 'link' items. */
  url?: string;
  /** Present for 'file' items. */
  file?: FileMeta;
  from: DeviceInfo;
  createdAt: string;
  expiresAt: string;
}

export interface PresentDevice extends DeviceInfo {
  method: AuthMethod;
  joinedAt: string;
}

/** What the browser keeps in localStorage to rejoin its room. */
export interface RoomSession {
  roomId: string;
  token: string;
  method: AuthMethod;
  /** Human label, e.g. an email or a shortened wallet address. */
  account?: string;
}

export interface PairingCode {
  pin: string;
  /** Opaque token embedded in the QR code URL. */
  pairToken: string;
  expiresAt: string;
}

/** Messages the server pushes over the WebSocket. */
export type ServerEvent =
  | { type: 'ready'; roomId: string; items: SharedItem[]; devices: PresentDevice[] }
  | { type: 'presence'; devices: PresentDevice[] }
  | { type: 'item:new'; item: SharedItem }
  | { type: 'item:removed'; itemId: string }
  | { type: 'room:cleared' }
  | { type: 'pair:used'; by: DeviceInfo }
  | { type: 'error'; message: string };
