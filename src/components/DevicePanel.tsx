import { useEffect, useRef, useState } from 'react';
import { DownloadCloud, HardDrive, Info, ShieldCheck, UploadCloud } from 'lucide-react';
import { formatBytes } from '../lib/shared';
import { storageEstimate } from '../lib/db';
import { isIOS, safariMayDelete } from '../lib/browser';

interface Props {
  privateMode: boolean;
  /** Items survive closing the tab (false when the browser blocks storage). */
  persistent: boolean;
  /** The browser promised not to clear our data (null: unknown). */
  persisted: boolean | null;
  savedCount: number;
  onTogglePrivate: () => Promise<void>;
  onBackup: () => Promise<void>;
  onRestore: (file: File) => Promise<void>;
}

/** "Where is my data?" + keep-nothing switch + backup/restore. */
export function DevicePanel({ privateMode, persistent, persisted, savedCount, onTogglePrivate, onBackup, onRestore }: Props) {
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const restoreInput = useRef<HTMLInputElement>(null);
  const safari = safariMayDelete();
  const ios = isIOS();

  useEffect(() => {
    void storageEstimate().then(setUsage);
  }, [savedCount]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      // the action shows its own message
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
          ? 'Nothing is kept on this computer: closing or reloading this tab clears everything, including the pairing.'
          : !persistent
            ? 'This browser won’t let qrLinkShare store anything: items disappear when you reload or close this tab.'
            : 'Everything you share is stored only on your devices, in this browser. Nothing you share is stored on any server.'}
      </p>
      <p className="mt-2 text-xs text-muted">
        To find each other, devices pass a tiny encrypted “here I am” through public relays, and each asks a public address service
        (Cloudflare’s) for its own internet address. Those services never see what you send.
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
          disabled={busy}
          onClick={() => run(onTogglePrivate)}
          className={`relative mt-0.5 w-10 h-6 shrink-0 rounded-full transition-colors cursor-pointer ${privateMode ? 'bg-brand' : 'bg-line'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${privateMode ? 'translate-x-4' : ''}`} />
        </button>
        <span>
          <span id="private-label" className="block text-sm font-semibold">
            Keep nothing on this computer{busy && !privateMode ? ' (deleting…)' : ''}
          </span>
          <span className="block text-xs text-muted">For shared or office computers. Nothing is saved once you close or reload the tab.</span>
        </span>
      </label>

      {!privateMode && persistent && (
        <div className="mt-4 pt-4 border-t border-line">
          {safari && (
            <p className="mb-3 rounded-xl bg-surface-2 p-3 text-xs flex items-start gap-2" role="note">
              <Info className="w-4 h-4 shrink-0 text-warn" />
              {ios ? (
                <span>
                  <b>iPhone / iPad:</b> Safari deletes a website’s data (Saved items and pairing) after 7 days of using Safari without
                  opening it. To keep them: tap <b>Backup</b>, then <b>Share → Add to Home Screen</b>. Open qrLinkShare from the Home Screen,
                  tap <b>Restore</b> and pair again there (the Home Screen app starts empty).
                </span>
              ) : (
                <span>
                  <b>Safari on Mac:</b> Safari deletes a website’s data (Saved items and pairing) after 7 days of using Safari without opening
                  it. Tap <b>Backup</b> now and then, or use qrLinkShare in another browser, or add it to the Dock (File → Add to Dock).
                </span>
              )}
            </p>
          )}
          <p className="text-xs text-muted">
            Your saved items exist only on your devices. If you clear this browser’s data, they’re gone, so download a backup now and then.
            {persisted === false && !safari && ' This browser may also clear storage when the device runs low on space.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-outline text-sm" disabled={busy || savedCount === 0} onClick={() => run(onBackup)}>
              <DownloadCloud className="w-4 h-4" /> Backup
            </button>
            <button type="button" className="btn btn-outline text-sm" disabled={busy} onClick={() => restoreInput.current?.click()}>
              <UploadCloud className="w-4 h-4" /> Restore
            </button>
          </div>
          {/* No "accept" filter: phone file pickers grey out file types they don't know. */}
          <input
            ref={restoreInput}
            type="file"
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
