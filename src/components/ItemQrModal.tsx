import React from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
import { SharedItem } from '../types/share';
import {
  buildItemDirectSharePayload,
  formatBytes,
} from '../utils/shareLogic';
import { QrCodeView } from './QrCodeView';

interface ItemQrModalProps {
  item: SharedItem | null;
  onClose: () => void;
}

export const ItemQrModal: React.FC<ItemQrModalProps> = ({ item, onClose }) => {
  if (!item) return null;

  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'http://localhost:3000';
  const qrPayload = buildItemDirectSharePayload(item, origin);
  const downloadHref = `/api/rooms/${encodeURIComponent(item.roomId)}/items/${encodeURIComponent(item.id)}/download`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="item-qr-modal-title"
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-md w-full p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2
              id="item-qr-modal-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100 truncate"
            >
              {item.title}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5">
              {item.category.toUpperCase()} · {formatBytes(item.sizeBytes)} ·{' '}
              {item.senderName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close QR modal"
            className="min-h-[36px] min-w-[36px] p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 bg-slate-100 dark:bg-slate-800 rounded-lg flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="py-4 flex flex-col items-center bg-slate-50 dark:bg-slate-950 rounded-xl border border-slate-200/80 dark:border-slate-800">
          <QrCodeView
            value={qrPayload}
            size={220}
            errorCorrectionLevel="M"
            downloadFileName={`qr-${item.id}`}
            copyLabel="Copy Payload"
            label={
              item.category === 'link'
                ? 'Scan to open URL directly on phone'
                : 'Scan to download directly on phone'
            }
          />
        </div>

        <div className="mt-4">
          <p className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
            Encoded QR Payload:
          </p>
          <p className="text-xs font-mono text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/80 rounded-lg px-3 py-2 break-all">
            {qrPayload}
          </p>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          {item.category === 'link' ? (
            <a
              href={item.content}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Open Destination Link</span>
            </a>
          ) : (
            <a
              href={downloadHref}
              download={item.fileName || `${item.id}.txt`}
              className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg flex items-center gap-1.5 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Download {item.fileName || 'Item'}</span>
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
