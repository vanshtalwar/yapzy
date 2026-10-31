import { LoaderCircleIcon } from 'lucide-react';
import { type ComponentProps } from 'react';

import { cn } from '../lib/cn.ts';

export function Spinner({
  className,
  label = 'Loading',
  ...props
}: ComponentProps<'span'> & { label?: string }) {
  return (
    <span role="status" className={cn('inline-flex items-center', className)} {...props}>
      <LoaderCircleIcon className="size-4 motion-safe:animate-spin" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
