// Source: 21st.dev — "Chat Messages" by nexus-ui, adapted: the TypingIndicator's three dots,
// re-done with CSS (motion-safe) instead of framer-motion; announces itself to screen readers.
import { cn } from '../../lib/cn.ts';

export function TypingIndicator({
  label = 'Stranger is typing',
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex justify-start', className)}>
      <div className="inline-flex items-center gap-1 rounded-2xl rounded-tl-md border bg-muted px-3.5 py-3">
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            aria-hidden
            className="size-1.5 rounded-full bg-muted-foreground motion-safe:animate-bounce"
            style={{ animationDelay: `${String(dot * 150)}ms` }}
          />
        ))}
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}
