import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Paperclip, UploadCloud, X } from 'lucide-react';
import type { RoomSession, SharedItem } from '../types/share';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, formatBytes, toHttpUrl } from '../lib/shared';
import { api, uid, uploadFile } from '../lib/api';
import { useToast } from './Toasts';

interface Upload {
  key: string;
  name: string;
  size: number;
  progress: number;
  cancel: () => void;
}

interface Props {
  session: RoomSession;
  peerCount: number;
  onSent: (item: SharedItem) => void;
}

export function Composer({ session, peerCount, onSent }: Props) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const isLink = !!toHttpUrl(text);

  const sendText = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    if (value.length > MAX_TEXT_CHARS) {
      // Very long notes travel as a .txt file instead of being cut off.
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      addFiles([new File([text], `note-${stamp}.txt`, { type: 'text/plain' })]);
      setText('');
      return;
    }
    setSending(true);
    try {
      const { item } = await api.sendText(session, value);
      onSent(item);
      setText('');
    } catch (err) {
      toast({ tone: 'error', title: 'Not sent', body: err instanceof Error ? err.message : undefined });
    } finally {
      setSending(false);
      textRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends on computers; Shift+Enter makes a new line. On phones Enter is a new line.
    // Never send while an input method (Japanese, Chinese, Hindi transliteration…) is composing.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && !coarse))) {
      e.preventDefault();
      sendText();
    }
  };

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        toast({ tone: 'error', title: `${file.name} is too large`, body: `Max ${formatBytes(MAX_FILE_BYTES)} per file.` });
        continue;
      }
      if (file.size === 0) continue;
      const key = uid();
      const { promise, cancel } = uploadFile(sessionRef.current, file, (p) =>
        setUploads((list) => list.map((u) => (u.key === key ? { ...u, progress: p } : u)))
      );
      setUploads((list) => [...list, { key, name: file.name || 'Pasted file', size: file.size, progress: 0, cancel }]);
      promise
        .then((item) => onSent(item))
        .catch((err) => {
          if (err?.status !== -1) toast({ tone: 'error', title: `${file.name} failed`, body: err?.message });
        })
        .finally(() => setUploads((list) => list.filter((u) => u.key !== key)));
    }
  };

  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  // Drop files anywhere on the page, or paste a screenshot with Ctrl/Cmd+V.
  useEffect(() => {
    const addFiles = (files: FileList | File[]) => addFilesRef.current(files);
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
    };
    const paste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      const files = dt?.files;
      if (!dt || !files || files.length === 0) return;
      const t = e.target as HTMLElement | null;
      const inTextField =
        !!t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'file') || t.isContentEditable);
      // The PIN box is for digits only, never for uploading.
      if (t?.getAttribute('aria-label') === '6-digit PIN') return;
      // Excel/Word/Numbers copy text plus a picture of it: keep the text.
      const hasText = dt.getData('text/plain').trim().length > 0;
      const onlyImages = Array.from(files).every((f) => f.type.startsWith('image/'));
      if (inTextField && hasText && onlyImages) return;
      e.preventDefault();
      addFiles(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
    };
  }, []);

  // Auto-grow the text box.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  return (
    <section aria-label="Send something" className="card p-3 sm:p-4">
      <form onSubmit={sendText}>
        <label htmlFor="composer-text" className="sr-only">
          Paste a link or type a note
        </label>
        <textarea
          id="composer-text"
          ref={textRef}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={peerCount > 0 ? 'Paste a link or type a note…' : 'Paste a link or type a note… (connect a device to send it across)'}
          className="field resize-none px-4 py-3 text-base leading-relaxed min-h-[72px]"
        />
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className="btn btn-outline" onClick={() => fileInput.current?.click()}>
            <Paperclip className="w-4 h-4" />
            <span>Add files</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <p className="hidden sm:block text-xs text-muted flex-1 truncate">
            {text.length > MAX_TEXT_CHARS
              ? 'Long note: it will be sent as a .txt file.'
              : `Photos, PDFs, docs, any file up to ${formatBytes(MAX_FILE_BYTES)}. Drop or paste anywhere.`}
          </p>
          <span className="sm:hidden flex-1" />
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || sending}>
            <span>{isLink ? 'Send link' : 'Send'}</span>
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </form>

      {uploads.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Uploads in progress">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-xl bg-surface-2 px-3 py-2.5">
              <div className="flex items-center gap-3 text-sm">
                <span className="flex-1 truncate font-medium">{u.name}</span>
                <span className="text-xs text-muted tabular-nums">
                  {Math.round(u.progress * 100)}% · {formatBytes(u.size)}
                </span>
                <button type="button" className="icon-btn w-7 h-7" aria-label={`Cancel ${u.name}`} onClick={u.cancel}>
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-2 h-1 rounded-full bg-line overflow-hidden">
                <div className="h-full bg-brand transition-[width]" style={{ width: `${u.progress * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {dragging && (
        <div className="fixed inset-0 z-50 p-4 sm:p-8 bg-bg/80 backdrop-blur-sm pointer-events-none">
          <div className="w-full h-full rounded-3xl border-2 border-dashed border-brand bg-brand-soft/60 flex flex-col items-center justify-center gap-3 text-center">
            <UploadCloud className="w-12 h-12 text-brand" />
            <p className="text-xl font-bold">Drop to send</p>
            <p className="text-sm text-muted">Files go to every device in this room</p>
          </div>
        </div>
      )}
    </section>
  );
}
