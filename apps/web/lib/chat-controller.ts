import {
  type AckResponse,
  chatMessageAckSchema,
  chatMessageOutSchema,
  chatTypingOutSchema,
  type ClientToServerEvents,
  ErrorCode,
  type MatchFound,
  matchFoundSchema,
  type NextReason,
  NOTICE_CODES,
  peerLeftSchema,
  peerPresenceSchema,
  type ReportFields,
  rtcDescriptionOutSchema,
  rtcIceOutSchema,
  sessionResumedSchema,
  systemNoticeSchema,
} from '@app/shared';
import { type z } from 'zod';

import { ApiError } from './api.ts';
import { type ChatStore } from './chat-store.ts';
import { type CallModeration, type CallModerationOptions } from './moderation/call-moderation.ts';
import { CallManager, type CallManagerOptions } from './rtc/call-manager.ts';
import { type PeerSummary } from './rtc/types.ts';
import { clearSession } from './session-token.ts';
import { type ChatSocket } from './socket.ts';

/** What video chat needs from the rest of the app (Part 7). */
export interface VideoDeps {
  /** The tab's camera + mic (acquired on the pre-join screen). */
  localMedia: {
    getStream(): MediaStream | null;
    onTrackReplaced(listener: (track: MediaStreamTrack) => void): () => void;
  };
  iceServers: {
    get(): Promise<RTCIceServer[]>;
    peek(): RTCIceServer[] | null;
    refreshInMs(): number;
  };
  forceRelay: boolean;
  createCall?: (options: CallManagerOptions) => CallManager;
  /** Trust & safety during calls (Part 8): frame sampling, report evidence, NSFW check. */
  moderation?: { create(options: CallModerationOptions): CallModeration };
}

