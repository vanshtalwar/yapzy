import { type Redis } from '@app/redis';

interface PendingOperation {
  channels: string[];
  op: 'ssubscribe' | 'sunsubscribe';
  since: number;
}

/**
 * Watches the subscriber connection of the sharded Socket.io adapter (D-100): one SSUBSCRIBE per
 * visitor room on create-room and one SUNSUBSCRIBE on delete-room, fired without awaiting.
 *
 * Every (un)subscription in flight is tracked, so a subscriber that stopped answering is
 * detected (`oldestPendingMs`): rooms created from then on are never subscribed and cross-node
 * delivery to them is silently lost. The node then reports itself unhealthy and is replaced
 * while its sessions resume elsewhere (D-046). (node-redis 6.3 — used before — got into exactly
 * that state under load: a SUNSUBSCRIBE reply was never matched and every later pub/sub command
 * queued behind it; ioredis matches replies strictly and fails loudly instead.)
 */
export function watchShardedSubscriber(client: Redis, now: () => number = Date.now) {
  const pending = new Map<number, PendingOperation>();
  let sequence = 0;

  function track(op: PendingOperation['op'], channels: string[], result: Promise<unknown>) {
    const id = (sequence += 1);
    pending.set(id, { channels, op, since: now() });
    return result.finally(() => {
      pending.delete(id);
    });
  }

  // The adapter calls ssubscribe/sunsubscribe, `on('smessageBuffer')` and stores its handler map
  // on the client object; everything except the two tracked commands goes to the client as is.
  const subscriber = new Proxy(client, {
    get(target, property) {
      if (property === 'ssubscribe' || property === 'sunsubscribe') {
        return (...channels: string[]) => track(property, channels, target[property](...channels));
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  return {
    subscriber,
    /** Age of the oldest subscribe/unsubscribe still waiting for Redis (0 = none). */
    oldestPendingMs(): number {
      let oldest = 0;
      for (const operation of pending.values()) oldest = Math.max(oldest, now() - operation.since);
      return oldest;
    },
    /** Diagnostics: the oldest pending operation, if any. */
    oldestPending(): PendingOperation | undefined {
      let found: PendingOperation | undefined;
      for (const operation of pending.values()) {
        if (found === undefined || operation.since < found.since) found = operation;
      }
      return found;
    },
    pendingCount: () => pending.size,
  };
}

export type WatchedSubscriber = ReturnType<typeof watchShardedSubscriber>;
