import { TRANSCRIPT_MAX_MESSAGES } from '@app/redis';
import {
  chatEndSchema,
  type ChatMessageAck,
  chatMessageSchema,
  chatNextSchema,
  chatTypingSchema,
  type ClientEventName,
  ErrorCode,
  matchAckSchema,
  moderationSignalSchema,
  pingSchema,
  type Pong,
  queueJoinSchema,
  queueLeaveSchema,
  rtcDescriptionSchema,
  rtcIceSchema,
  rtcSummarySchema,
  type SessionResumed,
  sessionResumeSchema,
} from '@app/shared';
import { ulid } from 'ulid';

import { SocketError } from '../errors.ts';
import { type GatewayModeration } from '../moderation.ts';
import { registerHandler } from '../register-handler.ts';
import { type RtcStats } from '../rtc-stats.ts';
import { type InSession, type Lifecycle } from '../sessions/lifecycle.ts';
import { type SessionStore } from '../sessions/store.ts';
import { type GatewaySocket } from '../types.ts';

/**
 * Token cost per event (bucket: see GATEWAY_DEFAULTS). Cheap events are frequent by nature (ICE
 * candidates, typing); `chat:next` is expensive so rapid skipping drains the budget.
 */
export const EVENT_COSTS = {
  'queue:join': 2,
  'queue:leave': 1,
  'chat:next': 3,
  'chat:end': 1,
  'chat:message': 1,
  'chat:typing': 0.25,
  'rtc:offer': 1,
  'rtc:answer': 1,
  'rtc:ice': 0.125,
  'rtc:summary': 1,
  'moderation:signal': 0.5,
  'match:ack': 0.5,
  'session:resume': 2,
  ping: 1,
} as const satisfies Record<ClientEventName, number>;

/** Typing indicators are relayed on change, and repeats at most every 2 s. */
export const TYPING_REPEAT_MS = 2_000;

export interface HandlerDeps {
  lifecycle: Lifecycle;
  store: SessionStore;
  now: () => Date;
  logger: { debug(obj: object, msg: string): void };
  rtcStats: RtcStats;
  moderation: GatewayModeration;
}

/** `moderation:signal` is accepted at most this often per socket (low weight, Part 8). */
export const SIGNAL_MIN_INTERVAL_MS = 5_000;
/** Client NSFW scores from here raise the session to the `high` sampling tier. */
export const SIGNAL_HIGH_RISK_SCORE = 0.8;

const BLOCKED_MESSAGES: Record<string, string> = {
  link: 'Links aren’t allowed in chat.',
  email: 'Sharing contact details isn’t allowed.',
  phone: 'Sharing contact details isn’t allowed.',
  handle: 'Moving the chat to other apps isn’t allowed.',
};

/** Summaries remembered per socket to drop duplicates (one per peer connection is expected). */
const MAX_SUMMARIES_PER_SOCKET = 64;

/**
 * Other participants still in the session. `reconnecting` ones are included: messages reach
 * them via their room if they are back, or via `missedMessages` when they resume.
 */
function activeOthers({ ref, context }: InSession) {
  return [...context.participants].filter(
    ([participantId, record]) => participantId !== ref.participantId && record.status !== 'left',
  );
}

/** WebRTC signals are addressed to exactly one active participant of a video session. */
function recipient(session: InSession, to: string): string {
  if (session.context.mode !== 'video') {
    throw new SocketError(ErrorCode.INVALID_STATE, 'WebRTC signaling requires a video session');
  }
  const target = activeOthers(session).find(([participantId]) => participantId === to);
  if (target === undefined) {
    throw new SocketError(ErrorCode.FORBIDDEN, 'Recipient is not in this session');
  }
  return target[1].visitorId;
}

