'use client';

import { type ClipboardEvent, type KeyboardEvent, useRef } from 'react';

import { cn } from '../../lib/cn.ts';

/** 6-digit one-time-code input: one box per digit, paste fills all, autocomplete one-time-code. */
export function OtpInput({
  value,
  onChange,
  length = 6,
  disabled = false,
  label = 'Authentication code',
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  disabled?: boolean;
  label?: string;
  autoFocus?: boolean;
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, index) => value[index] ?? '');

  const set = (index: number, digit: string) => {
    const next = digits.slice();
    next[index] = digit;
    onChange(next.join('').slice(0, length));
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && digits[index] === '' && index > 0) {
      inputs.current[index - 1]?.focus();
      set(index - 1, '');
      event.preventDefault();
    } else if (event.key === 'ArrowLeft' && index > 0) inputs.current[index - 1]?.focus();
    else if (event.key === 'ArrowRight' && index < length - 1) inputs.current[index + 1]?.focus();
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (pasted === '') return;
    event.preventDefault();
    onChange(pasted);
    inputs.current[Math.min(pasted.length, length - 1)]?.focus();
  };

  return (
    <div role="group" aria-label={label} className="flex gap-2">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(element) => {
            inputs.current[index] = element;
          }}
          value={digit}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          autoFocus={autoFocus && index === 0}
          aria-label={`Digit ${String(index + 1)}`}
          maxLength={1}
          className={cn(
            'size-11 rounded-md border border-input bg-background text-center text-lg font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          )}
          onChange={(event) => {
            const digit = event.target.value.replace(/\D/g, '').slice(-1);
            set(index, digit);
            if (digit !== '' && index < length - 1) inputs.current[index + 1]?.focus();
          }}
          onKeyDown={onKeyDown(index)}
          onPaste={onPaste}
        />
      ))}
    </div>
  );
}
