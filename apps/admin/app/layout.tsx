import './globals.css';

import { Toaster } from '@app/ui';
import { type Metadata, type Viewport } from 'next';
import { headers } from 'next/headers';
import { type ReactNode } from 'react';

import { SessionProvider } from '../lib/session.tsx';

export const metadata: Metadata = {
  title: { default: 'RandomChat Admin', template: '%s · RandomChat Admin' },
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#171717' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reading the request makes every page dynamic, which the per-request CSP nonce needs.
  await headers();
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <SessionProvider>{children}</SessionProvider>
        <Toaster />
      </body>
    </html>
  );
}
