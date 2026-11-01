import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: Tone;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
}

type Push = (t: Omit<Toast, 'id'>, ms?: number) => void;
const ToastContext = createContext<Push>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>(
    (t, ms = 5000) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { ...t, id }]);
      setTimeout(() => dismiss(id), ms);
    },
    [dismiss]
  );

  const icon = { success: CheckCircle2, error: AlertCircle, info: Info };
  const color = { success: 'text-live', error: 'text-danger', info: 'text-brand' };

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="fixed z-50 inset-x-0 bottom-0 flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none"
      >
        {toasts.map((t) => {
          const Icon = icon[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === 'error' ? 'alert' : 'status'}
              className="animate-rise pointer-events-auto w-full max-w-md card shadow-lg shadow-black/10 px-4 py-3 flex items-start gap-3"
            >
              <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${color[t.tone]}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">{t.title}</p>
                {t.body && <p className="text-sm text-muted mt-0.5 break-words">{t.body}</p>}
              </div>
              {t.action && (
                <button
                  type="button"
                  className="btn btn-primary min-h-9 px-3 text-sm"
                  onClick={() => {
                    t.action!.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button type="button" aria-label="Dismiss" className="icon-btn w-8 h-8 -mr-1" onClick={() => dismiss(t.id)}>
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
