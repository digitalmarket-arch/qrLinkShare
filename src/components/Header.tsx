import { LogOut, Monitor, Moon, Sun, Wallet } from 'lucide-react';
import type { Account } from '../types/share';
import type { RelayStatus } from '../lib/mesh';

export type Theme = 'system' | 'light' | 'dark';

interface Props {
  ready: boolean;
  relay: RelayStatus;
  deviceCount: number;
  account: Account | null;
  theme: Theme;
  onTheme: (t: Theme) => void;
  onSignOut: () => void;
}

export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="w-8 h-8" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--brand)" />
        <path d="M8 8h7v7H8zM17 17h7v7h-7zM19 8h5v5h-5zM8 19h5v5H8z" fill="var(--brand-ink)" />
      </svg>
      <span className="text-[17px] font-extrabold tracking-tight">qrLinkShare</span>
    </span>
  );
}

export function Header({ ready, relay, deviceCount, account, theme, onTheme, onSignOut }: Props) {
  const next: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  const pill =
    deviceCount > 0
      ? { dot: 'bg-live live-dot', text: `Connected · ${deviceCount} device${deviceCount > 1 ? 's' : ''}` }
      : relay === 'offline'
        ? { dot: 'bg-danger', text: 'Offline · retrying' }
        : relay === 'online' && ready
          ? { dot: 'bg-warn', text: 'Looking for your devices…' }
          : { dot: 'bg-warn', text: 'Connecting…' };

  return (
    <header className="sticky top-0 z-30 bg-bg/85 backdrop-blur-md border-b border-line">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center gap-3">
        <a href="./" aria-label="qrLinkShare home" className="shrink-0">
          <Logo />
        </a>
        <span className="flex-1" />

        <span
          className="hidden sm:inline-flex items-center gap-2 h-9 px-3 rounded-full bg-surface border border-line text-xs font-semibold"
          aria-live="polite"
        >
          <span className={`w-2 h-2 rounded-full ${pill.dot}`} />
          {pill.text}
        </span>
        <span className={`sm:hidden w-2.5 h-2.5 rounded-full ${pill.dot}`} role="status" aria-label={pill.text} title={pill.text} />

        {account && (
          <span className="inline-flex items-center gap-2 h-9 pl-3 pr-1 rounded-full bg-surface border border-line text-xs font-semibold max-w-[46vw]">
            {account.kind === 'wallet' ? (
              <Wallet className="w-3.5 h-3.5 text-brand shrink-0" />
            ) : (
              <span className="w-5 h-5 rounded-full bg-brand text-brand-ink text-[10px] flex items-center justify-center shrink-0">
                {(account.label || 'G')[0].toUpperCase()}
              </span>
            )}
            <span className="truncate">{account.label}</span>
            <button type="button" aria-label="Sign out" title="Sign out" className="icon-btn w-7 h-7" onClick={onSignOut}>
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </span>
        )}

        <button
          type="button"
          className="icon-btn"
          onClick={() => onTheme(next[theme])}
          aria-label={`Theme: ${theme}. Switch to ${next[theme]}`}
          title={`Theme: ${theme}`}
        >
          <ThemeIcon className="w-[18px] h-[18px]" />
        </button>
      </div>
    </header>
  );
}
