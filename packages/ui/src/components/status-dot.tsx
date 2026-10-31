import { type ComponentProps } from 'react';

import { cn } from '../lib/cn.ts';

const tones = {
  online: 'bg-success',
  warning: 'bg-warning',
  offline: 'bg-muted-foreground',
} as const;

/**
 * Pulsing presence dot (design inspired by the 21st.dev "Status" badge by diceui; written
 * in-house). Decorative: always pair it with visible text.
 */
export function StatusDot({
  tone = 'online',
  pulse = true,
  className,
  ...props
}: ComponentProps<'span'> & { tone?: keyof typeof tones; pulse?: boolean }) {
  return (
    <span className={cn('relative inline-flex size-2', className)} aria-hidden {...props}>
      {pulse && (
        <span
          className={cn(
            'absolute inline-flex size-full rounded-full opacity-75 motion-safe:animate-ping',
            tones[tone],
          )}
        />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', tones[tone])} />
    </span>
  );
}
