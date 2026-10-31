import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Smartphone,
  Monitor,
  Sun,
  Moon,
  QrCode,
  Printer,
} from 'lucide-react';
import {
  ConnectedDevice,
  CreateShareItemPayload,
  DeviceType,
  SharedItem,
} from './types/share';
import {
  buildItemDirectSharePayload,
  normalizeRoomCode,
} from './utils/shareLogic';
import { PairingSidebar } from './components/PairingSidebar';
import { ShareComposer } from './components/ShareComposer';
import { TransferStream } from './components/TransferStream';
import { ItemQrModal } from './components/ItemQrModal';
import { QrCodeView } from './components/QrCodeView';

export function App() {
  // Parse URL params for room and mobile mode
  const initialParams =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();

  const initialRoom =
    normalizeRoomCode(initialParams.get('room') || '') || 'SYNC-42';
  const initialDeviceMode: DeviceType =
    initialParams.get('device') === 'mobile' ? 'mobile' : 'desktop';

  const [roomId, setRoomId] = useState<string>(initialRoom);
  const [viewMode, setViewMode] = useState<'workspace' | 'print-sheet'>(
    'workspace'
  );
  const [isMobileMode, setIsMobileMode] = useState<boolean>(
    initialDeviceMode === 'mobile'
  );
  const [darkMode, setDarkMode] = useState<boolean>(false);

  const [items, setItems] = useState<SharedItem[]>([]);
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [wsConnected, setWsConnected] = useState<boolean>(false);
  const [activeQrItem, setActiveQrItem] = useState<SharedItem | null>(null);

  const clientIdRef = useRef<string>(
    `client-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  const wsRef = useRef<WebSocket | null>(null);

  // Sync dark mode class on <html> and <body>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  // Fetch room state over HTTP as immediate baseline & fallback
  const fetchRoomState = useCallback(async (targetRoomId: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/rooms/${encodeURIComponent(targetRoomId)}`
      );
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
        setDevices(data.devices || []);
      }
    } catch {
      // Handled gracefully
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Connect real-time WebSocket for room updates
  useEffect(() => {
    fetchRoomState(roomId);

    if (typeof window === 'undefined') return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;

    const connect = () => {
      if (unmounted) return;
      socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.onopen = () => {
        if (unmounted) return;
        setWsConnected(true);
        socket?.send(
          JSON.stringify({
            type: 'room:join',
            roomId,
            clientId: clientIdRef.current,
            deviceType: isMobileMode ? 'mobile' : 'desktop',
            deviceName: isMobileMode
              ? 'Mobile Companion Handset'
              : 'Desktop Studio Workstation',
          })
        );
      };

      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'room:init') {
            setItems(msg.items || []);
            setDevices(msg.devices || []);
            setIsLoading(false);
          } else if (msg.type === 'presence:updated') {
            setDevices(msg.devices || []);
          } else if (msg.type === 'item:created' && msg.item) {
            setItems((prev) => {
              if (prev.some((i) => i.id === msg.item.id)) return prev;
              return [msg.item, ...prev];
            });
          } else if (msg.type === 'item:updated' && msg.item) {
            setItems((prev) =>
              prev.map((i) => (i.id === msg.item.id ? msg.item : i))
            );
          } else if (msg.type === 'item:deleted' && msg.itemId) {
            setItems((prev) => prev.filter((i) => i.id !== msg.itemId));
          } else if (msg.type === 'room:cleared') {
            setItems(msg.items || []);
          }
        } catch {
          // Ignore invalid JSON
        }
      };

      socket.onclose = () => {
        if (unmounted) return;
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 2500);
      };
    };

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    };
  }, [roomId, isMobileMode, fetchRoomState]);

  const handleJoinRoom = (newRoomId: string) => {
    const normalized = normalizeRoomCode(newRoomId) || 'SYNC-42';
    setRoomId(normalized);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('room', normalized);
      window.history.replaceState({}, '', url.toString());
    }
  };

  const handleShareItem = async (payload: CreateShareItemPayload) => {
    const res = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/items`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to share item.');
    }

    const { item } = await res.json();
    // Idempotent optimistic insert in case WebSocket message hasn't arrived yet
    setItems((prev) => {
      if (prev.some((existing) => existing.id === item.id)) return prev;
      return [item, ...prev];
    });
  };

  const handleTogglePin = async (itemId: string) => {
    const res = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(itemId)}/pin`,
      { method: 'PATCH' }
    );
    if (res.ok) {
      const { item } = await res.json();
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    setItems((prev) => prev.filter((i) => i.id !== itemId));
    await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' }
    );
  };

  const handleClearUnpinned = async () => {
    const res = await fetch(
      `/api/rooms/${encodeURIComponent(roomId)}/items?keepPinned=true`,
      { method: 'DELETE' }
    );
    if (res.ok) {
      const { items: remaining } = await res.json();
      setItems(remaining || []);
    }
  };

  const focusComposerInput = () => {
    const el =
      document.getElementById('share-link-url') ||
      document.getElementById('file-caption-input');
    el?.focus();
  };

  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'http://localhost:3000';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Navigation Bar Contract */}
      <header className="flex items-center justify-between gap-8 px-6 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="/"
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0"
        >
          qrLinkShare
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="Primary Navigation"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300"
        >
          <a
            href="#qr-bridge"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('workspace');
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            QR Bridge
          </a>
          <a
            href="#beam-composer"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('workspace');
              focusComposerInput();
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Drop Files
          </a>
          <a
            href="#transfer-stream"
            onClick={(e) => {
              e.preventDefault();
              setViewMode('workspace');
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            Live Stream
          </a>
          <a
            href="#qr-sheet"
            onClick={(e) => {
              e.preventDefault();
              setViewMode(
                viewMode === 'print-sheet' ? 'workspace' : 'print-sheet'
              );
            }}
            className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0"
          >
            QR Sheet
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              setViewMode('workspace');
              focusComposerInput();
            }}
            className="px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-500 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            New Transfer
          </button>
        </div>
      </header>

      {/* Workspace Context Bar (Mode Toggles & Theme Switch) */}
      <div className="bg-white/70 dark:bg-slate-900/70 border-b border-slate-200/80 dark:border-slate-800/80 px-4 sm:px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400 font-mono flex-wrap">
            <span>Room: {roomId}</span>
            <span aria-hidden="true">·</span>
            <span>{items.length} items</span>
            <span aria-hidden="true">·</span>
            <span>
              {isMobileMode ? 'Phone Sender' : 'Desktop Studio'}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Perspective Switcher */}
            <div
              role="group"
              aria-label="Workspace view mode"
              className="inline-flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg"
            >
              <button
                type="button"
                onClick={() => {
                  setIsMobileMode(false);
                  setViewMode('workspace');
                }}
                className={`min-h-[34px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  !isMobileMode && viewMode === 'workspace'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Monitor className="w-3.5 h-3.5 shrink-0" />
                <span>Desktop</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsMobileMode(true);
                  setViewMode('workspace');
                }}
                className={`min-h-[34px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  isMobileMode && viewMode === 'workspace'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5 shrink-0" />
                <span>Phone View</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  setViewMode(
                    viewMode === 'print-sheet' ? 'workspace' : 'print-sheet'
                  )
                }
                className={`min-h-[34px] px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                  viewMode === 'print-sheet'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <QrCode className="w-3.5 h-3.5 shrink-0" />
                <span>QR Sheet</span>
              </button>
            </div>

            {/* Theme Toggle */}
            <button
              type="button"
              onClick={() => setDarkMode((d) => !d)}
              aria-label={
                darkMode ? 'Switch to light theme' : 'Switch to dark theme'
              }
              className="min-h-[34px] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
            >
              {darkMode ? (
                <>
                  <Sun className="w-3.5 h-3.5 text-amber-400" />
                  <span>Light</span>
                </>
              ) : (
                <>
                  <Moon className="w-3.5 h-3.5" />
                  <span>Dark</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Viewport */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6">
        {viewMode === 'print-sheet' ? (
          <section
            aria-labelledby="qr-sheet-heading"
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100 dark:border-slate-800">
              <div>
                <h1
                  id="qr-sheet-heading"
                  className="text-xl font-bold text-slate-900 dark:text-slate-100"
                >
                  Room {roomId} — Printable Multi-QR Transfer Sheet
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Scan any card below with a smartphone camera to open its link or download the attached file, image, or document directly.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="min-h-[38px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg flex items-center gap-1.5 cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Print QR Sheet</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('workspace')}
                  className="min-h-[38px] px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg cursor-pointer"
                >
                  Back to Workspace
                </button>
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/50 flex flex-col items-center text-center"
                >
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate max-w-full mb-1">
                    {item.title}
                  </p>
                  <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mb-3">
                    {item.category.toUpperCase()} · {item.senderName}
                  </p>
                  <QrCodeView
                    value={buildItemDirectSharePayload(item, origin)}
                    size={160}
                    downloadFileName={`qr-${item.id}`}
                    showControls={true}
                  />
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left Column (5 cols on lg): Phone-to-Desktop QR Pairing + Instant Beam Composer */}
            <div className="lg:col-span-5 space-y-6" id="qr-bridge">
              {isMobileMode ? (
                <>
                  <div id="beam-composer">
                    <ShareComposer
                      roomId={roomId}
                      defaultDevice="mobile"
                      onShareItem={handleShareItem}
                    />
                  </div>
                  <PairingSidebar
                    roomId={roomId}
                    onJoinRoom={handleJoinRoom}
                    devices={devices}
                    wsConnected={wsConnected}
                    onSwitchToMobilePreview={() => setIsMobileMode(false)}
                    isMobileMode={true}
                  />
                </>
              ) : (
                <>
                  <PairingSidebar
                    roomId={roomId}
                    onJoinRoom={handleJoinRoom}
                    devices={devices}
                    wsConnected={wsConnected}
                    onSwitchToMobilePreview={() => setIsMobileMode(true)}
                    isMobileMode={false}
                  />
                  <div id="beam-composer">
                    <ShareComposer
                      roomId={roomId}
                      defaultDevice="mobile"
                      onShareItem={handleShareItem}
                    />
                  </div>
                </>
              )}
            </div>

            {/* Right Column (7 cols on lg): Live Transfer Stream */}
            <div className="lg:col-span-7" id="transfer-stream">
              <TransferStream
                roomId={roomId}
                items={items}
                isLoading={isLoading}
                onTogglePin={handleTogglePin}
                onDeleteItem={handleDeleteItem}
                onClearUnpinned={handleClearUnpinned}
                onSelectItemForQr={(item) => setActiveQrItem(item)}
                onFocusComposer={focusComposerInput}
              />
            </div>
          </div>
        )}
      </main>

      {/* Clean Minimal Footer */}
      <footer className="mt-auto border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>
            qrLinkShare — Instant Phone-to-Desktop File, Image, Document & Link QR Bridge
          </span>
          <span className="font-mono">
            Room {roomId} · Direct QR & WebSocket Transfer
          </span>
        </div>
      </footer>

      {/* Individual Item QR Modal */}
      <ItemQrModal
        item={activeQrItem}
        onClose={() => setActiveQrItem(null)}
      />
    </div>
  );
}

export default App;
