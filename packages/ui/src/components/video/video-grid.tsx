import { type ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Lays out 1–4 tiles: one fills the stage, two sit side by side (stacked on phones), three
 * or four form a 2×2 grid — ready for group calls (Part 12).
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
        count >= 3 && 'grid-cols-2 grid-rows-2',
        className,
      )}
      {...props}
    />
  );
}
