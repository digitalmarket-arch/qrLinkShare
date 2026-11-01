import { useCallback, useEffect, useRef, useState } from 'react';
import type { PairingCode, RoomSession } from '../types/share';
import { api } from '../lib/api';

/**
 * Fetches a one-time QR token + 6-digit PIN for the current room and refreshes
 * it automatically before it expires (every ~3 minutes) or after it is used.
 */
export function usePairing(session: RoomSession | null, enabled: boolean) {
  const [code, setCode] = useState<PairingCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const loading = useRef(false);

  const refresh = useCallback(async () => {
    if (!session || loading.current) return;
    loading.current = true;
    try {
      setCode(await api.createPairing(session));
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

  // Tick once a second for the countdown, and renew when time is up.
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);

  const msLeft = code ? new Date(code.expiresAt).getTime() - now : 0;
  useEffect(() => {
    if (enabled && code && msLeft <= 0 && document.visibilityState === 'visible') refresh();
  }, [enabled, code, msLeft <= 0, refresh]);

  // A hidden tab doesn't need fresh codes; renew when it becomes visible again.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && code && new Date(code.expiresAt).getTime() < Date.now()) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, code, refresh]);

  const totalMs = 3 * 60 * 1000;
  return {
    code,
    error,
    refresh,
    secondsLeft: Math.max(0, Math.ceil(msLeft / 1000)),
    fractionLeft: code ? Math.max(0, Math.min(1, msLeft / totalMs)) : 0,
  };
}
