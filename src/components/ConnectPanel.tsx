import { lazy, Suspense, useEffect, useState } from 'react';
import { CameraOff, ChevronDown, Copy, KeyRound, Loader2, QrCode as QrIcon, RefreshCw, ScanLine, Wallet } from 'lucide-react';
import type { Account, DeviceInfo } from '../types/share';
import type { Mesh } from '../lib/mesh';
import { formatPin } from '../lib/shared';
import { copyText } from '../lib/browser';
import { usePairing } from '../hooks/usePairing';
import { QrCode } from './QrCode';
import { PinInput } from './PinInput';
import { useToast } from './Toasts';

/** The camera scanner (and its QR decoder) is a separate download. */
const loadScanner = () => import('./QrScanner');
const QrScanner = lazy(() =>
  loadScanner()
    .then((m) => ({ default: m.QrScanner }))
    // Offline, or a new version replaced the old files: show a message instead of a blank page.
    .catch(() => ({ default: ScannerUnavailable }))
);

function ScannerUnavailable() {
  return (
    <div className="aspect-square rounded-2xl bg-surface-2 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <CameraOff className="w-8 h-8 text-muted" />
      <p className="text-sm text-muted">Couldn’t load the camera scanner. You may be offline, or a new version of qrLinkShare is out.</p>
      <button type="button" className="btn btn-outline text-sm" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}

type Tab = 'show' | 'pin' | 'scan';

interface Props {
  mesh: Mesh | null;
  groupSecret: string;
  account: Account | null;
  isMobile: boolean;
  /** This device already has paired / signed-in devices, so show a compact version. */
  compact: boolean;
  /** Set while joining another device; shows what is happening. */
  joining: string | null;
  onCancelJoin: () => void;
  hasPaired: () => boolean;
  onKnock: (device: DeviceInfo, signal: AbortSignal) => Promise<boolean>;
  onAdopt: (secret: string, device: DeviceInfo) => Promise<void>;
  onPaired: (device: DeviceInfo, via: 'qr' | 'pin') => void;
  onEnterPin: (pin: string) => void;
  onScanned: (text: string) => void;
  onGoogle: () => void;
  onWallet: () => void;
}

export function ConnectPanel(props: Props) {
  const { mesh, isMobile, compact, joining } = props;
  const [tab, setTab] = useState<Tab>(isMobile ? 'pin' : 'show');
  const [expanded, setExpanded] = useState(!compact);
  const toast = useToast();

  useEffect(() => setExpanded(!compact), [compact]);

  // Fetch the scanner in the background once the app has settled, so the Scan tab works
  // offline and keeps working when a new version is published while this tab stays open.
  useEffect(() => {
    const prefetch = () => void loadScanner().catch(() => {});
    const ric = (window as Partial<Pick<Window, 'requestIdleCallback'>>).requestIdleCallback;
    if (ric) ric(prefetch, { timeout: 5000 });
    else setTimeout(prefetch, 3000);
  }, []);

  const open = expanded || !!joining;
  const showing = open && tab === 'show' && !joining;
  const pairing = usePairing({
    mesh,
    enabled: showing,
    groupSecret: props.groupSecret,
    hasPaired: props.hasPaired,
    onKnock: props.onKnock,
    onAdopt: props.onAdopt,
    onPaired: props.onPaired,
  });

  const tabs: Array<{ id: Tab; label: string; icon: typeof QrIcon }> = [
    { id: 'show', label: 'Show code', icon: QrIcon },
    { id: 'pin', label: 'Enter PIN', icon: KeyRound },
    { id: 'scan', label: 'Scan', icon: ScanLine },
  ];

  return (
    <section aria-labelledby="connect-title" className="card p-5 sm:p-6">
      <button
        type="button"
        className="w-full flex items-center justify-between gap-3 text-left"
        aria-expanded={open}
        onClick={() => setExpanded((v) => !v)}
        disabled={!compact}
      >
        <div>
          <h2 id="connect-title" className="text-lg font-bold">
            {compact ? 'Add another device' : 'Connect a device'}
          </h2>
          <p className="text-sm text-muted mt-0.5">
            {compact
              ? 'Pair one more phone, tablet or computer.'
              : isMobile
                ? 'Enter the PIN from your computer, or scan its QR code.'
                : 'Scan with your phone camera. No app needed.'}
          </p>
        </div>
        {compact && (
          <ChevronDown className={`w-5 h-5 text-muted shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        )}
      </button>

      {joining && (
        <div className="mt-5 rounded-2xl bg-surface-2 p-5 flex items-center gap-3" aria-live="polite">
          <Loader2 className="w-5 h-5 animate-spin text-brand shrink-0" />
          <p className="text-sm flex-1 min-w-0">{joining}</p>
          <button type="button" className="btn btn-ghost text-sm min-h-9 px-3 shrink-0" onClick={props.onCancelJoin}>
            Cancel
          </button>
        </div>
      )}

      {open && !joining && (
        <div className="mt-5">
          <div role="tablist" aria-label="Pairing method" className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-surface-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`min-h-10 px-1 rounded-lg text-sm font-semibold whitespace-nowrap flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                <t.icon className="w-4 h-4 shrink-0 max-[399px]:hidden" />
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-5" role="tabpanel">
            {tab === 'show' && (
              <div className="flex flex-col items-center text-center">
                <QrCode value={pairing.link} size={isMobile ? 200 : 232} label="QR code to pair another device" />
                <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">or enter this PIN</p>
                <p className="mt-1 font-mono text-4xl font-semibold tracking-[0.12em] tabular-nums" aria-live="polite">
                  {formatPin(pairing.pin)}
                </p>
                <div className="mt-4 w-full max-w-60">
                  <div className="h-1 rounded-full bg-surface-2 overflow-hidden">
                    <div
                      className="h-full bg-brand transition-[width] duration-1000 ease-linear"
                      style={{ width: `${pairing.fractionLeft * 100}%` }}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted">
                    <span className="tabular-nums">
                      New code in {Math.floor(pairing.secondsLeft / 60)}:{String(pairing.secondsLeft % 60).padStart(2, '0')}
                    </span>
                    <span className="flex items-center gap-1">
                      <button type="button" className="hover:text-ink cursor-pointer p-1" onClick={pairing.refresh} aria-label="New code">
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        className="hover:text-ink cursor-pointer p-1"
                        aria-label="Copy pairing link"
                        onClick={() =>
                          copyText(pairing.link)
                            .then(() => toast({ tone: 'success', title: 'Pairing link copied', body: 'Open it on the other device within 3 minutes.' }))
                            .catch(() => {})
                        }
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  </div>
                </div>
                <p className="mt-4 text-xs text-muted max-w-xs">
                  Keep this screen open while the other device connects. Each code works once.
                </p>
              </div>
            )}

            {tab === 'pin' && (
              <div>
                <p className="text-sm text-muted mb-4">
                  On the other device, open this website and choose <b className="text-ink">Show code</b>. Then type the 6 digits here.
                </p>
                <PinInput disabled={!!joining} onComplete={props.onEnterPin} />
              </div>
            )}

            {tab === 'scan' && (
              <div>
                <Suspense fallback={<div className="aspect-square rounded-2xl bg-surface-2 animate-pulse" />}>
                  <QrScanner onResult={props.onScanned} />
                </Suspense>
                <p className="mt-3 text-xs text-muted">
                  Tip: on most phones you can also just open the normal camera app and point it at the code.
                </p>
              </div>
            )}
          </div>

          {!props.account && (
            <div className="mt-6 pt-5 border-t border-line">
              <p className="text-sm font-semibold">Or sign in on both devices</p>
              <p className="text-sm text-muted mt-0.5">
                Your devices signed in to the same Google account or wallet find each other automatically.
              </p>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-2">
                <button type="button" className="btn btn-outline" onClick={props.onGoogle}>
                  <GoogleMark /> Continue with Google
                </button>
                <button type="button" className="btn btn-outline" onClick={props.onWallet}>
                  <Wallet className="w-4 h-4" /> Connect wallet
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.2 3.5-8.8z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6H1.4a12 12 0 0 0 0 10.8l4-3z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z" />
    </svg>
  );
}
