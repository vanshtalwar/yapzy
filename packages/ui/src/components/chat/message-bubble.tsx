// Source: 21st.dev — "Chat Messages" by nexus-ui, adapted (see chat-shell.tsx): bubble shape
// and alignment kept; tokens instead of gradients; delivery states added.
import { AlertCircleIcon, RotateCwIcon } from 'lucide-react';

import { cn } from '../../lib/cn.ts';

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'blocked';

export interface MessageBubbleProps {
  from: 'self' | 'stranger';
  /** Plain text. Rendered as a text node — never parsed as HTML, never auto-linked. */
  text: string;
  status?: MessageStatus;
  onRetry?: () => void;
}

export function MessageBubble({ from, text, status = 'sent', onRetry }: MessageBubbleProps) {
  const self = from === 'self';
  return (
    <div className={cn('flex w-full', self ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex max-w-[85%] flex-col gap-1 sm:max-w-[75%]', self && 'items-end')}>
        <p className="sr-only">{self ? 'You:' : 'Stranger:'}</p>
        <div
          className={cn(
            'rounded-2xl px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap',
            self
              ? 'rounded-tr-md bg-primary text-primary-foreground'
              : 'rounded-tl-md border bg-muted text-foreground',
            status === 'sending' && 'opacity-70',
            (status === 'failed' || status === 'blocked') &&
              'border border-destructive/60 bg-destructive/10 text-foreground',
          )}
        >
          {text}
        </div>
        {status === 'failed' && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 rounded text-xs text-destructive outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCwIcon className="size-3" aria-hidden />
            Not delivered — retry
          </button>
        )}
        {status === 'blocked' && (
          <span className="inline-flex items-center gap-1 text-xs text-destructive">
            <AlertCircleIcon className="size-3" aria-hidden />
            Not sent — this message breaks the community guidelines
          </span>
        )}
      </div>
    </div>
  );
}
