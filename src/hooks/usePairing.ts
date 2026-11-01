import { useCallback, useEffect, useRef, useState } from 'react';
import type { PairingCode, RoomSession } from '../types/share';
import { api } from '../lib/api';

const CODE_TTL_MS = 3 * 60 * 1000;
/** Count down a little faster than the server so we never show a code it already expired. */
const SAFETY_MS = 3_000;
/** Never auto-refresh more often than this, even if something about the clock is off. */
const MIN_AUTO_REFRESH_GAP_MS = 10_000;

type LocalCode = PairingCode & { localExpiresAt: number };

/**
 * Fetches a one-time QR token + 6-digit PIN for the current room and refreshes
 * it automatically before it expires (every ~3 minutes) or after it is used.
 * The countdown uses this device's own clock from the moment the code arrived,
 * so a computer whose clock is wrong doesn't loop or show stale codes.
 */
export function usePairing(session: RoomSession | null, enabled: boolean) {
  const [code, setCode] = useState<LocalCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const loading = useRef(false);
  const lastFetch = useRef(0);

  const refresh = useCallback(async () => {
    if (!session || loading.current) return;
    loading.current = true;
    lastFetch.current = Date.now();
    try {
      const c = await api.createPairing(session);
      setCode({ ...c, localExpiresAt: Date.now() + CODE_TTL_MS - SAFETY_MS });
      setNow(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a pairing code.');
    } finally {
      loading.current = false;
    }
  }, [session?.token]);

  useEffect(() => {
    setCode(null);
    if (enabled) refresh();
  }, [enabled, refresh]);

  // Tick once a second for the countdown.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);

  const msLeft = code ? code.localExpiresAt - now : 0;
  const expired = !!code && msLeft <= 0;

  // Renew when time is up (only while visible, and never in a tight loop).
  useEffect(() => {
    if (!enabled || !expired || document.visibilityState !== 'visible') return;
    if (Date.now() - lastFetch.current < MIN_AUTO_REFRESH_GAP_MS) return;
    refresh();
  }, [enabled, expired, refresh, now]);

  // A hidden tab doesn't need fresh codes; renew when it becomes visible again.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      if (code && code.localExpiresAt < Date.now() && Date.now() - lastFetch.current >= MIN_AUTO_REFRESH_GAP_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, code, refresh]);

  return {
    code: expired ? null : code,
    error,
    refresh,
    secondsLeft: Math.max(0, Math.ceil(msLeft / 1000)),
    fractionLeft: code ? Math.max(0, Math.min(1, msLeft / CODE_TTL_MS)) : 0,
  };
}
