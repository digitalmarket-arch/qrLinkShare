import { useMemo, useState } from 'react';
import { Bookmark, Clock, QrCode, Send, Smartphone } from 'lucide-react';
import type { Retention, StoredItem } from '../types/share';
import { ItemCard } from './ItemCard';
import { loadPref, savePref } from '../lib/settings';

type Filter = 'all' | 'link' | 'file' | 'text';

interface Props {
  items: StoredItem[];
  loading: boolean;
  myDeviceId: string;
  freshIds: Set<string>;
  progress: Record<string, number>;
  autoOpen: boolean;
  onToggleAutoOpen: () => void;
  getBlob: (id: string) => Promise<Blob | undefined>;
  onCopy: (text: string, what: string) => void;
  onShowQr: (item: StoredItem) => void;
  onKeep: (item: StoredItem) => void;
  onDelete: (item: StoredItem) => void;
  onRetry: (item: StoredItem) => void;
  onClear: (retention: Retention) => void;
  onProblem: (message: string) => void;
}

const newestFirst = (a: StoredItem, b: StoredItem) => b.createdAt.localeCompare(a.createdAt);

export function Feed(props: Props) {
  const { items, loading } = props;
  const [section, setSectionState] = useState<Retention>(() => loadPref<Retention>('section', 'temp'));
  const [filter, setFilter] = useState<Filter>('all');
  const setSection = (s: Retention) => {
    setSectionState(s);
    setFilter('all');
    savePref('section', s);
  };

  const bySection = useMemo(
    () => ({
      temp: items.filter((i) => i.retention === 'temp').sort(newestFirst),
      saved: items.filter((i) => i.retention === 'saved').sort(newestFirst),
    }),
    [items]
  );
  const list = bySection[section];
  const counts = useMemo(() => {
    const c = { all: list.length, link: 0, file: 0, text: 0 };
    for (const i of list) c[i.kind]++;
    return c;
  }, [list]);
  const visible = filter === 'all' ? list : list.filter((i) => i.kind === filter);

  const sections: Array<{ id: Retention; label: string; icon: typeof Clock; hint: string }> = [
    { id: 'temp', label: 'Temporary', icon: Clock, hint: 'Gone after 24 hours' },
    { id: 'saved', label: 'Saved', icon: Bookmark, hint: 'Kept until you delete them' },
  ];
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'link', label: 'Links' },
    { id: 'file', label: 'Files' },
    { id: 'text', label: 'Notes' },
  ];

  return (
    <section aria-label="Your items">
      <div role="tablist" aria-label="Sections" className="grid grid-cols-2 gap-2 mb-4">
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
            className={`card px-4 py-3 text-left flex items-center gap-3 cursor-pointer transition-colors ${
              section === s.id ? '!border-brand ring-2 ring-[var(--ring)]' : 'hover:bg-surface-2'
            }`}
          >
            <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${section === s.id ? 'bg-brand text-brand-ink' : 'bg-surface-2 text-muted'}`}>
              <s.icon className="w-4 h-4" />
            </span>
            <span className="min-w-0">
              <span className="block font-bold leading-tight">
                {s.label} <span className="text-muted font-semibold tabular-nums">({bySection[s.id].length})</span>
              </span>
              <span className="block text-xs text-muted truncate">{s.hint}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
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
        </div>
        <label className="flex items-center gap-2 text-sm text-muted cursor-pointer select-none">
          <span>Auto-open links</span>
          <button
            type="button"
            role="switch"
            aria-checked={props.autoOpen}
            onClick={props.onToggleAutoOpen}
            className={`relative w-10 h-6 rounded-full transition-colors cursor-pointer ${props.autoOpen ? 'bg-brand' : 'bg-line'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${props.autoOpen ? 'translate-x-4' : ''}`} />
          </button>
        </label>
      </div>

      {loading ? (
        <ul className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i} className="card h-28 animate-pulse" />
          ))}
        </ul>
      ) : list.length === 0 ? (
        <EmptyState section={section} />
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
              progress={props.progress[item.id]}
              getBlob={props.getBlob}
              onCopy={props.onCopy}
              onShowQr={props.onShowQr}
              onKeep={props.onKeep}
              onDelete={props.onDelete}
              onRetry={props.onRetry}
              onProblem={props.onProblem}
            />
          ))}
        </ul>
      )}

      {list.length > 0 && (
        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted">
          <span>
            {section === 'temp'
              ? 'Temporary items delete themselves 24 hours after they were sent.'
              : 'Saved items stay on this device until you delete them.'}
          </span>
          <button
            type="button"
            className="font-semibold hover:text-danger px-2 min-h-9 cursor-pointer"
            onClick={() => {
              const what = section === 'temp' ? 'all temporary items' : 'all saved items';
              if (confirm(`Delete ${what} from this device? Other devices keep their own copies.`)) props.onClear(section);
            }}
          >
            {section === 'temp' ? 'Clear temporary' : 'Delete all saved'}
          </button>
        </div>
      )}
    </section>
  );
}

function EmptyState({ section }: { section: Retention }) {
  const steps = [
    { icon: QrCode, title: 'Pair', body: 'Scan the QR code or type the PIN on your other device.' },
    { icon: Send, title: 'Send', body: 'Paste a link, write a note, or drop any file.' },
    { icon: Smartphone, title: 'Done', body: 'It goes straight to your other device. No server in between.' },
  ];
  return (
    <div className="card p-6 sm:p-8 text-center">
      <div className="mx-auto w-12 h-12 rounded-2xl bg-brand-soft text-brand flex items-center justify-center">
        {section === 'temp' ? <Clock className="w-6 h-6" /> : <Bookmark className="w-6 h-6" />}
      </div>
      <p className="mt-4 font-bold">{section === 'temp' ? 'No temporary items' : 'Nothing saved yet'}</p>
      <p className="mt-1 text-sm text-muted">
        {section === 'temp'
          ? 'Quick hand-offs land here and disappear after 24 hours.'
          : 'Choose “Save” when sending, or tap the bookmark on any temporary item, to keep it here.'}
      </p>
      {section === 'temp' && (
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
      )}
    </div>
  );
}
