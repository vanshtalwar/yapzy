'use client';

import { Toaster as Sonner, type ToasterProps } from 'sonner';

/** App-wide toasts; colors come from the theme tokens. */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="system"
      position="top-center"
      toastOptions={{
        classNames: {
          toast: 'border bg-popover text-popover-foreground shadow-lg',
          description: 'text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}

export { toast } from 'sonner';
