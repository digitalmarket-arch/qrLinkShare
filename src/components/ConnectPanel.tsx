import { lazy, Suspense, useEffect, useState } from 'react';
import { ChevronDown, Copy, KeyRound, QrCode as QrIcon, RefreshCw, ScanLine, Wallet } from 'lucide-react';
import type { RoomSession } from '../types/share';
import { formatPin } from '../lib/shared';
import { copyText, pairingLink } from '../lib/api';
import { usePairing } from '../hooks/usePairing';
import { QrCode } from './QrCode';
import { PinInput } from './PinInput';
import { useToast } from './Toasts';

// The camera scanner (and its QR decoder) only loads when someone opens the Scan tab.
const QrScanner = lazy(() => import('./QrScanner').then((m) => ({ default: m.QrScanner })));

type Tab = 'show' | 'pin' | 'scan';

interface Props {
  session: RoomSession;
  isMobile: boolean;
  /** Other devices are already connected, so show a compact version. */
  compact: boolean;
  busy: boolean;
  /** Bumped by the parent whenever a code was used, so we fetch a fresh one. */
  refreshSignal: number;
  onClaimPin: (pin: string) => Promise<void>;
  onScanned: (text: string) => void;
  onGoogle: () => void;
  onWallet: () => void;
}

export function ConnectPanel(props: Props) {
  const { session, isMobile, compact, busy, refreshSignal } = props;
  const [tab, setTab] = useState<Tab>(isMobile ? 'pin' : 'show');
  const [expanded, setExpanded] = useState(!compact);
  const toast = useToast();

  useEffect(() => setExpanded(!compact), [compact]);

  const showing = expanded && tab === 'show';
  const pairing = usePairing(session, showing);

  useEffect(() => {
    if (refreshSignal > 0 && showing) pairing.refresh();
  }, [refreshSignal]);

  const link = pairing.code ? pairingLink(pairing.code.pairToken) : '';
  const isAccount = session.method === 'google' || session.method === 'wallet';

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
        aria-expanded={expanded}
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
          <ChevronDown className={`w-5 h-5 text-muted shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        )}
      </button>

      {expanded && (
        <div className="mt-5">
          {/* Tabs */}
          <div role="tablist" aria-label="Pairing method" className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-surface-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={`min-h-10 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${
                  tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                }`}
              >
                <t.icon className="w-4 h-4" />
                {t.label}
              </button>
            ))}
          </div>

          <div className="mt-5" role="tabpanel">
            {tab === 'show' && (
              <div className="flex flex-col items-center text-center">
                {pairing.error ? (
                  <div className="w-full rounded-2xl bg-surface-2 p-6 text-sm text-muted">
                    <p>{pairing.error}</p>
                    <button type="button" className="btn btn-outline mt-4" onClick={pairing.refresh}>
                      <RefreshCw className="w-4 h-4" /> Try again
                    </button>
                  </div>
                ) : (
                  <>
                    <QrCode
                      value={link || 'about:blank'}
                      size={isMobile ? 200 : 232}
                      label="QR code to pair another device"
                      className={pairing.code ? '' : 'opacity-40'}
                    />
                    <p className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">or enter this PIN</p>
                    <p className="mt-1 font-mono text-4xl font-semibold tracking-[0.12em] tabular-nums" aria-live="polite">
                      {pairing.code ? formatPin(pairing.code.pin) : '··· ···'}
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
                            disabled={!link}
                            onClick={() =>
                              copyText(link)
                                .then(() => toast({ tone: 'success', title: 'Pairing link copied', body: 'Open it on the other device within 3 minutes.' }))
                                .catch(() => {})
                            }
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      </div>
                    </div>
                    <p className="mt-4 text-xs text-muted">Each code works once and expires after 3 minutes.</p>
                  </>
                )}
              </div>
            )}

            {tab === 'pin' && (
              <div>
                <p className="text-sm text-muted mb-4">
                  On the other device, open this website and choose <b className="text-ink">Show code</b>. Then type the 6 digits here.
                </p>
                <PinInput disabled={busy} onComplete={(pin) => props.onClaimPin(pin)} />
                {busy && <p className="mt-3 text-sm text-muted">Connecting…</p>}
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

          {/* Account sign-in */}
          {!isAccount && (
            <div className="mt-6 pt-5 border-t border-line">
              <p className="text-sm font-semibold">Or sign in on both devices</p>
              <p className="text-sm text-muted mt-0.5">
                Every device signed in to the same account connects automatically. No codes needed.
              </p>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2 gap-2">
                <button type="button" className="btn btn-outline" disabled={busy} onClick={props.onGoogle}>
                  <GoogleMark /> Continue with Google
                </button>
                <button type="button" className="btn btn-outline" disabled={busy} onClick={props.onWallet}>
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
