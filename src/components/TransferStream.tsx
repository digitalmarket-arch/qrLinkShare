import React, { useState } from 'react';
import {
  Search,
  Link2,
  Image as ImageIcon,
  FileText,
  FolderArchive,
  AlignLeft,
  QrCode,
  Download,
  Copy,
  Check,
  Pin,
  Trash2,
  ExternalLink,
  Smartphone,
  Monitor,
  Clock,
  BookmarkCheck,
  Zap,
} from 'lucide-react';
import {
  DesktopAuthSession,
  DeviceType,
  RetentionMode,
  ShareCategory,
  SharedItem,
} from '../types/share';
import {
  computeRoomStats,
  filterAndSortItems,
  findNewestUnopenedLink,
  formatBytes,
} from '../utils/shareLogic';

interface TransferStreamProps {
  roomId: string;
  items: SharedItem[];
  isLoading: boolean;
  authSession: DesktopAuthSession | null;
  autoOpenEnabled: boolean;
  onToggleAutoOpen: () => void;
  autoDeleteTempOnOpen: boolean;
  onToggleAutoDeleteTemp: () => void;
  lastAutoOpenedItem: SharedItem | null;
  onOpenLinkOnDesktop: (item: SharedItem) => void;
  onToggleRetention: (itemId: string, nextMode: RetentionMode) => void;
  onTogglePin: (itemId: string) => void;
  onDeleteItem: (itemId: string) => void;
  onClearTemporary: () => void;
  onSelectItemForQr: (item: SharedItem) => void;
  onFocusComposer: () => void;
}

type FilterCategory = 'all' | 'pinned' | ShareCategory;

const FILTER_OPTIONS: { id: FilterCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'link', label: 'Links' },
  { id: 'image', label: 'Images' },
  { id: 'document', label: 'Docs' },
  { id: 'file', label: 'Files' },
  { id: 'text', label: 'Text' },
  { id: 'pinned', label: 'Pinned' },
];

