import { type Logger } from '@app/logger';
import { type Matchmaker } from '@app/matchmaking';
import { MATCHMAKING_SWEEP_LOCK_KEY, presenceNodeKey, type Redis } from '@app/redis';

import { allMatchDimensions } from './sessions/store.ts';

/** A waiting ticket this old is assumed abandoned even if its node is alive. */
const MAX_WAITING_AGE_MS = 30 * 60 * 1000;

/**
 * Every `intervalMs`, one gateway (whoever wins `SET NX PX` on the lock) sweeps stale tickets
 * from every matchmaking tag. Tickets of crashed nodes are detected via presence keys.
 */
export function startTicketSweeper(deps: {
  redis: Redis;
  matchmaker: Matchmaker;
  nodeId: string;
  intervalMs: number;
  logger: Pick<Logger, 'debug' | 'warn'>;
}) {
  const { redis, matchmaker, nodeId, intervalMs, logger } = deps;

  async function isNodeAlive(id: string): Promise<boolean> {
    try {
      return (await redis.exists(presenceNodeKey(id))) === 1;
    } catch {
      return false; // malformed node id in a ticket
    }
  }

  async function sweep(): Promise<number> {
    // Lock shorter than the interval so a crashed holder never blocks the next round.
    const locked = await redis.set(
      MATCHMAKING_SWEEP_LOCK_KEY,
      nodeId,
      'PX',
      intervalMs - 1_000,
      'NX',
    );
    if (locked === null) return 0;
    let dropped = 0;
    for (const dims of allMatchDimensions()) {
      dropped += await matchmaker.sweepStale(dims, {
        maxWaitingAgeMs: MAX_WAITING_AGE_MS,
        isNodeAlive,
      });
    }
    if (dropped > 0) logger.debug({ dropped }, 'stale tickets swept');
    return dropped;
  }

  const timer = setInterval(() => {
    sweep().catch((error: unknown) => {
      logger.warn({ err: error }, 'ticket sweep failed');
    });
  }, intervalMs);
  timer.unref();

  return {
    sweep,
    stop: () => {
      clearInterval(timer);
    },
  };
}
