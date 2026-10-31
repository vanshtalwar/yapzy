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
}

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
  const { lifecycle, store, now } = deps;
  const lastTyping = { isTyping: false, sentAt: 0 };
  const summarized = new Set<string>();

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
      const from = session.ref.participantId;
      const id = ulid();
      const at = now().toISOString();
      const message = { sessionId, from, id, text, at };
      await store.appendLog(sessionId, message, TRANSCRIPT_MAX_MESSAGES);
      for (const [, record] of activeOthers(session)) {
        lifecycle.emitTo(record.visitorId, 'chat:message', message);
      }
      return { id, at };
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

  // Part 8 (trust & safety) implements client-side moderation signals.
  registerHandler(
    socket,
    'moderation:signal',
    moderationSignalSchema,
    () => {
      throw new SocketError(ErrorCode.NOT_IMPLEMENTED, 'moderation:signal is not implemented yet');
    },
    { cost: EVENT_COSTS['moderation:signal'] },
  );
}
