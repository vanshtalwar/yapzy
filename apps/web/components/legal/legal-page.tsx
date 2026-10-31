import { type ReactNode } from 'react';

import { SiteFooter } from '../site-footer.tsx';
import { SiteHeader } from '../site-header.tsx';

/** Placeholder legal page: clearly marked as not reviewed. */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        <p
          role="note"
          className="mb-6 rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm font-semibold text-warning"
        >
          Placeholder — requires legal review
        </p>
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Last updated {updated}</p>
        <div className="mt-6 space-y-4 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">
          {children}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
