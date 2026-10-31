import {
  CreateShareItemPayload,
  DeviceType,
  RetentionMode,
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
 * Generates a deterministic or random 6-digit numeric pairing PIN (e.g. "482910").
 */
export function generateSixDigitPin(seed?: number): string {
  if (seed !== undefined) {
    const val = Math.abs(Math.floor(seed * 193871 + 482910)) % 900000;
    return String(100000 + val);
  }
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Validates a 6-digit pairing PIN entered by the user.
 */
export function validatePinCode(input: string): {
  valid: boolean;
  cleaned: string;
  error?: string;
} {
  const cleaned = input.replace(/\s+/g, '').trim();
  if (!/^[0-9]{6}$/.test(cleaned)) {
    return {
      valid: false,
      cleaned,
      error: 'Enter a valid 6-digit numeric pairing PIN (for example, 482910).',
    };
  }
  return { valid: true, cleaned };
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
  resolvedRetention?: RetentionMode;
} {
  const category = detectItemCategory({
    explicitCategory: payload.category,
    mimeType: payload.mimeType,
    fileName: payload.fileName,
    content: payload.content,
  });

  const resolvedRetention: RetentionMode =
    payload.retentionMode === 'temporary' ? 'temporary' : 'saved';

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
        resolvedRetention,
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
      resolvedRetention,
    };
  }

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
    resolvedRetention,
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
 * Builds the Phone-to-Desktop pairing & QR login URL encoded in the desktop QR code.
 * Preserves repository subpaths (e.g. https://user.github.io/qrLinkShare/) for GitHub Pages.
 */
export function buildPairingUrl(
  originOrBaseUrl: string,
  roomCode: string,
  challengeId?: string,
  pinCode?: string
): string {
  const cleanBase = originOrBaseUrl
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/$/, '');
  const code = normalizeRoomCode(roomCode) || 'SYNC-42';
  let url = `${cleanBase}/?room=${encodeURIComponent(code)}&device=mobile`;
  if (challengeId) {
    url += `&qrLogin=${encodeURIComponent(challengeId)}`;
  }
  if (pinCode) {
    url += `&pin=${encodeURIComponent(pinCode)}`;
  }
  return url;
}

/**
 * Builds the direct payload for an individual shared item's QR code so scanning it on a phone
 * immediately opens the link, reads the text, or opens/downloads the shared item.
 */
export function buildItemDirectSharePayload(
  item: SharedItem,
  originOrBaseUrl: string,
  isStaticHost = false
): string {
  const cleanBase = originOrBaseUrl
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/$/, '');
  if (item.category === 'link') {
    return item.content;
  }
  if (item.category === 'text' && item.content.length <= 600) {
    return item.content;
  }
  if (isStaticHost) {
    const token = encodeShareUrlPayload(item);
    return `${cleanBase}/?room=${encodeURIComponent(item.roomId)}#share=${token}`;
  }
  return `${cleanBase}/api/rooms/${encodeURIComponent(item.roomId)}/items/${encodeURIComponent(item.id)}/download`;
}

/**
 * Finds the newest shared link that has not yet been auto-opened on desktop.
 */
export function findNewestUnopenedLink(items: SharedItem[]): SharedItem | null {
  const links = items
    .filter((i) => i.category === 'link' && !i.openedOnDesktop)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  return links[0] ?? null;
}

/**
 * Filters and sorts shared items (pinned first, then newest first) including retentionMode filtering.
 */
