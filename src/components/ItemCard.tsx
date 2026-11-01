import { useState } from 'react';
import {
  Archive,
  Copy,
  Download,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  Film,
  Link2,
  Monitor,
  Music,
  Presentation,
  QrCode,
  Share2,
  Smartphone,
  StickyNote,
  Tablet,
  Trash2,
} from 'lucide-react';
import type { FileKind, SharedItem } from '../types/share';
import { fileKindOf, formatBytes, timeAgo } from '../lib/shared';
import { fileUrl } from '../lib/api';

const FILE_ICONS: Record<FileKind, typeof File> = {
  image: FileImage,
  video: Film,
  audio: Music,
  pdf: FileText,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  archive: Archive,
  code: FileCode2,
  other: File,
};

const DEVICE_ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

interface Props {
  item: SharedItem;
  myDeviceId: string;
  fresh: boolean;
  onCopy: (text: string, what: string) => void;
  onShowQr: (item: SharedItem) => void;
  onDelete: (item: SharedItem) => void;
}

export function ItemCard({ item, myDeviceId, fresh, onCopy, onShowQr, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const mine = item.from.id === myDeviceId;
  const DeviceIcon = DEVICE_ICONS[item.from.type] ?? Monitor;

  const kind = item.file ? fileKindOf(item.file.mime, item.file.name) : null;
  const isImage = kind === 'image' && item.file && /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(item.file.mime);
  const canPreview = item.file && (isImage || kind === 'pdf' || kind === 'video' || kind === 'audio' || item.file.mime === 'text/plain');
  const longText = (item.text?.length ?? 0) > 280 || (item.text?.split('\n').length ?? 0) > 6;

  let Icon = StickyNote;
  if (item.kind === 'link') Icon = Link2;
  if (kind) Icon = FILE_ICONS[kind];

  let host = '';
  if (item.url) {
    try {
      host = new URL(item.url).hostname.replace(/^www\./, '');
    } catch {
      host = item.url;
    }
  }

  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator && matchMedia('(pointer: coarse)').matches;
  const nativeShare = async () => {
    try {
      if (item.file) {
        const res = await fetch(fileUrl(item.file.fileId));
        const blob = await res.blob();
        const f = new window.File([blob], item.file.name, { type: item.file.mime });
        if (navigator.canShare?.({ files: [f] })) return await navigator.share({ files: [f] });
        return await navigator.share({ url: fileUrl(item.file.fileId) });
      }
      if (item.url) return await navigator.share({ url: item.url });
      if (item.text) return await navigator.share({ text: item.text });
    } catch {
      // user cancelled
    }
  };

  return (
    <li className={`card overflow-hidden ${fresh ? 'animate-flash' : ''}`}>
      <div className="p-4 flex gap-3.5">
        {/* Thumbnail / icon */}
        {isImage ? (
          <a
            href={fileUrl(item.file!.fileId)}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden bg-surface-2"
          >
            <img src={fileUrl(item.file!.fileId)} alt={item.file!.name} loading="lazy" className="w-full h-full object-cover" />
          </a>
        ) : (
          <div
            className={`shrink-0 w-12 h-12 rounded-xl flex items-center justify-center ${
              item.kind === 'link' ? 'bg-brand-soft text-brand' : 'bg-surface-2 text-muted'
            }`}
          >
            <Icon className="w-5 h-5" />
          </div>
        )}

        <div className="flex-1 min-w-0">
          {item.kind === 'link' && (
            <>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline break-all line-clamp-1">
                {host}
              </a>
              <p className="text-sm text-muted break-all line-clamp-2">{item.url}</p>
            </>
          )}
          {item.kind === 'text' && (
            <div>
              <p className={`text-[15px] whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}>{item.text}</p>
              {longText && (
                <button type="button" className="mt-1 text-sm font-semibold text-brand cursor-pointer" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}
          {item.file && (
            <>
              <p className="font-semibold break-all line-clamp-2">{item.file.name}</p>
              <p className="text-sm text-muted">{formatBytes(item.file.size)}</p>
            </>
          )}

          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
            <DeviceIcon className="w-3.5 h-3.5" />
            <span className="truncate">{mine ? 'This device' : item.from.name}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={item.createdAt} className="shrink-0">
              {timeAgo(item.createdAt)}
            </time>
          </p>
        </div>
      </div>

      {/* Actions */}
      <div className="px-2 pb-2 flex items-center gap-1">
        {item.kind === 'link' && (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary min-h-10 px-3.5 text-sm">
            <ExternalLink className="w-4 h-4" /> Open
          </a>
        )}
        {item.kind === 'text' && (
          <button type="button" className="btn btn-primary min-h-10 px-3.5 text-sm" onClick={() => onCopy(item.text!, 'Text')}>
            <Copy className="w-4 h-4" /> Copy
          </button>
        )}
        {item.file && (
          <a href={fileUrl(item.file.fileId, true)} download={item.file.name} className="btn btn-primary min-h-10 px-3.5 text-sm">
            <Download className="w-4 h-4" /> Download
          </a>
        )}
        {item.file && canPreview && !isImage && (
          <a href={fileUrl(item.file.fileId)} target="_blank" rel="noreferrer" className="btn btn-ghost min-h-10 px-3 text-sm">
            Preview
          </a>
        )}

        <span className="flex-1" />

        {canNativeShare && (
          <button type="button" className="icon-btn" aria-label="Share to another app" onClick={nativeShare}>
            <Share2 className="w-4 h-4" />
          </button>
        )}
        {item.kind !== 'text' && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Copy link"
            onClick={() => onCopy(item.url ?? fileUrl(item.file!.fileId), 'Link')}
          >
            <Copy className="w-4 h-4" />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Show QR code for this item" onClick={() => onShowQr(item)}>
          <QrCode className="w-4 h-4" />
        </button>
        <button type="button" className="icon-btn hover:!text-danger" aria-label="Delete for everyone" onClick={() => onDelete(item)}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </li>
  );
}
