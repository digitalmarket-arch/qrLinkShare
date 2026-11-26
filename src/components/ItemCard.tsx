import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Bookmark,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Eye,
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
  RotateCw,
  Share2,
  Smartphone,
  StickyNote,
  Tablet,
  Trash2,
} from 'lucide-react';
import type { FileKind, StoredItem } from '../types/share';
import { fileKindOf, formatBytes, formatTimeLeft, isInlineSafeMime, msUntilExpiry, timeAgo } from '../lib/shared';
import { downloadBlob } from '../lib/browser';
import { splitLinks } from '../lib/linkify';
import { qrPayloadFor } from '../lib/qrPayload';

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

/** File types Chrome/Safari will actually share as files (Chromium's allow-list). */
const SHAREABLE_EXT = /\.(avif|bmp|csv|flac|gif|ico|jfif|jpe?g|m4a|m4v|mp3|mp4|mpe?g|oga|ogg|ogv|opus|pdf|pjpe?g|png|tiff?|txt|wav|weba|webm|webp)$/i;
const SHAREABLE_MIME = /^(image\/(jpeg|png|webp|gif|avif|bmp|tiff|x-icon)|application\/pdf|text\/(plain|csv)|video\/(mp4|webm|mpeg|ogg)|audio\/(mpeg|mp3|mp4|ogg|wav|webm|flac|x-m4a|opus))$/i;

interface Props {
  item: StoredItem;
  myDeviceId: string;
  fresh: boolean;
  /** 0..1 while this item is being sent or received. */
  progress?: number;
  /** Some device is connected right now (so a waiting item is about to go out). */
  online: boolean;
  /** Names of known devices, for "couldn't be saved on <name>". */
  deviceNames: Record<string, string>;
  getBlob: (id: string) => Promise<Blob | undefined>;
  onCopy: (text: string, what: string) => void;
  onShowQr: (item: StoredItem) => void;
  onKeep: (item: StoredItem) => void;
  onDelete: (item: StoredItem) => void;
  onRetry: (item: StoredItem) => void;
  onProblem: (message: string) => void;
}

