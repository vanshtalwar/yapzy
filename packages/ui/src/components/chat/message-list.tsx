'use client';

// Source: 21st.dev — "Chat Messages" by nexus-ui, adapted (see chat-shell.tsx).
import { type ReactNode, useEffect, useRef } from 'react';

import { cn } from '../../lib/cn.ts';

/** Distance from the bottom (px) within which new content keeps the view pinned. */
const PIN_THRESHOLD = 80;

/**
 * Accessible chat log: `role="log"` + polite live region so screen readers announce new
 * messages. Auto-scrolls on new content only if the reader was already near the bottom.
 */
export function MessageList({
  children,
  className,
  /** Changes whenever content changes (e.g. message count + typing flag). */
  revision,
}: {
  children: ReactNode;
  className?: string;
  revision: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
  }, [revision]);

  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label="Chat messages"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD;
      }}
      className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-4', className)}
    >
      {children}
    </div>
  );
}
