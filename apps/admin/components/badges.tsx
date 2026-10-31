import { type ReportReason } from '@app/shared';
import { Badge, cn } from '@app/ui';

import { priorityTone, REASON_LABELS, STATUS_LABELS } from '../lib/labels.ts';

export function PriorityBadge({ priority }: { priority: number }) {
  const tone = priorityTone(priority);
  return (
    <span
      className={cn(
        'inline-flex min-w-9 justify-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums',
        tone === 'danger' && 'bg-destructive text-destructive-foreground',
        tone === 'warning' && 'bg-warning/15 text-warning',
        tone === 'muted' && 'bg-muted text-muted-foreground',
      )}
      aria-label={`Priority ${String(priority)}`}
    >
      {priority}
    </span>
  );
}

export function StatusBadge({ status }: { status: keyof typeof STATUS_LABELS }) {
  return <Badge variant={status === 'OPEN' ? 'default' : 'muted'}>{STATUS_LABELS[status]}</Badge>;
}

export function ReasonLabel({ reason }: { reason: ReportReason }) {
  return (
    <span className={cn(reason === 'MINOR_SAFETY' && 'font-semibold text-destructive')}>
      {REASON_LABELS[reason]}
    </span>
  );
}
