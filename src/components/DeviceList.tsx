import { Monitor, Smartphone, Tablet, Unlink } from 'lucide-react';
import type { ConnectedDevice, DeviceInfo, KnownDevice, LinkMethod } from '../types/share';
import { timeAgo } from '../lib/shared';

const ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet };
const METHOD_LABEL: Record<LinkMethod, string> = {
  paired: 'Paired with QR / PIN',
  google: 'Same Google account',
  wallet: 'Same wallet',
};

interface Props {
  self: DeviceInfo;
  devices: ConnectedDevice[];
  /** Devices seen before that aren't connected right now. */
  offline: KnownDevice[];
  onUnpair: () => void;
}

export function DeviceList({ self, devices, offline, onUnpair }: Props) {
  const SelfIcon = ICONS[self.type] ?? Monitor;
  return (
    <section aria-labelledby="devices-title" className="card p-5">
      <h2 id="devices-title" className="text-sm font-bold flex items-center justify-between">
        <span>Connected devices</span>
        <span className="text-muted tabular-nums">{devices.length}</span>
      </h2>
      <ul className="mt-3 space-y-1">
        <li className="flex items-center gap-3 py-1.5">
          <span className="w-9 h-9 rounded-xl bg-surface-2 flex items-center justify-center text-muted">
            <SelfIcon className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate">
              {self.name} <span className="ml-1 text-xs font-medium text-brand">(this device)</span>
            </p>
          </div>
        </li>
        {devices.map((d) => {
          const Icon = ICONS[d.type] ?? Monitor;
          return (
            <li key={d.id} className="flex items-center gap-3 py-1.5">
              <span className="relative w-9 h-9 rounded-xl bg-surface-2 flex items-center justify-center text-muted">
                <Icon className="w-4 h-4" />
                <span className="absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full bg-live ring-2 ring-[var(--surface)]" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{d.name}</p>
                <p className="text-xs text-muted">{METHOD_LABEL[d.method]}</p>
              </div>
            </li>
          );
        })}
        {offline.map((d) => {
          const Icon = ICONS[d.type] ?? Monitor;
          return (
            <li key={d.id} className="flex items-center gap-3 py-1.5 opacity-70">
              <span className="w-9 h-9 rounded-xl bg-surface-2 flex items-center justify-center text-muted">
                <Icon className="w-4 h-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold truncate">{d.name}</p>
                <p className="text-xs text-muted">Offline · seen {timeAgo(new Date(d.lastSeen).toISOString())}. Catches up when it’s back</p>
              </div>
            </li>
          );
        })}
        {devices.length === 0 && offline.length === 0 && (
          <li className="text-xs text-muted pt-1">
            Paired devices show up here whenever both have this page open.
          </li>
        )}
      </ul>
      <button type="button" className="btn btn-ghost w-full mt-3 text-sm" onClick={onUnpair}>
        <Unlink className="w-4 h-4" /> Unpair this device
      </button>
    </section>
  );
}
