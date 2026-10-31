import React, { useState } from 'react';
import {
  Smartphone,
  Monitor,
  RefreshCw,
  ArrowRight,
  QrCode,
} from 'lucide-react';
import {
  ConnectedDevice,
  ErrorCorrectionLevel,
} from '../types/share';
import {
  buildPairingUrl,
  generateRoomCode,
  normalizeRoomCode,
} from '../utils/shareLogic';
import { QrCodeView } from './QrCodeView';

interface PairingSidebarProps {
  roomId: string;
  onJoinRoom: (newRoomId: string) => void;
  devices: ConnectedDevice[];
  wsConnected: boolean;
  onSwitchToMobilePreview: () => void;
  isMobileMode: boolean;
}

export const PairingSidebar: React.FC<PairingSidebarProps> = ({
  roomId,
  onJoinRoom,
  devices,
  wsConnected,
  onSwitchToMobilePreview,
  isMobileMode,
}) => {
  const [customRoomInput, setCustomRoomInput] = useState(roomId);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [ecLevel, setEcLevel] = useState<ErrorCorrectionLevel>('M');

  const origin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'http://localhost:3000';
  const pairingUrl = buildPairingUrl(origin, roomId);

  const handleRoomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normalizeRoomCode(customRoomInput);
    if (!cleaned || cleaned.length < 3) {
      setRoomError('Enter at least 3 alphanumeric characters (e.g. SYNC-42).');
      return;
    }
    setRoomError(null);
    setCustomRoomInput(cleaned);
    onJoinRoom(cleaned);
  };

  const handleGenerateNewRoom = () => {
    const nextCode = generateRoomCode();
    setCustomRoomInput(nextCode);
    setRoomError(null);
    onJoinRoom(nextCode);
  };

  return (
    <section
      aria-labelledby="pairing-heading"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2
            id="pairing-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2"
          >
            <QrCode className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>Phone-to-Desktop QR Bridge</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Scan with your phone camera to beam files, photos, docs, and links directly to this screen.
          </p>
        </div>
      </div>

      {/* QR Code Display */}
      <div className="py-3 flex flex-col items-center border-y border-slate-100 dark:border-slate-800/80">
        <QrCodeView
          value={pairingUrl}
          size={188}
          errorCorrectionLevel={ecLevel}
          downloadFileName={`qrlinkshare-room-${roomId}`}
          label={`Room ${roomId} · Instant Mobile Drop`}
        />

        {/* Error Correction Level Selector */}
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>QR Redundancy:</span>
          <div
            role="group"
            aria-label="QR Error Correction Level"
            className="inline-flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg"
          >
            {(['L', 'M', 'Q', 'H'] as ErrorCorrectionLevel[]).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setEcLevel(level)}
                className={`px-2 py-1 text-xs font-mono rounded-md transition-colors cursor-pointer ${
                  ecLevel === level
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-semibold shadow-2xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Room Code Switcher */}
      <form onSubmit={handleRoomSubmit} className="mt-4" noValidate>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="room-code-input"
            className="text-xs font-medium text-slate-700 dark:text-slate-300"
          >
            Active Transfer Room Code
          </label>
          <button
            type="button"
            onClick={handleGenerateNewRoom}
            className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 flex items-center gap-1 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className="w-3 h-3" />
            <span>New Private Room</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="room-code-input"
            type="text"
            value={customRoomInput}
            onChange={(e) => {
              setCustomRoomInput(e.target.value.toUpperCase());
              if (roomError) setRoomError(null);
            }}
            placeholder="SYNC-42"
            maxLength={12}
            className="w-full min-h-[40px] px-3 py-2 text-sm font-mono font-semibold tracking-wider uppercase bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button
            type="submit"
            className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-white bg-slate-900 dark:bg-indigo-600 hover:bg-slate-800 dark:hover:bg-indigo-500 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>Switch Room</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {roomError && (
          <p role="alert" className="mt-1.5 text-xs text-red-600 dark:text-red-400">
            {roomError}
          </p>
        )}
      </form>

      {/* Connected Devices in Room */}
      <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800/80">
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
          <span>Paired Endpoints in {roomId}</span>
          <span className="font-mono tabular-nums">
            {wsConnected ? 'Live Sync Active' : 'HTTP Sync'} · {devices.length}{' '}
            {devices.length === 1 ? 'device' : 'devices'}
          </span>
        </div>

        <ul className="space-y-1.5">
          {devices.length > 0 ? (
            devices.map((dev) => (
              <li
                key={dev.clientId}
                className="flex items-center justify-between text-xs py-1.5 px-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300"
              >
                <span className="flex items-center gap-2 truncate">
                  {dev.deviceType === 'mobile' ? (
                    <Smartphone className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400 shrink-0" />
                  ) : (
                    <Monitor className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400 shrink-0" />
                  )}
                  <span className="font-medium truncate">{dev.deviceName}</span>
                </span>
                <span className="text-slate-400 dark:text-slate-500 font-mono text-[11px] shrink-0">
                  {dev.deviceType === 'mobile' ? 'Phone' : 'Desktop'}
                </span>
              </li>
            ))
          ) : (
            <li className="text-xs text-slate-500 dark:text-slate-400 py-1">
              Ready for incoming phone or desktop transfers.
            </li>
          )}
        </ul>

        <button
          type="button"
          onClick={onSwitchToMobilePreview}
          className="mt-3 w-full min-h-[40px] px-3 py-2 text-xs font-medium text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-950/60 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 border border-indigo-200/70 dark:border-indigo-800/70 rounded-lg transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer"
        >
          <Smartphone className="w-3.5 h-3.5" />
          <span>
            {isMobileMode
              ? 'Switch to Desktop Receiver View'
              : 'Preview Mobile Phone Sender View'}
          </span>
        </button>
      </div>
    </section>
  );
};
