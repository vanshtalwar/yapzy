import { ChevronDownIcon } from 'lucide-react';
import { type ComponentProps } from 'react';

import { cn } from '../lib/cn.ts';
import { fieldClasses } from './input.tsx';

/**
 * Styled native <select>: fully accessible and uses the platform picker on phones, which
 * matters more for a mobile-first chat app than a custom popover.
 */
export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select className={cn(fieldClasses, 'h-10 appearance-none pr-9', className)} {...props}>
        {children}
      </select>
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}
