import { type ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Lays out 1–4 tiles: one fills the stage, two sit side by side (stacked on phones), three
 * or four form a 2×2 grid on wider screens and a scrollable stack on phones (group calls).
 */
export function VideoGrid({
  count,
  className,
  ...props
}: ComponentProps<'div'> & { count: number }) {
  return (
    <div
      className={cn(
        'grid size-full gap-2',
        count <= 1 && 'grid-cols-1',
        count === 2 && 'grid-cols-1 grid-rows-2 sm:grid-cols-2 sm:grid-rows-1',
        count >= 3 &&
          'auto-rows-[minmax(12rem,1fr)] grid-cols-1 overflow-y-auto sm:grid-cols-2 sm:grid-rows-2 sm:overflow-hidden',
        className,
      )}
      {...props}
    />
  );
}
