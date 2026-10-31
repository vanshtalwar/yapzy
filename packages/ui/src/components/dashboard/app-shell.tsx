'use client';

import { MenuIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { cn } from '../../lib/cn.ts';
import { Sheet, SheetContent, SheetTitle } from '../sheet.tsx';

/** Sidebar + main area; the sidebar becomes a drawer below md. */
export function AppShell({
  brand,
  nav,
  footer,
  children,
}: {
  brand: ReactNode;
  /** Nav content (links); receives a callback to close the mobile drawer. */
  nav: (close: () => void) => ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
  };
  const sidebar = (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="text-base font-semibold">{brand}</div>
      <nav aria-label="Main" className="flex flex-1 flex-col gap-1">
        {nav(close)}
      </nav>
      {footer}
    </div>
  );
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r bg-card md:block">
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b px-4 py-2 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            className="rounded-md p-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setOpen(true);
            }}
          >
            <MenuIcon className="size-5" aria-hidden />
          </button>
          <span className="font-semibold">{brand}</span>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="md:hidden">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Sidebar link styling (use with the app's router Link via `asChild`-like className). */
export function navItemClass(active: boolean): string {
  return cn(
    'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [&_svg]:size-4',
    active
      ? 'bg-accent text-accent-foreground'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
  );
}
