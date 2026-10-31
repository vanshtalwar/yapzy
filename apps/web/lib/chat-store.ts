import {
  type ChatMessageAck,
  type ChatMessageOut,
  type ChatTypingOut,
  ErrorCode,
  type MatchFound,
  type PeerLeft,
  type PeerPresence,
  type QueuePreferences,
  type SessionResumed,
} from '@app/shared';
import { createStore } from 'zustand/vanilla';

import { DEFAULT_PREFERENCES } from './preferences.ts';
import { type CallView } from './rtc/types.ts';

/**
 * Chat state machine (Part 6):
 *
 *   idle ──start──▶ connecting ──queue:waiting──▶ waiting ──match:found──▶ matched
 *    ▲                 │  ▲                          │ (hidden 60 s → idle, paused)   │
 *    │ stop            │  └──────── next ─────────────┼────────────────────────────────┤
 *    └─────────────────┴──────────────────────────────┘          peer:left / stop     ▼
 *                                                                               ended ──new chat──▶ connecting
 *   blocked (banned) and error (auth / replaced / network) are terminal until the user acts.
 *   Video (Part 7): `call` mirrors the CallManager of the matched session; leaving `matched`
 *   or switching sessions clears it (the controller closes the CallManager on the same change).
 *
 * Every session-scoped server event is ignored unless its sessionId is the current one, so
 * stale signals from a chat the user already skipped can never leak into the new one.
 */
export type ChatStatus =
  'idle' | 'connecting' | 'waiting' | 'matched' | 'ended' | 'blocked' | 'error';
export type EndReason = 'peer_left' | 'peer_disconnected' | 'self_left' | 'expired';
export type ErrorKind = 'auth' | 'replaced' | 'network' | 'unknown';
export type OutgoingStatus = 'sending' | 'sent' | 'failed' | 'blocked';

export type ChatEntry =
  | { kind: 'system'; id: string; text: string }
  | { kind: 'stranger'; id: string; text: string; at: string }
  | {
      kind: 'self';
      /** Server id once acknowledged, the client id until then. */
      id: string;
      clientMsgId: string;
      text: string;
      at: string | null;
      status: OutgoingStatus;
    };

export interface ChatData {
  status: ChatStatus;
  preferences: QueuePreferences;
  sessionId: string | null;
  selfParticipantId: string | null;
  peerIds: string[];
  commonInterests: string[];
  entries: ChatEntry[];
  peerTyping: boolean;
  /** The stranger's signaling connection dropped (they may come back). */
  peerUnstable: boolean;
  /** Our own socket is disconnected (socket.io is reconnecting). */
  connectionLost: boolean;
  endReason: EndReason | null;
  /** Waiting was paused because the tab stayed hidden (ghost-tab protection). */
  paused: boolean;
  /** The user pressed Stop while searching. */
  stopped: boolean;
  /** Id of the last stranger message received (resume cursor). */
  lastReceivedId: string | null;
  /** lastReceivedId snapshot taken when the connection dropped (D-057). */
  resumeCursor: string | null;
  blockedUntil: string | null;
  errorKind: ErrorKind | null;
  errorMessage: string | null;
  /** Video call of the current session: plain values only, media stays in the CallManager. */
  call: CallView | null;
}

export interface ChatActions {
  setPreferences(preferences: Partial<QueuePreferences>): void;
  startSearch(): void;
  waiting(): void;
  /** Returns false if the match must be declined (user stopped searching meanwhile). */
  matchFound(match: MatchFound): boolean;
  receiveMessage(message: ChatMessageOut): void;
  setPeerTyping(event: ChatTypingOut): void;
  peerReconnecting(event: PeerPresence): void;
  peerResumed(event: PeerPresence): void;
  peerLeft(event: PeerLeft): void;
  /** Optimistically adds an outgoing message; returns its session or null if not in a chat. */
  addOutgoing(text: string, clientMsgId: string): { sessionId: string } | null;
  ackMessage(clientMsgId: string, ack: ChatMessageAck): void;
  failMessage(clientMsgId: string, code: string): void;
  /** Marks a failed message as sending again and returns it, or null if not retryable. */
  retryMessage(clientMsgId: string): { sessionId: string; text: string } | null;
  selfLeft(): void;
  sessionExpired(): void;
  resumed(result: SessionResumed): void;
  setConnectionLost(lost: boolean): void;
  pause(): void;
  stopSearching(): void;
  setBlocked(expiresAt: string | null): void;
  setError(kind: ErrorKind, message: string): void;
  /** Ignored unless it belongs to the current matched session (or clears the call). */
  setCall(view: CallView | null): void;
  reset(): void;
}

