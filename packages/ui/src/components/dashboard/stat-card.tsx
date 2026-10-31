import { type ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

/** One number with a label and an optional hint/trend, for dashboards. */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'warning' | 'danger';
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border bg-card p-4 text-card-foreground shadow-sm', className)}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{label}</span>
        {icon !== undefined && <span className="[&_svg]:size-4">{icon}</span>}
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tabular-nums',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-destructive',
        )}
      >
        {value}
      </p>
      {hint !== undefined && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
