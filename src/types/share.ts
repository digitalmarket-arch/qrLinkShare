export type ShareCategory = 'link' | 'image' | 'document' | 'file' | 'text';

export type DeviceType = 'desktop' | 'mobile';

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

export interface SharedItem {
  id: string;
  roomId: string;
  category: ShareCategory;
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
  title?: string;
  content?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  dataUrl?: string;
  senderDevice: DeviceType;
  senderName: string;
}

export interface RoomState {
  roomId: string;
  items: SharedItem[];
  devices: ConnectedDevice[];
}
