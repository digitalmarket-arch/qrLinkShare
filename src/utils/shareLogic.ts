import {
  CreateShareItemPayload,
  DeviceType,
  ShareCategory,
  SharedItem,
} from '../types/share';

/**
 * Normalizes a human-readable room code into uppercase alphanumeric format (e.g. "SYNC-42").
 */
export function normalizeRoomCode(input: string): string {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!cleaned) {
    return '';
  }
  return cleaned.slice(0, 12);
}

/**
 * Generates a fresh 6-character pairing code formatted as XXX-NNN (e.g., "K9X-482").
 */
export function generateRoomCode(seed?: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digits = '23456789';
  let prefix = '';
  let suffix = '';
  for (let i = 0; i < 3; i++) {
    const idx =
      seed !== undefined
        ? (seed * (i + 7) + i * 13) % chars.length
        : Math.floor(Math.random() * chars.length);
    prefix += chars[idx];
  }
  for (let i = 0; i < 3; i++) {
    const idx =
      seed !== undefined
        ? (seed * (i + 3) + i * 19) % digits.length
        : Math.floor(Math.random() * digits.length);
    suffix += digits[idx];
  }
  return `${prefix}-${suffix}`;
}

/**
 * Automatically classifies a shared item into 'link', 'image', 'document', 'file', or 'text'.
 */
export function detectItemCategory(params: {
  explicitCategory?: ShareCategory;
  mimeType?: string;
  fileName?: string;
  content?: string;
}): ShareCategory {
  const { explicitCategory, mimeType = '', fileName = '', content = '' } = params;
  const lowerMime = mimeType.toLowerCase();
  const lowerName = fileName.toLowerCase();

  if (
    lowerMime.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(lowerName)
  ) {
    return 'image';
  }

  if (
    lowerMime === 'application/pdf' ||
    lowerMime.includes('word') ||
    lowerMime.includes('presentation') ||
    lowerMime.includes('spreadsheet') ||
    lowerMime === 'text/markdown' ||
    lowerMime === 'text/csv' ||
    /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv|rtf|epub)$/.test(lowerName)
  ) {
    return 'document';
  }

  if (fileName || lowerMime) {
    return 'file';
  }

  if (explicitCategory) {
    return explicitCategory;
  }

  const trimmed = content.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    return 'link';
  }

  return 'text';
}

/**
 * Validates a share item submission. Never substitutes fallback values when required inputs are empty/invalid.
 */
export function validateShareSubmission(payload: CreateShareItemPayload): {
  valid: boolean;
  error?: string;
  normalizedUrl?: string;
  resolvedCategory?: ShareCategory;
} {
  const category = detectItemCategory({
    explicitCategory: payload.category,
    mimeType: payload.mimeType,
    fileName: payload.fileName,
    content: payload.content,
  });

  if (category === 'link') {
    const raw = (payload.content ?? '').trim();
    if (!raw) {
      return {
        valid: false,
        error: 'Please enter a destination URL to share.',
      };
    }

    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw)
      ? raw
      : raw.includes('.') && !raw.includes(' ')
        ? `https://${raw}`
        : '';

    if (!withProtocol) {
      return {
        valid: false,
        error: 'Enter a valid web address (for example, https://example.com).',
      };
    }

    try {
      const parsed = new URL(withProtocol);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        !parsed.hostname ||
        !parsed.hostname.includes('.')
      ) {
        return {
          valid: false,
          error: 'URL must include a valid domain name (e.g. https://docs.example.com).',
        };
      }
      return {
        valid: true,
        normalizedUrl: parsed.toString(),
        resolvedCategory: 'link',
      };
    } catch {
      return {
        valid: false,
        error: 'Enter a valid URL format (for example, https://example.com/file).',
      };
    }
  }

  if (category === 'text') {
    const text = (payload.content ?? '').trim();
    if (!text) {
      return {
        valid: false,
        error: 'Please enter text, a note, or a clipboard snippet before sending.',
      };
    }
    return {
      valid: true,
      resolvedCategory: 'text',
    };
  }

  // Image, Document, or File upload
  if (!payload.fileName || !payload.dataUrl) {
    return {
      valid: false,
      error: 'Please select or drop a file, image, or document to share.',
    };
  }

  if (!payload.dataUrl.startsWith('data:')) {
    return {
      valid: false,
      error: 'Uploaded file payload must be a valid encoded data stream.',
    };
  }

  return {
    valid: true,
    resolvedCategory: category,
  };
}

/**
 * Formats byte counts into clean human-readable strings for tabular display.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

/**
 * Builds the Phone-to-Desktop pairing URL encoded in the room QR code.
 */
export function buildPairingUrl(origin: string, roomCode: string): string {
  const cleanOrigin = origin.replace(/\/$/, '');
  const code = normalizeRoomCode(roomCode) || 'SYNC-42';
  return `${cleanOrigin}/?room=${encodeURIComponent(code)}&device=mobile`;
}

/**
 * Builds the direct payload for an individual shared item's QR code so scanning it on a phone
 * immediately opens the link, downloads the file/image/doc, or reads the text.
 */
export function buildItemDirectSharePayload(
  item: SharedItem,
  origin: string
): string {
  const cleanOrigin = origin.replace(/\/$/, '');
  if (item.category === 'link') {
    return item.content;
  }
  if (
    item.category === 'image' ||
    item.category === 'document' ||
    item.category === 'file'
  ) {
    return `${cleanOrigin}/api/rooms/${encodeURIComponent(item.roomId)}/items/${encodeURIComponent(item.id)}/download`;
  }
  // For short text, encode directly; if very long, point to download/raw endpoint
  if (item.content.length <= 600) {
    return item.content;
  }
  return `${cleanOrigin}/api/rooms/${encodeURIComponent(item.roomId)}/items/${encodeURIComponent(item.id)}/download`;
}

/**
 * Filters and sorts shared items (pinned first, then newest first).
 */
export function filterAndSortItems(
  items: SharedItem[],
  options: {
    category: 'all' | 'pinned' | ShareCategory;
    searchQuery: string;
    deviceFilter?: 'all' | DeviceType;
  }
): SharedItem[] {
  const query = options.searchQuery.trim().toLowerCase();
  const deviceFilter = options.deviceFilter ?? 'all';

  return items
    .filter((item) => {
      if (options.category === 'pinned' && !item.pinned) return false;
      if (
        options.category !== 'all' &&
        options.category !== 'pinned' &&
        item.category !== options.category
      ) {
        return false;
      }
      if (deviceFilter !== 'all' && item.senderDevice !== deviceFilter) {
        return false;
      }
      if (!query) return true;
      const haystack = [
        item.title,
        item.content,
        item.fileName ?? '',
        item.mimeType ?? '',
        item.senderName,
        item.category,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
}

/**
 * Computes summary counts and total byte size for a room.
 */
export function computeRoomStats(items: SharedItem[]): {
  totalItems: number;
  totalBytes: number;
  pinnedCount: number;
  countByCategory: Record<ShareCategory, number>;
} {
  const countByCategory: Record<ShareCategory, number> = {
    link: 0,
    image: 0,
    document: 0,
    file: 0,
    text: 0,
  };
  let totalBytes = 0;
  let pinnedCount = 0;

  for (const item of items) {
    countByCategory[item.category] = (countByCategory[item.category] ?? 0) + 1;
    totalBytes += item.sizeBytes || 0;
    if (item.pinned) pinnedCount += 1;
  }

  return {
    totalItems: items.length,
    totalBytes,
    pinnedCount,
    countByCategory,
  };
}