export function filterAndSortItems(
  items: SharedItem[],
  options: {
    category: 'all' | 'pinned' | ShareCategory;
    retentionFilter?: 'all' | RetentionMode;
    searchQuery: string;
    deviceFilter?: 'all' | DeviceType;
  }
): SharedItem[] {
  const query = options.searchQuery.trim().toLowerCase();
  const deviceFilter = options.deviceFilter ?? 'all';
  const retentionFilter = options.retentionFilter ?? 'all';

  return items
    .filter((item) => {
      if (
        retentionFilter !== 'all' &&
        (item.retentionMode || 'saved') !== retentionFilter
      ) {
        return false;
      }
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
        item.retentionMode ?? 'saved',
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
 * Encodes a lightweight share item into a URL-safe base64 token so QR codes on static hosts (GitHub Pages)
 * can beam links, text, and metadata directly via URL hash (#share=...) without a backend server.
 */
export function encodeShareUrlPayload(
  item: Pick<
    SharedItem,
    | 'category'
    | 'retentionMode'
    | 'title'
    | 'content'
    | 'fileName'
    | 'mimeType'
    | 'senderDevice'
    | 'senderName'
  >
): string {
  const compact = {
    c: item.category,
    r: item.retentionMode || 'saved',
    t: item.title.slice(0, 100),
    v: item.content.slice(0, 1200),
    f: item.fileName,
    m: item.mimeType,
    d: item.senderDevice,
    s: item.senderName.slice(0, 40),
  };
  const json = JSON.stringify(compact);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf-8').toString('base64url');
  }
  const base64 = btoa(
    encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_m, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes a URL-safe base64 share token from #share=... into a CreateShareItemPayload.
 */
export function decodeShareUrlPayload(
  token: string
): CreateShareItemPayload | null {
  try {
    const cleaned = token.trim();
    if (!cleaned) return null;
    let json = '';
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(cleaned, 'base64url').toString('utf-8');
    } else {
      const base64 = cleaned.replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '==='.slice((base64.length + 3) % 4);
      const binary = atob(padded);
      json = decodeURIComponent(
        Array.from(binary)
          .map((ch) => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('')
      );
    }
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed.v !== 'string') return null;
    return {
      category: parsed.c || 'text',
      retentionMode: parsed.r === 'temporary' ? 'temporary' : 'saved',
      title: parsed.t || 'Beamed via QR Link',
      content: parsed.v,
      fileName: parsed.f,
      mimeType: parsed.m,
      senderDevice: parsed.d === 'desktop' ? 'desktop' : 'mobile',
      senderName: parsed.s || 'QR Instant Beam',
    };
  } catch {
    return null;
  }
}

/**
 * Builds the canonical GitHub Pages deployment URL for a given GitHub username and repository name.
 */
export function buildGithubPagesUrl(
  username: string,
  repoName = 'qrLinkShare',
  roomCode?: string
): string {
  const cleanUser = username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  const cleanRepo =
    repoName.trim().replace(/[^a-zA-Z0-9._-]/g, '') || 'qrLinkShare';
  const baseUrl = cleanUser
    ? `https://${cleanUser}.github.io/${cleanRepo}/`
    : `https://your-username.github.io/${cleanRepo}/`;
  if (!roomCode) return baseUrl;
  const normalizedRoom = normalizeRoomCode(roomCode) || 'SYNC-42';
  return `${baseUrl}?room=${encodeURIComponent(normalizedRoom)}`;
}

/**
 * Computes summary counts and total byte size for a room, including temporary vs saved counts.
 */
export function computeRoomStats(items: SharedItem[]): {
  totalItems: number;
  totalBytes: number;
  pinnedCount: number;
  temporaryCount: number;
  savedCount: number;
  unopenedLinkCount: number;
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
  let temporaryCount = 0;
  let savedCount = 0;
  let unopenedLinkCount = 0;

  for (const item of items) {
    countByCategory[item.category] = (countByCategory[item.category] ?? 0) + 1;
    totalBytes += item.sizeBytes || 0;
    if (item.pinned) pinnedCount += 1;
    if (item.retentionMode === 'temporary') {
      temporaryCount += 1;
    } else {
      savedCount += 1;
    }
    if (item.category === 'link' && !item.openedOnDesktop) {
      unopenedLinkCount += 1;
    }
  }

  return {
    totalItems: items.length,
    totalBytes,
    pinnedCount,
    temporaryCount,
    savedCount,
    unopenedLinkCount,
    countByCategory,
  };
}
