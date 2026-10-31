export type ShareCategory = 'link' | 'image' | 'document' | 'file' | 'text';

export type RetentionMode = 'temporary' | 'saved';

export type DeviceType = 'desktop' | 'mobile';

export type DesktopAuthMethod = 'qr' | 'pin' | 'google';

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface SharedItem {
  id: string;
  roomId: string;
  category: ShareCategory;
  /** 'temporary' for ephemeral one-time link/drop, 'saved' for persistent vault links/data/docs */
  retentionMode: RetentionMode;
  title: string;
  /** For 'link', the destination URL. For 'text', the text body. For files/images/docs, optional note/caption. */
  content: string;
  /** Original filename for uploaded files, images, or documents */
  fileName?: string;
  /** MIME type e.g. image/png, application/pdf, text/markdown */
  mimeType?: string;
  /** Size in bytes */
  sizeBytes: number;
  /** Data URL (base64 or UTF-8 data URI) for instant preview & direct phone/desktop download */
  dataUrl?: string;
  /** Device that shared this item */
  senderDevice: DeviceType;
  senderName: string;
  createdAt: string;
  pinned: boolean;
  /** Tracks whether this item has been auto-opened or launched in the desktop browser */
  openedOnDesktop?: boolean;
}

export interface ConnectedDevice {
  clientId: string;
  deviceName: string;
  deviceType: DeviceType;
  joinedAt: string;
}

export interface CreateShareItemPayload {
  id?: string;
  category?: ShareCategory;
  retentionMode?: RetentionMode;
  title?: string;
  content?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  dataUrl?: string;
  senderDevice: DeviceType;
  senderName: string;
}

export interface DesktopAuthSession {
  authenticated: boolean;
  method: DesktopAuthMethod;
  userLabel: string;
  userEmail?: string;
  roomId: string;
  authenticatedAt: string;
}

export interface QrLoginChallenge {
  challengeId: string;
  pinCode: string;
  roomId: string;
  status: 'pending' | 'approved';
  approvedByName?: string;
  createdAt: string;
}

export interface RoomState {
  roomId: string;
  items: SharedItem[];
  devices: ConnectedDevice[];
}
