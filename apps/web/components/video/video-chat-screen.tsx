'use client';

import {
  Button,
  CallControlButton,
  CallControls,
  cn,
  QualityBadge,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Spinner,
  VideoGrid,
  VideoTile,
} from '@app/ui';
import {
  EyeOffIcon,
  FlagIcon,
  MessageSquareIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  PlayIcon,
  SettingsIcon,
  SkipForwardIcon,
  VideoIcon,
  VideoOffIcon,
  WifiOffIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import {
  getChatController,
  getChatStore,
  getLocalMedia,
  releaseChatController,
  releaseLocalMedia,
  useChat,
  useLocalMedia,
} from '../../lib/chat.ts';
import { type ChatState } from '../../lib/chat-store.ts';
import { type RemoteParticipantView } from '../../lib/rtc/types.ts';
import { getSession } from '../../lib/session-token.ts';
import { AgeGate } from '../age-gate.tsx';
import { BlockedScreen } from '../blocked-screen.tsx';
import { useConfirmPress } from '../chat/use-confirm-press.ts';
import { ReportDialog } from '../report/report-dialog.tsx';
import { ChatPanel } from './chat-panel.tsx';
import { DeviceSettingsDialog } from './device-settings-dialog.tsx';
import { LocalVideo, RemoteVideo } from './media-video.tsx';
import { PreJoin } from './pre-join.tsx';

const controller = () => getChatController();

function connectionOf(participant: RemoteParticipantView | undefined) {
  if (participant === undefined || participant.state === 'new') return 'connecting';
  if (participant.state === 'connected') return 'connected';
  return participant.state === 'connecting' ? 'connecting' : 'reconnecting';
}

/** Centered message over the stage (searching, ended, paused, errors). */
function StageOverlay({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-stage/70 p-6 text-center text-stage-foreground">
      {children}
    </div>
  );
}

function stageMessage(state: ChatState, onStart: () => void): ReactNode {
  switch (state.status) {
    case 'connecting':
    case 'waiting':
      return (
        <StageOverlay>
          <Spinner label="Searching" />
          <p className="text-sm font-medium">Looking for someone…</p>
        </StageOverlay>
      );
    case 'ended':
      return (
        <StageOverlay>
          <p className="text-sm font-medium">
            {state.endReason === 'self_left'
              ? 'You left the chat.'
              : state.endReason === 'peer_disconnected'
                ? 'Stranger has disconnected.'
                : state.endReason === 'expired'
                  ? 'This chat has ended.'
                  : 'Stranger has left the chat.'}
          </p>
          {state.preferences.autoRequeue && state.endReason !== 'self_left' ? (
            <p className="text-xs opacity-80">Finding someone new…</p>
          ) : (
            <Button onClick={onStart}>
              <PlayIcon aria-hidden /> New chat
            </Button>
          )}
        </StageOverlay>
      );
    case 'idle':
      return (
        <StageOverlay>
          <p className="text-sm font-medium">
            {state.paused ? 'Paused — this tab was in the background' : 'You’re not in a chat'}
          </p>
          <Button onClick={onStart}>
            <PlayIcon aria-hidden /> {state.paused ? 'Keep searching' : 'New chat'}
          </Button>
        </StageOverlay>
      );
    case 'error':
      return (
        <StageOverlay>
          <p className="max-w-sm text-sm">{state.errorMessage}</p>
          <Button
            onClick={() => {
              controller().reconnect();
            }}
          >
            {state.errorKind === 'replaced' ? 'Use RandomChat here' : 'Try again'}
          </Button>
        </StageOverlay>
      );
    default:
      return null;
  }
}

export function VideoChatScreen() {
  const state = useChat((s) => s);
  const media = useLocalMedia();
  const [joined, setJoined] = useState(false);
  const [gateRequested, setGateRequested] = useState(false);
  const [gateDismissed, setGateDismissed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [seen, setSeen] = useState({ sessionId: null as string | null, count: 0 });

  // The camera starts with the pre-join check and stays on across matches; leaving the page
  // ends the chat and turns it off (both deferred, so StrictMode's remount keeps them).
  useEffect(() => {
    const chat = getChatController();
    const store = getChatStore().getState();
    if (store.preferences.mode !== 'video' && store.status !== 'idle') void chat.stop();
    store.setPreferences({ mode: 'video' });
    void getLocalMedia().acquire();
    return () => {
      releaseChatController();
      releaseLocalMedia();
    };
  }, []);

  const matched = state.status === 'matched';
  const searching = state.status === 'connecting' || state.status === 'waiting';
  const needsVerification = state.status === 'error' && state.errorKind === 'auth';
  const participants = matched ? (state.call?.participants ?? []) : [];
  const strangerMessages = state.entries.filter((entry) => entry.kind === 'stranger').length;
  const unread = chatOpen
    ? 0
    : Math.max(0, strangerMessages - (seen.sessionId === state.sessionId ? seen.count : 0));

  // Without a valid session token the age gate comes first (it opens by itself if the token
  // expires during a chat).
  const start = () => {
    if (getSession() === null || needsVerification) {
      setGateRequested(true);
      setGateDismissed(false);
      return;
    }
    setJoined(true);
    controller().start();
  };
  const next = useConfirmPress(() => {
    void controller().next();
  }, matched);

  if (state.status === 'blocked') {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <BlockedScreen expiresAt={state.blockedUntil} />
      </div>
    );
  }

  const gate = (
    <AgeGate
      open={(gateRequested || needsVerification) && !gateDismissed}
      onOpenChange={(open) => {
        setGateDismissed(!open);
        if (!open) setGateRequested(false);
      }}
      onVerified={() => {
        setGateRequested(false);
        setGateDismissed(false);
        setJoined(true);
        controller().reconnect();
      }}
      onBlocked={(expiresAt) => {
        getChatStore().getState().setBlocked(expiresAt);
      }}
    />
  );

  if (!joined || needsVerification) {
    return (
      <>
        <PreJoin onStart={start} />
        {gate}
      </>
    );
  }

  const peer = participants[0];
  const chat = <ChatPanel className="min-h-0" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-2 sm:p-4 md:flex-row">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div
          className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-stage"
          aria-busy={searching}
        >
          {matched && participants.length > 0 ? (
            <VideoGrid count={participants.length} className="p-0">
              {participants.map((participant) => (
                <VideoTile
                  key={participant.participantId}
                  // WebRTC connection state of this peer, for tests and support tooling.
                  data-rtc-state={participant.state}
                  // Client NSFW check flagged this video: keep it blurred (D-054 / Part 8).
                  className={cn('rounded-none', state.remoteFlagged && '[&_video]:blur-2xl')}
                  placeholder={
                    state.remoteFlagged ? (
                      <>
                        <EyeOffIcon className="size-6" aria-hidden />
                        <p className="max-w-xs font-medium">
                          This video may show explicit content, so we blurred it.
                        </p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={next.press}>
                            <SkipForwardIcon aria-hidden /> {next.armed ? 'Really skip?' : 'Next'}
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              setReportOpen(true);
                            }}
                          >
                            <FlagIcon aria-hidden /> Report
                          </Button>
                        </div>
                      </>
                    ) : participant.trackCount === 0 ? (
                      <>
                        <Spinner label="Connecting" />
                        <span>Connecting video…</span>
                      </>
                    ) : undefined
                  }
                  overlay={
                    <button
                      type="button"
                      aria-label="Report"
                      className="absolute top-3 right-3 rounded-full bg-stage/60 p-2 text-stage-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
                      onClick={() => {
                        setReportOpen(true);
                      }}
                    >
                      <FlagIcon className="size-4" aria-hidden />
                    </button>
                  }
                >
                  <RemoteVideo
                    participantId={participant.participantId}
                    trackCount={participant.trackCount}
                  />
                </VideoTile>
              ))}
            </VideoGrid>
          ) : (
            <div className="size-full opacity-60">
              <LocalVideo />
            </div>
          )}

          {matched && (
            <VideoTile
              label="You"
              className="absolute right-3 bottom-3 aspect-[3/4] w-24 border border-stage-foreground/20 shadow-lg sm:aspect-video sm:w-44"
              placeholder={media.videoEnabled ? undefined : <VideoOffIcon className="size-5" />}
            >
              <LocalVideo />
            </VideoTile>
          )}

          <div className="absolute top-3 left-3 flex flex-col items-start gap-2">
            {matched && (
              <QualityBadge connection={connectionOf(peer)} quality={peer?.quality ?? null} />
            )}
            {state.connectionLost && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 rounded-full bg-warning px-2.5 py-1 text-xs font-medium text-stage"
              >
                <WifiOffIcon className="size-3.5" aria-hidden /> Reconnecting to RandomChat…
              </span>
            )}
            {matched && state.peerUnstable && (
              <span
                role="status"
                className="rounded-full bg-stage/60 px-2.5 py-1 text-xs text-stage-foreground"
              >
                Stranger’s connection is unstable…
              </span>
            )}
          </div>

          {!matched && stageMessage(state, start)}
        </div>

        <CallControls className="mx-auto w-fit">
          <CallControlButton
            icon={media.audioEnabled ? <MicIcon /> : <MicOffIcon />}
            label={media.audioEnabled ? 'Mute' : 'Unmute'}
            tone={media.audioEnabled ? 'default' : 'off'}
            pressed={!media.audioEnabled}
            onClick={() => {
              getLocalMedia().setAudioEnabled(!media.audioEnabled);
            }}
          />
          <CallControlButton
            icon={media.videoEnabled ? <VideoIcon /> : <VideoOffIcon />}
            label={media.videoEnabled ? 'Camera' : 'Camera off'}
            tone={media.videoEnabled ? 'default' : 'off'}
            pressed={!media.videoEnabled}
            onClick={() => {
              getLocalMedia().setVideoEnabled(!media.videoEnabled);
            }}
          />
          <CallControlButton
            icon={<MessageSquareIcon />}
            label="Chat"
            badge={unread}
            className="md:hidden"
            onClick={() => {
              setChatOpen(true);
              setSeen({ sessionId: state.sessionId, count: strangerMessages });
            }}
          />
          <CallControlButton
            icon={<SettingsIcon />}
            label="Settings"
            onClick={() => {
              setSettingsOpen(true);
            }}
          />
          <CallControlButton
            icon={<FlagIcon />}
            label="Report"
            disabled={!matched}
            className="hidden sm:flex"
            onClick={() => {
              setReportOpen(true);
            }}
          />
          {matched ? (
            <>
              <CallControlButton
                icon={<SkipForwardIcon />}
                label={next.armed ? 'Really?' : 'Next'}
                tone="primary"
                aria-keyshortcuts="Escape"
                onClick={next.press}
              />
              <CallControlButton
                icon={<PhoneOffIcon />}
                label="Stop"
                tone="danger"
                onClick={() => {
                  void controller().stop();
                }}
              />
            </>
          ) : searching ? (
            <CallControlButton
              icon={<PhoneOffIcon />}
              label="Stop"
              tone="danger"
              onClick={() => {
                void controller().stop();
              }}
            />
          ) : (
            <CallControlButton
              icon={<PlayIcon />}
              label="New chat"
              tone="primary"
              disabled={state.status === 'error'}
              onClick={start}
            />
          )}
        </CallControls>
      </div>

      <aside
        aria-label="Text chat"
        className="hidden min-h-0 flex-col overflow-hidden rounded-2xl border bg-card md:flex md:w-80 lg:w-96"
      >
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Chat</h2>
        {chat}
      </aside>

      <Sheet
        open={chatOpen}
        onOpenChange={(open) => {
          setChatOpen(open);
          setSeen({ sessionId: state.sessionId, count: strangerMessages });
        }}
      >
        <SheetContent side="bottom" className="h-[70dvh] md:hidden">
          <div className="border-b px-4 py-3">
            <SheetTitle>Chat</SheetTitle>
            <SheetDescription className="sr-only">Text chat with the stranger</SheetDescription>
          </div>
          {chat}
        </SheetContent>
      </Sheet>

      <DeviceSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <ReportDialog open={reportOpen} onOpenChange={setReportOpen} video />
      {gate}
    </div>
  );
}
