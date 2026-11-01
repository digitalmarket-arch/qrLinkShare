import { useRef, useState } from 'react';

interface Props {
  disabled?: boolean;
  onComplete: (pin: string) => void;
}

/**
 * Six boxes for a 6-digit PIN. A single real <input> sits on top, so typing,
 * pasting and phone "one-time code" autofill all just work.
 */
export function PinInput({ disabled, onComplete }: Props) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setValue(digits);
    if (digits.length === 6) {
      onComplete(digits);
      setTimeout(() => setValue(''), 300);
    }
  };

  return (
    <div className="relative" onClick={() => inputRef.current?.focus()}>
      <div className="grid grid-cols-6 gap-2" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => {
          const active = focused && i === Math.min(value.length, 5);
          return (
            <div
              key={i}
              className={`h-14 rounded-xl flex items-center justify-center font-mono text-2xl font-semibold border transition-colors ${
                active ? 'border-brand bg-surface ring-4 ring-[var(--ring)]' : 'border-line bg-surface-2'
              } ${i === 2 ? 'mr-1.5' : ''}`}
            >
              {value[i] ?? ''}
            </div>
          );
        })}
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => update(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={disabled}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        aria-label="6-digit PIN"
        className="absolute inset-0 w-full h-full opacity-0 cursor-text"
      />
    </div>
  );
}
