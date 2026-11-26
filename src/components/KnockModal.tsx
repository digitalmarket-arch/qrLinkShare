import { Monitor, ShieldCheck, Smartphone, Tablet } from 'lucide-react';
import type { DeviceInfo } from '../types/share';
import { Modal } from './Modal';

const ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };

export interface Knock {
  device: DeviceInfo;
  /** pin: it typed this device's PIN. account: it says it's signed in to the same Google account. */
  reason: 'pin' | 'account';
}

/** "iPhone · Safari entered your PIN. Connect it?" */
export function KnockModal({ knock, onAnswer }: { knock: Knock | null; onAnswer: (allow: boolean) => void }) {
  const device = knock?.device;
  const Icon = device ? ICONS[device.type] ?? Monitor : Monitor;
  const account = knock?.reason === 'account';
  return (
    <Modal open={!!knock} title={account ? 'Is this your device?' : 'Connect this device?'} onClose={() => onAnswer(false)}>
      {device && (
        <div>
          <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-4">
            <span className="w-11 h-11 rounded-xl bg-surface flex items-center justify-center">
              <Icon className="w-5 h-5 text-brand" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold truncate">{device.name}</p>
              <p className="text-sm text-muted">{account ? 'says it’s signed in to your Google account' : 'entered your PIN'}</p>
            </div>
          </div>
          <p className="mt-4 text-sm text-muted flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-live" />
            {account
              ? 'Both devices were waiting for the other to confirm first. Allow it only if it’s one of your own devices and you’re using it right now.'
              : 'Only allow it if it’s your device (or someone you’re sharing with) right now. It will be able to send to and receive from your devices.'}
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