export const TransferStream: React.FC<TransferStreamProps> = ({
  roomId,
  items,
  isLoading,
  authSession,
  autoOpenEnabled,
  onToggleAutoOpen,
  autoDeleteTempOnOpen,
  onToggleAutoDeleteTemp,
  lastAutoOpenedItem,
  onOpenLinkOnDesktop,
  onToggleRetention,
  onTogglePin,
  onDeleteItem,
  onClearTemporary,
  onSelectItemForQr,
  onFocusComposer,
}) => {
  const [selectedCategory, setSelectedCategory] =
    useState<FilterCategory>('all');
  const [retentionFilter, setRetentionFilter] = useState<'all' | RetentionMode>(
    'all'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [deviceFilter, setDeviceFilter] = useState<'all' | DeviceType>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filteredItems = filterAndSortItems(items, {
    category: selectedCategory,
    retentionFilter,
    searchQuery,
    deviceFilter,
  });

  const stats = computeRoomStats(items);
  const newestUnopenedLink = findNewestUnopenedLink(items);
  const newestLinkOverall =
    newestUnopenedLink ||
    lastAutoOpenedItem ||
    items.find((item) => item.category === 'link') ||
    null;

  const handleCopyContent = async (item: SharedItem) => {
    const origin =
      typeof window !== 'undefined'
        ? window.location.origin
        : 'http://localhost:3000';
    const textToCopy =
      item.category === 'link' || item.category === 'text'
        ? item.content
        : `${origin}/api/rooms/${encodeURIComponent(item.roomId)}/items/${encodeURIComponent(item.id)}/download`;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1800);
    }
  };

  const renderCategoryIcon = (category: ShareCategory) => {
    switch (category) {
      case 'link':
        return (
          <Link2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
        );
      case 'image':
        return (
          <ImageIcon className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        );
      case 'document':
        return (
          <FileText className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
        );
      case 'file':
        return (
          <FolderArchive className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
        );
      case 'text':
        return (
          <AlignLeft className="w-4 h-4 text-slate-600 dark:text-slate-400 shrink-0" />
        );
    }
  };

  const formatTimestamp = (iso: string) => {
    try {
      const date = new Date(iso);
      return date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Just now';
    }
  };

  return (
    <section
      aria-labelledby="stream-heading"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5"
    >
      {/* Desktop Auto-Open Newest Link Launch Banner */}
      {newestLinkOverall && (
        <div
          data-testid="newest-link-launcher"
          className="mb-5 p-4 rounded-xl bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800/80 flex flex-col gap-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-mono text-indigo-700 dark:text-indigo-300 flex-wrap">
                <Zap className="w-3.5 h-3.5 shrink-0" />
                <span className="font-semibold font-sans">
                  {lastAutoOpenedItem?.id === newestLinkOverall.id
                    ? 'Auto-Launched on Desktop Login'
                    : newestUnopenedLink
                      ? 'Newest Shared Link Ready for Desktop Browser'
                      : 'Latest Shared Link in Vault'}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {newestLinkOverall.retentionMode === 'saved'
                    ? 'SAVED VAULT'
                    : 'TEMPORARY LINK'}
                </span>
                {authSession && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>AUTH: {authSession.method.toUpperCase()}</span>
                  </>
                )}
              </div>
              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate mt-1">
                {newestLinkOverall.title}
              </p>
              <p className="text-xs font-mono text-indigo-600 dark:text-indigo-400 truncate mt-0.5">
                {newestLinkOverall.content}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0 flex-wrap">
              <button
                type="button"
                onClick={() => onOpenLinkOnDesktop(newestLinkOverall)}
                className="min-h-[38px] px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open Newest Link on Desktop</span>
              </button>
            </div>
          </div>

          {/* Auto-Open & Temporary Link Behavior Controls */}
          <div className="pt-2.5 border-t border-indigo-200/60 dark:border-indigo-800/60 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoOpenEnabled}
                  onChange={onToggleAutoOpen}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Auto-open newest link on QR / PIN / Google login</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoDeleteTempOnOpen}
                  onChange={onToggleAutoDeleteTemp}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span>Auto-clear temporary link after opening</span>
              </label>
            </div>

            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
              {stats.unopenedLinkCount} unopened link
              {stats.unopenedLinkCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      )}

      {/* Stream Header & Summary Metrics */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-100 dark:border-slate-800">
        <div>
          <h2
            id="stream-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            Shared Links, Docs & Files ({roomId})
          </h2>
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums flex-wrap">
            <span>{stats.totalItems} total</span>
            <span aria-hidden="true">·</span>
            <span>{stats.temporaryCount} temporary</span>
            <span aria-hidden="true">·</span>
            <span>{stats.savedCount} saved in vault</span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(stats.totalBytes)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Device Origin Filter */}
          <div
            role="group"
            aria-label="Filter by sender device"
            className="inline-flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg"
          >
            {(['all', 'mobile', 'desktop'] as const).map((dev) => (
              <button
                key={dev}
                type="button"
                onClick={() => setDeviceFilter(dev)}
                className={`min-h-[32px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  deviceFilter === dev
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {dev === 'all'
                  ? 'All Devices'
                  : dev === 'mobile'
                    ? 'From Phone'
                    : 'From Desktop'}
              </button>
            ))}
          </div>

          {stats.temporaryCount > 0 && (
            <button
              type="button"
              onClick={onClearTemporary}
              className="min-h-[32px] px-3 py-1.5 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 bg-slate-100 dark:bg-slate-800 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Clear Temporary ({stats.temporaryCount})
            </button>
          )}
        </div>
      </div>

      {/* Retention Tier Selector: All vs Temporary Links/Drops vs Saved Vault */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100 dark:border-slate-800">
        <div
          role="group"
          aria-label="Filter by storage retention mode"
          className="inline-flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg flex-wrap"
        >
          <button
            type="button"
            onClick={() => setRetentionFilter('all')}
            className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              retentionFilter === 'all'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            All Storage ({stats.totalItems})
          </button>
          <button
            type="button"
            onClick={() => setRetentionFilter('temporary')}
            className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              retentionFilter === 'temporary'
                ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Temporary Links ({stats.temporaryCount})</span>
          </button>
          <button
            type="button"
            onClick={() => setRetentionFilter('saved')}
            className={`min-h-[34px] px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
              retentionFilter === 'saved'
                ? 'bg-white dark:bg-slate-900 text-indigo-700 dark:text-indigo-300 shadow-2xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
            }`}
          >
            <BookmarkCheck className="w-3.5 h-3.5 shrink-0" />
            <span>Saved Links / Data / Docs ({stats.savedCount})</span>
          </button>
        </div>

        <div className="relative w-full sm:w-56 shrink-0">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            aria-label="Search shared files, links, and notes"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter by title, URL, file..."
            className="w-full min-h-[36px] pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Category Filter Bar */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Filter shared items by category"
          className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg flex-wrap"
        >
          {FILTER_OPTIONS.map((opt) => {
            const count =
              opt.id === 'all'
                ? stats.totalItems
                : opt.id === 'pinned'
                  ? stats.pinnedCount
                  : stats.countByCategory[opt.id];
            return (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={selectedCategory === opt.id}
                onClick={() => setSelectedCategory(opt.id)}
                className={`min-h-[32px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  selectedCategory === opt.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {opt.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {/* Stream List */}
      <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
        {isLoading ? (
          <div className="py-12 text-center space-y-2">
            <p className="text-sm font-medium text-slate-600 dark:text-slate-400">
              Synchronizing Room {roomId}...
            </p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              No matching items in this view
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-md mx-auto">
              {items.length === 0
                ? 'Scan the room QR code on your phone or use the Instant Beam Composer to drop your first temporary link or saved document.'
                : 'No shared items match your current storage filter, category, or search query.'}
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              {items.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCategory('all');
                    setRetentionFilter('all');
                    setSearchQuery('');
                    setDeviceFilter('all');
                  }}
                  className="min-h-[38px] px-4 py-2 text-xs font-medium text-white bg-slate-900 dark:bg-indigo-600 rounded-lg hover:bg-slate-800 cursor-pointer"
                >
                  Reset Filters
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onFocusComposer}
                  className="min-h-[38px] px-4 py-2 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 cursor-pointer"
                >
                  Share First Item
                </button>
              )}
            </div>
          </div>
        ) : (
          filteredItems.map((item) => {
            const downloadHref =
              item.dataUrl && item.dataUrl.startsWith('data:')
                ? item.dataUrl
                : `data:text/plain;charset=utf-8,${encodeURIComponent(item.content)}`;
            const isSaved = (item.retentionMode || 'temporary') === 'saved';

            return (
              <article
                key={item.id}
                data-testid="shared-item-row"
                className="py-4 first:pt-2 last:pb-1 flex flex-col gap-3"
              >
                <div className="flex flex-col gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="mt-0.5 p-2 rounded-lg bg-slate-100 dark:bg-slate-800 shrink-0">
                      {renderCategoryIcon(item.category)}
                    </div>

                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 break-words">
                        {item.title}
                      </h3>

                      {/* Clean unboxed metadata row */}
                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 flex-wrap font-mono tabular-nums">
                        <span className="uppercase">{item.category}</span>
                        <span aria-hidden="true">·</span>
                        <span
                          className={
                            isSaved
                              ? 'text-indigo-600 dark:text-indigo-400 font-semibold'
                              : 'text-amber-600 dark:text-amber-400 font-semibold'
                          }
                        >
                          {isSaved ? 'SAVED VAULT' : 'TEMPORARY'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatBytes(item.sizeBytes)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="inline-flex items-center gap-1 font-sans">
                          {item.senderDevice === 'mobile' ? (
                            <Smartphone className="w-3 h-3 shrink-0" />
                          ) : (
                            <Monitor className="w-3 h-3 shrink-0" />
                          )}
                          <span>{item.senderName}</span>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatTimestamp(item.createdAt)}</span>
                        {item.category === 'link' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span
                              className={
                                item.openedOnDesktop
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : 'text-indigo-600 dark:text-indigo-400 font-semibold'
                              }
                            >
                              {item.openedOnDesktop
                                ? 'OPENED ON DESKTOP'
                                : 'UNOPENED'}
                            </span>
                          </>
                        )}
                        {item.pinned && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-indigo-600 dark:text-indigo-400 font-semibold font-sans">
                              Pinned
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Item Action Bar */}
                  <div className="flex items-center gap-1.5 flex-wrap pl-11">
                    {item.category === 'link' ? (
                      <button
                        type="button"
                        onClick={() => onOpenLinkOnDesktop(item)}
                        className="min-h-[36px] px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Open on Desktop</span>
                      </button>
                    ) : (
                      <a
                        href={downloadHref}
                        download={item.fileName || `${item.id}.txt`}
                        className="min-h-[36px] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Download</span>
                      </a>
                    )}

                    {/* Promote Temporary to Saved Vault or switch back */}
                    <button
                      type="button"
                      onClick={() =>
                        onToggleRetention(
                          item.id,
                          isSaved ? 'temporary' : 'saved'
                        )
                      }
                      aria-label={
                        isSaved
                          ? `Move ${item.title} to Temporary`
                          : `Save ${item.title} to Permanent Vault`
                      }
                      className={`min-h-[36px] px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                        isSaved
                          ? 'text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100'
                          : 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/60 hover:bg-amber-100'
                      }`}
                    >
                      {isSaved ? (
                        <>
                          <BookmarkCheck className="w-3.5 h-3.5" />
                          <span>Saved</span>
                        </>
                      ) : (
                        <>
                          <BookmarkCheck className="w-3.5 h-3.5" />
                          <span>Save to Vault</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => onSelectItemForQr(item)}
                      aria-label={`Show QR code for ${item.title}`}
                      className="min-h-[36px] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      <QrCode className="w-3.5 h-3.5" />
                      <span>Item QR</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleCopyContent(item)}
                      aria-label={`Copy ${item.title}`}
                      className="min-h-[36px] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                    >
                      {copiedId === item.id ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => onTogglePin(item.id)}
                      aria-label={
                        item.pinned
                          ? `Unpin ${item.title}`
                          : `Pin ${item.title}`
                      }
                      className={`min-h-[36px] min-w-[36px] p-1.5 rounded-lg transition-colors flex items-center justify-center cursor-pointer ${
                        item.pinned
                          ? 'text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/50'
                          : 'text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 bg-slate-100 dark:bg-slate-800'
                      }`}
                    >
                      <Pin className="w-3.5 h-3.5" />
                    </button>

                    <button
                      type="button"
                      onClick={() => onDeleteItem(item.id)}
                      aria-label={`Delete ${item.title}`}
                      className="min-h-[36px] min-w-[36px] p-1.5 text-slate-500 hover:text-red-600 dark:hover:text-red-400 bg-slate-100 dark:bg-slate-800 hover:bg-red-50 dark:hover:bg-red-950/40 rounded-lg transition-colors flex items-center justify-center cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Inline Content Preview based on category */}
                {item.category === 'link' && (
                  <div className="pl-11">
                    <a
                      href={item.content}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => onOpenLinkOnDesktop(item)}
                      className="text-xs font-mono text-indigo-600 dark:text-indigo-400 hover:underline break-all"
                    >
                      {item.content}
                    </a>
                  </div>
                )}

                {item.category === 'image' && item.dataUrl && (
                  <div className="pl-11">
                    <div className="relative rounded-xl overflow-hidden bg-slate-950 border border-slate-200 dark:border-slate-800 max-w-md max-h-52 flex items-center justify-center">
                      <img
                        src={item.dataUrl}
                        alt={item.title}
                        referrerPolicy="no-referrer"
                        className="max-h-52 w-auto object-contain"
                      />
                    </div>
                  </div>
                )}

                {(item.category === 'document' ||
                  item.category === 'file' ||
                  item.category === 'text') && (
                  <div className="pl-11">
                    <pre className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 text-xs font-mono text-slate-700 dark:text-slate-300 overflow-x-auto max-h-32 whitespace-pre-wrap">
                      {item.content}
                    </pre>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>
    </section>
  );
};
