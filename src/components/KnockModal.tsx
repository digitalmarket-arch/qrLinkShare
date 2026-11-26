import { Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import type { DeviceInfo } from '../types/share';
import { Modal } from './Modal';

const ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

export interface Knock {
  device: DeviceInfo;
  /** pin: it typed this device's PIN. account: it's signed in to the same Google account. */
  reason: 'pin' | 'account';
  /** The security code both screens show. */
  code: string;
}

/** "47 21" */
export const formatCode = (code: string) => `${code.slice(0, 2)} ${code.slice(2)}`;

/** "iPhone · Safari entered your PIN. Does it show 47 21? Allow?" */
export function KnockModal({ knock, onAnswer }: { knock: Knock | null; onAnswer: (allow: boolean) => void }) {
  const device = knock?.device;
  const Icon = device ? ICONS[device.type] ?? Monitor : Monitor;
  const account = knock?.reason === 'account';
  return (
    <Modal open={!!knock} title={account ? 'Is this your device?' : 'Connect this device?'} onClose={() => onAnswer(false)}>
      {device && knock && (
        <div>
          <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-4">
            <span className="w-11 h-11 rounded-xl bg-surface flex items-center justify-center">
              <Icon className="w-5 h-5 text-brand" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold truncate">{device.name}</p>
              <p className="text-sm text-muted">{account ? 'is signed in to your Google account' : 'entered your PIN'}</p>
            </div>
          </div>
          <div className="mt-4 rounded-2xl border border-line p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Security code</p>
            <p className="mt-1 font-mono text-4xl font-semibold tracking-[0.15em] tabular-nums" aria-label={`Security code ${knock.code.split('').join(' ')}`}>
              {formatCode(knock.code)}
            </p>
            <p className="mt-2 text-sm text-muted">Check that {device.name} shows the same code.</p>
          </div>
          <p className="mt-4 text-sm text-muted flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-live" />
            {account
              ? 'Allow it only if it’s your own device and it shows this same code right now.'
              : 'Allow it only if it’s your own device and it shows this same code. Pairing connects it to all your paired devices.'}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button type="button" className="btn btn-outline" onClick={() => onAnswer(false)}>
              Don’t allow
            </button>
            <button type="button" className="btn btn-primary" onClick={() => onAnswer(true)}>
              Allow
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
