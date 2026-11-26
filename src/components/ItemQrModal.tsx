import type { StoredItem } from '../types/share';
import { Modal } from './Modal';
import { QrCode } from './QrCode';

/** What a phone gets when it scans an item's QR code (no pairing, no server). */
function qrPayload(item: StoredItem): { value: string; hint: string } | null {
  if (item.kind === 'link') return { value: item.url!, hint: 'Scan to open this link.' };
  if (item.kind === 'text') {
    const text = item.text ?? '';
    if (text.length <= 1000) return { value: text, hint: 'Scan to read this note on another phone.' };
    return { value: text.slice(0, 1000), hint: 'This note is long, so the QR code contains only the first 1,000 characters.' };
  }
  return null; // files travel only to paired devices
}

export function ItemQrModal({ item, onClose }: { item: StoredItem | null; onClose: () => void }) {
  const payload = item ? qrPayload(item) : null;
  return (
    <Modal open={!!item} title="Scan to grab it" onClose={onClose}>
      {payload && (
        <div className="flex flex-col items-center text-center">
          <QrCode value={payload.value} size={260} label="QR code for this item" />
          <p className="mt-4 text-sm text-muted max-w-xs">{payload.hint}</p>
        </div>
      )}
    </Modal>
  );
}