export interface ChatControllerDeps {
  store: ChatStore;
  socket: ChatSocket;
  /** Toast / non-blocking notice for the user. */
  notify?: (message: string) => void;
  video?: VideoDeps;
  /** Sends a report (with evidence frames) to the API. */
  reports?: { submit(fields: ReportFields, frames: Blob[]): Promise<void> };
  ackTimeoutMs?: number;
  /** Hidden-tab time after which a search is paused (ghost-tab protection). */
  ghostTabMs?: number;
  /** Pause before auto-requeueing after the stranger left. */
  requeueDelayMs?: number;
  /** Stop sending "typing" after this much inactivity. */
  typingIdleMs?: number;
  document?: Document;
  /** Receives `pagehide`, `online` (defaults to `window`). */
  window?: EventTarget;
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

/** Server payloads are validated like everything else crossing a boundary; bad ones are dropped. */
function valid<T>(schema: z.ZodType<T>, payload: unknown): T | null {
  const parsed = schema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

const AUTH_CODES = new Set<string>([
  ErrorCode.TOKEN_EXPIRED,
  ErrorCode.TOKEN_INVALID,
  ErrorCode.UNAUTHORIZED,
]);

/**
 * Wires the socket to the chat store: one place for all protocol rules (acks, resume, stale
 * sessions, ghost-tab pause, typing throttle, video calls). UI components only call these
 * methods.
 *
 * Video invariant: a CallManager exists exactly while the store is `matched` in a video
 * session with the same id — any transition away (skip, stop, peer left, expiry, ban, error)
 * closes it and reports one `rtc:summary` per peer connection.
 */
export function createChatController(deps: ChatControllerDeps) {
  const { store, socket, video } = deps;
  const notify = deps.notify ?? (() => undefined);
  const ackTimeoutMs = deps.ackTimeoutMs ?? 8_000;
  const ghostTabMs = deps.ghostTabMs ?? 60_000;
  const requeueDelayMs = deps.requeueDelayMs ?? 400;
  const typingIdleMs = deps.typingIdleMs ?? 3_000;
  const doc = deps.document ?? (typeof document === 'undefined' ? undefined : document);
  const win = deps.window ?? (typeof window === 'undefined' ? undefined : window);

  /** Set when the server deliberately cut us off (replaced, banned, auth): no auto-reconnect. */
  let kicked = false;
  let attached = false;
  let typing = false;
  let call: CallManager | null = null;
  let callModeration: CallModeration | null = null;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  let ghostTimer: ReturnType<typeof setTimeout> | undefined;
  let requeueTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let iceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** Session we skipped locally but the server has not let go of yet (chat:next refused). */
  let leaving: string | null = null;
  const detach: (() => void)[] = [];

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

  /** Fire-and-forget (signaling, summaries): the server still acks, nobody waits. */
  function send<
    E extends 'rtc:offer' | 'rtc:answer' | 'rtc:ice' | 'rtc:summary' | 'moderation:signal',
  >(event: E, payload: Payload<E>): void {
    (socket.emit as (event: string, payload: unknown, ack: () => void) => void)(
      event,
      payload,
      () => undefined,
    );
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

  function authFailed(): void {
    kicked = true;
    clearSession();
    store
      .getState()
      .setError('auth', 'Your session expired. Please confirm again to keep chatting.');
  }

  // --- video calls ------------------------------------------------------------------------

  function reportSummaries(sessionId: string, summaries: PeerSummary[]) {
    for (const summary of summaries) send('rtc:summary', { sessionId, ...summary });
  }

  function endCall(): void {
    callModeration?.stop();
    callModeration = null;
    if (call === null) return;
    const ended = call;
    call = null;
    reportSummaries(ended.sessionId, ended.close());
    if (state().call !== null) store.getState().setCall(null);
  }

  function startCall(match: MatchFound): void {
    endCall();
    const localStream = video?.localMedia.getStream() ?? null;
    if (video === undefined || localStream === null) return; // guarded by join()
    const { sessionId } = match;
    const options: CallManagerOptions = {
      sessionId,
      peers: match.peers,
      localStream,
      iceServers: video.iceServers.peek() ?? [],
      forceRelay: video.forceRelay,
      signaling: {
        description: (to, type, sdp) => {
          send(type === 'offer' ? 'rtc:offer' : 'rtc:answer', { sessionId, to, sdp });
        },
        candidate: (to, { candidate = '', sdpMid, sdpMLineIndex, usernameFragment }) => {
          send('rtc:ice', {
            sessionId,
            to,
            candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment },
          });
        },
      },
      onChange: (view) => {
        store.getState().setCall(view);
      },
      onFailed: () => {
        const current = state();
        if (current.status !== 'matched' || current.sessionId !== sessionId) return;
        notify('Couldn’t connect the video. Finding someone new…');
        void skip('rtc_failed');
      },
    };
    call = (video.createCall ?? ((o: CallManagerOptions) => new CallManager(o)))(options);
    store.getState().setCall(call.view());

    const peer = match.peers[0]?.participantId;
    callModeration =
      video.moderation?.create({
        sessionId,
        localStream: () => video.localMedia.getStream(),
        remoteStream: () => (peer === undefined ? null : (call?.remoteStream(peer) ?? null)),
        schedule: match.moderation,
        signal: (verdict) => {
          if (peer === undefined) return;
          send('moderation:signal', {
            sessionId,
            about: peer,
            kind: verdict.kind,
            score: Math.min(1, verdict.score),
          });
        },
        onRemoteFlagged: () => {
          store.getState().setRemoteFlagged(sessionId);
        },
        onSelfFlagged: () => {
          notify('Heads up: your camera may be showing something that isn’t allowed here.');
        },
      }) ?? null;
  }

  /** TURN credentials expire (TTL): refresh before they do, also for a call in progress. */
  function scheduleIceRefresh(): void {
    clearTimeout(iceRefreshTimer);
    if (video === undefined || state().preferences.mode !== 'video') return;
    iceRefreshTimer = setTimeout(() => {
      video.iceServers.get().then(
        (servers) => {
          call?.setIceServers(servers);
          scheduleIceRefresh();
        },
        () => {
          iceRefreshTimer = setTimeout(scheduleIceRefresh, 15_000);
        },
      );
    }, video.iceServers.refreshInMs());
  }

  // --- queue & session --------------------------------------------------------------------

  /** Video: never queue without camera + mic, and have TURN credentials ready for the match. */
  async function prepareVideo(): Promise<boolean> {
    if (state().preferences.mode !== 'video') return true;
    if (video === undefined || video.localMedia.getStream() === null) {
      store.getState().setError('unknown', 'Video chat needs your camera and microphone.');
      return false;
    }
    try {
      await video.iceServers.get();
      scheduleIceRefresh();
      return true;
    } catch (error) {
      if (error instanceof ApiError && AUTH_CODES.has(error.code)) {
        authFailed();
      } else {
        notify('Cannot reach RandomChat right now — retrying…');
        requeueTimer = setTimeout(() => void join(), 3_000);
      }
      return false;
    }
  }

  async function join(): Promise<void> {
    if (!(await prepareVideo())) return;
    const { status } = state();
    if (status !== 'connecting' && status !== 'waiting') return; // stopped meanwhile
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
    const resumed = response.ok ? valid(sessionResumedSchema, response.data) : null;
    if (resumed !== null) {
      store.getState().resumed(resumed);
      call?.recover(); // signals may have been lost while we were away
      return;
    }
    if (response.ok || response.error.code === ErrorCode.SESSION_NOT_RESUMABLE) {
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
    const ack = response.ok ? valid(chatMessageAckSchema, response.data) : null;
    if (ack !== null) store.getState().ackMessage(clientMsgId, ack);
    else
      store
        .getState()
        .failMessage(clientMsgId, response.ok ? ErrorCode.INTERNAL_ERROR : response.error.code);
  }

  /** Leave the current chat and look for the next stranger. */
  async function skip(reason?: NextReason): Promise<void> {
    const { status, sessionId } = state();
    if (status !== 'matched' || sessionId === null) return;
    stopTyping();
    store.getState().startSearch(); // closes the call (store subscription below)
    leaving = sessionId;
    await requestNext(sessionId, reason, 0);
  }

  /**
   * The UI has already moved on; keep asking until the server lets us go too. Rapid skipping
   * is throttled by the gateway (RATE_LIMITED): retry instead of being stuck "searching" while
   * the server still has us in the old chat.
   */
  async function requestNext(sessionId: string, reason: NextReason | undefined, attempt: number) {
    if (leaving !== sessionId || state().status !== 'connecting') return;
    const response = await emit('chat:next', { sessionId, ...(reason ? { reason } : {}) });
    if (leaving !== sessionId) return; // stopped meanwhile
    if (response.ok) {
      leaving = null;
      store.getState().waiting();
      return;
    }
    switch (response.error.code) {
      case ErrorCode.NOT_IN_SESSION:
        leaving = null; // the chat had ended anyway
        await join();
        return;
      case ErrorCode.RATE_LIMITED:
      case ErrorCode.SERVICE_UNAVAILABLE:
        if (attempt === 0) notify('Slow down a little — finding the next stranger in a moment.');
        clearTimeout(requeueTimer);
        requeueTimer = setTimeout(() => void requestNext(sessionId, reason, attempt + 1), 1_000);
        return;
      default:
        leaving = null;
        store.getState().setError('unknown', response.error.message);
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

  /** Tab closed or reloaded: end the chat now instead of after the reconnect grace period. */
  function onPageHide() {
    const { status, sessionId } = state();
    endCall();
    if (!socket.connected) return;
    if (status === 'matched' && sessionId !== null) {
      socket.emit('chat:end', { sessionId }, () => undefined);
    } else if (status === 'waiting' || status === 'connecting') {
      socket.emit('queue:leave', {}, () => undefined);
    }
  }

  /** Back online (network change): reconnect right away and repair the media path. */
  function onOnline() {
    if (!kicked && !socket.connected) socket.connect();
    call?.recover();
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
      // The call is NOT closed: media is peer-to-peer and survives a signaling reconnect.
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
        } else if (code !== undefined && AUTH_CODES.has(code)) {
          authFailed();
        } else if (!socket.active) {
          // Rejected by the server's middleware (e.g. draining): socket.io will not retry itself.
          scheduleReconnect(1_000);
        }
      },
    );

    socket.on('system:notice', (raw) => {
      const notice = valid(systemNoticeSchema, raw);
      switch (notice?.code) {
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
        case NOTICE_CODES.MESSAGE_BLOCKED:
          notify(notice.message);
          break;
        case NOTICE_CODES.FRAME_SCHEDULE:
          if (notice.sessionId !== undefined && notice.sessionId === call?.sessionId) {
            callModeration?.setSchedule(notice.moderation ?? null);
          }
          break;
        case NOTICE_CODES.SERVER_RESTARTING:
          // This node is draining (deploy): move now instead of waiting to be cut off. The
          // session survives (participant `reconnecting`) and resumes on the next node.
          if (!kicked) {
            socket.disconnect();
            scheduleReconnect(250);
          }
          break;
        default:
          break;
      }
    });

    socket.on('queue:waiting', () => {
      store.getState().waiting();
    });

    socket.on('match:found', (raw) => {
      const match = valid(matchFoundSchema, raw);
      if (match === null) return;
      if (!store.getState().matchFound(match)) {
        void emit('chat:end', { sessionId: match.sessionId }); // stopped searching meanwhile
        return;
      }
      // Ready for the initiator's offer before acknowledging (it can follow immediately).
      if (match.mode === 'video' && call?.sessionId !== match.sessionId) startCall(match);
      void emit('match:ack', { sessionId: match.sessionId });
    });

    socket.on('chat:message', (raw) => {
      const message = valid(chatMessageOutSchema, raw);
      if (message !== null) store.getState().receiveMessage(message);
    });
    socket.on('chat:typing', (raw) => {
      const event = valid(chatTypingOutSchema, raw);
      if (event !== null) store.getState().setPeerTyping(event);
    });
    for (const kind of ['offer', 'answer'] as const) {
      socket.on(`rtc:${kind}`, (raw) => {
        const signal = valid(rtcDescriptionOutSchema, raw);
        if (signal !== null) call?.handleSignal({ kind, ...signal });
      });
    }
    socket.on('rtc:ice', (raw) => {
      const signal = valid(rtcIceOutSchema, raw);
      if (signal !== null) call?.handleSignal({ kind: 'ice', ...signal });
    });
    socket.on('peer:reconnecting', (raw) => {
      const event = valid(peerPresenceSchema, raw);
      if (event !== null) store.getState().peerReconnecting(event);
    });
    socket.on('peer:resumed', (raw) => {
      const event = valid(peerPresenceSchema, raw);
      if (event !== null) store.getState().peerResumed(event);
    });
    socket.on('peer:left', (raw) => {
      const event = valid(peerLeftSchema, raw);
      if (event === null) return;
      if (call?.sessionId === event.sessionId && !event.sessionEnded) {
        const summary = call.removePeer(event.participantId);
        if (summary !== null) reportSummaries(event.sessionId, [summary]);
      }
      store.getState().peerLeft(event);
      if (event.sessionEnded) maybeRequeue();
    });

    // The call follows the store: leaving `matched` (or another session) closes it.
    detach.push(
      store.subscribe((current) => {
        if (
          call !== null &&
          (current.status !== 'matched' || current.sessionId !== call.sessionId)
        ) {
          endCall();
        }
      }),
    );
    if (video !== undefined) {
      detach.push(
        video.localMedia.onTrackReplaced((track) => {
          void call?.replaceLocalTrack(track);
        }),
      );
    }

    doc?.addEventListener('visibilitychange', onVisibilityChange);
    win?.addEventListener('pagehide', onPageHide);
    win?.addEventListener('online', onOnline);
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
    next(): Promise<void> {
      return skip();
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
        const pending = leaving;
        leaving = null;
        // Still inside a chat the server didn't let us skip yet: end that one instead.
        await (pending === null
          ? emit('queue:leave', {})
          : emit('chat:end', { sessionId: pending }));
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

    /**
     * Reports the stranger (with their last frames if this is a video call) and moves on:
     * reporting always ends the chat for the reporter. Throws if the API refused it.
     */
    async report(input: { reason: ReportFields['reason']; details?: string }): Promise<void> {
      const { status, sessionId, peerIds } = state();
      const peer = peerIds[0];
      if (deps.reports === undefined || sessionId === null || peer === undefined) return;
      if (status !== 'matched' && status !== 'ended') return;
      const frames = callModeration?.evidence() ?? []; // before the call is closed
      const details = input.details?.trim();
      await deps.reports.submit(
        {
          sessionId,
          reportedParticipantId: peer,
          reason: input.reason,
          ...(details === undefined || details === '' ? {} : { details }),
        },
        frames,
      );
      notify('Thanks for reporting — our team will review it.');
      if (state().status === 'matched' && state().sessionId === sessionId) await skip();
    },

    /** Remote media of the current call, for `<video>` elements (never put it in state). */
    remoteStream(participantId: string): MediaStream | null {
      return call?.remoteStream(participantId) ?? null;
    },

    /** Reconnect after the user confirmed "use RandomChat in this tab" or re-verified. */
    reconnect(): void {
      kicked = false;
      leaving = null;
      store.getState().reset();
      if (socket.connected) socket.disconnect();
      start();
    },

    dispose(): void {
      clearTimeout(typingTimer);
      clearTimeout(ghostTimer);
      clearTimeout(requeueTimer);
      clearTimeout(reconnectTimer);
      clearTimeout(iceRefreshTimer);
      const { status, sessionId } = state();
      endCall();
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
        for (const undo of detach.splice(0)) undo();
        doc?.removeEventListener('visibilitychange', onVisibilityChange);
        win?.removeEventListener('pagehide', onPageHide);
        win?.removeEventListener('online', onOnline);
        attached = false;
      }
      store.getState().reset();
    },
  };
}

export type ChatController = ReturnType<typeof createChatController>;
