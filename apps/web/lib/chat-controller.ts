import {
  type AckResponse,
  type ClientToServerEvents,
  ErrorCode,
  NOTICE_CODES,
  type SessionResumed,
} from '@app/shared';

import { type ChatStore } from './chat-store.ts';
import { clearSession } from './session-token.ts';
import { type ChatSocket } from './socket.ts';

export interface ChatControllerDeps {
  store: ChatStore;
  socket: ChatSocket;
  /** Toast / non-blocking notice for the user. */
  notify?: (message: string) => void;
  ackTimeoutMs?: number;
  /** Hidden-tab time after which a search is paused (ghost-tab protection). */
  ghostTabMs?: number;
  /** Pause before auto-requeueing after the stranger left. */
  requeueDelayMs?: number;
  /** Stop sending "typing" after this much inactivity. */
  typingIdleMs?: number;
  document?: Document;
}

type Payload<E extends keyof ClientToServerEvents> = Parameters<ClientToServerEvents[E]>[0];
type Ack = AckResponse<unknown>;

interface AckEmitter {
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
}

const TIMEOUT: Ack = {
  ok: false,
  error: { code: ErrorCode.SERVICE_UNAVAILABLE, message: 'timeout' },
};

/**
 * Wires the socket to the chat store: one place for all protocol rules (acks, resume, stale
 * sessions, ghost-tab pause, typing throttle). UI components only call these methods.
 */
