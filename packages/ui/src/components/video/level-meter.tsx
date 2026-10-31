import { cn } from '../../lib/cn.ts';

/** Segmented input-level meter (0–1), e.g. "is my microphone working?". */
export function LevelMeter({
  level,
  label = 'Microphone level',
  segments = 12,
  className,
}: {
  level: number;
  label?: string;
  segments?: number;
  className?: string;
}) {
  const clamped = Math.min(1, Math.max(0, level));
  const active = Math.round(clamped * segments);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      className={cn('flex h-2 gap-0.5', className)}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          className={cn(
            'flex-1 rounded-full',
            index < active ? 'bg-success' : 'bg-muted-foreground/20',
          )}
        />
      ))}
    </div>
  );
}
