'use client';

import { MessageBubble, MessageList, SystemMessage, TypingIndicator } from '@app/ui';

import { getChatController } from '../../lib/chat.ts';
import { type ChatEntry } from '../../lib/chat-store.ts';

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
          <MessageBubble key={entry.id} from="stranger" text={entry.text} />
        ),
      )}
      {peerTyping && <TypingIndicator />}
    </MessageList>
  );
}
