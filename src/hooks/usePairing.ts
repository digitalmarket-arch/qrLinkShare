import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceInfo } from '../types/share';
import type { Mesh } from '../lib/mesh';
import { inviteLink, randomPin, randomSecret } from '../lib/pairing';

export const CODE_TTL_MS = 3 * 60 * 1000;

interface Code {
  invite: string;
  pin: string;
  expiresAt: number;
}

const freshCode = (): Code => ({ invite: randomSecret(18), pin: randomPin(), expiresAt: Date.now() + CODE_TTL_MS });
const linkFor = (c: Code) => inviteLink(c.invite, { origin: location.origin, pathname: location.pathname });

/**
 * While `enabled`, shows a one-time QR invitation + 6-digit PIN for this device and
 * listens for a new device using either. Codes change every 3 minutes, after each use,
 * and after a declined or abandoned attempt. The 3-minute limit is enforced when a
 * device arrives, so it also holds while this tab is in the background.
 */
export function usePairing(opts: {
  mesh: Mesh | null;
  enabled: boolean;
  groupSecret: string;
  hasPaired: () => boolean;
  onKnock: (device: DeviceInfo, code: string, signal: AbortSignal) => Promise<boolean>;
  onAdopt: (secret: string, device: DeviceInfo) => Promise<void>;
  onPaired: (device: DeviceInfo, via: 'qr' | 'pin') => void;
  /** Two devices used the same PIN at once (the code was replaced for safety). */
  onCollision: () => void;
}) {
  const { mesh, enabled } = opts;
  const [code, setCode] = useState<Code>(freshCode);
  const [now, setNow] = useState(Date.now());
  const handlers = useRef(opts);
  handlers.current = opts;
  /** While someone is deciding whether to allow a device, the code isn't replaced. */
  const knocking = useRef(0);

  /** Replaces the code; returns the new pairing link. */
  const refresh = useCallback(() => {
    const next = freshCode();
    setCode(next);
    return linkFor(next);
  }, []);

  // Listen for new devices using the current code.
  useEffect(() => {
    if (!mesh || !enabled) return;
    const stop = mesh.host(code, {
      groupSecret: () => handlers.current.groupSecret,
      hasPaired: () => handlers.current.hasPaired(),
      onKnock: async (d, sasCode, signal) => {
        knocking.current++;
        try {
          return await handlers.current.onKnock(d, sasCode, signal);
        } finally {
          knocking.current--;
        }
      },
      onAdopt: (secret, d) => handlers.current.onAdopt(secret, d),
      onPaired: (d, via) => {
        handlers.current.onPaired(d, via);
        refresh(); // each code works once
      },
      onSpent: (reason) => {
        if (reason === 'collision') handlers.current.onCollision();
        refresh();
      },
    });
    return stop;
  }, [mesh, enabled, code, refresh]);

  // Countdown, and a new code when time is up (also in a background tab).
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      if (n >= code.expiresAt && knocking.current === 0) refresh();
    };
    tick();
    const t = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, code.expiresAt, refresh]);

  const msLeft = Math.max(0, code.expiresAt - now);
  return {
    pin: code.pin,
    link: linkFor(code),
    secondsLeft: Math.ceil(msLeft / 1000),
    fractionLeft: msLeft / CODE_TTL_MS,
    refresh,
  };
}
