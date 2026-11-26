import { useEffect, useRef, useState } from 'react';
import { DownloadCloud, HardDrive, ShieldCheck, UploadCloud } from 'lucide-react';
import { formatBytes } from '../lib/shared';
import { storageEstimate } from '../lib/db';

interface Props {
  privateMode: boolean;
  persistent: boolean;
  savedCount: number;
  onTogglePrivate: () => void;
  onBackup: () => Promise<void>;
  onRestore: (file: File) => Promise<void>;
}

/** "Where is my data?" + keep-nothing switch + backup/restore. */
export function DevicePanel({ privateMode, persistent, savedCount, onTogglePrivate, onBackup, onRestore }: Props) {
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void storageEstimate().then(setUsage);
  }, [savedCount]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="device-title" className="card p-5">
      <h2 id="device-title" className="text-sm font-bold flex items-center gap-2">
        <HardDrive className="w-4 h-4 text-muted" /> Your data
      </h2>
      <p className="mt-2 text-sm text-muted flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-live" />
        {privateMode
          ? 'Nothing is kept on this computer: items disappear when you close this tab.'
          : 'Everything is stored only on your devices, in this browser. Nothing is stored on any server.'}
      </p>
      {!privateMode && usage && usage.used > 0 && (
        <p className="mt-2 text-xs text-muted">
          Using {formatBytes(usage.used)} on this device{usage.quota ? ` (of about ${formatBytes(usage.quota)} available)` : ''}.
        </p>
      )}

      <label className="mt-4 flex items-start gap-3 cursor-pointer select-none">
        <button
          type="button"
          role="switch"
          aria-checked={privateMode}
          aria-labelledby="private-label"
          onClick={onTogglePrivate}
          className={`relative mt-0.5 w-10 h-6 shrink-0 rounded-full transition-colors cursor-pointer ${privateMode ? 'bg-brand' : 'bg-line'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${privateMode ? 'translate-x-4' : ''}`} />
        </button>
        <span>
          <span id="private-label" className="block text-sm font-semibold">
            Keep nothing on this computer
          </span>
          <span className="block text-xs text-muted">For shared or office computers. Nothing is saved after you close the tab.</span>
        </span>
      </label>

      {!privateMode && (
        <div className="mt-4 pt-4 border-t border-line">
          <p className="text-xs text-muted">
            Your saved items exist only on your devices. If you clear this browser’s data, they’re gone, so download a backup now and then.
            {!persistent && ' This browser may clear storage when space runs low.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-outline text-sm" disabled={busy || savedCount === 0} onClick={() => run(onBackup)}>
              <DownloadCloud className="w-4 h-4" /> Backup
            </button>
            <button type="button" className="btn btn-outline text-sm" disabled={busy} onClick={() => restoreInput.current?.click()}>
              <UploadCloud className="w-4 h-4" /> Restore
            </button>
          </div>
          <input
            ref={restoreInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void run(() => onRestore(f));
            }}
          />
        </div>
      )}
    </section>
  );
}
