import type { SharedItem } from '../types/share';
import { fileUrl } from '../lib/api';
import { Modal } from './Modal';
import { QrCode } from './QrCode';

/** What a phone gets when it scans an item's QR code (no pairing needed). */
function qrPayload(item: SharedItem): { value: string; hint: string } {
  if (item.kind === 'link') return { value: item.url!, hint: 'Scan to open this link.' };
  if (item.kind === 'file') return { value: fileUrl(item.file!.fileId), hint: 'Scan to download this file. Anyone with the code can open it until it expires.' };
  const text = item.text ?? '';
  if (text.length <= 1000) return { value: text, hint: 'Scan to read this note on another phone.' };
  return { value: text.slice(0, 1000), hint: 'This note is long, so the QR code contains only the first 1,000 characters.' };
}

export function ItemQrModal({ item, onClose }: { item: SharedItem | null; onClose: () => void }) {
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
