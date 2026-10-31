import { cn } from '../../lib/cn.ts';

export type CallQuality = 'good' | 'fair' | 'poor';
export type CallConnection = 'connecting' | 'connected' | 'reconnecting';

const QUALITY_LABELS: Record<CallQuality, string> = {
  good: 'Good connection',
  fair: 'Fair connection',
  poor: 'Poor connection',
};
const BAR_COLORS: Record<CallQuality, string> = {
  good: 'bg-success',
  fair: 'bg-warning',
  poor: 'bg-destructive',
};
const BAR_HEIGHTS = ['h-1', 'h-2', 'h-3'] as const;

/** Signal bars + label for the media connection (from WebRTC stats). */
export function QualityBadge({
  connection,
  quality,
  className,
}: {
  connection: CallConnection;
  quality: CallQuality | null;
  className?: string;
}) {
  const label =
    connection === 'connecting'
      ? 'Connecting…'
      : connection === 'reconnecting'
        ? 'Reconnecting…'
        : quality === null
          ? 'Connected'
          : QUALITY_LABELS[quality];
  const bars = connection !== 'connected' ? 0 : quality === 'poor' ? 1 : quality === 'fair' ? 2 : 3;
  const color = BAR_COLORS[quality ?? 'good'];
  return (
    <span
      role="status"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full bg-stage/60 px-2.5 py-1 text-xs font-medium text-stage-foreground backdrop-blur-sm',
        className,
      )}
    >
      <span aria-hidden className="flex h-3 items-end gap-0.5">
        {BAR_HEIGHTS.map((height, index) => (
          <span
            key={height}
            className={cn(
              'w-1 rounded-sm',
              height,
              index < bars ? color : 'bg-stage-foreground/30',
            )}
          />
        ))}
      </span>
      {label}
    </span>
  );
}
