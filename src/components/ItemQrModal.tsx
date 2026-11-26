import type { StoredItem } from '../types/share';
import { qrPayloadFor } from '../lib/qrPayload';
import { Modal } from './Modal';
import { QrCode } from './QrCode';

export function ItemQrModal({ item, onClose }: { item: StoredItem | null; onClose: () => void }) {
  const payload = item ? qrPayloadFor(item) : null;
  return (
    <Modal open={!!item} title={payload?.ok === false ? 'No QR code for this' : 'Scan to grab it'} onClose={onClose}>
      {payload && (
        <div className="flex flex-col items-center text-center">
          {payload.ok === true ? (
            <>
              <QrCode value={payload.value} size={260} label="QR code for this item" />
              <p className="mt-4 text-sm text-muted max-w-xs">{payload.hint}</p>
            </>
          ) : (
            <p className="w-full max-w-xs rounded-2xl bg-surface-2 px-5 py-6 text-sm">{payload.reason}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
