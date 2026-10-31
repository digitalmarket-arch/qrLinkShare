import { SharedItem } from '../types/share';

const SAMPLE_DIAGRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480" fill="none">
  <rect width="800" height="480" rx="24" fill="#0F172A"/>
  <rect x="32" y="32" width="736" height="416" rx="16" stroke="#334155" stroke-width="2" stroke-dasharray="6 6"/>
  <rect x="72" y="110" width="220" height="260" rx="16" fill="#1E293B" stroke="#6366F1" stroke-width="2"/>
  <text x="182" y="155" fill="#F8FAFC" font-family="sans-serif" font-size="18" font-weight="bold" text-anchor="middle">Mobile Handset</text>
  <text x="182" y="182" fill="#94A3B8" font-family="monospace" font-size="13" text-anchor="middle">Scans QR · Approves Login</text>
  <rect x="112" y="210" width="140" height="120" rx="12" fill="#0F172A" stroke="#475569"/>
  <circle cx="182" cy="270" r="32" fill="#4F46E5" fill-opacity="0.25" stroke="#818CF8" stroke-width="2"/>
  <path d="M170 270L178 278L196 260" stroke="#A5B4FC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M312 240H488" stroke="#6366F1" stroke-width="3" stroke-dasharray="8 8"/>
  <polygon points="488,240 474,232 474,248" fill="#6366F1"/>
  <rect x="346" y="206" width="108" height="30" rx="6" fill="#1E1B4B" stroke="#4F46E5"/>
  <text x="400" y="226" fill="#C7D2FE" font-family="monospace" font-size="12" text-anchor="middle">QR LOGIN SYNC</text>
  <rect x="508" y="110" width="220" height="260" rx="16" fill="#1E293B" stroke="#10B981" stroke-width="2"/>
  <text x="618" y="155" fill="#F8FAFC" font-family="sans-serif" font-size="18" font-weight="bold" text-anchor="middle">Desktop Browser</text>
  <text x="618" y="182" fill="#94A3B8" font-family="monospace" font-size="13" text-anchor="middle">Auto-Opens Links</text>
  <rect x="538" y="210" width="160" height="32" rx="6" fill="#0F172A" stroke="#334155"/>
  <rect x="538" y="254" width="160" height="32" rx="6" fill="#0F172A" stroke="#334155"/>
  <rect x="538" y="298" width="160" height="32" rx="6" fill="#0F172A" stroke="#334155"/>
</svg>`;

const SAMPLE_SPEC_MARKDOWN = `# Q4 Mobile-to-Desktop Release Checklist (v4.2)

## 1. QR Login & Auto-Open Verification
- Room / Vault Code: SYNC-42
- Authentication: QR Scan, 6-Digit PIN, or Google Sign-In
- Retention Tiers: Temporary Links vs. Saved Links / Data / Docs

## 2. Shared Deliverables
1. Interactive Checkout Prototype (Temporary Link — Auto-Opens on Desktop Login)
2. Architecture Reference Docs: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API
3. Production Environment Variables Bundle (Saved JSON Data)

