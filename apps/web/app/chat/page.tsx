import { cn, Spinner } from '@app/ui';
import { type Metadata } from 'next';
import { Suspense } from 'react';

import { ChatScreen } from '../../components/chat/chat-screen.tsx';
import { SiteHeader } from '../../components/site-header.tsx';
import { VideoChatScreen } from '../../components/video/video-chat-screen.tsx';

export const metadata: Metadata = { title: 'Chat' };

export default async function ChatPage({ searchParams }: PageProps<'/chat'>) {
  const { mode } = await searchParams;
  const video = mode === 'video';
  return (
    <div className="flex h-dvh flex-col">
      <SiteHeader />
      <main
        className={cn(
          'mx-auto flex min-h-0 w-full flex-1 flex-col',
          video ? 'max-w-7xl' : 'max-w-3xl sm:px-4 sm:pb-4',
        )}
      >
        <Suspense fallback={<Spinner className="m-auto" />}>
          {video ? <VideoChatScreen /> : <ChatScreen />}
        </Suspense>
      </main>
    </div>
  );
}
