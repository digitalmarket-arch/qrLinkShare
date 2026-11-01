import { useMemo, useState } from 'react';
import { Inbox, QrCode, Send, Smartphone } from 'lucide-react';
import type { SharedItem } from '../types/share';
import { ItemCard } from './ItemCard';

type Filter = 'all' | 'link' | 'file' | 'text';

interface Props {
  items: SharedItem[];
  loading: boolean;
  myDeviceId: string;
  freshIds: Set<string>;
  autoOpen: boolean;
  onToggleAutoOpen: () => void;
  onCopy: (text: string, what: string) => void;
  onShowQr: (item: SharedItem) => void;
  onDelete: (item: SharedItem) => void;
  onClearAll: () => void;
}

export function Feed(props: Props) {
  const { items, loading } = props;
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const c = { all: items.length, link: 0, file: 0, text: 0 };
    for (const i of items) c[i.kind]++;
    return c;
  }, [items]);

  const visible = filter === 'all' ? items : items.filter((i) => i.kind === filter);
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'link', label: 'Links' },
    { id: 'file', label: 'Files' },
    { id: 'text', label: 'Notes' },
  ];

  return (
    <section aria-labelledby="feed-title">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 id="feed-title" className="text-lg font-bold">
          Shared items{' '}
          {items.length > 0 && <span className="text-muted font-semibold tabular-nums">({items.length})</span>}
        </h2>
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
          <span>Auto-open links</span>
          <button
            type="button"
            role="switch"
            aria-checked={props.autoOpen}
            onClick={props.onToggleAutoOpen}
            className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer ${props.autoOpen ? 'bg-brand' : 'bg-line'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                props.autoOpen ? 'translate-x-4' : ''
              }`}
            />
          </button>
        </label>
      </div>

      {items.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3 overflow-x-auto -mx-1 px-1 pb-1">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={`shrink-0 min-h-9 px-3.5 rounded-full text-sm font-semibold border transition-colors cursor-pointer ${
                filter === f.id ? 'bg-ink text-bg border-ink' : 'border-line text-muted hover:text-ink'
              }`}
            >
              {f.label}
              {f.id !== 'all' && counts[f.id] > 0 && <span className="ml-1 opacity-60 tabular-nums">{counts[f.id]}</span>}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            className="shrink-0 text-sm font-semibold text-muted hover:text-danger px-2 min-h-9 cursor-pointer"
            onClick={() => {
              if (confirm('Delete every item in this room for all devices?')) props.onClearAll();
            }}
          >
            Clear all
          </button>
        </div>
      )}

      {loading ? (
        <ul className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="card h-28 animate-pulse" />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : visible.length === 0 ? (
        <p className="card p-8 text-center text-sm text-muted">Nothing here in this category yet.</p>
      ) : (
        <ul className="space-y-3">
          {visible.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              myDeviceId={props.myDeviceId}
              fresh={props.freshIds.has(item.id)}
              onCopy={props.onCopy}
              onShowQr={props.onShowQr}
              onDelete={props.onDelete}
            />
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <p className="mt-4 text-center text-xs text-muted">Items disappear automatically after 24 hours.</p>
      )}
    </section>
  );
}

function EmptyState() {
  const steps = [
    { icon: QrCode, title: 'Pair', body: 'Scan the QR code or type the PIN on your other device.' },
    { icon: Send, title: 'Send', body: 'Paste a link, write a note, or drop any file.' },
    { icon: Smartphone, title: 'Done', body: 'It shows up on every paired device instantly.' },
  ];
  return (
    <div className="card p-6 sm:p-8 text-center">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-brand-soft text-brand flex items-center justify-center">
        <Inbox className="w-6 h-6" />
      </div>
      <p className="mt-4 font-bold">Nothing shared yet</p>
      <p className="mt-1 text-sm text-muted">Anything you send here appears on your other devices in real time.</p>
      <ol className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
        {steps.map((s, i) => (
          <li key={s.title} className="rounded-2xl bg-surface-2 p-4">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-ink text-bg text-xs font-bold flex items-center justify-center">{i + 1}</span>
              <s.icon className="w-4 h-4 text-muted" />
              <span className="font-semibold text-sm">{s.title}</span>
            </div>
            <p className="mt-2 text-sm text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