export type ChatState = ChatData & ChatActions;

const freshSession = {
  sessionId: null,
  selfParticipantId: null,
  peerIds: [],
  commonInterests: [],
  entries: [],
  peerTyping: false,
  peerUnstable: false,
  endReason: null,
  lastReceivedId: null,
  resumeCursor: null,
  call: null,
} satisfies Partial<ChatData>;

let systemCounter = 0;
function system(text: string): ChatEntry {
  systemCounter += 1;
  return { kind: 'system', id: `system-${String(systemCounter)}`, text };
}

export function createChatStore(preferences: QueuePreferences = DEFAULT_PREFERENCES) {
  return createStore<ChatState>()((set, get) => {
    /** True if the event belongs to the chat we are in right now. */
    const current = (sessionId: string) =>
      get().status === 'matched' && get().sessionId === sessionId;

    const updateSelf = (
      clientMsgId: string,
      change: (entry: Extract<ChatEntry, { kind: 'self' }>) => Extract<ChatEntry, { kind: 'self' }>,
    ) => {
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.kind === 'self' && entry.clientMsgId === clientMsgId ? change(entry) : entry,
        ),
      }));
    };

    return {
      status: 'idle',
      preferences,
      ...freshSession,
      connectionLost: false,
      paused: false,
      stopped: false,
      blockedUntil: null,
      errorKind: null,
      errorMessage: null,

      setPreferences: (change) => {
        set((state) => ({ preferences: { ...state.preferences, ...change } }));
      },

      startSearch: () => {
        set({
          ...freshSession,
          status: 'connecting',
          paused: false,
          stopped: false,
          errorKind: null,
          errorMessage: null,
        });
      },

      waiting: () => {
        const { status } = get();
        if (status === 'connecting' || status === 'waiting') set({ status: 'waiting' });
        // The server requeued us after an early failure (fair requeue): start a fresh search.
        else if (status === 'ended') set({ ...freshSession, status: 'waiting' });
      },

      matchFound: (match) => {
        const state = get();
        if (state.sessionId === match.sessionId) return true; // duplicate delivery
        if (state.status === 'idle' || state.status === 'blocked' || state.status === 'error') {
          return false;
        }
        const entries: ChatEntry[] = [
          system("You're now chatting with a random stranger. Say hi!"),
        ];
        if (match.commonInterests.length > 0) {
          entries.push(system(`You both like: ${match.commonInterests.join(', ')}.`));
        }
        set({
          ...freshSession,
          status: 'matched',
          sessionId: match.sessionId,
          selfParticipantId: match.selfParticipantId,
          peerIds: match.peers.map((peer) => peer.participantId),
          commonInterests: match.commonInterests,
          entries,
        });
        return true;
      },

      receiveMessage: (message) => {
        if (!current(message.sessionId)) return;
        if (get().entries.some((entry) => entry.kind === 'stranger' && entry.id === message.id))
          return;
        set((state) => ({
          entries: [
            ...state.entries,
            { kind: 'stranger', id: message.id, text: message.text, at: message.at },
          ],
          peerTyping: false,
          lastReceivedId: message.id,
        }));
      },

      setPeerTyping: (event) => {
        if (current(event.sessionId)) set({ peerTyping: event.isTyping });
      },

      peerReconnecting: (event) => {
        if (current(event.sessionId)) set({ peerUnstable: true, peerTyping: false });
      },

      peerResumed: (event) => {
        if (current(event.sessionId)) set({ peerUnstable: false });
      },

      peerLeft: (event) => {
        if (!current(event.sessionId)) return;
        if (!event.sessionEnded) {
          set((state) => ({ entries: [...state.entries, system('A participant left the chat.')] }));
          return;
        }
        const disconnected = event.reason === 'disconnected';
        set((state) => ({
          status: 'ended',
          endReason: disconnected ? 'peer_disconnected' : 'peer_left',
          peerTyping: false,
          peerUnstable: false,
          call: null,
          entries: [
            ...state.entries,
            system(disconnected ? 'Stranger has disconnected.' : 'Stranger has left the chat.'),
          ],
        }));
      },

      addOutgoing: (text, clientMsgId) => {
        const { status, sessionId } = get();
        if (status !== 'matched' || sessionId === null) return null;
        set((state) => ({
          entries: [
            ...state.entries,
            { kind: 'self', id: clientMsgId, clientMsgId, text, at: null, status: 'sending' },
          ],
        }));
        return { sessionId };
      },

      ackMessage: (clientMsgId, ack) => {
        updateSelf(clientMsgId, (entry) => ({ ...entry, id: ack.id, at: ack.at, status: 'sent' }));
      },

      failMessage: (clientMsgId, code) => {
        updateSelf(clientMsgId, (entry) => ({
          ...entry,
          status: code === ErrorCode.MESSAGE_BLOCKED ? 'blocked' : 'failed',
        }));
      },

      retryMessage: (clientMsgId) => {
        const { status, sessionId, entries } = get();
        const entry = entries.find((e) => e.kind === 'self' && e.clientMsgId === clientMsgId);
        if (
          status !== 'matched' ||
          sessionId === null ||
          entry?.kind !== 'self' ||
          entry.status !== 'failed'
        ) {
          return null;
        }
        updateSelf(clientMsgId, (e) => ({ ...e, status: 'sending' }));
        return { sessionId, text: entry.text };
      },

      selfLeft: () => {
        if (get().status !== 'matched') return;
        set((state) => ({
          status: 'ended',
          endReason: 'self_left',
          peerTyping: false,
          call: null,
          entries: [...state.entries, system('You left the chat.')],
        }));
      },

      sessionExpired: () => {
        if (get().status !== 'matched') return;
        set((state) => ({
          status: 'ended',
          endReason: 'expired',
          peerTyping: false,
          peerUnstable: false,
          call: null,
          entries: [...state.entries, system('This chat has ended.')],
        }));
      },

      resumed: (result) => {
        const { status, sessionId, entries } = get();
        if (status !== 'matched' || sessionId === null) return;
        const known = new Set(entries.map((entry) => entry.id));
        const missed = result.missedMessages.filter(
          (message) => message.sessionId === sessionId && !known.has(message.id),
        );
        const last = missed.at(-1);
        set({
          entries: [
            ...entries,
            ...missed.map((message) => ({
              kind: 'stranger' as const,
              id: message.id,
              text: message.text,
              at: message.at,
            })),
          ],
          peerIds: result.peers.map((peer) => peer.participantId),
          ...(last === undefined ? {} : { lastReceivedId: last.id }),
          connectionLost: false,
        });
      },

      setConnectionLost: (lost) => {
        if (lost) {
          // Snapshot the cursor now: a message arriving live on the new socket must not move
          // it past messages we missed while offline (D-057).
          if (!get().connectionLost)
            set({ connectionLost: true, resumeCursor: get().lastReceivedId });
        } else {
          set({ connectionLost: false });
        }
      },

      pause: () => {
        if (get().status === 'waiting') set({ status: 'idle', paused: true });
      },

      stopSearching: () => {
        const { status } = get();
        if (status === 'waiting' || status === 'connecting') set({ status: 'idle', stopped: true });
      },

      setBlocked: (expiresAt) => {
        set({ ...freshSession, status: 'blocked', blockedUntil: expiresAt });
      },

      setError: (kind, message) => {
        set({
          status: 'error',
          errorKind: kind,
          errorMessage: message,
          peerTyping: false,
          call: null,
        });
      },

      setCall: (view) => {
        if (view === null || current(view.sessionId)) set({ call: view });
      },

      reset: () => {
        set({
          ...freshSession,
          status: 'idle',
          paused: false,
          stopped: false,
          connectionLost: false,
          blockedUntil: null,
          errorKind: null,
          errorMessage: null,
        });
      },
    };
  });
}

export type ChatStore = ReturnType<typeof createChatStore>;
