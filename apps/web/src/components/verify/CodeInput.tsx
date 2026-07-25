'use client';

/**
 * Ввод SMS-кода — 6 «бумажных» ячеек (движок core/verify).
 *
 * Под капотом ОДИН настоящий input, растянутый поверх ячеек с opacity:0 — так
 * автозаполнение из SMS (iOS Security Code AutoFill / Android WebOTP через
 * autocomplete="one-time-code") работает как с обычным полем, а вставка из
 * буфера приходит целой строкой. Ячейки — только отображение.
 */

import { useEffect, useRef, useState } from 'react';

export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  error = false,
  disabled = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Вызывается один раз, когда набраны все цифры (автосабмит). */
  onComplete?: (v: string) => void;
  length?: number;
  error?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // Автосабмит ровно один раз на конкретное значение (backspace+повтор — снова можно).
  useEffect(() => {
    if (value.length === length && firedFor.current !== value) {
      firedFor.current = value;
      onComplete?.(value);
    }
    if (value.length < length) firedFor.current = null;
  }, [value, length, onComplete]);

  const cells = Array.from({ length }, (_, i) => value[i] ?? '');
  const activeIdx = Math.min(value.length, length - 1);

  return (
    <div
      className={error ? 'otp-shake' : undefined}
      style={{ position: 'relative', display: 'inline-flex', gap: 'var(--spacing-2)' }}
      onClick={() => inputRef.current?.focus()}
    >
      {cells.map((ch, i) => (
        <div
          key={i}
          className={[
            'otp-cell',
            focused && i === activeIdx && !disabled ? 'otp-cell--active' : '',
            ch ? 'otp-cell--filled' : '',
            error ? 'otp-cell--error' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          // лёгкий рукописный «разнобой» ячеек (наклон как у PersonCard)
          style={{ transform: `rotate(${[-1.2, 0.8, -0.5, 1.1, -0.9, 0.6][i % 6]}deg)` }}
        >
          {ch}
        </div>
      ))}
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={length}
        value={value}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, length))}
        aria-label="Код из SMS"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          border: 'none',
          background: 'transparent',
          caretColor: 'transparent',
          cursor: disabled ? 'default' : 'text',
        }}
      />
    </div>
  );
}
