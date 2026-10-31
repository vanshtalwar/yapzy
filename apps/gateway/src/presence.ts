import { type Logger } from '@app/logger';
import { PRESENCE_NODES_KEY, PRESENCE_TTL_SECONDS, presenceNodeKey, type Redis } from '@app/redis';

export interface PresenceDeps {
  redis: Redis;
  nodeId: string;
  intervalMs: number;
  countSockets: () => number;
  logger: Pick<Logger, 'warn'>;
}

/**
 * Publishes this node's socket count (`presence:node:<id>`, TTL 15 s) and membership in
 * `presence:nodes`. A crashed node's count expires on its own; its stale set member is pruned
 * by whichever node ticks next.
 */
export function startPresence(deps: PresenceDeps) {
  const { redis, nodeId, intervalMs, countSockets, logger } = deps;
  const ownKey = presenceNodeKey(nodeId);

  async function tick(): Promise<void> {
    await redis
      .multi()
      .set(ownKey, String(countSockets()), 'EX', PRESENCE_TTL_SECONDS)
      .sadd(PRESENCE_NODES_KEY, nodeId)
      .exec();

    const members = await redis.smembers(PRESENCE_NODES_KEY);
    const others = members.filter((member) => member !== nodeId);
    const alive = await Promise.all(
      others.map(async (member) => {
        try {
          return (await redis.exists(presenceNodeKey(member))) === 1;
        } catch {
          return false; // malformed member
        }
      }),
    );
    const dead = others.filter((_, index) => alive[index] === false);
    if (dead.length > 0) await redis.srem(PRESENCE_NODES_KEY, ...dead);
  }

  const safeTick = () => {
    tick().catch((error: unknown) => {
      logger.warn({ err: error }, 'presence update failed');
    });
  };

  safeTick();
  const timer = setInterval(safeTick, intervalMs);
  timer.unref();

  return {
    /** Refresh now (e.g. right after connections change, or in tests). */
    refresh: tick,
    async stop(): Promise<void> {
      clearInterval(timer);
      await redis.multi().del(ownKey).srem(PRESENCE_NODES_KEY, nodeId).exec();
    },
  };
}
