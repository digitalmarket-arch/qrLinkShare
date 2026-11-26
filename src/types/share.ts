/**
 * Types for the peer-to-peer app. Everything lives on the user's own devices.
 */

export type DeviceType = 'desktop' | 'mobile' | 'tablet';

export type ItemKind = 'text' | 'link' | 'file';

/** 'temp' items disappear after 24 hours; 'saved' items stay until deleted. */
export type Retention = 'temp' | 'saved';

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
  /** The device's verified peer-to-peer identity (stable per browser). */
  id: string;
  name: string;
  type: DeviceType;
}

export interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

/** What travels between devices (no local-only fields). */
export interface WireItem {
  id: string;
  kind: ItemKind;
  retention: Retention;
  text?: string;
  url?: string;
  file?: FileMeta;
  from: DeviceInfo;
  createdAt: string;
  /** Only for 'temp' items. */
  expiresAt?: string;
}

/**
 * - ready: complete and usable
 * - pending: created on this device while no other device was connected; sent when one connects
 * - receiving: a file still arriving from another device
 * - failed: a file transfer that didn't finish
 */
export type ItemStatus = 'ready' | 'pending' | 'receiving' | 'failed';

export interface StoredItem extends WireItem {
  status: ItemStatus;
  /** Local time the item was stored on this device (ms). */
  storedAt: number;
  /** Devices this device has delivered the item to (only for items created here). */
  deliveredTo?: string[];
}

/** A device this one has been connected to before (remembered so it can catch up later). */
export interface KnownDevice extends DeviceInfo {
  method: LinkMethod;
  /** Items created after this moment are delivered to it when it reconnects. */
  since: number;
  lastSeen: number;
}

/** How a connected device is linked to this one. */
export type LinkMethod = 'paired' | 'google' | 'wallet';

export interface ConnectedDevice extends DeviceInfo {
  method: LinkMethod;
}

/** A signed-in account whose devices connect automatically. */
export type Account =
  | { kind: 'google'; uid: string; label: string }
  /** roomKey: derived from the wallet's signature of a fixed message (only the wallet can produce it). */
  | { kind: 'wallet'; address: string; label: string; roomKey: string };
