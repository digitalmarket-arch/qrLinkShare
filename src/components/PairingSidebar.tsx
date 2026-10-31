import React, { useState } from 'react';
import {
  Smartphone,
  Monitor,
  RefreshCw,
  ArrowRight,
  QrCode,
  KeyRound,
  ShieldCheck,
  LogIn,
  LogOut,
  CheckCircle2,
  ExternalLink,
} from 'lucide-react';
import {
  ConnectedDevice,
  DesktopAuthMethod,
  DesktopAuthSession,
  ErrorCorrectionLevel,
} from '../types/share';
import {
  buildPairingUrl,
  generateRoomCode,
  normalizeRoomCode,
  validatePinCode,
} from '../utils/shareLogic';
import { QrCodeView } from './QrCodeView';

interface PairingSidebarProps {
  roomId: string;
  challengeId: string;
  activePinCode: string;
  authSession: DesktopAuthSession | null;
  onJoinRoom: (newRoomId: string) => void;
  onApproveQrLogin: (method: DesktopAuthMethod, label?: string) => Promise<void>;
  onVerifyPinLogin: (pinInput: string) => Promise<void>;
  onGoogleLogin: () => Promise<void>;
  onLogoutSession: () => Promise<void>;
  devices: ConnectedDevice[];
  wsConnected: boolean;
  onSwitchToMobilePreview: () => void;
  isMobileMode: boolean;
}

