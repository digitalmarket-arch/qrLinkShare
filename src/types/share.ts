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
 * - pending: created on this device and not yet confirmed by any other device; sent when one connects
 * - receiving: a file still arriving from another device
 * - failed: a file transfer that didn't finish
 */
export type ItemStatus = 'ready' | 'pending' | 'receiving' | 'failed';

export interface StoredItem extends WireItem {
  status: ItemStatus;
  /** Local time the item was stored on this device (ms). */
  storedAt: number;
  /** Devices that confirmed they saved the item (only for items created here). */
  deliveredTo?: string[];
  /** Devices that couldn't take it, and why (only for items created here). Cleared by "Try again". */
  refusedBy?: Record<string, RefusalReason>;
  /** Why an incoming file failed (when known). */
  failReason?: 'no-space' | 'sender-gone';
}

/** no-space: the other device is out of storage; refused: it couldn't accept it. */
export type RefusalReason = 'no-space' | 'refused';

/** A device this one has been connected to before (remembered so it can catch up later). */
export interface KnownDevice extends DeviceInfo {
  /** How it is linked; a device can be paired and share an account at the same time. */
  methods: LinkMethod[];
  /** Items created after this moment are delivered to it when it reconnects. */
  since: number;
  lastSeen: number;
}

/** How a connected device is linked to this one. */
export type LinkMethod = 'paired' | 'google' | 'wallet';

export interface ConnectedDevice extends DeviceInfo {
  method: LinkMethod;
  /** A "keep nothing" device: it's a new device on every visit, so it isn't remembered. */
  ephemeral?: boolean;
}

/** A signed-in account whose devices connect automatically. */
export type Account =
  | { kind: 'google'; uid: string; label: string }
  /** roomKey: derived from the wallet's signature of a fixed message (only the wallet can produce it). */
  | { kind: 'wallet'; address: string; label: string; roomKey: string };