export function registerHandlers(socket: GatewaySocket, deps: HandlerDeps): void {
  const { lifecycle, store, now, moderation } = deps;
  const lastTyping = { isTyping: false, sentAt: 0 };
  const summarized = new Set<string>();
  let lastSignalAt = Number.NEGATIVE_INFINITY;

  registerHandler(socket, 'ping', pingSchema, (): Pong => ({ serverTime: now().getTime() }), {
    cost: EVENT_COSTS.ping,
  });

  registerHandler(
    socket,
    'queue:join',
    queueJoinSchema,
    (preferences) => lifecycle.joinQueue(socket, preferences),
    { cost: EVENT_COSTS['queue:join'] },
  );

  registerHandler(socket, 'queue:leave', queueLeaveSchema, () => lifecycle.leaveQueue(socket), {
    cost: EVENT_COSTS['queue:leave'],
  });

  registerHandler(
    socket,
    'chat:next',
    chatNextSchema,
    ({ sessionId, reason }) => lifecycle.next(socket, sessionId, reason),
    { cost: EVENT_COSTS['chat:next'] },
  );

  registerHandler(
    socket,
    'chat:end',
    chatEndSchema,
    ({ sessionId }) => lifecycle.end(socket, sessionId),
    { cost: EVENT_COSTS['chat:end'] },
  );

  registerHandler(
    socket,
    'match:ack',
    matchAckSchema,
    ({ sessionId }) => lifecycle.ack(socket, sessionId),
    { cost: EVENT_COSTS['match:ack'] },
  );

  registerHandler(
    socket,
    'session:resume',
    sessionResumeSchema,
    ({ sessionId, lastMessageId }): Promise<SessionResumed> =>
      lifecycle.resume(socket, sessionId, lastMessageId),
    { cost: EVENT_COSTS['session:resume'] },
  );

  registerHandler(
    socket,
    'chat:message',
    chatMessageSchema,
    async ({ sessionId, text }): Promise<ChatMessageAck> => {
      const session = await lifecycle.inSession(socket, sessionId);
      const verdict = moderation.filterText(text);
      if (verdict.action === 'block') {
        const reason = verdict.reasons[0] ?? 'blocked_term';
        const notice = BLOCKED_MESSAGES[reason] ?? 'That message isn’t allowed.';
        socket.emit('system:notice', { code: 'MESSAGE_BLOCKED', message: notice });
        // Recorded off the hot path (worker: ModerationEvent + trust −2).
        void moderation
          .recordEvent({
            visitorId: socket.data.visitorId,
            sessionId,
            source: 'TEXT_FILTER',
            label: reason,
            score: 1,
            action: 'MESSAGE_BLOCKED',
            trustEvent: 'text_violation',
            at: now().toISOString(),
          })
          .catch(() => undefined);
        throw new SocketError(ErrorCode.MESSAGE_BLOCKED, notice);
      }
      const relayed = verdict.action === 'mask' ? (verdict.masked ?? text) : text;
      const from = session.ref.participantId;
      const id = ulid();
      const at = now().toISOString();
      const message = { sessionId, from, id, text: relayed, at };
      await store.appendLog(sessionId, message, TRANSCRIPT_MAX_MESSAGES);
      for (const [, record] of activeOthers(session)) {
        lifecycle.emitTo(record.visitorId, 'chat:message', message);
      }
      return relayed === text ? { id, at } : { id, at, text: relayed };
    },
    { cost: EVENT_COSTS['chat:message'] },
  );

  registerHandler(
    socket,
    'chat:typing',
    chatTypingSchema,
    async ({ sessionId, isTyping }) => {
      const session = await lifecycle.inSession(socket, sessionId);
      const at = now().getTime();
      if (isTyping === lastTyping.isTyping && at - lastTyping.sentAt < TYPING_REPEAT_MS) return;
      lastTyping.isTyping = isTyping;
      lastTyping.sentAt = at;
      for (const [, record] of activeOthers(session)) {
        lifecycle.emitTo(record.visitorId, 'chat:typing', {
          sessionId,
          from: session.ref.participantId,
          isTyping,
        });
      }
    },
    { cost: EVENT_COSTS['chat:typing'] },
  );

  for (const event of ['rtc:offer', 'rtc:answer'] as const) {
    registerHandler(
      socket,
      event,
      rtcDescriptionSchema,
      async ({ sessionId, to, sdp }) => {
        const session = await lifecycle.inSession(socket, sessionId);
        lifecycle.emitTo(recipient(session, to), event, {
          sessionId,
          from: session.ref.participantId,
          sdp,
        });
      },
      { cost: EVENT_COSTS[event] },
    );
  }

  registerHandler(
    socket,
    'rtc:ice',
    rtcIceSchema,
    async ({ sessionId, to, candidate }) => {
      const session = await lifecycle.inSession(socket, sessionId);
      lifecycle.emitTo(recipient(session, to), 'rtc:ice', {
        sessionId,
        from: session.ref.participantId,
        candidate,
      });
    },
    { cost: EVENT_COSTS['rtc:ice'] },
  );

  registerHandler(
    socket,
    'rtc:summary',
    rtcSummarySchema,
    async (summary) => {
      await lifecycle.checkSummary(socket, summary.sessionId, summary.peer);
      const key = `${summary.sessionId}:${summary.peer}`;
      if (summarized.has(key)) return;
      if (summarized.size >= MAX_SUMMARIES_PER_SOCKET) summarized.clear();
      summarized.add(key);
      // Connection-quality metrics only (no addresses); exported as metrics in Part 10.
      deps.rtcStats.record(summary);
      deps.logger.debug({ rtcSummary: summary }, 'rtc summary');
    },
    { cost: EVENT_COSTS['rtc:summary'] },
  );

  /**
   * Client-side NSFW classifier results. Unverified, so low weight: recorded for review
   * without trust changes; a high score about the stranger raises the session's frame
   * sampling to `high` so the server checks for itself (D-054).
   */
  registerHandler(
    socket,
    'moderation:signal',
    moderationSignalSchema,
    async ({ sessionId, about, kind, score }) => {
      const at = now().getTime();
      if (at - lastSignalAt < SIGNAL_MIN_INTERVAL_MS) {
        throw new SocketError(ErrorCode.RATE_LIMITED, 'One signal per 5 seconds');
      }
      lastSignalAt = at;
      const session = await lifecycle.inSession(socket, sessionId);
      const subject =
        about === 'self'
          ? socket.data.visitorId
          : activeOthers(session).find(([participantId]) => participantId === about)?.[1].visitorId;
      if (subject === undefined) {
        throw new SocketError(ErrorCode.FORBIDDEN, 'Not a participant of this session');
      }
      await moderation.recordEvent({
        visitorId: subject,
        sessionId,
        source: 'CLIENT_NSFW',
        label: kind,
        score,
        action: 'NONE',
        trustEvent: null,
        at: new Date(at).toISOString(),
      });
      if (about !== 'self' && score >= SIGNAL_HIGH_RISK_SCORE) await lifecycle.raiseRisk(sessionId);
    },
    { cost: EVENT_COSTS['moderation:signal'] },
  );
}