## 3. Sign-Off
Approved by Mobile Platform Engineering & Design Systems.`;

const SAMPLE_JSON_CONFIG = JSON.stringify(
  {
    app: 'qrLinkShare',
    version: '4.5.0',
    authMethods: ['qr-scan', 'six-digit-pin', 'google-oauth'],
    retentionTiers: ['temporary', 'saved'],
    autoOpenNewestLinkOnDesktop: true,
    defaultRoom: 'SYNC-42',
  },
  null,
  2
);

function toBase64DataUrl(content: string, mimeType: string): string {
  if (typeof Buffer !== 'undefined') {
    return `data:${mimeType};base64,${Buffer.from(content, 'utf-8').toString('base64')}`;
  }
  return `data:${mimeType};utf8,${encodeURIComponent(content)}`;
}

export function createInitialSeedItems(roomId = 'SYNC-42'): SharedItem[] {
  const now = Date.now();
  return [
    {
      id: 'seed-link-temp-1',
      roomId,
      category: 'link',
      retentionMode: 'temporary',
      title: 'Interactive Checkout Prototype (Staging v4.2)',
      content:
        'https://staging.acme-design.io/proto/v4-checkout?utm_source=qr_bridge',
      sizeBytes: 68,
      senderDevice: 'mobile',
      senderName: 'iPhone 16 Pro · Field Test',
      createdAt: new Date(now - 1000 * 60 * 1).toISOString(),
      pinned: true,
      openedOnDesktop: false,
    },
    {
      id: 'seed-link-saved-1',
      roomId,
      category: 'link',
      retentionMode: 'saved',
      title: 'MDN WebSockets & Real-Time API Reference',
      content: 'https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API',
      sizeBytes: 63,
      senderDevice: 'mobile',
      senderName: 'iPhone 16 Pro · Field Test',
      createdAt: new Date(now - 1000 * 60 * 5).toISOString(),
      pinned: true,
      openedOnDesktop: false,
    },
    {
      id: 'seed-image-1',
      roomId,
      category: 'image',
      retentionMode: 'saved',
      title: 'Phone-to-Desktop Sync Architecture Diagram',
      content: 'Whiteboard snapshot exported from mobile companion app.',
      fileName: 'sync-architecture-v4.svg',
      mimeType: 'image/svg+xml',
      sizeBytes: SAMPLE_DIAGRAM_SVG.length,
      dataUrl: toBase64DataUrl(SAMPLE_DIAGRAM_SVG, 'image/svg+xml'),
      senderDevice: 'mobile',
      senderName: 'iPhone 16 Pro · Field Test',
      createdAt: new Date(now - 1000 * 60 * 12).toISOString(),
      pinned: false,
      openedOnDesktop: true,
    },
    {
      id: 'seed-doc-1',
      roomId,
      category: 'document',
      retentionMode: 'saved',
      title: 'Q4 Mobile Handoff & Release Notes',
      content: SAMPLE_SPEC_MARKDOWN,
      fileName: 'Q4_Mobile_Handoff_Spec.md',
      mimeType: 'text/markdown',
      sizeBytes: SAMPLE_SPEC_MARKDOWN.length,
      dataUrl: toBase64DataUrl(SAMPLE_SPEC_MARKDOWN, 'text/markdown'),
      senderDevice: 'desktop',
      senderName: 'MacBook Pro M4 · Studio',
      createdAt: new Date(now - 1000 * 60 * 24).toISOString(),
      pinned: false,
      openedOnDesktop: true,
    },
    {
      id: 'seed-file-1',
      roomId,
      category: 'file',
      retentionMode: 'saved',
      title: 'Mobile Bridge Runtime Manifest (JSON Data)',
      content: SAMPLE_JSON_CONFIG,
      fileName: 'bridge-manifest.json',
      mimeType: 'application/json',
      sizeBytes: SAMPLE_JSON_CONFIG.length,
      dataUrl: toBase64DataUrl(SAMPLE_JSON_CONFIG, 'application/json'),
      senderDevice: 'mobile',
      senderName: 'Pixel 9 Pro · QA Lab',
      createdAt: new Date(now - 1000 * 60 * 38).toISOString(),
      pinned: false,
      openedOnDesktop: true,
    },
    {
      id: 'seed-text-1',
      roomId,
      category: 'text',
      retentionMode: 'temporary',
      title: 'Temporary One-Time SSH Tunnel & Lab Wi-Fi Note',
      content:
        'SSID: Acme-Hardware-Lab-5G | Pass: Horizon#2026! | Tunnel: ssh -L 3000:localhost:3000 dev@10.0.4.18',
      sizeBytes: 98,
      senderDevice: 'mobile',
      senderName: 'iPhone 16 Pro · Field Test',
      createdAt: new Date(now - 1000 * 60 * 52).toISOString(),
      pinned: false,
      openedOnDesktop: false,
    },
  ];
}

export const QUICK_SAMPLE_PAYLOADS = {
  photoSvg: {
    title: 'Camera Roll: PCB Layout Inspection Shot',
    fileName: 'pcb-inspection-shot.svg',
    mimeType: 'image/svg+xml',
    content: 'Captured from mobile camera inspection rig.',
    rawBody: `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440" fill="none">
      <rect width="720" height="440" rx="20" fill="#064E3B"/>
      <rect x="28" y="28" width="664" height="384" rx="12" fill="#047857" stroke="#34D399" stroke-width="2"/>
      <circle cx="96" cy="96" r="24" fill="#FBBF24"/>
      <circle cx="624" cy="96" r="24" fill="#FBBF24"/>
      <circle cx="96" cy="344" r="24" fill="#FBBF24"/>
      <circle cx="624" cy="344" r="24" fill="#FBBF24"/>
      <rect x="220" y="130" width="280" height="180" rx="12" fill="#1E293B" stroke="#A7F3D0" stroke-width="2"/>
      <text x="360" y="210" fill="#ECFDF5" font-family="monospace" font-size="20" font-weight="bold" text-anchor="middle">MCU-REV-4B</text>
      <text x="360" y="242" fill="#6EE7B7" font-family="monospace" font-size="14" text-anchor="middle">PASS · 3.30V NOMINAL</text>
    </svg>`,
  },
  docMarkdown: {
    title: 'Field Inspection Report — Unit #408',
    fileName: 'Field_Inspection_Unit_408.md',
    mimeType: 'text/markdown',
    content: `# Field Inspection Summary — Unit #408\n\n- **Inspector**: Mobile Handset #12\n- **Status**: Passed Thermal & Optical Checks\n- **Peak Temp**: 41.2 °C\n- **Notes**: Ready for desktop archival and sign-off.`,
    rawBody: `# Field Inspection Summary — Unit #408\n\n- **Inspector**: Mobile Handset #12\n- **Status**: Passed Thermal & Optical Checks\n- **Peak Temp**: 41.2 °C\n- **Notes**: Ready for desktop archival and sign-off.`,
  },
  csvDataset: {
    title: 'Latency Telemetry Batch Export (CSV)',
    fileName: 'transfer-telemetry-batch.csv',
    mimeType: 'text/csv',
    content: `seq,payload_type,size_kb,transfer_ms,status\n1,image/svg+xml,14.2,38,OK\n2,application/pdf,412.8,94,OK\n3,text/uri-list,0.4,12,OK\n4,application/json,8.6,19,OK`,
    rawBody: `seq,payload_type,size_kb,transfer_ms,status\n1,image/svg+xml,14.2,38,OK\n2,application/pdf,412.8,94,OK\n3,text/uri-list,0.4,12,OK\n4,application/json,8.6,19,OK`,
  },
};