export function createChatController(deps: ChatControllerDeps) {
  const { store, socket } = deps;
  const notify = deps.notify ?? (() => undefined);
  const ackTimeoutMs = deps.ackTimeoutMs ?? 8_000;
  const ghostTabMs = deps.ghostTabMs ?? 60_000;
  const requeueDelayMs = deps.requeueDelayMs ?? 400;
  const typingIdleMs = deps.typingIdleMs ?? 3_000;
  const doc = deps.document ?? (typeof document === 'undefined' ? undefined : document);

  /** Set when the server deliberately cut us off (replaced, banned, auth): no auto-reconnect. */
  let kicked = false;
  let attached = false;
  let typing = false;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let ghostTimer: ReturnType<typeof setTimeout> | undefined;
  let requeueTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const state = () => store.getState();

  async function emit<E extends keyof ClientToServerEvents>(
    event: E,
    payload: Payload<E>,
  ): Promise<Ack> {
    try {
      // Socket.io's typed overloads cannot express "event E with its own payload" for a
      // generic E; the payload is already typed by `Payload<E>` in this function's signature.
      const timed = socket.timeout(ackTimeoutMs) as unknown as AckEmitter;
      return (await timed.emitWithAck(event, payload)) as Ack;
    } catch {
      return TIMEOUT;
    }
  }

  function scheduleReconnect(delayMs: number) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(
      () => {
        if (!kicked && !socket.connected) socket.connect();
      },
      delayMs + Math.random() * delayMs,
    );
  }

  async function join(): Promise<void> {
    const response = await emit('queue:join', state().preferences);
    if (response.ok) {
      store.getState().waiting();
      return;
    }
    switch (response.error.code) {
      case ErrorCode.INVALID_STATE:
        // The server already has us waiting (e.g. it requeued us after an early failure).
        store.getState().waiting();
        return;
      case ErrorCode.RATE_LIMITED:
        notify('Slow down a little — searching again in a moment.');
        requeueTimer = setTimeout(() => void join(), 2_000);
        return;
      case ErrorCode.SERVICE_UNAVAILABLE:
        // Timed out: the reconnect handler will requeue once the socket is back.
        return;
      default:
        store.getState().setError('unknown', response.error.message);
    }
  }

  async function resume(sessionId: string, cursor: string | null): Promise<void> {
    const response = await emit('session:resume', {
      sessionId,
      ...(cursor === null ? {} : { lastMessageId: cursor }),
    });
    if (response.ok) {
      store.getState().resumed(response.data as SessionResumed);
      return;
    }
    if (response.error.code === ErrorCode.SESSION_NOT_RESUMABLE) {
      store.getState().sessionExpired();
      maybeRequeue();
    }
  }

  function maybeRequeue() {
    if (!state().preferences.autoRequeue || state().status !== 'ended') return;
    clearTimeout(requeueTimer);
    requeueTimer = setTimeout(() => {
      if (state().status === 'ended') start();
    }, requeueDelayMs);
  }

  function stopTyping() {
    clearTimeout(typingTimer);
    if (!typing) return;
    typing = false;
    const { sessionId, status } = state();
    if (status === 'matched' && sessionId !== null) {
      socket.emit('chat:typing', { sessionId, isTyping: false }, () => undefined);
    }
  }

  async function deliver(clientMsgId: string, sessionId: string, text: string) {
    const response = await emit('chat:message', { sessionId, text, clientMsgId });
    if (response.ok) {
      store.getState().ackMessage(clientMsgId, response.data as { id: string; at: string });
    } else {
      store.getState().failMessage(clientMsgId, response.error.code);
    }
  }

  function onVisibilityChange() {
    if (doc === undefined) return;
    clearTimeout(ghostTimer);
    if (!doc.hidden || state().status !== 'waiting') return;
    ghostTimer = setTimeout(() => {
      if (doc.hidden && state().status === 'waiting') {
        void emit('queue:leave', {});
        store.getState().pause();
      }
    }, ghostTabMs);
  }

  function attach() {
    if (attached) return;
    attached = true;

    socket.on('connect', () => {
      store.getState().setConnectionLost(false);
      const { status, sessionId, resumeCursor } = state();
      if (status === 'matched' && sessionId !== null) void resume(sessionId, resumeCursor);
      else if (status === 'connecting' || status === 'waiting') void join();
    });

    socket.on('disconnect', (reason) => {
      store.getState().setConnectionLost(true);
      stopTyping();
      // socket.io only auto-reconnects after transport failures, not when the server closed
      // the connection (e.g. a gateway draining for a restart).
      if (!kicked && reason === 'io server disconnect') scheduleReconnect(500);
    });

    socket.on(
      'connect_error',
      (error: Error & { data?: { code?: string; expiresAt?: string | null } }) => {
        const code = error.data?.code;
        if (code === ErrorCode.BANNED) {
          kicked = true;
          store.getState().setBlocked(error.data?.expiresAt ?? null);
        } else if (
          code === ErrorCode.TOKEN_EXPIRED ||
          code === ErrorCode.TOKEN_INVALID ||
          code === ErrorCode.UNAUTHORIZED
        ) {
          kicked = true;
          clearSession();
          store
            .getState()
            .setError('auth', 'Your session expired. Please confirm again to keep chatting.');
        } else if (!socket.active) {
          // Rejected by the server's middleware (e.g. draining): socket.io will not retry itself.
          scheduleReconnect(1_000);
        }
      },
    );

    socket.on('system:notice', (notice) => {
      switch (notice.code) {
        case NOTICE_CODES.SESSION_REPLACED:
          kicked = true;
          store.getState().setError('replaced', 'RandomChat is open in another tab or window.');
          break;
        case NOTICE_CODES.BANNED:
          kicked = true;
          store.getState().setBlocked(null);
          break;
        case NOTICE_CODES.RATE_LIMITED:
          notify("You're going too fast — slow down a little.");
          break;
        default:
          break; // SERVER_RESTARTING: the disconnect handler reconnects us elsewhere
      }
    });

    socket.on('queue:waiting', () => {
      store.getState().waiting();
    });

    socket.on('match:found', (match) => {
      if (store.getState().matchFound(match)) {
        void emit('match:ack', { sessionId: match.sessionId });
      } else {
        void emit('chat:end', { sessionId: match.sessionId }); // stopped searching meanwhile
      }
    });

    socket.on('chat:message', (message) => {
      store.getState().receiveMessage(message);
    });
    socket.on('chat:typing', (event) => {
      store.getState().setPeerTyping(event);
    });
    socket.on('peer:reconnecting', (event) => {
      store.getState().peerReconnecting(event);
    });
    socket.on('peer:resumed', (event) => {
      store.getState().peerResumed(event);
    });
    socket.on('peer:left', (event) => {
      store.getState().peerLeft(event);
      if (event.sessionEnded) maybeRequeue();
    });

    doc?.addEventListener('visibilitychange', onVisibilityChange);
  }

  function start() {
    kicked = false;
    clearTimeout(requeueTimer);
    attach();
    store.getState().startSearch();
    if (socket.connected) void join();
    else socket.connect(); // `connect` handler joins
  }

  return {
    start,

    /** Skip to the next stranger. */
    async next(): Promise<void> {
      const { status, sessionId } = state();
      if (status !== 'matched' || sessionId === null) return;
      stopTyping();
      store.getState().startSearch();
      const response = await emit('chat:next', { sessionId });
      if (!response.ok && response.error.code === ErrorCode.NOT_IN_SESSION) await join();
      else if (response.ok) store.getState().waiting();
    },

    /** Leave the chat (or stop searching). */
    async stop(): Promise<void> {
      clearTimeout(requeueTimer);
      const { status, sessionId } = state();
      if (status === 'matched' && sessionId !== null) {
        stopTyping();
        store.getState().selfLeft();
        await emit('chat:end', { sessionId });
      } else if (status === 'waiting' || status === 'connecting') {
        store.getState().stopSearching();
        await emit('queue:leave', {});
      }
    },

    send(text: string): boolean {
      const trimmed = text.trim();
      if (trimmed === '') return false;
      const clientMsgId = crypto.randomUUID();
      const target = store.getState().addOutgoing(trimmed, clientMsgId);
      if (target === null) return false;
      stopTyping();
      void deliver(clientMsgId, target.sessionId, trimmed);
      return true;
    },

    retry(clientMsgId: string): void {
      const target = store.getState().retryMessage(clientMsgId);
      if (target !== null) void deliver(clientMsgId, target.sessionId, target.text);
    },

    /** Call on every keystroke; sends typing=true once and typing=false after inactivity. */
    typing(): void {
      const { status, sessionId } = state();
      if (status !== 'matched' || sessionId === null) return;
      if (!typing) {
        typing = true;
        socket.emit('chat:typing', { sessionId, isTyping: true }, () => undefined);
      }
      clearTimeout(typingTimer);
      typingTimer = setTimeout(stopTyping, typingIdleMs);
    },

    setAutoRequeue(autoRequeue: boolean): void {
      store.getState().setPreferences({ autoRequeue });
    },

    /** Reconnect after the user confirmed "use RandomChat in this tab" or re-verified. */
    reconnect(): void {
      kicked = false;
      store.getState().reset();
      if (socket.connected) socket.disconnect();
      start();
    },

    dispose(): void {
      clearTimeout(typingTimer);
      clearTimeout(ghostTimer);
      clearTimeout(requeueTimer);
      clearTimeout(reconnectTimer);
      const { status, sessionId } = state();
      if (socket.connected) {
        if (status === 'matched' && sessionId !== null) {
          socket.emit('chat:end', { sessionId }, () => undefined);
        } else if (status === 'waiting' || status === 'connecting') {
          socket.emit('queue:leave', {}, () => undefined);
        }
      }
      kicked = true;
      socket.disconnect();
      if (attached) {
        socket.off();
        doc?.removeEventListener('visibilitychange', onVisibilityChange);
        attached = false;
      }
      store.getState().reset();
    },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
