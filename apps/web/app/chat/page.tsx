import { Button, Spinner } from '@app/ui';
import { type Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';

import { ChatScreen } from '../../components/chat/chat-screen.tsx';
import { SiteHeader } from '../../components/site-header.tsx';

export const metadata: Metadata = { title: 'Chat' };

function VideoComingSoon() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-xl font-semibold">Video chat is coming soon</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        For now you can talk with strangers by text.
      </p>
      <Button asChild>
        <Link href="/chat?mode=text">Start a text chat</Link>
      </Button>
    </div>
  );
}

export default async function ChatPage({ searchParams }: PageProps<'/chat'>) {
  const { mode } = await searchParams;
  return (
    <div className="flex h-dvh flex-col">
      <SiteHeader />
      <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col sm:px-4 sm:pb-4">
        {mode === 'video' ? (
          <VideoComingSoon />
        ) : (
          <Suspense fallback={<Spinner className="m-auto" />}>
            <ChatScreen />
          </Suspense>
        )}
      </main>
    </div>
  );
}