export const PairingSidebar: React.FC<PairingSidebarProps> = ({
  roomId,
  challengeId,
  activePinCode,
  authSession,
  onJoinRoom,
  onApproveQrLogin,
  onVerifyPinLogin,
  onGoogleLogin,
  onLogoutSession,
  devices,
  wsConnected,
  onSwitchToMobilePreview,
  isMobileMode,
}) => {
  const [authTab, setAuthTab] = useState<DesktopAuthMethod>('qr');
  const [customRoomInput, setCustomRoomInput] = useState(roomId);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [ecLevel, setEcLevel] = useState<ErrorCorrectionLevel>('M');

  const baseUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : 'http://localhost:3000/';
  const pairingUrl = buildPairingUrl(
    baseUrl,
    roomId,
    challengeId,
    activePinCode
  );

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

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    const check = validatePinCode(pinInput);
    if (!check.valid) {
      setPinError(check.error || 'Enter a valid 6-digit numeric PIN.');
      return;
    }
    setIsApproving(true);
    try {
      await onVerifyPinLogin(check.cleaned);
      setPinInput('');
    } catch (err) {
      setPinError(
        err instanceof Error ? err.message : 'Failed to verify 6-digit PIN.'
      );
    } finally {
      setIsApproving(false);
    }
  };

  const handleQrApproveClick = async () => {
    setAuthError(null);
    setIsApproving(true);
    try {
      await onApproveQrLogin('qr', 'iPhone 16 Pro · QR Scan Login');
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Could not complete QR login.'
      );
    } finally {
      setIsApproving(false);
    }
  };

  const handleGoogleSignInClick = async () => {
    setAuthError(null);
    setIsApproving(true);
    try {
      await onGoogleLogin();
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'Google sign-in popup was closed or blocked.'
      );
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <section
      aria-labelledby="pairing-heading"
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2
            id="pairing-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2"
          >
            <QrCode className="w-4 h-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
            <span>Desktop QR Login & Account Bridge</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Log in on desktop via QR code scan, 6-digit PIN, or Google to automatically open your newest phone-shared links.
          </p>
        </div>
      </div>

      {/* Authenticated Desktop Status Banner */}
      {authSession?.authenticated ? (
        <div className="mb-4 p-3 rounded-xl bg-emerald-50/90 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/80 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span className="truncate">
                Desktop Logged In ({authSession.method.toUpperCase()})
              </span>
            </div>
            <p className="text-[11px] text-emerald-700 dark:text-emerald-400 font-mono truncate mt-0.5">
              {authSession.userLabel} · Room {roomId}
            </p>
          </div>
          <button
            type="button"
            onClick={onLogoutSession}
            className="min-h-[32px] px-2.5 py-1 text-xs font-medium text-emerald-900 dark:text-emerald-200 bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 rounded-lg hover:bg-emerald-100 flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <LogOut className="w-3 h-3" />
            <span>Lock</span>
          </button>
        </div>
      ) : (
        <div className="mb-4 p-3 rounded-xl bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200/80 dark:border-indigo-800/70">
          <p className="text-xs font-semibold text-indigo-950 dark:text-indigo-200">
            Awaiting Desktop Login to Auto-Launch Shared Links
          </p>
          <p className="text-[11px] text-indigo-700 dark:text-indigo-300 mt-0.5">
            Scan the QR code below with your phone, enter your 6-digit PIN, or sign in with Google.
          </p>
        </div>
      )}

      {/* 3-Way Authentication Method Tabs (QR Scan | 6-Digit PIN | Google Sign-In) */}
      <div
        role="tablist"
        aria-label="Desktop authentication method"
        className="grid grid-cols-3 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg mb-4"
      >
        <button
          type="button"
          role="tab"
          aria-selected={authTab === 'qr'}
          onClick={() => {
            setAuthTab('qr');
            setAuthError(null);
          }}
          className={`min-h-[38px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
            authTab === 'qr'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <QrCode className="w-3.5 h-3.5 shrink-0" />
          <span>1. Scan QR</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={authTab === 'pin'}
          onClick={() => {
            setAuthTab('pin');
            setAuthError(null);
          }}
          className={`min-h-[38px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
            authTab === 'pin'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <KeyRound className="w-3.5 h-3.5 shrink-0" />
          <span>2. 6-Digit PIN</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={authTab === 'google'}
          onClick={() => {
            setAuthTab('google');
            setAuthError(null);
          }}
          className={`min-h-[38px] px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap cursor-pointer ${
            authTab === 'google'
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xs'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
          <span>3. Google</span>
        </button>
      </div>

      {/* Tab 1: Scan Desktop QR with Phone */}
      {authTab === 'qr' && (
        <div className="py-3 flex flex-col items-center border-y border-slate-100 dark:border-slate-800/80">
          <QrCodeView
            value={pairingUrl}
            size={184}
            errorCorrectionLevel={ecLevel}
            downloadFileName={`qrlinkshare-login-${roomId}`}
            label={`Scan to Log In & Open Links (${roomId})`}
          />

          <button
            type="button"
            disabled={isApproving}
            onClick={handleQrApproveClick}
            className="mt-3 w-full min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            <span>
              {isApproving
                ? 'Approving QR Login...'
                : 'Approve QR Login & Auto-Open Newest Link'}
            </span>
          </button>

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
      )}

      {/* Tab 2: 6-Digit Pairing PIN Code */}
      {authTab === 'pin' && (
        <div className="py-4 border-y border-slate-100 dark:border-slate-800/80 space-y-4">
          <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Active Phone-to-Desktop Pairing PIN ({roomId})
            </p>
            <p
              data-testid="active-pairing-pin"
              className="mt-1 text-2xl font-mono font-bold tracking-widest text-slate-900 dark:text-slate-100 tabular-nums"
            >
              {activePinCode.slice(0, 3)} {activePinCode.slice(3)}
            </p>
          </div>

          <form onSubmit={handlePinSubmit} noValidate className="space-y-2.5">
            <label
              htmlFor="pairing-pin-input"
              className="block text-xs font-medium text-slate-700 dark:text-slate-300"
            >
              Enter 6-Digit Phone PIN to Log In on Desktop
            </label>
            <div className="flex items-center gap-2">
              <input
                id="pairing-pin-input"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={pinInput}
                onChange={(e) => {
                  setPinInput(e.target.value.replace(/[^0-9]/g, ''));
                  if (pinError) setPinError(null);
                }}
                placeholder={activePinCode}
                className="w-full min-h-[42px] px-3 py-2 text-sm font-mono font-semibold tracking-widest bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 tabular-nums"
              />
              <button
                type="submit"
                disabled={isApproving}
                className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Verify PIN & Open
              </button>
            </div>
            {pinError && (
              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                {pinError}
              </p>
            )}
          </form>
        </div>
      )}

      {/* Tab 3: Google Account Cloud Sync */}
      {authTab === 'google' && (
        <div className="py-4 border-y border-slate-100 dark:border-slate-800/80 space-y-3">
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Sign in with the same Google account on your phone and desktop browser to sync your Saved Vault and Temporary Links via Cloud Firestore.
          </p>

          <button
            type="button"
            disabled={isApproving}
            onClick={handleGoogleSignInClick}
            className="w-full min-h-[42px] px-4 py-2.5 text-xs font-semibold text-white bg-slate-900 dark:bg-indigo-600 hover:bg-slate-800 dark:hover:bg-indigo-500 rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign In with Google & Sync Vault</span>
          </button>
        </div>
      )}

      {authError && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {authError}
        </p>
      )}

      {/* Room Code Switcher */}
      <form onSubmit={handleRoomSubmit} className="mt-4" noValidate>
        <div className="flex items-center justify-between mb-1.5">
          <label
            htmlFor="room-code-input"
            className="text-xs font-medium text-slate-700 dark:text-slate-300"
          >
            Active Vault / Room ID
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
            {wsConnected ? 'Live Sync Active' : 'Cloud / Local Sync'} ·{' '}
            {devices.length} {devices.length === 1 ? 'device' : 'devices'}
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
