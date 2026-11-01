import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

interface Props {
  value: string;
  size?: number;
  className?: string;
  label: string;
}

/** Renders a crisp SVG QR code. Always dark-on-white so every camera can read it. */
export function QrCode({ value, size = 220, className = '', label }: Props) {
  const [svg, setSvg] = useState('');

  useEffect(() => {
    let alive = true;
    QRCode.toString(value, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#111116', light: '#ffffff' } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [value]);

  return (
    <div
      role="img"
      aria-label={label}
      className={`bg-white rounded-2xl p-4 shadow-sm ring-1 ring-black/5 ${className}`}
      style={{ width: size, height: size }}
    >
      {svg ? (
        <div className="w-full h-full [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="w-full h-full rounded-lg bg-neutral-100 animate-pulse" />
      )}
    </div>
  );
}
