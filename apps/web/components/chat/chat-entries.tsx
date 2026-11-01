'use client';

import { MessageBubble, MessageList, SystemMessage, TypingIndicator } from '@app/ui';

import { getChatController, useChat } from '../../lib/chat.ts';
import { type ChatEntry, strangerName } from '../../lib/chat-store.ts';

/** The conversation: system notes, the stranger's messages and ours (with send status). */
export function ChatEntries({
  entries,
  peerTyping,
  className,
}: {
  entries: ChatEntry[];
  peerTyping: boolean;
  className?: string;
}) {
  // Group calls (Part 12): name the author of each stranger message.
  const names = useChat((state) => (state.groupCall ? state : null));
  return (
    <MessageList
      revision={`${String(entries.length)}-${String(peerTyping)}`}
      {...(className === undefined ? {} : { className })}
    >
      {entries.map((entry) =>
        entry.kind === 'system' ? (
          <SystemMessage key={entry.id}>{entry.text}</SystemMessage>
        ) : entry.kind === 'self' ? (
          <MessageBubble
            key={entry.clientMsgId}
            from="self"
            text={entry.text}
            status={entry.status}
            onRetry={() => {
              getChatController().retry(entry.clientMsgId);
            }}
          />
        ) : (
          <MessageBubble
            key={entry.id}
            from="stranger"
            text={entry.text}
            {...(names === null || entry.from === undefined
              ? {}
              : { author: strangerName(names, entry.from) })}
          />
        ),
      )}
      {peerTyping && <TypingIndicator />}
    </MessageList>
  );
}
