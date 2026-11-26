import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Bookmark, Clock, Paperclip, UploadCloud } from 'lucide-react';
import type { Retention, StoredItem } from '../types/share';
import { MAX_FILE_BYTES, MAX_TEXT_CHARS, formatBytes, toHttpUrl } from '../lib/shared';
import { loadPref, savePref } from '../lib/settings';
import { useToast } from './Toasts';

interface Props {
  deviceCount: number;
  /** Text to pre-fill (e.g. shared into the app from another app). */
  initialText?: string;
  sendText: (text: string, retention: Retention) => Promise<StoredItem | null>;
  sendFile: (file: File, retention: Retention) => Promise<StoredItem | null>;
}

export function Composer({ deviceCount, initialText, sendText, sendFile }: Props) {
  const [text, setText] = useState(initialText ?? '');
  const [retention, setRetentionState] = useState<Retention>(() => loadPref<Retention>('retention', 'temp'));
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  const setRetention = (r: Retention) => {
    setRetentionState(r);
    savePref('retention', r);
  };
  const retentionRef = useRef(retention);
  retentionRef.current = retention;

  useEffect(() => {
    if (initialText) setText(initialText);
  }, [initialText]);

  const isLink = !!toHttpUrl(text);
  const tooLong = text.length > MAX_TEXT_CHARS;

  const notifyQueued = (item: StoredItem | null) => {
    if (item?.status === 'pending') {
      toast({ tone: 'info', title: 'Saved on this device', body: 'It will be sent as soon as one of your devices connects.' }, 4000);
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_BYTES) {
        toast({ tone: 'error', title: `${file.name} is too large`, body: `Max ${formatBytes(MAX_FILE_BYTES)} per file.` });
        continue;
      }
      if (file.size === 0) continue;
      try {
        notifyQueued(await sendFile(file, retentionRef.current));
      } catch (err) {
        toast({ tone: 'error', title: `${file.name} could not be saved`, body: err instanceof Error ? err.message : 'Storage may be full.' });
      }
    }
  };
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    try {
      if (tooLong) {
        // Very long notes travel as a .txt file instead of being cut off.
        const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
        await addFiles([new File([text], `note-${stamp}.txt`, { type: 'text/plain' })]);
      } else {
        notifyQueued(await sendText(text, retention));
      }
      // Saved on this device first, so it's safe to clear the box now.
      setText((t) => (t === text ? '' : t));
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
      void submit();
    }
  };

  // Drop files anywhere on the page, or paste a screenshot with Ctrl/Cmd+V.
  useEffect(() => {
    const add = (files: FileList | File[]) => void addFilesRef.current(files);
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
      if (e.dataTransfer?.files.length) add(e.dataTransfer.files);
    };
    const paste = (e: ClipboardEvent) => {
      const dt = e.clipboardData;
      const files = dt?.files;
      if (!dt || !files || files.length === 0) return;
      const t = e.target as HTMLElement | null;
      const inTextField =
        !!t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'file') || t.isContentEditable);
      // The PIN box is for digits only, never for sending files.
      if (t?.getAttribute('aria-label') === '6-digit PIN') return;
      // Excel/Word/Numbers copy text plus a picture of it: keep the text.
      const hasText = dt.getData('text/plain').trim().length > 0;
      const onlyImages = Array.from(files).every((f) => f.type.startsWith('image/'));
      if (inTextField && hasText && onlyImages) return;
      e.preventDefault();
      add(files);
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

  const options: Array<{ id: Retention; label: string; hint: string; icon: typeof Clock }> = [
    { id: 'temp', label: 'Temporary', hint: 'Gone in 24 h', icon: Clock },
    { id: 'saved', label: 'Save', hint: 'Until you delete it', icon: Bookmark },
  ];

  return (
    <section aria-label="Send something" className="card p-3 sm:p-4">
      <form onSubmit={submit}>
        <div role="radiogroup" aria-label="Keep it for" className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-surface-2 mb-3">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={retention === o.id}
              onClick={() => setRetention(o.id)}
              className={`min-h-11 px-2 rounded-lg text-left flex items-center gap-2 transition-colors cursor-pointer ${
                retention === o.id ? 'bg-surface shadow-sm text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              <o.icon className={`w-4 h-4 shrink-0 ${retention === o.id ? 'text-brand' : ''}`} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold leading-tight">{o.label}</span>
                <span className="block text-[11px] leading-tight opacity-80 truncate">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>

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
          placeholder={deviceCount > 0 ? 'Paste a link or type a note…' : 'Paste a link or type a note… (sent when a device connects)'}
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
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <p className="hidden sm:block text-xs text-muted flex-1 truncate">
            {tooLong
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

      {dragging && (
        <div className="fixed inset-0 z-50 p-4 sm:p-8 bg-bg/80 backdrop-blur-sm pointer-events-none">
          <div className="w-full h-full rounded-3xl border-2 border-dashed border-brand bg-brand-soft/60 flex flex-col items-center justify-center gap-3 text-center">
            <UploadCloud className="w-12 h-12 text-brand" />
            <p className="text-xl font-bold">Drop to send</p>
            <p className="text-sm text-muted">{retention === 'saved' ? 'Saved on your devices' : 'Temporary: gone after 24 hours'}</p>
          </div>
        </div>
      )}
    </section>
  );
}
