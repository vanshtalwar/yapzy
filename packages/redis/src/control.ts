import { type Redis } from 'ioredis';
import { z } from 'zod';

import { parseRedisJson } from './json.ts';
import { GW_CONTROL_CHANNEL } from './keys.ts';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const id = z.string().min(1).max(128);

/** Messages on `gw:control`. Every gateway node receives every message (incl. the sender). */
export const gwControlMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('kick_visitor'),
    originNodeId: id,
    visitorId: id,
    reason: z.enum(['session_replaced', 'banned', 'admin']),
    /** The visitor's new socket, which must survive the kick (one socket per visitor). */
    keepSocketId: id.optional(),
  }),
  z.object({
    type: z.literal('end_session'),
    originNodeId: id,
    sessionId: id,
    reason: z.enum(['admin', 'banned', 'server_restart']),
  }),
  z
    .object({
      type: z.literal('ban_applied'),
      originNodeId: id,
      banId: id,
      banType: z.enum(['HARD', 'SHADOW']),
      visitorId: id.optional(),
      deviceIdHash: hex64.optional(),
      ipHash: hex64.optional(),
      expiresAt: z.iso.datetime().nullable(),
    })
    .refine(
      (ban) =>
        ban.visitorId !== undefined || ban.deviceIdHash !== undefined || ban.ipHash !== undefined,
      { message: 'ban_applied needs visitorId, deviceIdHash or ipHash' },
    ),
]);

export type GwControlMessage = z.output<typeof gwControlMessageSchema>;

/**
 * `channel` exists for tests only: pub/sub ignores the DB index, so tests must not publish on
 * the real channel a running dev gateway listens to.
 */
export async function publishControl(
  redis: Redis,
  message: GwControlMessage,
  channel: string = GW_CONTROL_CHANNEL,
): Promise<number> {
  const payload = JSON.stringify(gwControlMessageSchema.parse(message));
  return redis.publish(channel, payload);
}

export interface ControlSubscriptionHandlers {
  onMessage: (message: GwControlMessage) => void;
  /** Malformed messages are dropped; this hook lets the caller log/count them. */
  onInvalid?: (error: unknown) => void;
}

/**
 * Subscribes a DEDICATED connection (a subscribed RESP2 connection can't run other commands)
 * and returns an async unsubscribe function.
 */
export async function subscribeControl(
  subscriber: Redis,
  handlers: ControlSubscriptionHandlers,
  channel: string = GW_CONTROL_CHANNEL,
): Promise<() => Promise<void>> {
  const listener = (receivedOn: string, raw: string) => {
    if (receivedOn !== channel) return;
    let message: GwControlMessage;
    try {
      message = parseRedisJson(raw, gwControlMessageSchema, channel);
    } catch (error) {
      handlers.onInvalid?.(error);
      return;
    }
    handlers.onMessage(message);
  };

  subscriber.on('message', listener);
  await subscriber.subscribe(channel);

  return async () => {
    subscriber.off('message', listener);
    await subscriber.unsubscribe(channel);
  };
}
