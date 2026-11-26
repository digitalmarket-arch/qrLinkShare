import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceInfo } from '../types/share';
import type { Mesh } from '../lib/mesh';
import { inviteLink, randomPin, randomSecret } from '../lib/pairing';

const CODE_TTL_MS = 3 * 60 * 1000;

interface Code {
  invite: string;
  pin: string;
  expiresAt: number;
}

const freshCode = (): Code => ({ invite: randomSecret(18), pin: randomPin(), expiresAt: Date.now() + CODE_TTL_MS });

/**
 * While `enabled`, shows a one-time QR invitation + 6-digit PIN for this device and
 * listens for a new device using either. Codes change every 3 minutes and after each use.
 */
export function usePairing(opts: {
  mesh: Mesh | null;
  enabled: boolean;
  groupSecret: string;
  onKnock: (device: DeviceInfo) => Promise<boolean>;
  onPaired: (device: DeviceInfo, via: 'qr' | 'pin') => void;
}) {
  const { mesh, enabled, groupSecret } = opts;
  const [code, setCode] = useState<Code>(freshCode);
  const [now, setNow] = useState(Date.now());
  const handlers = useRef(opts);
  handlers.current = opts;
  const secretRef = useRef(groupSecret);
  secretRef.current = groupSecret;

  const refresh = useCallback(() => setCode(freshCode()), []);

  // Listen for new devices using the current code.
  useEffect(() => {
    if (!mesh || !enabled) return;
    const stop = mesh.host(
      { invite: code.invite, pin: code.pin },
      {
        groupSecret: () => secretRef.current,
        onKnock: (d) => handlers.current.onKnock(d),
        onPaired: (d, via) => {
          handlers.current.onPaired(d, via);
          refresh(); // each code works once
        },
      }
    );
    return stop;
  }, [mesh, enabled, code.invite, code.pin, refresh]);

  // Countdown, and a new code when time is up (only while visible).
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= code.expiresAt && document.visibilityState === 'visible') refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [enabled, code.expiresAt, refresh]);

  // A code that expired while the tab was hidden is replaced when it comes back.
  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= code.expiresAt) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled, code.expiresAt, refresh]);

  const msLeft = Math.max(0, code.expiresAt - now);
  return {
    pin: code.pin,
    link: inviteLink(code.invite, { origin: location.origin, pathname: location.pathname }),
    secondsLeft: Math.ceil(msLeft / 1000),
    fractionLeft: msLeft / CODE_TTL_MS,
    refresh,
  };
}
