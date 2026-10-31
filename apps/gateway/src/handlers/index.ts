import {
  chatEndSchema,
  chatMessageSchema,
  chatNextSchema,
  chatTypingSchema,
  type ClientEventName,
  ErrorCode,
  moderationSignalSchema,
  pingSchema,
  type Pong,
  queueJoinSchema,
  queueLeaveSchema,
  rtcDescriptionSchema,
  rtcIceSchema,
  rtcSummarySchema,
} from '@app/shared';
import { type z } from 'zod';

import { SocketError } from '../errors.ts';
import { registerHandler } from '../register-handler.ts';
import { type GatewaySocket } from '../types.ts';

/**
 * Token cost per event (bucket: see GUARD_DEFAULTS). Cheap events are frequent by nature (ICE
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
  ping: 1,
} as const satisfies Record<ClientEventName, number>;

/** Events implemented in Part 5 (matchmaking, sessions, relay); validated but not handled yet. */
const STUBBED: [ClientEventName, z.ZodType][] = [
  ['queue:join', queueJoinSchema],
  ['queue:leave', queueLeaveSchema],
  ['chat:next', chatNextSchema],
  ['chat:end', chatEndSchema],
  ['chat:message', chatMessageSchema],
  ['chat:typing', chatTypingSchema],
  ['rtc:offer', rtcDescriptionSchema],
  ['rtc:answer', rtcDescriptionSchema],
  ['rtc:ice', rtcIceSchema],
  ['rtc:summary', rtcSummarySchema],
  ['moderation:signal', moderationSignalSchema],
];

export function registerHandlers(socket: GatewaySocket, now: () => Date): void {
  registerHandler(socket, 'ping', pingSchema, (): Pong => ({ serverTime: now().getTime() }), {
    cost: EVENT_COSTS.ping,
  });

  for (const [event, schema] of STUBBED) {
    registerHandler(
      socket,
      event,
      schema,
      () => {
        throw new SocketError(ErrorCode.NOT_IMPLEMENTED, `${event} is not implemented yet`);
      },
      { cost: EVENT_COSTS[event] },
    );
  }
}
