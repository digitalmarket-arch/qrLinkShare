import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface Props {
  value: string;
  size?: number;
  className?: string;
  label: string;
}

const FAILED_MESSAGE = 'Couldn’t make a QR code for this.';

/** Renders a crisp SVG QR code. Always dark-on-white so every camera can read it. */
export function QrCode({ value, size = 220, className = '', label }: Props) {
  // null while the first code is still being made.
  const [result, setResult] = useState<{ svg: string } | { failed: true } | null>(null);

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#111116', light: '#ffffff' } })
      .then((svg) => alive && setResult({ svg }))
      .catch(() => alive && setResult({ failed: true }));
    return () => {
      alive = false;
    };
  }, [value]);

  const failed = !!result && 'failed' in result;
  return (
    <div
      role="img"
      aria-label={failed ? FAILED_MESSAGE : label}
      className={`bg-white rounded-2xl p-4 shadow-sm ring-1 ring-black/5 ${className}`}
      style={{ width: size, height: size }}
    >
      {result && 'svg' in result ? (
        <div className="w-full h-full [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: result.svg }} />
      ) : failed ? (
        // The box stays white in dark mode too, so this uses a fixed grey that reads well on white.
        <div className="w-full h-full flex items-center justify-center px-2 text-center text-sm text-neutral-500">{FAILED_MESSAGE}</div>
      ) : (
        <div className="w-full h-full rounded-lg bg-neutral-100 animate-pulse" />
      )}
    </div>
  );
}
