import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, ShieldCheck, Wallet } from 'lucide-react';
import { Modal } from './Modal';
import { discoverWallets, mobileWalletLinks, type WalletOption } from '../lib/wallet';

interface Props {
  open: boolean;
  isMobile: boolean;
  busyWallet: string | null;
  onClose: () => void;
  onPick: (wallet: WalletOption) => void;
}

export function WalletModal({ open, isMobile, busyWallet, onClose, onPick }: Props) {
  const [wallets, setWallets] = useState<WalletOption[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setWallets(null);
    discoverWallets().then(setWallets);
  }, [open]);

  return (
    <Modal open={open} title="Connect a wallet" onClose={onClose}>
      <p className="text-sm text-muted">
        Sign a free message to prove you own the address. Every device signed in with the same wallet shares files automatically.
      </p>

      <div className="mt-4 space-y-2">
        {wallets === null && (
          <div className="flex items-center gap-2 text-sm text-muted py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Looking for wallets…
          </div>
        )}

        {wallets?.map((w) => (
          <button
            key={w.id}
            type="button"
            disabled={!!busyWallet}
            onClick={() => onPick(w)}
            className="btn btn-outline w-full justify-start min-h-14"
          >
            {w.icon ? <img src={w.icon} alt="" className="w-7 h-7 rounded-lg" /> : <Wallet className="w-6 h-6" />}
            <span className="flex-1 text-left">{w.name}</span>
            {busyWallet === w.id && <Loader2 className="w-4 h-4 animate-spin" />}
          </button>
        ))}

        {wallets?.length === 0 &&
          (isMobile ? (
            <>
              <p className="text-sm font-semibold pt-1">Open this page in your wallet app</p>
              {mobileWalletLinks().map((l) => (
                <a key={l.name} href={l.href} className="btn btn-outline w-full justify-between min-h-14">
                  {l.name} <ExternalLink className="w-4 h-4 text-muted" />
                </a>
              ))}
            </>
          ) : (
            <div className="rounded-xl bg-surface-2 p-4 text-sm">
              <p className="font-semibold">No wallet found in this browser</p>
              <p className="text-muted mt-1">Install a wallet extension such as MetaMask, then reload this page.</p>
              <a href="https://metamask.io/download/" target="_blank" rel="noreferrer" className="btn btn-primary mt-3">
                Get MetaMask <ExternalLink className="w-4 h-4" />
              </a>
            </div>
          ))}
      </div>

      <p className="mt-5 flex items-start gap-2 text-xs text-muted">
        <ShieldCheck className="w-4 h-4 shrink-0 text-live" />
        Signing costs no gas and does not let this site move your funds. Never sign a transaction here.
      </p>
    </Modal>
  );
}
