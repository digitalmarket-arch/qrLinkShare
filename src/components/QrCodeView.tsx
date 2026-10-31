import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Download, Check, Copy } from 'lucide-react';
import { ErrorCorrectionLevel } from '../types/share';

interface QrCodeViewProps {
  value: string;
  size?: number;
  errorCorrectionLevel?: ErrorCorrectionLevel;
  fgColor?: string;
  bgColor?: string;
  label?: string;
  downloadFileName?: string;
  showControls?: boolean;
  copyLabel?: string;
}

export const QrCodeView: React.FC<QrCodeViewProps> = ({
  value,
  size = 200,
  errorCorrectionLevel = 'M',
  fgColor = '#0F172A',
  bgColor = '#FFFFFF',
  label,
  downloadFileName = 'qrlinkshare-code',
  showControls = true,
  copyLabel = 'Copy Pair URL',
}) => {
  const [svgMarkup, setSvgMarkup] = useState<string>('');
  const [pngDataUrl, setPngDataUrl] = useState<string>('');
  const [copiedPayload, setCopiedPayload] = useState(false);

  useEffect(() => {
    let active = true;
    const safeValue = value.trim() || 'https://localhost:3000';

    QRCode.toString(safeValue, {
      type: 'svg',
      width: size,
      margin: 2,
      errorCorrectionLevel,
      color: {
        dark: fgColor,
        light: bgColor,
      },
    })
      .then((svg) => {
        if (active) setSvgMarkup(svg);
      })
      .catch(() => {
        if (active) setSvgMarkup('');
      });

    QRCode.toDataURL(safeValue, {
      width: size * 2,
      margin: 2,
      errorCorrectionLevel,
      color: {
        dark: fgColor,
        light: bgColor,
      },
    })
      .then((url) => {
        if (active) setPngDataUrl(url);
      })
      .catch(() => {
        if (active) setPngDataUrl('');
      });

    return () => {
      active = false;
    };
  }, [value, size, errorCorrectionLevel, fgColor, bgColor]);

  const handleDownloadPng = () => {
    if (!pngDataUrl) return;
    const link = document.createElement('a');
    link.href = pngDataUrl;
    link.download = `${downloadFileName}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadSvg = () => {
    if (!svgMarkup) return;
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${downloadFileName}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleCopyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 1800);
    } catch {
      setCopiedPayload(true);
      setTimeout(() => setCopiedPayload(false), 1800);
    }
  };

  return (
    <div className="flex flex-col items-center">
      <div
        data-testid="qr-code-surface"
        className="p-3 bg-white rounded-xl border border-slate-200 dark:border-slate-700 shadow-xs flex items-center justify-center"
        style={{ width: size + 24, height: size + 24 }}
      >
        {svgMarkup ? (
          <div
            className="w-full h-full flex items-center justify-center [&>svg]:w-full [&>svg]:h-full"
            dangerouslySetInnerHTML={{ __html: svgMarkup }}
          />
        ) : (
          <div className="text-xs text-slate-400 font-mono">Generating QR...</div>
        )}
      </div>

      {label && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 text-center max-w-[240px] truncate">
          {label}
        </p>
      )}

      {showControls && (
        <div className="mt-3 flex items-center gap-2 flex-wrap justify-center">
          <button
            type="button"
            onClick={handleCopyValue}
            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedPayload ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>Copied Link</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>{copyLabel}</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={handleDownloadPng}
            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>PNG</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadSvg}
            className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>SVG</span>
          </button>
        </div>
      )}
    </div>
  );
};
