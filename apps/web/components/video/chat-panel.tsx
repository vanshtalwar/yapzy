'use client';

import { MAX_MESSAGE_LENGTH } from '@app/shared';
import { ChatComposer, cn } from '@app/ui';
import { useState } from 'react';

import { getChatController, useChat } from '../../lib/chat.ts';
import { ChatEntries } from '../chat/chat-entries.tsx';

/** Text chat next to the video (side panel on desktop, drawer on phones). */
export function ChatPanel({ className }: { className?: string }) {
  const entries = useChat((s) => s.entries);
  const matched = useChat((s) => s.status === 'matched');
  const peerTyping = useChat((s) => s.peerTyping);
  const [draft, setDraft] = useState('');

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <ChatEntries entries={entries} peerTyping={matched && peerTyping} />
      <div className="border-t p-3">
        {matched ? (
          <ChatComposer
            value={draft}
            onChange={setDraft}
            maxLength={MAX_MESSAGE_LENGTH}
            onTyping={() => {
              getChatController().typing();
            }}
            onSend={() => {
              if (getChatController().send(draft)) setDraft('');
            }}
          />
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            You can text here once you’re connected.
          </p>
        )}
      </div>
    </div>
  );
}
