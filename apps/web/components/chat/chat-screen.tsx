'use client';

import { MAX_MESSAGE_LENGTH } from '@app/shared';
import { Button, ChatComposer, ChatShell, Label, Spinner, Switch } from '@app/ui';
import { FlagIcon, HomeIcon, PlayIcon, SquareIcon, WifiOffIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useState } from 'react';

import { getChatController, getChatStore, releaseChatController, useChat } from '../../lib/chat.ts';
import { type ChatState } from '../../lib/chat-store.ts';
import { LANGUAGE_NAMES } from '../../lib/languages.ts';
import { getSession } from '../../lib/session-token.ts';
import { AgeGate } from '../age-gate.tsx';
import { BlockedScreen } from '../blocked-screen.tsx';
import { ReportDialog } from '../report/report-dialog.tsx';
import { ChatEntries } from './chat-entries.tsx';
import { NextButton } from './next-button.tsx';

function headerFor(state: ChatState): { title: string; status: string } {
  switch (state.status) {
    case 'matched':
      return {
        title: 'Stranger',
        status: state.peerTyping
          ? 'typing…'
          : state.peerUnstable
            ? 'connection unstable…'
            : state.commonInterests.length > 0
              ? `You both like ${state.commonInterests.join(', ')}`
              : 'Connected',
      };
    case 'connecting':
    case 'waiting': {
      const { lang, interests } = state.preferences;
      const filters = [LANGUAGE_NAMES[lang], ...interests].join(' · ');
      return { title: 'Looking for someone…', status: filters };
    }
    case 'ended':
      return { title: 'Chat ended', status: 'Start a new chat whenever you like' };
    case 'idle':
      return { title: state.paused ? 'Paused' : 'Not searching', status: 'RandomChat' };
    default:
      return { title: 'RandomChat', status: '' };
  }
}

export function ChatScreen() {
  const state = useChat((s) => s);
  const [draft, setDraft] = useState('');
  const [gateDismissed, setGateDismissed] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const autoRequeueId = useId();

  // Start (or re-attach to) the chat on mount; leave it on unmount. Without a session token
  // the store says so, which opens the age gate below.
  useEffect(() => {
    const controller = getChatController();
    const store = getChatStore().getState();
    // Coming from a video chat in this tab: leave it, this screen has no camera.
    if (store.preferences.mode !== 'text' && store.status !== 'idle') void controller.stop();
    store.setPreferences({ mode: 'text' });
    if (getSession() === null) {
      store.setError('auth', 'Please confirm you are 18+ to start chatting.');
    } else if (store.status === 'idle') {
      controller.start();
    }
    return releaseChatController;
  }, []);

  // A missing, expired or rejected session token sends the visitor through the gate.
  const needsVerification = state.status === 'error' && state.errorKind === 'auth';
  const gateOpen = needsVerification && !gateDismissed;
  const controller = () => getChatController();
  const header = headerFor(state);
  const matched = state.status === 'matched';
  const searching = state.status === 'connecting' || state.status === 'waiting';

  if (state.status === 'blocked') {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <BlockedScreen expiresAt={state.blockedUntil} />
      </div>
    );
  }

  const gate = (
    <AgeGate
      open={gateOpen}
      onOpenChange={(open) => {
        setGateDismissed(!open);
      }}
      onVerified={() => {
        setGateDismissed(false);
        controller().reconnect();
      }}
      onBlocked={(expiresAt) => {
        getChatStore().getState().setBlocked(expiresAt);
      }}
    />
  );

  if (needsVerification) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-sm text-sm">{state.errorMessage}</p>
        <Button
          onClick={() => {
            setGateDismissed(false);
          }}
        >
          Continue
        </Button>
        {gate}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-sm text-sm">{state.errorMessage}</p>
        <Button
          onClick={() => {
            controller().reconnect();
          }}
        >
          {state.errorKind === 'replaced' ? 'Use RandomChat here' : 'Try again'}
        </Button>
        {gate}
      </div>
    );
  }

  const footer = matched ? (
    <ChatComposer
      value={draft}
      onChange={setDraft}
      maxLength={MAX_MESSAGE_LENGTH}
      onTyping={() => {
        controller().typing();
      }}
      onSend={() => {
        if (controller().send(draft)) setDraft('');
      }}
    />
  ) : state.status === 'ended' || state.status === 'idle' ? (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-2">
        <Switch
          id={autoRequeueId}
          checked={state.preferences.autoRequeue}
          onCheckedChange={(value) => {
            controller().setAutoRequeue(value);
          }}
        />
        <Label htmlFor={autoRequeueId} className="font-normal text-muted-foreground">
          Auto-find next stranger
        </Label>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="ghost">
          <Link href="/">
            <HomeIcon aria-hidden /> Home
          </Link>
        </Button>
        <Button
          onClick={() => {
            controller().start();
          }}
        >
          <PlayIcon aria-hidden />
          {state.paused ? 'Keep searching' : 'New chat'}
        </Button>
      </div>
    </div>
  ) : (
    <p className="text-center text-xs text-muted-foreground">
      Tip: press <kbd className="rounded border px-1">Esc</kbd> twice to skip to the next stranger.
    </p>
  );

  return (
    <>
      <ChatShell
        title={header.title}
        status={header.status}
        aria-busy={searching}
        actions={
          matched ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Report"
                onClick={() => {
                  setReportOpen(true);
                }}
              >
                <FlagIcon aria-hidden />
                <span className="hidden sm:inline">Report</span>
              </Button>
              <NextButton
                onNext={() => {
                  void controller().next();
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void controller().stop();
                }}
              >
                <SquareIcon aria-hidden /> Stop
              </Button>
            </>
          ) : searching ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void controller().stop();
              }}
            >
              <SquareIcon aria-hidden /> Stop
            </Button>
          ) : undefined
        }
        banner={
          state.connectionLost ? (
            <p
              role="status"
              className="flex items-center gap-2 border-b bg-warning/10 px-4 py-2 text-xs text-warning"
            >
              <WifiOffIcon className="size-3.5" aria-hidden /> Connection lost — reconnecting…
            </p>
          ) : matched && state.peerUnstable ? (
            <p role="status" className="border-b bg-muted px-4 py-2 text-xs text-muted-foreground">
              Stranger’s connection is unstable… they may be back in a moment.
            </p>
          ) : undefined
        }
        footer={footer}
      >
        {searching && state.entries.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <Spinner label="Searching" className="text-primary" />
            <p className="text-sm text-muted-foreground">Looking for someone to chat with…</p>
          </div>
        ) : state.status === 'idle' && state.entries.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="text-sm font-medium">
              {state.paused
                ? 'Paused — click “Keep searching” to continue'
                : 'You’re not in a chat'}
            </p>
            {state.paused && (
              <p className="text-xs text-muted-foreground">
                We pause searching when this tab stays in the background, so nobody gets matched
                with an empty tab.
              </p>
            )}
          </div>
        ) : (
          <ChatEntries entries={state.entries} peerTyping={matched && state.peerTyping} />
        )}
      </ChatShell>
      <ReportDialog open={reportOpen} onOpenChange={setReportOpen} video={false} />
      {gate}
    </>
  );
}
