import './globals.css';

import { Toaster } from '@app/ui';
import { type Metadata, type Viewport } from 'next';
import { headers } from 'next/headers';
import { type ReactNode } from 'react';

export const metadata: Metadata = {
  title: { default: 'RandomChat — talk to someone new', template: '%s · RandomChat' },
  description: 'Anonymous one-to-one chat with a random stranger. Free, no account, 18+.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#171717' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Dynamic rendering: every response gets its own CSP nonce (proxy.ts).
  await headers();
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
