'use client';

import { XIcon } from 'lucide-react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { type ComponentProps } from 'react';

import { cn } from '../lib/cn.ts';

/** A dialog that slides in from an edge — e.g. the chat drawer on phones. */
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const sides = {
  bottom: 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl border-t',
  right: 'inset-y-0 right-0 h-full w-full max-w-sm border-l',
} as const;

export function SheetContent({
  side = 'bottom',
  className,
  children,
  ...props
}: ComponentProps<typeof SheetPrimitive.Content> & { side?: keyof typeof sides }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <SheetPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-lg outline-none',
          sides[side],
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-3 right-3 rounded-sm p-1 opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
          <XIcon className="size-4" aria-hidden />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetTitle({ className, ...props }: ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      className={cn('text-base leading-none font-semibold', className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
