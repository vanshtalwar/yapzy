import Link from 'next/link';

import { OnlineCount } from './landing/online-count.tsx';

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3">
      <Link
        href="/"
        className="rounded text-lg font-bold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        RandomChat
      </Link>
      <OnlineCount />
    </header>
  );
}
