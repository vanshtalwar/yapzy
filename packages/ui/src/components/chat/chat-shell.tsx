// Source: 21st.dev — "Chat Messages" by nexus-ui (https://21st.dev/r/nexus-ui/chat-messages),
// adapted: layout (header / log / composer) kept; demo autoplay, sample data, AI branding,
// hard-coded colors and framer-motion removed (no animation on the chat hot path); theme
// tokens; full-height mobile-first layout; presentational only.
import { type ComponentProps, type ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface ChatShellProps extends Omit<ComponentProps<'section'>, 'title'> {
  title: ReactNode;
  /** Short status under the title (e.g. "Connected", "Searching…"). */
  status?: ReactNode;
  /** Header actions (Next / Stop). */
  actions?: ReactNode;
  /** Non-blocking banner under the header (e.g. "connection unstable"). */
  banner?: ReactNode;
  /** Composer or end-of-chat actions. */
  footer?: ReactNode;
}

export function ChatShell({
  title,
  status,
  actions,
  banner,
  footer,
  className,
  children,
  ...props
}: ChatShellProps) {
  return (
    <section
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden border-border bg-card text-card-foreground sm:rounded-xl sm:border sm:shadow-sm',
        className,
      )}
      {...props}
    >
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          {status !== undefined && (
            <p className="truncate text-xs text-muted-foreground">{status}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {banner}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {footer !== undefined && <footer className="border-t p-3">{footer}</footer>}
    </section>
  );
}
