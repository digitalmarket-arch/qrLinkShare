import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { CameraOff } from 'lucide-react';

interface Props {
  onResult: (text: string) => void;
}

/**
 * Live camera QR scanner. Uses the browser's built-in BarcodeDetector when
 * available (fast, Android/Chrome/macOS) and falls back to jsQR everywhere else.
 */
export function QrScanner({ onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    type Detector = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };
    const NativeDetector = (window as unknown as { BarcodeDetector?: new (o: object) => Detector }).BarcodeDetector;
    const detector = NativeDetector ? new NativeDetector({ formats: ['qr_code'] }) : null;

    const found = (text: string) => {
      if (done.current) return;
      done.current = true;
      navigator.vibrate?.(40);
      onResultRef.current(text);
      setTimeout(() => (done.current = false), 2500);
    };

    let last = 0;
    const tick = async (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      const video = videoRef.current;
      if (!video || video.readyState < 2 || t - last < 180 || done.current) return;
      last = t;
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes[0]?.rawValue) found(codes[0].rawValue);
          return;
        }
        if (!ctx) return;
        const w = Math.min(640, video.videoWidth);
        const h = Math.round((video.videoHeight / video.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (code?.data) found(code.data);
      } catch {
        // ignore a bad frame
      }
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot open the camera. Use your phone camera app, or enter the PIN instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((tr) => tr.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play().catch(() => {});
        raf = requestAnimationFrame(tick);
      } catch (err) {
        const name = (err as DOMException)?.name;
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access in your browser settings, or enter the PIN instead.'
            : name === 'NotFoundError'
              ? 'No camera found on this device. Enter the PIN instead.'
              : 'Could not start the camera. Enter the PIN instead.'
        );
      }
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  if (error) {
    return (
      <div className="aspect-square rounded-2xl bg-surface-2 flex flex-col items-center justify-center text-center gap-3 p-6">
        <CameraOff className="w-8 h-8 text-muted" />
        <p className="text-sm text-muted">{error}</p>
      </div>
    );
  }

  return (
    <div className="relative aspect-square rounded-2xl overflow-hidden bg-black">
      <video ref={videoRef} playsInline muted className="absolute inset-0 w-full h-full object-cover" />
      {/* Viewfinder */}
      <div className="absolute inset-[12%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
        <div className="scan-line absolute left-3 right-3 h-0.5 bg-brand shadow-[0_0_12px_var(--brand)]" />
      </div>
      <p className="absolute bottom-3 inset-x-0 text-center text-xs font-medium text-white/90">
        Point at the QR code on the other screen
      </p>
    </div>
  );
}
