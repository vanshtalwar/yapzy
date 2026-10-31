'use client';

// Source: 21st.dev — "Chat Messages" by nexus-ui, adapted: the input row (field + send
// button) kept; textarea with Shift+Enter newlines, a live character counter and limits.
import { SendIcon } from 'lucide-react';
import { type KeyboardEvent, type SyntheticEvent, useId } from 'react';

import { cn } from '../../lib/cn.ts';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  maxLength: number;
  disabled?: boolean;
  placeholder?: string;
  /** Called on every keystroke (typing indicator). */
  onTyping?: () => void;
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  maxLength,
  disabled = false,
  placeholder = 'Type a message…',
  onTyping,
}: ChatComposerProps) {
  const counterId = useId();
  const length = value.length;
  const canSend = !disabled && value.trim().length > 0 && length <= maxLength;

  const submit = (event?: SyntheticEvent) => {
    event?.preventDefault();
    if (canSend) onSend();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline; IME composition must not send.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="relative min-w-0 flex-1">
        <textarea
          value={value}
          onChange={(event) => {
            onChange(event.target.value.slice(0, maxLength));
            onTyping?.();
          }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-label="Message"
          aria-describedby={counterId}
          className="block max-h-32 min-h-10 w-full resize-none rounded-xl border border-input bg-background px-3.5 py-2.5 pr-16 text-base outline-none field-sizing-content placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
        />
        <span
          id={counterId}
          className={cn(
            'pointer-events-none absolute right-3 bottom-2.5 text-xs tabular-nums text-muted-foreground',
            length >= maxLength * 0.9 && 'text-warning',
            length >= maxLength && 'text-destructive',
          )}
        >
          {length}/{maxLength}
        </span>
      </div>
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send message"
        className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:bg-secondary disabled:text-muted-foreground"
      >
        <SendIcon className="size-4" aria-hidden />
      </button>
    </form>
  );
}
