import { useEffect, useRef, useState } from 'react';
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
import { fileKindOf, formatBytes, isInlineSafeMime, timeAgo } from '../lib/shared';
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
  // Only offer Preview when the server will actually show it in the browser (not .mov / .m4a etc.).
  const canPreview = !!item.file && isInlineSafeMime(item.file.mime);
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

  // Browsers only open the share sheet straight from a tap, so a file must already be
  // downloaded by then. We start downloading when the finger touches Share (never in
  // the background); if it isn't ready by the tap, the button asks for a second tap.
  const SHARE_FILE_MAX = 10 * 1024 * 1024;
  const shareFile = useRef<File | null>(null);
  const [shareState, setShareState] = useState<'idle' | 'loading' | 'ready'>('idle');
  useEffect(
    () => () => {
      shareFile.current = null; // release memory when the card goes away
    },
    []
  );

  const prepareShare = () => {
    const meta = item.file;
    if (!meta || meta.size > SHARE_FILE_MAX || shareState !== 'idle') return;
    setShareState('loading');
    fetch(fileUrl(meta.fileId))
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((blob) => {
        shareFile.current = new window.File([blob], meta.name, { type: meta.mime });
        setShareState('ready');
      })
      .catch(() => setShareState('idle'));
  };

  const nativeShare = () => {
    let p: Promise<void>;
    if (item.file) {
      const f = shareFile.current;
      if (f && navigator.canShare?.({ files: [f] })) p = navigator.share({ files: [f], title: item.file.name });
      else if (item.file.size <= SHARE_FILE_MAX && shareState !== 'ready') {
        prepareShare(); // still downloading: the button shows "tap again"
        return;
      } else p = navigator.share({ url: fileUrl(item.file.fileId), title: item.file.name });
    } else if (item.url) p = navigator.share({ url: item.url });
    else p = navigator.share({ text: item.text ?? '' });
    p.catch(() => {}); // cancelled
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
            <img
              src={fileUrl(item.file!.fileId)}
              alt={item.file!.name}
              loading="lazy"
              crossOrigin="anonymous"
              className="w-full h-full object-cover"
            />
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
          <button
            type="button"
            className={`icon-btn relative ${shareState === 'loading' ? 'animate-pulse' : ''}`}
            aria-label={shareState === 'loading' ? 'Preparing file to share' : shareState === 'ready' ? 'File ready, tap to share' : 'Share to another app'}
            onPointerDown={prepareShare}
            onClick={nativeShare}
          >
            <Share2 className="w-4 h-4" />
            {shareState === 'ready' && <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-live" />}
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
