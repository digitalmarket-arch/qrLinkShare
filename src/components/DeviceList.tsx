import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import type { PresentDevice } from '../types/share';

const ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };
const METHOD_LABEL: Record<PresentDevice['method'], string> = {
  guest: 'Started here',
  qr: 'QR code',
  pin: 'PIN',
  google: 'Google',
  wallet: 'Wallet',
};

interface Props {
  devices: PresentDevice[];
  myDeviceId: string;
  onLeave: () => void;
  leaveLabel: string;
}

export function DeviceList({ devices, myDeviceId, onLeave, leaveLabel }: Props) {
  const sorted = [...devices].sort((a, b) => (a.id === myDeviceId ? -1 : b.id === myDeviceId ? 1 : 0));
  return (
    <section aria-labelledby="devices-title" className="card p-5">
      <h2 id="devices-title" className="text-sm font-bold flex items-center justify-between">
        <span>Devices online</span>
        <span className="text-muted tabular-nums">{devices.length}</span>
      </h2>
      <ul className="mt-3 space-y-1">
        {sorted.map((d) => {
          const Icon = ICONS[d.type] ?? Monitor;
          const me = d.id === myDeviceId;
          return (
            <li key={d.id} className="flex items-center gap-3 py-1.5">
              <span className="relative w-9 h-9 rounded-xl bg-surface-2 flex items-center justify-center text-muted">
                <Icon className="w-4 h-4" />
                <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-live ring-2 ring-[var(--surface)]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">
                  {d.name}
                  {me && <span className="ml-1.5 text-xs font-medium text-brand">(this device)</span>}
                </p>
                <p className="text-xs text-muted">{METHOD_LABEL[d.method]}</p>
              </div>
            </li>
          );
        })}
        {devices.length === 1 && (
          <li className="text-xs text-muted pt-1">Waiting for another device to join…</li>
        )}
      </ul>
      <button type="button" className="btn btn-ghost w-full mt-3 text-sm" onClick={onLeave}>
        <LogOut className="w-4 h-4" /> {leaveLabel}
      </button>
    </section>
  );
}
