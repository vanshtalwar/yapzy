import { type ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

/** Centered, muted note in the chat log ("You're now chatting with a stranger"). */
export function SystemMessage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        'mx-auto my-1 max-w-[90%] rounded-full bg-secondary px-3 py-1 text-center text-xs text-secondary-foreground',
        className,
      )}
    >
      {children}
    </p>
  );
}