/** One item card. Memoised: the feed re-renders often (progress), cards only when their own data changes. */
export const ItemCard = memo(function ItemCard({
  item,
  myDeviceId,
  fresh,
  progress,
  online,
  deviceNames,
  getBlob,
  onCopy,
  onShowQr,
  onKeep,
  onDelete,
  onRetry,
  onProblem,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const mine = item.from.id === myDeviceId;
  const DeviceIcon = DEVICE_ICONS[item.from.type] ?? Monitor;
  const available = item.status === 'ready' || item.status === 'pending';
  /** Devices that couldn't take this item (own items only), e.g. because their storage is full. */
  const refusals = mine ? Object.entries(item.refusedBy ?? {}).filter(([id]) => !(item.deliveredTo ?? []).includes(id)) : [];

  const kind = item.file ? fileKindOf(item.file.mime, item.file.name) : null;
  const isImage = kind === 'image' && !!item.file && /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(item.file.mime);
  const canPreview = !!item.file && isInlineSafeMime(item.file.mime) && !isImage;
  const longText = (item.text?.length ?? 0) > 280 || (item.text?.split('\n').length ?? 0) > 6;
  // Links inside a note become clickable.
  const noteParts = useMemo(() => (item.kind === 'text' ? splitLinks(item.text ?? '') : []), [item.kind, item.text]);
  const canShowQr = useMemo(
    () => qrPayloadFor({ kind: item.kind, text: item.text, url: item.url })?.ok === true,
    [item.kind, item.text, item.url]
  );

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

  // Image thumbnails come straight from this device's storage.
  useEffect(() => {
    if (!isImage || !available) return;
    let url: string | null = null;
    let alive = true;
    void getBlob(item.id).then((blob) => {
      if (!alive || !blob) return;
      url = URL.createObjectURL(blob);
      setThumb(url);
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [item.id, isImage, available, getBlob]);

  // Keep the file ready while a finger is on Share, so the share sheet opens straight from the tap.
  const fileRef = useRef<globalThis.File | null>(null);
  const loadFile = async () => {
    if (fileRef.current || !item.file) return fileRef.current;
    const blob = await getBlob(item.id);
    if (blob) fileRef.current = new window.File([blob], item.file.name, { type: item.file.mime });
    return fileRef.current;
  };
  useEffect(
    () => () => {
      fileRef.current = null;
    },
    []
  );

  const canNativeShare = typeof navigator !== 'undefined' && 'share' in navigator && matchMedia('(pointer: coarse)').matches;
  const fileShareable = useMemo(() => {
    const m = item.file;
    if (!canNativeShare || !m || typeof navigator.canShare !== 'function') return false;
    // Chrome's canShare() says yes to types it then refuses, so check its allow-list ourselves.
    if (!SHAREABLE_EXT.test(m.name) || !SHAREABLE_MIME.test(m.mime)) return false;
    try {
      return navigator.canShare({ files: [new window.File([], m.name, { type: m.mime })] });
    } catch {
      return false;
    }
  }, [item.id, canNativeShare]);

  const nativeShare = async () => {
    try {
      if (item.file) {
        if (!fileShareable) return onProblem('This type of file can’t be shared to other apps. Download it instead.');
        const f = await loadFile();
        if (f) await navigator.share({ files: [f], title: item.file.name });
      } else if (item.url) await navigator.share({ url: item.url });
      else await navigator.share({ text: item.text ?? '' });
    } catch (err) {
      if ((err as DOMException)?.name === 'NotAllowedError') onProblem('Your browser blocked sharing. Tap Share again.');
    }
  };

  const download = async () => {
    const blob = await getBlob(item.id);
    if (!blob || !item.file) return onProblem('This file is no longer on this device.');
    downloadBlob(blob, item.file.name);
  };

  const preview = async () => {
    // Open the tab right away (browsers only allow pop-ups straight from a tap), then fill it.
    const win = window.open('about:blank', '_blank');
    const blob = await getBlob(item.id);
    if (!blob || !win) {
      win?.close();
      return onProblem(win ? 'This file is no longer on this device.' : 'Allow pop-ups to preview files.');
    }
    win.opener = null;
    win.location.href = URL.createObjectURL(blob);
  };

  const left = msUntilExpiry(item);
  const pct = progress !== undefined ? Math.round(progress * 100) : null;

  return (
    <li className={`card overflow-hidden ${fresh ? 'animate-flash' : ''}`}>
      <div className="p-4 flex gap-3.5">
        {isImage && thumb ? (
          <button
            type="button"
            onClick={download}
            aria-label={`Download ${item.file!.name}`}
            className="shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-xl overflow-hidden bg-surface-2 cursor-pointer"
          >
            <img src={thumb} alt="" className="w-full h-full object-cover" />
          </button>
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
              <p className={`text-[15px] whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}>
                {noteParts.map((part, i) =>
                  part.kind === 'link' ? (
                    <a
                      key={i}
                      href={part.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand underline underline-offset-2 break-all"
                    >
                      {part.text}
                    </a>
                  ) : (
                    <Fragment key={i}>{part.text}</Fragment>
                  )
                )}
              </p>
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

          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
            <DeviceIcon className="w-3.5 h-3.5" />
            <span className="truncate max-w-[12rem]">{mine ? 'This device' : item.from.name}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={item.createdAt} className="shrink-0">
              {timeAgo(item.createdAt)}
            </time>
            {item.retention === 'temp' && Number.isFinite(left) && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1 shrink-0">
                  <Clock className="w-3 h-3" /> gone in {formatTimeLeft(left)}
                </span>
              </>
            )}
          </p>

          {item.status === 'pending' && mine && pct === null && !refusals.length && (
            <p className={`mt-1.5 text-xs font-semibold ${online ? 'text-brand' : 'text-warn'}`}>
              {online ? 'Sending…' : 'Waiting to send. It goes out when one of your devices connects.'}
            </p>
          )}
          {refusals.map(([id, reason]) => (
            <p key={id} className="mt-1.5 text-xs font-semibold text-danger flex items-start gap-1">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              {reason === 'no-space'
                ? `Couldn’t be saved on ${deviceNames[id] ?? 'the other device'}: not enough space there. Free up space, then tap Try again.`
                : `${deviceNames[id] ?? 'The other device'} couldn’t accept this.`}
            </p>
          ))}
          {item.status === 'receiving' && <p className="mt-1.5 text-xs font-semibold text-brand">Receiving{pct !== null ? ` ${pct}%` : '…'}</p>}
          {item.status === 'pending' && pct !== null && <p className="mt-1.5 text-xs font-semibold text-brand">Sending {pct}%</p>}
          {item.status === 'failed' && (
            <p className="mt-1.5 text-xs font-semibold text-danger flex items-start gap-1">
              <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
              {item.failReason === 'no-space'
                ? `Not enough space on this device to save it. Free up space, then ask ${item.from.name} to tap Try again.`
                : item.failReason === 'sender-gone'
                  ? `Not received: ${item.from.name} disconnected from this device before it finished. Ask for it again if you still need it.`
                  : `Transfer interrupted. It’s sent again automatically when ${item.from.name} is back online.`}
            </p>
          )}
          {pct !== null && (
            <div className="mt-1.5 h-1 rounded-full bg-line overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-brand transition-[width]" style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="px-2 pb-2 flex items-center gap-1">
        {item.kind === 'link' && (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary min-h-10 px-3.5 text-sm">
            <ExternalLink className="w-4 h-4" /> <span className="max-[379px]:sr-only">Open</span>
          </a>
        )}
        {item.kind === 'text' && (
          <button type="button" className="btn btn-primary min-h-10 px-3.5 text-sm" onClick={() => onCopy(item.text!, 'Text')}>
            <Copy className="w-4 h-4" /> <span className="max-[379px]:sr-only">Copy</span>
          </button>
        )}
        {item.file && available && (
          <button type="button" className="btn btn-primary min-h-10 px-3.5 text-sm" onClick={download}>
            <Download className="w-4 h-4" /> <span className="max-[379px]:sr-only">Download</span>
          </button>
        )}
        {canPreview && available && (
          <button type="button" className="icon-btn" aria-label="Preview in the browser" title="Preview" onClick={preview}>
            <Eye className="w-4 h-4" />
          </button>
        )}

        <span className="flex-1" />

        {item.retention === 'temp' && available && (
          <button type="button" className="icon-btn hover:!text-brand" aria-label="Keep forever (move to Saved)" title="Save" onClick={() => onKeep(item)}>
            <Bookmark className="w-4 h-4" />
          </button>
        )}
        {mine && pct === null && (item.status === 'pending' || refusals.length > 0) && (
          <button type="button" className="icon-btn" aria-label="Try sending again" title="Try again" onClick={() => onRetry(item)}>
            <RotateCw className="w-4 h-4" />
          </button>
        )}
        {canNativeShare && available && (
          <button type="button" className="icon-btn" aria-label="Share to another app" onPointerDown={() => void loadFile()} onClick={nativeShare}>
            <Share2 className="w-4 h-4" />
          </button>
        )}
        {item.kind === 'link' && (
          <button type="button" className="icon-btn" aria-label="Copy link" onClick={() => onCopy(item.url!, 'Link')}>
            <Copy className="w-4 h-4" />
          </button>
        )}
        {canShowQr && (
          <button type="button" className="icon-btn" aria-label="Show QR code for this item" onClick={() => onShowQr(item)}>
            <QrCode className="w-4 h-4" />
          </button>
        )}
        <button type="button" className="icon-btn hover:!text-danger" aria-label="Delete from this device" onClick={() => onDelete(item)}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </li>
  );
});
